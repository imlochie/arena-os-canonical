import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, sourceAnalyses, sourceAssets } from "@waveyard/database";
import {
  consumeTestFault,
  enqueueSourceAnalysis,
  recordTestFaultEvent,
} from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import type { SourceAnalysisJobPayload } from "@waveyard/types";

export const SOURCE_ANALYSIS_ENGINE = "waveyard-numpy-dsp";
export const SOURCE_ANALYSIS_ENGINE_VERSION = "1.0.0";
const CANONICAL_PITCHES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;
const ENHARMONIC_PITCHES: Record<string, (typeof CANONICAL_PITCHES)[number]> = {
  C: "C",
  "B#": "C",
  "C#": "C#",
  Db: "C#",
  D: "D",
  "D#": "D#",
  Eb: "D#",
  E: "E",
  Fb: "E",
  "E#": "F",
  F: "F",
  "F#": "F#",
  Gb: "F#",
  G: "G",
  "G#": "G#",
  Ab: "G#",
  A: "A",
  "A#": "A#",
  Bb: "A#",
  B: "B",
  Cb: "B",
};

export type AnalysisEngineResult = {
  analysisEngine: string;
  analysisEngineVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGridMs: number[] | null;
  beatConfidence: number | null;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Keep BPM in the documented persisted range without inventing a fallback. */
export function normaliseBpm(value: unknown): number | null {
  if (!finiteNumber(value) || value < 40 || value > 300) return null;
  return Math.round(value * 1000) / 1000;
}

export function normaliseConfidence(value: unknown): number | null {
  if (!finiteNumber(value) || value < 0 || value > 1) return null;
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Confidence evidence used by the NumPy autocorrelation tracker. */
export function bpmConfidenceFromEvidence(
  strongestScore: number,
  runnerUpScore: number,
  beatRegularity: number,
): number {
  const separation = Math.max(
    0,
    Math.min(
      1,
      (strongestScore - runnerUpScore) /
        Math.max(Math.abs(strongestScore), Number.EPSILON),
    ),
  );
  return normaliseConfidence(
    0.65 * separation + 0.35 * Math.max(0, Math.min(1, beatRegularity)),
  )!;
}

/** Krumhansl profile confidence is the winning-vs-runner-up separation only. */
export function keyConfidenceFromProfiles(
  strongestScore: number,
  runnerUpScore: number,
): number {
  return normaliseConfidence(
    Math.max(
      0,
      Math.min(
        1,
        (strongestScore - runnerUpScore) /
          Math.max(Math.abs(strongestScore), Number.EPSILON),
      ),
    ),
  )!;
}

/** 55% BPM confidence plus 45% regularity of ordered source beat timing. */
export function beatConfidenceFromGrid(
  bpmConfidence: number,
  beatGridMs: number[],
): number {
  if (beatGridMs.length < 3) return 0;
  const intervals = beatGridMs.slice(1).map((value, index) => value - beatGridMs[index]);
  const mean = intervals.reduce((total, value) => total + value, 0) / intervals.length;
  if (mean <= 0) return 0;
  const variance = intervals.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  ) / intervals.length;
  const regularity = Math.max(0, Math.min(1, 1 - 4 * Math.sqrt(variance) / mean));
  return normaliseConfidence(
    0.55 * Math.max(0, Math.min(1, bpmConfidence)) + 0.45 * regularity,
  )!;
}

export function normaliseMusicalKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([A-G](?:#|b)?)[\s_-]+(major|minor)\s*$/i.exec(value);
  if (!match) return null;
  const pitch = ENHARMONIC_PITCHES[
    `${match[1][0].toUpperCase()}${match[1].slice(1)}`
  ];
  const mode = match[2].toLowerCase();
  return pitch && (mode === "major" || mode === "minor")
    ? `${pitch} ${mode}`
    : null;
}

/** Beat positions are canonical source milliseconds and must be strictly ordered. */
export function normaliseBeatGrid(
  value: unknown,
  durationSeconds: number,
): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 100_000)
    return null;
  const maximum = Math.max(1, Math.round(durationSeconds * 1000));
  const grid = value.map((position) =>
    finiteNumber(position) ? Math.round(position) : Number.NaN,
  );
  if (
    grid.some(
      (position, index) =>
        !Number.isInteger(position) ||
        position < 0 ||
        position > maximum ||
        (index > 0 && position <= grid[index - 1]),
    )
  )
    return null;
  return grid;
}

