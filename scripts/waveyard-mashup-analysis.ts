import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  analysePcm,
  beatConfidenceFromGrid,
  decodeMonoPcm,
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  normaliseBeatGrid,
  onsetEnvelope,
} from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import { desktopSectionCandidates } from "../lib/arena/src/lib/waveyard/worker-local/sections";
import { detectRepeatedPhraseMatches, sectionEnergyChangeDb } from "../lib/arena/src/lib/waveyard/worker-local/section-rhythm";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "../lib/arena/src/lib/waveyard/types/analysis-provenance";
import { normalizeSourceSections, sourceSectionsAreValid } from "../lib/arena/src/lib/waveyard/types/source-sections";

const args = process.argv.slice(2).filter((value) => value !== "--");
const [outputPath, excerptStartText, excerptDurationText, ...sourcePaths] = args;
const excerptStartSeconds = Number(excerptStartText ?? "15");
const fullTrack = excerptDurationText === "full";
const excerptDurationSeconds = fullTrack ? null : Number(excerptDurationText ?? "12");
if (!outputPath || sourcePaths.length < 2
  || !Number.isFinite(excerptStartSeconds) || excerptStartSeconds < 0
  || (fullTrack && excerptStartSeconds !== 0)
  || (!fullTrack && (
    excerptDurationSeconds === null
    || !Number.isFinite(excerptDurationSeconds)
    || excerptDurationSeconds < 2
  ))) {
  throw new Error(
    "Usage: tsx scripts/waveyard-mashup-analysis.ts -- <output.json> <excerpt-start-seconds> <excerpt-duration-seconds|full> <two or more audio paths>",
  );
}

async function checksumFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const tracks = [];
for (const sourcePath of sourcePaths) {
  const absolutePath = resolve(sourcePath);
  const pcm = fullTrack
    ? await decodeMonoPcm(absolutePath)
    : await decodeMonoPcm(absolutePath, Math.max(60, excerptStartSeconds + excerptDurationSeconds! + 15));
  const analysis = analysePcm(pcm);
  const analyzedDurationSeconds = Math.round((pcm.length / 22_050) * 100) / 100;
  const evaluatedDurationSeconds = fullTrack
    ? Math.max(0, analyzedDurationSeconds - excerptStartSeconds)
    : excerptDurationSeconds!;
  const beatGridMs = analysis.beatGridMs === null
    ? null
    : normaliseBeatGrid(analysis.beatGridMs, analyzedDurationSeconds);
  if (analysis.beatGridMs !== null && beatGridMs === null) {
    throw new Error(`Analysis returned an invalid beat grid for ${basename(absolutePath)}.`);
  }
  const combinedBeatConfidence = beatGridMs === null
    ? analysis.beatConfidence
    : beatConfidenceFromGrid(analysis.bpmConfidence, beatGridMs, analysis.beatConfidence);
  if (beatGridMs === null && combinedBeatConfidence !== null) {
    throw new Error(`Analysis returned beat confidence without a beat grid for ${basename(absolutePath)}.`);
  }
  const startMs = Math.round(excerptStartSeconds * 1000);
  const endMs = startMs + Math.round(evaluatedDurationSeconds * 1000);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const phraseMatches = beatGridMs
    ? detectRepeatedPhraseMatches(beatGridMs, envelope, frameMs, pcm)
    : null;
  const sectionCandidates = beatGridMs
    ? desktopSectionCandidates(beatGridMs, envelope, frameMs, pcm, phraseMatches ?? undefined)
    : null;
  const sourceChecksumSha256 = await checksumFile(absolutePath);
  const normalizedSections = sectionCandidates && beatGridMs
    ? normalizeSourceSections(
      sectionCandidates,
      beatGridMs,
      {
        analysisEngine: DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256,
      },
      ({ startBeatIndex, endBeatIndex, sectionIndex }) => `evaluation:${sectionIndex}:${startBeatIndex}:${endBeatIndex}`,
      analyzedDurationSeconds * 1000,
    )
    : null;
  if (sectionCandidates && beatGridMs) {
    if (!normalizedSections || normalizedSections.length !== sectionCandidates.length) {
      throw new Error(`Some section candidates were rejected by persistence normalization for ${basename(absolutePath)}.`);
    }
    if (!sourceSectionsAreValid(normalizedSections, beatGridMs, analyzedDurationSeconds * 1000)) {
      throw new Error(`Section candidates failed persistence validation for ${basename(absolutePath)}.`);
    }
  }
  const phraseMatchesWithTimes = phraseMatches?.map((match) => {
    const section = normalizedSections?.find((candidate) =>
      candidate.startBeatIndex === match.startBeatIndex && candidate.endBeatIndex === match.endBeatIndex,
    );
    if (!section) {
      throw new Error(`A repeated phrase was not preserved by persistence normalization for ${basename(absolutePath)}.`);
    }
    return {
      startBeatIndex: match.startBeatIndex,
      endBeatIndex: match.endBeatIndex,
      startMs: section.startMs,
      endMs: section.endMs,
      label: match.label,
      similarity: match.labelConfidence,
    };
  }) ?? null;
  const sections = normalizedSections?.map((section, index) => {
    const candidate = sectionCandidates![index]!;
    return {
      id: section.id,
      sectionIndex: section.sectionIndex,
      startBeatIndex: section.startBeatIndex,
      endBeatIndex: section.endBeatIndex,
      startBar: section.startBar,
      endBar: section.endBar,
      startMs: section.startMs,
      endMs: section.endMs,
      label: section.label,
      labelConfidence: section.labelConfidence,
      structuralConfidence: section.structuralConfidence,
      analysisEngine: section.analysisEngine,
      analysisEngineVersion: section.analysisEngineVersion,
      sourceChecksumSha256: section.sourceChecksumSha256,
      energyChangeDb: beatGridMs
        ? sectionEnergyChangeDb(sectionCandidates![index - 1] ?? null, candidate, beatGridMs, pcm)
        : null,
    };
  }) ?? null;
  tracks.push({
    filename: basename(absolutePath),
    sourceChecksumSha256,
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sectionAnalysisEngine: DESKTOP_SECTION_ENGINE,
    sectionAnalysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
    repeatedPhraseMatches: phraseMatchesWithTimes,
    analyzedDurationSeconds,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    musicalKey: analysis.musicalKey,
    keyConfidence: analysis.keyConfidence,
    excerpt: {
      startSeconds: excerptStartSeconds,
      durationSeconds: evaluatedDurationSeconds,
      beatGridMs: beatGridMs
        ?.filter((beatMs) => beatMs >= startMs && beatMs <= endMs)
        .map((beatMs) => beatMs - startMs) ?? null,
    },
    rawBeatGridConfidence: analysis.beatConfidence,
    beatConfidence: combinedBeatConfidence,
    sections,
  });
}
await writeFile(resolve(outputPath), `${JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  tracks,
}, null, 2)}\n`);
