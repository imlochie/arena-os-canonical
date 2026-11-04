import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  analysePcm,
  decodeMonoPcm,
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
} from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";

const args = process.argv.slice(2).filter((value) => value !== "--");
const [outputPath, excerptStartText, excerptDurationText, ...sourcePaths] = args;
const excerptStartSeconds = Number(excerptStartText ?? "15");
const excerptDurationSeconds = Number(excerptDurationText ?? "12");
if (!outputPath || sourcePaths.length < 2
  || !Number.isFinite(excerptStartSeconds) || excerptStartSeconds < 0
  || !Number.isFinite(excerptDurationSeconds) || excerptDurationSeconds < 2) {
  throw new Error(
    "Usage: tsx scripts/waveyard-mashup-analysis.ts -- <output.json> <excerpt-start-seconds> <excerpt-duration-seconds> <two or more audio paths>",
  );
}

const tracks = [];
for (const sourcePath of sourcePaths) {
  const absolutePath = resolve(sourcePath);
  const pcm = await decodeMonoPcm(absolutePath, Math.max(60, excerptStartSeconds + excerptDurationSeconds + 15));
  const analysis = analysePcm(pcm);
  const startMs = Math.round(excerptStartSeconds * 1000);
  const endMs = startMs + Math.round(excerptDurationSeconds * 1000);
  tracks.push({
    filename: basename(absolutePath),
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    analyzedDurationSeconds: Math.round((pcm.length / 22_050) * 100) / 100,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    musicalKey: analysis.musicalKey,
    keyConfidence: analysis.keyConfidence,
    excerpt: {
      startSeconds: excerptStartSeconds,
      durationSeconds: excerptDurationSeconds,
      beatGridMs: analysis.beatGridMs
        ?.filter((beatMs) => beatMs >= startMs && beatMs <= endMs)
        .map((beatMs) => beatMs - startMs) ?? null,
    },
    beatConfidence: analysis.beatConfidence,
  });
}
await writeFile(resolve(outputPath), `${JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  tracks,
}, null, 2)}\n`);
