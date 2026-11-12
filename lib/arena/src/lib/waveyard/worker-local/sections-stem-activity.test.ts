import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import {
  processingJobs,
  projects,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  vocalAnalyses,
  vocalActivityIntervals,
  vocalPhrases,
} from "@workspace/db/waveyardSchema";
import type { StorageProvider } from "@workspace/arena/lib/waveyard/storage";
import type { SourceSectionAnalysisJobPayload } from "@workspace/arena/lib/waveyard/types";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "../types/analysis-provenance";
import { parsePassageFingerprint } from "../types/passage-compatibility";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  vocalAnalysisIdempotencyKey,
} from "../types/vocal-analysis";
import { ANALYSIS_PCM_RATE } from "./analysis-engine";
import { handleSectionAnalysisJob } from "./sections";
import { provisionDesktopSectionAnalysis } from "./analysis";
import { applyDesktopMigrationsToPGlite } from "./pglite-migrations.test-helper";

const sourceChecksum = "a".repeat(64);
const stemChecksum = "b".repeat(64);
const beatGrid = Array.from({ length: 65 }, (_, index) => index * 500);

function signal(amplitudeAtBar: (bar: number) => number) {
  const pcm = new Float32Array(ANALYSIS_PCM_RATE * 32);
  for (let sample = 0; sample < pcm.length; sample += 1) {
    const bar = Math.floor(sample / (ANALYSIS_PCM_RATE * 2));
    pcm[sample] = amplitudeAtBar(bar) * Math.sin((2 * Math.PI * 110 * sample) / ANALYSIS_PCM_RATE);
  }
  return pcm;
}

async function createFixture(currentSourceProvenance: boolean) {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
  const database = drizzle(client);
  const [project] = await database.insert(projects).values({
    ownerId: randomUUID(),
    title: "Per-stem structure",
  }).returning();
  const [source] = await database.insert(sourceAssets).values({
    projectId: project.id,
    originalFilename: "source.wav",
    mimeType: "audio/wav",
    storageKey: "source-key",
    checksumSha256: sourceChecksum,
    durationSeconds: 32,
    sampleRate: 44_100,
    channels: 2,
    codec: "pcm_s16le",
    fileSizeBytes: ANALYSIS_PCM_RATE * 32 * 2,
  }).returning();
  const [analysis] = await database.insert(sourceAnalyses).values({
    projectId: project.id,
    sourceAssetId: source.id,
    status: "complete",
    idempotencyKey: `analysis:${source.id}:${randomUUID()}`,
    analysisEngine: "arena-js-dsp",
    analysisEngineVersion: "1.4.0",
    sourceChecksumSha256: source.checksumSha256,
    beatGrid: JSON.stringify(beatGrid),
    beatConfidence: 0.9,
  }).returning();
  const [sectionAnalysis] = await database.insert(sourceSectionAnalyses).values({
    projectId: project.id,
    sourceAssetId: source.id,
    sourceAnalysisId: analysis.id,
    status: "queued",
    stage: "queued",
    idempotencyKey: `sections:${source.id}:${randomUUID()}`,
    analysisEngine: DESKTOP_SECTION_ENGINE,
    analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
  }).returning();
  const [separation] = await database.insert(processingJobs).values({
    projectId: project.id,
    sourceAssetId: source.id,
    type: "separation",
    status: "complete",
    stage: "complete",
    idempotencyKey: `separation:${source.id}:${randomUUID()}`,
    model: "test-separation",
    requestedDevice: "cpu",
    metadata: JSON.stringify({
      sourceChecksumSha256: currentSourceProvenance ? sourceChecksum : "c".repeat(64),
    }),
  }).returning();
  const [stem] = await database.insert(stemAssets).values({
    projectId: project.id,
    sourceAssetId: source.id,
    separationJobId: separation.id,
    stemType: "bass",
    engine: "test",
    model: "test-separation",
    modelVersion: "test",
    storageKey: "stem-key",
    checksumSha256: stemChecksum,
    durationSeconds: 32,
    sampleRate: 44_100,
    channels: 2,
    codec: "pcm_s16le",
    format: "wav",
    fileSizeBytes: ANALYSIS_PCM_RATE * 32 * 2,
  }).returning();
  const payload: SourceSectionAnalysisJobPayload = {
    sourceSectionAnalysisId: sectionAnalysis.id,
    projectId: project.id,
    sourceAssetId: source.id,
    sourceAnalysisId: analysis.id,
    analysisEngine: DESKTOP_SECTION_ENGINE,
    analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
  };

  return { client, database, source, stem, analysis, sectionAnalysis, payload };
}

