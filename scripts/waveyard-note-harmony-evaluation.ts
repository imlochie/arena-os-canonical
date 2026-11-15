/**
 * Full-recording component probe, not a persisted-route or listening test.
 * Reuses existing separation files; never starts another separation or downloads
 * owner recordings. Missing/changed bytes fail explicitly.
 *
 * pnpm --filter @workspace/scripts exec tsx /absolute/path/to/this-script.ts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_PCM_RATE, detectHarmonyTimeline, detectVocalPitchFrames } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import { scoreVocalChordToneFit } from "../lib/arena/src/lib/waveyard/studio/mashup";
import { stableVocalNotes } from "../lib/arena/src/lib/waveyard/studio/note-harmony";
import type { VocalPitchFrame } from "../lib/arena/src/lib/waveyard/types/vocal-analysis";
import { LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION, type HarmonyEvent } from "../lib/arena/src/lib/waveyard/types/harmony-analysis";

type PinnedFile = { file: string; sha256: string };
type Track = PinnedFile & { id: string; title: string; containerDurationMs: number; stems?: { vocals: PinnedFile; other: PinnedFile; bass: PinnedFile; drums: PinnedFile } };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "scripts/fixtures/waveyard-musical-evaluation.json"), "utf8")) as {
  tracks: Track[]; groundTruth: string; groundTruthStatus: string; stemAssociation: string;
};
const ownerNotes = JSON.parse(readFileSync(resolve(root, manifest.groundTruth), "utf8")) as {
  recordings: Record<string, { sourceSha256: string; sections: Array<{ startMs: number; endMs: number; label: string }> }>;
};
for (const track of manifest.tracks) {
  for (const pinned of [track, ...Object.values(track.stems ?? {})]) {
    const bytes = readFileSync(resolve(root, pinned.file));
    if (createHash("sha256").update(bytes).digest("hex") !== pinned.sha256)
      throw new Error(`Evaluation bytes changed: ${pinned.file}`);
  }
}
function decode(file: string): Float32Array {
  const bytes = execFileSync(process.env.ARENA_FFMPEG_PATH || "ffmpeg", [
    "-nostdin", "-v", "error", "-i", resolve(root, file),
    "-f", "f32le", "-ac", "1", "-ar", String(ANALYSIS_PCM_RATE), "pipe:1",
  ], { maxBuffer: 128 * 1024 * 1024 });
  if (!bytes.length || bytes.length % 4) throw new Error(`Invalid analysis PCM: ${file}`);
  const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (pcm.some((sample) => !Number.isFinite(sample))) throw new Error(`Non-finite analysis PCM: ${file}`);
  return pcm;
}
const analyses: Array<{ track: Track; durationMs: number; frames: VocalPitchFrame[]; chords: HarmonyEvent[]; otherOnlyChords: HarmonyEvent[] }> = [];
for (const track of manifest.tracks.filter((candidate) => candidate.stems)) {
  const vocalPcm = decode(track.stems!.vocals.file);
  const otherPcm = decode(track.stems!.other.file);
  const bassPcm = decode(track.stems!.bass.file);
  const drumPcm = decode(track.stems!.drums.file);
  const durationMs = Math.round(vocalPcm.length / ANALYSIS_PCM_RATE * 1000);
  if ([otherPcm, bassPcm, drumPcm].some((pcm) => pcm.length !== vocalPcm.length) || Math.abs(durationMs - track.containerDurationMs) > 250)
    throw new Error(`Expected full-length, aligned stems for ${track.id}; excerpts are not accepted.`);
  const otherOnlyChords = detectHarmonyTimeline(otherPcm);
  const bedPcm = new Float32Array(otherPcm.length);
  for (let frame = 0; frame < bedPcm.length; frame++)
    bedPcm[frame] = otherPcm[frame]! + bassPcm[frame]! + drumPcm[frame]!;
  analyses.push({ track, durationMs, frames: detectVocalPitchFrames(vocalPcm), chords: detectHarmonyTimeline(bedPcm), otherOnlyChords });
}
const results = analyses.map(({ track, durationMs, frames, chords, otherOnlyChords }) => {
  const annotations = ownerNotes.recordings[track.id];
  if (annotations && annotations.sourceSha256 !== track.sha256) throw new Error(`Owner annotations refer to different bytes: ${track.id}`);
  return ({
  trackId: track.id, durationMs,
  pitchFrameCount: frames.length,
  confidentVoicedFrameCount: frames.filter((frame) => frame.voiced && frame.confidence >= 0.75).length,
  stableEstimatedNoteCount: stableVocalNotes(frames).length,
  chordWindowCount: chords.length,
  namedChordWindowCount: chords.filter((chord) => chord.root && chord.quality !== "unknown").length,
  otherOnlyControl: {
    chordWindowCount: otherOnlyChords.length,
    namedChordWindowCount: otherOnlyChords.filter((chord) => chord.root && chord.quality !== "unknown").length,
    nativeTimelineFit: scoreVocalChordToneFit({ vocalFrames: frames, bedChords: otherOnlyChords,
      donorStartMs: 0, donorEndMs: durationMs, bedStartMs: 0, bedEndMs: durationMs, stretchRatio: 1, pitchShiftSemitones: 0 }),
  },
  nativeTimelineFit: scoreVocalChordToneFit({ vocalFrames: frames, bedChords: chords,
    donorStartMs: 0, donorEndMs: durationMs, bedStartMs: 0, bedEndMs: durationMs,
    stretchRatio: 1, pitchShiftSemitones: 0 }),
  provisionalOwnerSections: (annotations?.sections ?? []).map((section) => ({
    ...section,
    analyzedEndMs: Math.min(durationMs, section.endMs),
    harmonicFit: scoreVocalChordToneFit({ vocalFrames: frames, bedChords: chords,
      donorStartMs: section.startMs, donorEndMs: Math.min(durationMs, section.endMs),
      bedStartMs: section.startMs, bedEndMs: Math.min(durationMs, section.endMs), stretchRatio: 1, pitchShiftSemitones: 0 }),
  })),
  notes: stableVocalNotes(frames),
  chordWindows: chords,
}); });
const report = {
  schemaVersion: 1,
  localHarmonyEngineVersion: LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION,
  evidence: "Full-length owner-recording component probe using production detectors, MIDI converter and harmonic scorer. No synthetic audio.",
  limitations: {
    persistedRouteAcceptance: false, newlyRenderedMashups: false, independentListeners: 0,
    noteOrChordAccuracy: "unverified without reference labels",
    polyphonicMelodicNoteExtraction: "not implemented by this probe",
    groundTruth: manifest.groundTruthStatus, stemAssociation: manifest.stemAssociation,
  },
  inventory: manifest.tracks.map((track) => ({ id: track.id, title: track.title, sha256: track.sha256,
    containerDurationMs: track.containerDurationMs, status: track.stems ? "component-probed" : "awaiting-pinned-stems" })),
  results,
};
const output = resolve(root, "generated-artifacts/waveyard-note-harmony");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: "generated-artifacts/waveyard-note-harmony/report.json",
  inventoryTracks: manifest.tracks.length, results: results.map(({ notes, chordWindows, ...summary }) => summary),
  limitations: report.limitations }, null, 2));