/**
 * The Python engine returns only computed evidence. Invalid or unavailable
 * evidence remains null; Waveyard never supplies a default musical value.
 */
export function normaliseAnalysisResult(
  value: unknown,
  durationSeconds: number,
): AnalysisEngineResult {
  if (!value || typeof value !== "object")
    throw new Error("Analysis engine returned no result document.");
  const result = value as Record<string, unknown>;
  if (
    result.analysisEngine !== SOURCE_ANALYSIS_ENGINE ||
    result.analysisEngineVersion !== SOURCE_ANALYSIS_ENGINE_VERSION
  )
    throw new Error("Analysis engine provenance does not match the queued job.");

  const bpm = result.bpm == null ? null : normaliseBpm(result.bpm);
  if (result.bpm != null && bpm === null)
    throw new Error("Analysis engine returned an invalid BPM.");
  const bpmConfidence = result.bpmConfidence == null
    ? null
    : normaliseConfidence(result.bpmConfidence);
  if (result.bpmConfidence != null && bpmConfidence === null)
    throw new Error("Analysis engine returned an invalid BPM confidence.");
  if (!bpm && bpmConfidence !== null)
    throw new Error("BPM confidence cannot exist without a BPM result.");

  const musicalKey = result.musicalKey == null
    ? null
    : normaliseMusicalKey(result.musicalKey);
  if (result.musicalKey != null && musicalKey === null)
    throw new Error("Analysis engine returned an invalid musical key.");
  const keyConfidence = result.keyConfidence == null
    ? null
    : normaliseConfidence(result.keyConfidence);
  if (result.keyConfidence != null && keyConfidence === null)
    throw new Error("Analysis engine returned an invalid key confidence.");
  if (!musicalKey && keyConfidence !== null)
    throw new Error("Key confidence cannot exist without a key result.");

  const beatGridMs = result.beatGridMs == null
    ? null
    : normaliseBeatGrid(result.beatGridMs, durationSeconds);
  if (result.beatGridMs != null && beatGridMs === null)
    throw new Error("Analysis engine returned an invalid beat grid.");
  const beatConfidence = result.beatConfidence == null
    ? null
    : normaliseConfidence(result.beatConfidence);
  if (result.beatConfidence != null && beatConfidence === null)
    throw new Error("Analysis engine returned an invalid beat confidence.");
  if (!beatGridMs && beatConfidence !== null)
    throw new Error("Beat confidence cannot exist without a beat grid.");

  return {
    analysisEngine: SOURCE_ANALYSIS_ENGINE,
    analysisEngineVersion: SOURCE_ANALYSIS_ENGINE_VERSION,
    bpm,
    bpmConfidence,
    musicalKey,
    keyConfidence,
    beatGridMs,
    beatConfidence,
  };
}

export function analysisIdempotencyKey(sourceAssetId: string) {
  return `analysis:${sourceAssetId}:${SOURCE_ANALYSIS_ENGINE}:${SOURCE_ANALYSIS_ENGINE_VERSION}`;
}

export function analysisQueuePayload(job: {
  id: string;
  projectId: string;
  sourceAssetId: string;
  analysisEngine: string;
  analysisEngineVersion: string;
}): SourceAnalysisJobPayload {
  return {
    sourceAnalysisId: job.id,
    projectId: job.projectId,
    sourceAssetId: job.sourceAssetId,
    analysisEngine: job.analysisEngine,
    analysisEngineVersion: job.analysisEngineVersion,
  };
}

