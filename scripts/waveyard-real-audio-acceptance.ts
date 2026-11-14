/**
 * Waveyard real-audio acceptance benchmark.
 *
 * Takes pairs of real, legally usable recordings (CC0 corpus, see
 * `waveyard-real-audio-corpus.ts`), runs them through the *production* analysis
 * and planning path, and records what the engine actually decided. This is the
 * evidence layer the mashup-generation directive asks for; it is measured
 * behaviour, not a quality claim. No listening test is performed here and none
 * may be inferred from the output (listener count is N=0).
 *
 * Synthetic fixtures are used elsewhere as regressions. They must never be
 * presented as musical evidence, which is why this script refuses to run
 * without real audio.
 *
 * Usage:
 *   tsx scripts/waveyard-real-audio-acceptance.ts
 *   tsx scripts/waveyard-real-audio-acceptance.ts --out report.json
 *
 * Requires ARENA_FFMPEG_PATH and a populated corpus
 * (`tsx scripts/waveyard-real-audio-corpus.ts` first).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analysePcm } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import {
  planMashup,
  type MashupSourceProfile,
} from "../lib/arena/src/lib/waveyard/studio/mashup";
import {
  trustedAnalysisBpm,
  hasReliableMixingConfidence,
} from "../lib/arena/src/lib/waveyard/types/analysis-confidence";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDirectory = resolve(here, "..", "generated-artifacts", "waveyard-real-audio");
const ANALYSIS_RATE = 22_050;

type TrackAnalysis = ReturnType<typeof analysePcm> & { file: string; durationMs: number };

function decode(file: string, ffmpeg: string): Float32Array {
  const stdout = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", join(corpusDirectory, file), "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

/** Deterministic sections so the planner has the structure evidence it normally gets from the DB. */
function syntheticSections(durationMs: number): MashupSourceProfile["sections"] {
  const at = (fraction: number) => Math.round(durationMs * fraction);
  return [
    { label: "intro", startMs: 0, endMs: at(0.1) },
    { label: "verse", startMs: at(0.1), endMs: at(0.5) },
    { label: "chorus", startMs: at(0.5), endMs: at(0.8) },
    { label: "outro", startMs: at(0.8), endMs: durationMs },
  ];
}

function profileFor(role: "vocals" | "instrumental", analysis: TrackAnalysis): MashupSourceProfile {
  return {
    role,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    bpmCandidates: analysis.bpmCandidates,
    musicalKey: analysis.musicalKey,
    keyConfidence: analysis.keyConfidence,
    beatGridMs: analysis.beatGridMs,
    beatConfidence: analysis.beatConfidence,
    downbeatGridMs: analysis.downbeatGridMs,
    downbeatConfidence: analysis.downbeatConfidence,
    durationMs: analysis.durationMs,
    sections: syntheticSections(analysis.durationMs),
  };
}

function describeAnalysis(analysis: TrackAnalysis) {
  return {
    file: analysis.file,
    durationSeconds: Math.round(analysis.durationMs / 100) / 10,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    bpmCandidates: analysis.bpmCandidates,
    bpmTrusted: trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence) !== null,
    musicalKey: analysis.musicalKey,
    keyConfidence: analysis.keyConfidence,
    keyTrusted: hasReliableMixingConfidence(analysis.keyConfidence),
    beatGridBeats: analysis.beatGridMs?.length ?? 0,
    beatConfidence: analysis.beatConfidence,
    downbeatGridBeats: analysis.downbeatGridMs?.length ?? 0,
    downbeatConfidence: analysis.downbeatConfidence,
  };
}