function fixtureStorage(invalidKey?: string): StorageProvider {
  return {
    kind: "local",
    verifyObject: async (key) => {
      if (key === invalidKey) throw new Error("fixture object checksum mismatch");
    },
    getLocalPath: () => null,
    getToFile: async (key, path) => writeFile(path, key),
  } as unknown as StorageProvider;
}

async function runSectionAnalysis(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  storage = fixtureStorage(),
) {
  const sourcePcm = signal(() => 0.08);
  const changedStemPcm = signal((bar) => bar < 4 ? 0.02 : 0.16);
  const vocalPcm = signal((bar) => bar % 2 === 0 ? 0.04 : 0.1);
  const decode = async (path: string) => {
    const key = await readFile(path, "utf8");
    return key === "stem-key" ? changedStemPcm : key === "voice-key" ? vocalPcm : sourcePcm;
  };
  await handleSectionAnalysisJob(fixture.payload as unknown as Record<string, unknown>, {
    db: fixture.database as unknown as NonNullable<Parameters<typeof handleSectionAnalysisJob>[1]>["db"],
    storage,
    decode,
  });
}

test("persisted section job uses only source-matched completed stems and records their boundary evidence", async () => {
  const fixture = await createFixture(true);
  try {
    await runSectionAnalysis(fixture);
    const sections = await fixture.database.select().from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, fixture.source.id))
      .orderBy(sourceSections.sectionIndex);
    const changedSection = sections.find((section) => section.startBeatIndex === 16);
    assert.equal(changedSection?.label, "stem-change");
    const fingerprint = parsePassageFingerprint(changedSection?.passageFingerprint, {
      sourceChecksumSha256: sourceChecksum,
      startBeatIndex: 16,
      endBeatIndex: changedSection?.endBeatIndex,
    });
    assert.equal(fingerprint?.stemActivity.status, "measured");
    if (fingerprint?.stemActivity.status === "measured") {
      assert.equal(fingerprint.stemActivity.value[0]?.stemAssetId, fixture.stem.id);
      assert.equal(fingerprint.stemActivity.value[0]?.separationJobId, fixture.stem.separationJobId);
      assert.ok((fingerprint.stemActivity.value[0]?.boundaryChanges[0]?.deltaDb ?? 0) >= 6);
      assert.equal(fingerprint.stemActivity.value[0]?.boundaryChanges[0]?.beatIndex, 16);
    }
  } finally {
    await fixture.client.close();
  }
});

