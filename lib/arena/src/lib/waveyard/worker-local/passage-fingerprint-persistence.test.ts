import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { projects, sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections } from "@workspace/db/waveyardSchema";
import { applyDesktopMigrationsToPGlite } from "./pglite-migrations.test-helper";
import {
  PASSAGE_FINGERPRINT_ENGINE,
  PASSAGE_FINGERPRINT_ENGINE_VERSION,
  parsePassageFingerprint,
  type PassageFingerprint,
} from "../types/passage-compatibility";

const fingerprint: PassageFingerprint = {
  schemaVersion: 1,
  engine: PASSAGE_FINGERPRINT_ENGINE,
  engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
  sourceChecksumSha256: "a".repeat(64),
  startBeatIndex: 0,
  endBeatIndex: 16,
  rhythm: { status: "measured", value: Array.from({ length: 64 }, (_, index) => index % 4 === 0 ? 1 : 0), method: "four subdivisions", confidence: 0.8 },
  chroma: { status: "measured", value: Array.from({ length: 48 }, (_, index) => index % 12 === 0 ? 1 : -1 / 11), method: "four chroma windows", confidence: 0.8 },
  beatPhase: { status: "measured", value: { subdivisionProfile: [1, 0, 0, 0], beatPeriodMs: 500 }, method: "subdivision onset energy", confidence: 0.8 },
  energy: { status: "measured", value: { rmsDb: -14 }, method: "source RMS", confidence: null },
  downbeatConfidence: { status: "unavailable", reason: "No independent downbeat analysis." },
  vocalActivity: { status: "unavailable", reason: "No isolated-vocal analysis." },
  instrumentalDensity: { status: "unavailable", reason: "No non-vocal stem activity envelope." },
};

test("desktop migration persists and reloads source-section passage fingerprints", async () => {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  try {
    await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
    const db = drizzle(client);
    const [project] = await db.insert(projects).values({ ownerId: randomUUID(), title: "Passage fingerprint persistence" }).returning();
    const [source] = await db.insert(sourceAssets).values({
      projectId: project.id,
      originalFilename: "fingerprint.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/fingerprint.wav`,
      checksumSha256: fingerprint.sourceChecksumSha256,
      durationSeconds: 8,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 705_600,
    }).returning();
    const [analysis] = await db.insert(sourceAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      status: "complete",
      idempotencyKey: `analysis:${source.id}:${randomUUID()}`,
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: source.checksumSha256,
      beatGrid: JSON.stringify(Array.from({ length: 17 }, (_, index) => index * 500)),
      beatConfidence: 0.8,
    }).returning();
    const [sectionAnalysis] = await db.insert(sourceSectionAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      sourceAnalysisId: analysis.id,
      status: "complete",
      idempotencyKey: `sections:${source.id}:${randomUUID()}`,
      analysisEngine: "arena-js-structure",
      analysisEngineVersion: "1.5.0",
      sourceChecksumSha256: source.checksumSha256,
    }).returning();
    await db.insert(sourceSections).values({
      id: "section-passage-fingerprint",
      projectId: project.id,
      sourceAssetId: source.id,
      sourceAnalysisId: analysis.id,
      sourceSectionAnalysisId: sectionAnalysis.id,
      sectionIndex: 0,
      startMs: 0,
      endMs: 8_000,
      startBeatIndex: 0,
      endBeatIndex: 16,
      startBar: 1,
      endBar: 4,
      label: "section",
      structuralConfidence: 0.8,
      analysisEngine: "arena-js-structure",
      analysisEngineVersion: "1.5.0",
      sourceChecksumSha256: source.checksumSha256,
      passageFingerprint: fingerprint,
    });
    const [reloaded] = await db.select().from(sourceSections).where(eq(sourceSections.id, "section-passage-fingerprint"));
    assert.deepEqual(parsePassageFingerprint(reloaded.passageFingerprint, {
      sourceChecksumSha256: source.checksumSha256,
      startBeatIndex: reloaded.startBeatIndex,
      endBeatIndex: reloaded.endBeatIndex,
    }), fingerprint);
  } finally {
    await client.close();
  }
});