async function updateJob(
  id: string,
  patch: Partial<typeof sourceAnalyses.$inferInsert>,
) {
  await getDb()
    .update(sourceAnalyses)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sourceAnalyses.id, id));
}

function runAnalysisEngine(inputPath: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root =
      process.env.WAVEYARD_ROOT ??
      (existsSync(resolve(current, "services/analysis/analyze.py"))
        ? current
        : resolve(current, "../.."));
    const script = resolve(root, "services/analysis/analyze.py");
    const child = spawn(python, [script, "--input", inputPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `Musical analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`,
          ),
        );
    });
  });
}

/** Worker-owned local musical analysis; source audio remains immutable. */
export async function processSourceAnalysis(
  payload: SourceAnalysisJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(sourceAnalyses)
    .where(eq(sourceAnalyses.id, payload.sourceAnalysisId))
    .limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const invalidPayload =
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== payload.sourceAssetId ||
    job.analysisEngine !== payload.analysisEngine ||
    job.analysisEngineVersion !== payload.analysisEngineVersion;
  if (invalidPayload) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      analysisError:
        "Analysis queue payload does not match its durable source target.",
      completedAt: new Date(),
    });
    throw new Error("Analysis payload does not match its durable source target.");
  }

  const [source] = await db
    .select()
    .from(sourceAssets)
    .where(
      and(
        eq(sourceAssets.id, payload.sourceAssetId),
        eq(sourceAssets.projectId, payload.projectId),
      ),
    )
    .limit(1);
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: source ? "source_changed" : "source_missing",
      analysisError: source
        ? "Source checksum no longer matches analysis provenance."
        : "Authorized source asset is missing.",
      completedAt: new Date(),
    });
    throw new Error("Authorized source asset is unavailable for analysis.");
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-analysis-"));
  const inputPath = join(temporaryDirectory, "source-input");
  try {
    await updateJob(job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      attempts: (job.attempts ?? 0) + 1,
      analysisError: null,
      errorCode: null,
      completedAt: null,
    });
    await reportStage("preparing");
    await getStorage().getToFile(source.storageKey, inputPath);
    if (await consumeTestFault("analysis-engine")) {
      await recordTestFaultEvent({
        fault: "analysis-engine",
        event: "injected",
        at: new Date().toISOString(),
      });
      throw new Error("Injected musical-analysis engine failure.");
    }

    await updateJob(job.id, { status: "processing", stage: "analyzing" });
    await reportStage("analyzing");
    const { stdout } = await runAnalysisEngine(inputPath, temporaryDirectory);
    const raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as unknown;
    const result = normaliseAnalysisResult(raw, source.durationSeconds);
    const analyzedAt = new Date();

    await updateJob(job.id, {
      status: "complete",
      stage: "complete",
      analysisEngine: result.analysisEngine,
      analysisEngineVersion: result.analysisEngineVersion,
      bpm: result.bpm,
      bpmConfidence: result.bpmConfidence,
      musicalKey: result.musicalKey,
      keyConfidence: result.keyConfidence,
      beatGrid: result.beatGridMs ? JSON.stringify(result.beatGridMs) : null,
      beatConfidence: result.beatConfidence,
      analysisError: null,
      errorCode: null,
      analyzedAt,
      completedAt: analyzedAt,
    });
    await reportStage("complete");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 1800)
        : "Unknown musical analysis failure.";
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "analysis_failed",
      analysisError: message,
      bpm: null,
      bpmConfidence: null,
      musicalKey: null,
      keyConfidence: null,
      beatGrid: null,
      beatConfidence: null,
      analyzedAt: null,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Enqueues a durable existing row. Used by retry boundaries as well as tests. */
export async function enqueueAnalysisRow(
  job: typeof sourceAnalyses.$inferSelect,
) {
  return enqueueSourceAnalysis(analysisQueuePayload(job));
}