test("persisted vocal pitch-continuity runs appear in the exact source passages they overlap", async () => {
  const fixture = await createFixture(true);
  try {
    const [vocalStem] = await fixture.database.insert(stemAssets).values({
      projectId: fixture.source.projectId,
      sourceAssetId: fixture.source.id,
      separationJobId: fixture.stem.separationJobId,
      stemType: "vocals",
      engine: "test",
      model: "test-separation",
      modelVersion: "test",
      storageKey: "voice-key",
      checksumSha256: "d".repeat(64),
      durationSeconds: 32,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: ANALYSIS_PCM_RATE * 32 * 2,
    }).returning();
    const [vocalAnalysis] = await fixture.database.insert(vocalAnalyses).values({
      projectId: fixture.source.projectId,
      sourceAssetId: fixture.source.id,
      stemAssetId: vocalStem.id,
      status: "complete",
      stage: "complete",
      idempotencyKey: vocalAnalysisIdempotencyKey(
        vocalStem.id,
        LOCAL_VOCAL_ANALYSIS_ENGINE,
        LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
      ),
      analysisEngine: LOCAL_VOCAL_ANALYSIS_ENGINE,
      analysisEngineVersion: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: fixture.source.checksumSha256,
      stemChecksumSha256: vocalStem.checksumSha256,
    }).returning();
    await fixture.database.insert(vocalPhrases).values([
      { vocalAnalysisId: vocalAnalysis.id, phraseIndex: 0, startMs: 9_000, endMs: 10_500, confidence: 0.87 },
      { vocalAnalysisId: vocalAnalysis.id, phraseIndex: 1, startMs: 10_800, endMs: 11_500, confidence: 0.74 },
    ]);
    await fixture.database.insert(vocalActivityIntervals).values([
      { vocalAnalysisId: vocalAnalysis.id, intervalIndex: 0, startMs: 8_500, endMs: 10_600, confidence: 0.83 },
      { vocalAnalysisId: vocalAnalysis.id, intervalIndex: 1, startMs: 10_900, endMs: 11_900, confidence: 0.79 },
    ]);

    await runSectionAnalysis(fixture);
    const sections = await fixture.database.select().from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, fixture.source.id))
      .orderBy(sourceSections.sectionIndex);
    const expectedRuns = [
      { startMs: 9_000, endMs: 10_500, confidence: 0.87 },
      { startMs: 10_800, endMs: 11_500, confidence: 0.74 },
    ];
    const expectedActivityIntervals = [
      { startMs: 8_500, endMs: 10_600, confidence: 0.83 },
      { startMs: 10_900, endMs: 11_900, confidence: 0.79 },
    ];
    let persistedRunCount = 0;
    for (const section of sections) {
      const fingerprint = parsePassageFingerprint(section.passageFingerprint, {
        sourceChecksumSha256: sourceChecksum,
        startBeatIndex: section.startBeatIndex,
        endBeatIndex: section.endBeatIndex,
      });
      assert.equal(fingerprint?.vocalActivity.status, "measured");
      if (fingerprint?.vocalActivity.status !== "measured") continue;
      assert.equal(fingerprint.vocalActivity.value.analysisId, vocalAnalysis.id);
      assert.equal(fingerprint.vocalActivity.value.stemAssetId, vocalStem.id);
      const expectedForSection = expectedRuns.filter((run) => run.endMs > section.startMs && run.startMs < section.endMs);
      const expectedActivityForSection = expectedActivityIntervals.filter((run) => run.endMs > section.startMs && run.startMs < section.endMs);
      assert.deepEqual(fingerprint.vocalActivity.value.pitchContinuityRuns, expectedForSection.map((run) => ({
        ...run,
        startMs: Math.max(section.startMs, run.startMs),
        endMs: Math.min(section.endMs, run.endMs),
      })));
      assert.deepEqual(fingerprint.vocalActivity.value.activityIntervals, expectedActivityForSection.map((run) => ({
        ...run,
        startMs: Math.max(section.startMs, run.startMs),
        endMs: Math.min(section.endMs, run.endMs),
      })));
      assert.ok(fingerprint.vocalActivity.value.activityCoverage >= 0);
      assert.ok(fingerprint.vocalActivity.value.pitchCoverage >= 0);
      persistedRunCount += fingerprint.vocalActivity.value.pitchContinuityRuns.length;
    }
    assert.ok(persistedRunCount >= expectedRuns.length, "each source-bound run is assigned to the passage or passages it overlaps");

    await fixture.database.update(vocalAnalyses).set({ stemChecksumSha256: "e".repeat(64) })
      .where(eq(vocalAnalyses.id, vocalAnalysis.id));
    await fixture.database.update(sourceSectionAnalyses).set({
      status: "queued",
      stage: "queued",
      completedAt: null,
    }).where(eq(sourceSectionAnalyses.id, fixture.sectionAnalysis.id));
    await runSectionAnalysis(fixture);
    const staleFingerprint = parsePassageFingerprint(
      (await fixture.database.select().from(sourceSections)
        .where(eq(sourceSections.sourceAssetId, fixture.source.id))
        .orderBy(sourceSections.sectionIndex))[0]?.passageFingerprint,
      { sourceChecksumSha256: sourceChecksum },
    );
    assert.equal(staleFingerprint?.vocalActivity.status, "unavailable", "changed stem provenance cannot survive into a new section pass");
  } finally {
    await fixture.client.close();
  }
});