async function main(): Promise<void> {
  const ffmpeg = process.env.ARENA_FFMPEG_PATH;
  if (!ffmpeg) {
    console.error("ARENA_FFMPEG_PATH must point at an ffmpeg binary.");
    process.exit(1);
  }
  const manifestPath = join(here, "fixtures", "waveyard-real-audio", "corpus.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    source: { repository: string; commit: string };
    license: { id: string };
    tracks: Array<{ file: string }>;
  };
  if (!existsSync(corpusDirectory) || manifest.tracks.some((track) => !existsSync(join(corpusDirectory, track.file)))) {
    console.error("Corpus is not populated. Run: tsx scripts/waveyard-real-audio-corpus.ts");
    process.exit(1);
  }

  const analyses = new Map<string, TrackAnalysis>();
  for (const track of manifest.tracks) {
    const pcm = decode(track.file, ffmpeg);
    const analysis = analysePcm(pcm);
    analyses.set(track.file, {
      ...analysis,
      file: track.file,
      durationMs: Math.round((pcm.length / ANALYSIS_RATE) * 1000),
    });
  }

  const files = [...analyses.keys()].sort();
  const pairs: Array<Record<string, unknown>> = [];
  for (const vocalsFile of files) {
    for (const bedFile of files) {
      if (vocalsFile === bedFile) continue;
      const vocals = analyses.get(vocalsFile)!;
      const bed = analyses.get(bedFile)!;
      const result = planMashup(profileFor("vocals", vocals), profileFor("instrumental", bed));
      const trustedVocals = trustedAnalysisBpm(vocals.bpm, vocals.bpmConfidence);
      const trustedBed = trustedAnalysisBpm(bed.bpm, bed.bpmConfidence);
      pairs.push({
        vocals: vocalsFile,
        bed: bedFile,
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
        // What the engine decided, not what it would ideally decide.
        masterBpm: result.ok ? result.plan.masterBpm : undefined,
        stretchRatio: result.ok ? result.plan.vocalsStretchRatio : undefined,
        pitchSemitones: result.ok ? result.plan.vocalsPitchSemitones : undefined,
        keyRelationship: result.ok ? result.plan.keyRelationship : undefined,
        segments: result.ok ? result.plan.segments.length : undefined,
        arrangement: result.ok ? Boolean(result.plan.arrangement) : undefined,
        outputSeconds: result.ok ? Math.round(result.plan.durationMs / 100) / 10 : undefined,
        bothTemposTrusted: trustedVocals !== null && trustedBed !== null,
        octaveResolutionExplained: result.ok
          ? result.plan.rationale.some((line) => /octave resolved from the pulse family/i.test(line))
          : undefined,
        octaveAmbiguous: result.ok
          ? result.plan.warnings.some((line) => /octave is ambiguous/i.test(line))
          : undefined,
        warnings: result.ok ? result.plan.warnings.length : undefined,
      });
    }
  }

  const planned = pairs.filter((pair) => pair.ok);
  const report = {
    evidence: "real CC0 audio through the production analysis and planning code; measured behaviour only, NOT a musical-quality claim",
    listeners: 0,
    synthetic: false,
    corpus: { repository: manifest.source.repository, commit: manifest.source.commit, license: manifest.license.id },
    analysis: [...analyses.values()].map(describeAnalysis),
    summary: {
      tracks: files.length,
      pairs: pairs.length,
      planned: planned.length,
      refused: pairs.length - planned.length,
      tracksWithTrustedTempo: [...analyses.values()]
        .filter((analysis) => trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence) !== null).length,
      tracksWithTrustedKey: [...analyses.values()]
        .filter((analysis) => hasReliableMixingConfidence(analysis.keyConfidence)).length,
      pairsWithOctaveResolution: planned.filter((pair) => pair.octaveResolutionExplained).length,
      pairsWithOctaveAmbiguity: planned.filter((pair) => pair.octaveAmbiguous).length,
      distinctReportedKeys: [...new Set([...analyses.values()].map((analysis) => analysis.musicalKey))].length,
      stretchRatios: planned.map((pair) => pair.stretchRatio as number).sort((left, right) => left - right),
    },
    pairs,
  };

  console.log(JSON.stringify(report.summary, null, 2));
  console.log("\nAnalysis:");
  for (const row of report.analysis) {
    console.log(
      `  ${row.file.padEnd(30)} ${String(row.bpm ?? "-").padStart(7)} BPM `
      + `(conf ${row.bpmConfidence ?? "-"}, trusted ${row.bpmTrusted})  `
      + `${row.musicalKey ?? "-"} (conf ${row.keyConfidence ?? "-"}, trusted ${row.keyTrusted})`,
    );
  }

  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const destination = resolve(process.argv[outIndex + 1]!);
    writeFileSync(destination, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${destination}`);
  }
}

await main();