test("stems from a separation of different source bytes stay out of structural evidence", async () => {
  const fixture = await createFixture(false);
  try {
    await runSectionAnalysis(fixture);
    const sections = await fixture.database.select().from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, fixture.source.id));
    assert.ok(sections.length > 0);
    assert.ok(sections.every((section) => section.label !== "stem-change"));
    const fingerprint = parsePassageFingerprint(sections[0]?.passageFingerprint, {
      sourceChecksumSha256: sourceChecksum,
      startBeatIndex: sections[0]!.startBeatIndex,
      endBeatIndex: sections[0]!.endBeatIndex,
    });
    assert.equal(fingerprint?.stemActivity.status, "unavailable");
  } finally {
    await fixture.client.close();
  }
});

test("a corrupt optional stem is skipped while source-only sections still complete", async () => {
  const fixture = await createFixture(true);
  try {
    await runSectionAnalysis(fixture, fixtureStorage("stem-key"));
    const sections = await fixture.database.select().from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, fixture.source.id));
    assert.ok(sections.length > 0);
    assert.ok(sections.every((section) => section.label !== "stem-change"));
    const fingerprint = parsePassageFingerprint(sections[0]?.passageFingerprint, {
      sourceChecksumSha256: sourceChecksum,
      startBeatIndex: sections[0]!.startBeatIndex,
      endBeatIndex: sections[0]!.endBeatIndex,
    });
    assert.equal(fingerprint?.stemActivity.status, "unavailable");
  } finally {
    await fixture.client.close();
  }
});

test("completed separation redispatches structural analysis with a distinct queue identity", async () => {
  const fixture = await createFixture(true);
  try {
    await fixture.database.update(sourceSectionAnalyses).set({ status: "complete", stage: "complete" })
      .where(eq(sourceSectionAnalyses.id, fixture.sectionAnalysis.id));
    await fixture.database.insert(sourceSections).values({
      id: "old-source-only-section",
      projectId: fixture.source.projectId,
      sourceAssetId: fixture.source.id,
      sourceAnalysisId: fixture.analysis.id,
      sourceSectionAnalysisId: fixture.sectionAnalysis.id,
      sectionIndex: 0,
      startMs: 0,
      endMs: 8_000,
      startBeatIndex: 0,
      endBeatIndex: 16,
      startBar: 1,
      endBar: 4,
      label: "section",
      labelConfidence: 0,
      structuralConfidence: 0.5,
      analysisEngine: DESKTOP_SECTION_ENGINE,
      analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
      sourceChecksumSha256: sourceChecksum,
    });
    const dispatches: SourceSectionAnalysisJobPayload[] = [];
    await provisionDesktopSectionAnalysis(fixture.analysis, fixture.source, {
      database: fixture.database as unknown as NonNullable<Parameters<typeof handleSectionAnalysisJob>[1]>["db"],
      dispatchKey: "a".repeat(24),
      enqueue: async (payload) => { dispatches.push(payload); },
    });
    const [refreshed] = await fixture.database.select().from(sourceSectionAnalyses)
      .where(eq(sourceSectionAnalyses.id, fixture.sectionAnalysis.id));
    const remainingSections = await fixture.database.select().from(sourceSections)
      .where(eq(sourceSections.sourceAssetId, fixture.source.id));
    assert.equal(refreshed.status, "queued");
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0]?.dispatchKey, "a".repeat(24));
    assert.equal(remainingSections.length, 0);
  } finally {
    await fixture.client.close();
  }
});
