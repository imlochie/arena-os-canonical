import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import {
  projects,
  sourceAssets,
  sourceAnalyses,
  sourceSectionAnalyses,
  sourceSections,
  processingJobs,
  stemAssets,
  remixSessions,
  remixTracks,
  remixClips,
  remixVersions,
} from "@workspace/db/waveyardSchema";
import { applyDesktopMigrationsToPGlite } from "../worker-local/pglite-migrations.test-helper";
import { planMashup, renderMashup, type MashupSourceProfile } from "./mashup";
import { loadSourceProfile } from "./mashup-sources";
import { trustedAnalysisBeatGrid } from "../types/analysis-confidence";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "../types/analysis-provenance";
import { PASSAGE_FINGERPRINT_ENGINE, PASSAGE_FINGERPRINT_ENGINE_VERSION, unavailablePassageEvidence } from "../types/passage-compatibility";

function testPassageFingerprint(
  sourceChecksumSha256: string,
  startBeatIndex = 0,
  endBeatIndex = 16,
  kind: "compatible" | "different" = "compatible",
) {
  const compatible = kind === "compatible";
  const measured = <T>(value: T) => ({ status: "measured" as const, value, method: "database acceptance fixture", confidence: 0.95 });
  return {
    schemaVersion: 2 as const,
    engine: PASSAGE_FINGERPRINT_ENGINE,
    engineVersion: PASSAGE_FINGERPRINT_ENGINE_VERSION,
    sourceChecksumSha256,
    startBeatIndex,
    endBeatIndex,
    rhythm: measured(Array.from({ length: 32 }, (_, index) =>
      Number(index % 4 === (compatible ? 0 : 1)))),
    chroma: measured(Array.from({ length: 48 }, (_, index) => index % 12 === 0 ? 1 : 0.05)),
    beatPhase: measured({
      subdivisionProfile: compatible ? [0.9, 0.05, 0.03, 0.02] : [0.03, 0.9, 0.05, 0.02],
      beatPeriodMs: 500,
    }),
    energy: measured({ rmsDb: -12 }),
    downbeatConfidence: measured(0.95),
    vocalActivity: unavailablePassageEvidence("not available in this fixture"),
    instrumentalDensity: unavailablePassageEvidence("not available in this fixture"),
    stemActivity: unavailablePassageEvidence("not available in this fixture"),
  };
}

test("Genuine database round-trip acceptance: plan -> save remix -> query tracks/clips -> edit -> update version", async () => {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  try {
    await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
    const db = drizzle(client);

    const ownerId = randomUUID();
    const [project] = await db.insert(projects).values({
      ownerId,
      title: "Mashup Round-Trip Acceptance",
    }).returning();

    // Insert source assets
    const [vocalSource] = await db.insert(sourceAssets).values({
      projectId: project.id,
      originalFilename: "vocals-master.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/vocals-master.wav`,
      checksumSha256: "1".repeat(64),
      durationSeconds: 30,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 30 * 44100 * 4,
    }).returning();

    const [bedSource] = await db.insert(sourceAssets).values({
      projectId: project.id,
      originalFilename: "bed-master.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/bed-master.wav`,
      checksumSha256: "2".repeat(64),
      durationSeconds: 60,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 60 * 44100 * 4,
    }).returning();

    // Insert separation jobs
    const [vocalJob] = await db.insert(processingJobs).values({
      projectId: project.id,
      sourceAssetId: vocalSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      idempotencyKey: `vocal-job-${randomUUID()}`,
      model: "demucs",
      requestedDevice: "cpu",
      completedAt: new Date(),
    }).returning();

    const [bedJob] = await db.insert(processingJobs).values({
      projectId: project.id,
      sourceAssetId: bedSource.id,
      type: "separation",
      status: "complete",
      stage: "complete",
      idempotencyKey: `bed-job-${randomUUID()}`,
      model: "demucs",
      requestedDevice: "cpu",
      completedAt: new Date(),
    }).returning();

    // Insert stems
    const [vocalStem] = await db.insert(stemAssets).values({
      projectId: project.id,
      sourceAssetId: vocalSource.id,
      separationJobId: vocalJob.id,
      stemType: "vocals",
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "v4",
      storageKey: `projects/${project.id}/vocals-stem.wav`,
      checksumSha256: "3".repeat(64),
      durationSeconds: 30,
      sampleRate: 44_100,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 30 * 44100 * 4,
    }).returning();

    const [drumsStem] = await db.insert(stemAssets).values({
      projectId: project.id,
      sourceAssetId: bedSource.id,
      separationJobId: bedJob.id,
      stemType: "drums",
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "v4",
      storageKey: `projects/${project.id}/bed-drums.wav`,
      checksumSha256: "4".repeat(64),
      durationSeconds: 60,
      sampleRate: 44_100,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 60 * 44100 * 4,
    }).returning();

    const [bassStem] = await db.insert(stemAssets).values({
      projectId: project.id,
      sourceAssetId: bedSource.id,
      separationJobId: bedJob.id,
      stemType: "bass",
      engine: "demucs",
      model: "htdemucs",
      modelVersion: "v4",
      storageKey: `projects/${project.id}/bed-bass.wav`,
      checksumSha256: "5".repeat(64),
      durationSeconds: 60,
      sampleRate: 44_100,
      channels: 2,
      codec: "wav",
      format: "wav",
      fileSizeBytes: 60 * 44100 * 4,
    }).returning();

    // Mashup source profiles
    const vocalProfile: MashupSourceProfile = {
      role: "vocals",
      sourceAssetId: vocalSource.id,
      sourceChecksumSha256: vocalSource.checksumSha256,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "A minor",
      keyConfidence: 0.9,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 61 }, (_, index) => index * 500),
      durationMs: 30_000,
      sections: [
        {
          id: "donor-verse",
          label: "section",
          startMs: 0,
          endMs: 8_000,
          startBeatIndex: 0,
          endBeatIndex: 16,
          passageFingerprint: testPassageFingerprint(vocalSource.checksumSha256, 0, 16, "different"),
        },
        {
          id: "donor-chorus",
          label: "section",
          startMs: 16_000,
          endMs: 24_000,
          startBeatIndex: 32,
          endBeatIndex: 48,
          passageFingerprint: testPassageFingerprint(vocalSource.checksumSha256, 32, 48),
        },
      ],
      vocalPhrases: [
        { startMs: 1_000, endMs: 2_000, confidence: 0.95 },
        { startMs: 17_000, endMs: 18_000, confidence: 0.95 },
      ],
    };

    const bedProfile: MashupSourceProfile = {
      role: "instrumental",
      sourceAssetId: bedSource.id,
      sourceChecksumSha256: bedSource.checksumSha256,
      bpm: 120,
      bpmConfidence: 0.95,
      musicalKey: "C major",
      keyConfidence: 0.9,
      beatConfidence: 0.95,
      beatGridMs: Array.from({ length: 121 }, (_, index) => index * 500),
      durationMs: 60_000,
      sections: [
        { label: "intro", startMs: 0, endMs: 8_000 },
        {
          id: "bed-verse",
          label: "verse",
          startMs: 8_000,
          endMs: 16_000,
          startBeatIndex: 16,
          endBeatIndex: 32,
          passageFingerprint: testPassageFingerprint(bedSource.checksumSha256, 16, 32),
        },
        { label: "breakdown", startMs: 16_000, endMs: 40_000 },
        {
          id: "bed-chorus",
          label: "chorus",
          startMs: 40_000,
          endMs: 48_000,
          startBeatIndex: 80,
          endBeatIndex: 96,
          passageFingerprint: testPassageFingerprint(bedSource.checksumSha256, 80, 96),
        },
      ],
    };

    const planned = planMashup(vocalProfile, bedProfile);
    assert.ok(planned.ok);
    const plan = planned.plan;
    assert.equal(plan.passageSearch?.selectedDonorSectionId, "donor-chorus");
    assert.equal(plan.passageSearch?.selectedBedSectionId, "bed-chorus");
    assert.ok(Math.abs(plan.segments[0]!.mashupStartMs - 24_750) <= 1);

    // Execute save transaction (same pattern as POST /mashup route action: "save")
    const saveResult = await db.transaction(async (tx) => {
      const [remix] = await tx.insert(remixSessions).values({
        projectId: project.id,
        ownerId,
        name: `Mashup: ${vocalSource.originalFilename} × ${bedSource.originalFilename}`,
        masterVolume: 1,
        loopStartMs: 0,
        loopEndMs: null,
        tempoBpm: plan.masterBpm,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        gridDivision: "beat",
        snapEnabled: true,
        targetKey: bedProfile.musicalKey,
      }).returning();

      const tracksToInsert = [
        { remixSessionId: remix.id, stemAssetId: vocalStem.id, name: "Lead Vocals", sortOrder: 0, volume: 1, pan: 0 },
        { remixSessionId: remix.id, stemAssetId: drumsStem.id, name: "Drums", sortOrder: 1, volume: 0.8, pan: 0 },
        { remixSessionId: remix.id, stemAssetId: bassStem.id, name: "Bass", sortOrder: 2, volume: 0.8, pan: 0 },
      ];

      const insertedTracks = await tx.insert(remixTracks).values(tracksToInsert).returning();
      const trackByStemId = new Map(insertedTracks.map((t) => [t.stemAssetId, t]));

      const clipsToInsert: Array<{
        remixTrackId: string;
        stemAssetId: string;
        timelineStartMs: number;
        durationMs: number;
        sourceOffsetMs: number;
        gain: number;
        fadeInMs: number;
        fadeOutMs: number;
        tempoSyncEnabled: boolean;
        keySyncEnabled: boolean;
        beatSnapEnabled: boolean;
      }> = [];

      // Vocal clips from planned segments
      const vocalTrack = trackByStemId.get(vocalStem.id)!;
      for (const seg of plan.segments) {
        clipsToInsert.push({
          remixTrackId: vocalTrack.id,
          stemAssetId: vocalStem.id,
          timelineStartMs: seg.mashupStartMs,
          durationMs: seg.mashupEndMs - seg.mashupStartMs,
          sourceOffsetMs: seg.vocalsFromMs,
          gain: 0.85,
          fadeInMs: seg.crossfadeMs,
          fadeOutMs: seg.crossfadeMs,
          tempoSyncEnabled: true,
          keySyncEnabled: true,
          beatSnapEnabled: true,
        });
      }

      // Bed clips spanning full duration
      for (const stem of [drumsStem, bassStem]) {
        const track = trackByStemId.get(stem.id)!;
        clipsToInsert.push({
          remixTrackId: track.id,
          stemAssetId: stem.id,
          timelineStartMs: 0,
          durationMs: plan.durationMs,
          sourceOffsetMs: 0,
          gain: 0.8,
          fadeInMs: 50,
          fadeOutMs: 150,
          tempoSyncEnabled: false,
          keySyncEnabled: false,
          beatSnapEnabled: true,
        });
      }

      const insertedClips = await tx.insert(remixClips).values(clipsToInsert).returning();

      const snapshot = {
        name: remix.name,
        masterVolume: remix.masterVolume,
        tempoBpm: remix.tempoBpm,
        mashupPlan: {
          engine: plan.engine,
          masterBpm: plan.masterBpm,
          vocalsStretchRatio: plan.vocalsStretchRatio,
          vocalsPitchSemitones: plan.vocalsPitchSemitones,
          keyRelationship: plan.keyRelationship,
          durationMs: plan.durationMs,
          segments: plan.segments,
          passageSearch: plan.passageSearch,
          rationale: plan.rationale,
          warnings: plan.warnings,
        },
        tracks: insertedTracks.map((track) => ({
          ...track,
          clips: insertedClips.filter((c) => c.remixTrackId === track.id),
        })),
      };

      const [version] = await tx.insert(remixVersions).values({
        remixSessionId: remix.id,
        createdById: ownerId,
        name: "Initial mashup arrangement",
        snapshot: JSON.stringify(snapshot),
      }).returning();

      return { remix, version, tracks: insertedTracks, clips: insertedClips };
    });

    assert.ok(saveResult.remix.id);
    assert.equal(saveResult.tracks.length, 3);
    assert.ok(saveResult.clips.length >= 3);
    const initialSnapshot = JSON.parse(saveResult.version.snapshot) as {
      mashupPlan?: { passageSearch?: { selectedDonorSectionId?: string | null; selectedBedSectionId?: string | null } };
    };
    assert.equal(initialSnapshot.mashupPlan?.passageSearch?.selectedDonorSectionId, "donor-chorus",
      "the version snapshot retains why and where the whole-track planner selected its later section");
    assert.equal(initialSnapshot.mashupPlan?.passageSearch?.selectedBedSectionId, "bed-chorus");

    // Reopen from database: query remixSessions, remixTracks, and remixClips
    const [reloadedSession] = await db
      .select()
      .from(remixSessions)
      .where(eq(remixSessions.id, saveResult.remix.id));
    assert.ok(reloadedSession);
    assert.equal(reloadedSession.tempoBpm, 120);
    assert.equal(reloadedSession.targetKey, "C major");
    assert.equal(reloadedSession.version, 1);

    const reloadedTracks = await db
      .select()
      .from(remixTracks)
      .where(eq(remixTracks.remixSessionId, reloadedSession.id));
    assert.equal(reloadedTracks.length, 3);

    const reloadedClips = await db
      .select()
      .from(remixClips)
      .where(inArray(remixClips.remixTrackId, reloadedTracks.map((t) => t.id)));
    assert.equal(reloadedClips.length, saveResult.clips.length);

    // Verify clips have matching timeline positions, source offsets, and sync flags
    for (const clip of reloadedClips) {
      assert.ok(Number.isFinite(clip.timelineStartMs));
      assert.ok(clip.durationMs > 0);
      assert.ok(clip.gain > 0 && clip.gain <= 1);
    }
    const reopenedVocalClip = reloadedClips.find((clip) => clip.stemAssetId === vocalStem.id)!;
    assert.equal(reopenedVocalClip.timelineStartMs, plan.segments[0]!.mashupStartMs,
      "the full-track passage selection must survive the database save/reopen round-trip");
    assert.equal(reopenedVocalClip.sourceOffsetMs, plan.segments[0]!.vocalsFromMs,
      "the earlier vocal material remains attached instead of being cut to the selected later passage");

    // Studio Editing & Re-saving: simulate user adjusting track volume & clip gain
    const trackToEdit = reloadedTracks[0];
    const clipToEdit = reloadedClips.find((c) => c.remixTrackId === trackToEdit.id)!;

    await db.transaction(async (tx) => {
      await tx
        .update(remixTracks)
        .set({ volume: 0.95, pan: 0.1, updatedAt: new Date() })
        .where(eq(remixTracks.id, trackToEdit.id));

      await tx
        .update(remixClips)
        .set({ gain: 0.9, updatedAt: new Date() })
        .where(eq(remixClips.id, clipToEdit.id));

      await tx
        .update(remixSessions)
        .set({ masterVolume: 0.92, version: reloadedSession.version + 1, updatedAt: new Date() })
        .where(eq(remixSessions.id, reloadedSession.id));
    });

    // Verify edit was saved and version incremented
    const [editedSession] = await db
      .select()
      .from(remixSessions)
      .where(eq(remixSessions.id, reloadedSession.id));
    assert.equal(editedSession.version, 2);
    assert.equal(editedSession.masterVolume, 0.92);

    const [editedTrack] = await db
      .select()
      .from(remixTracks)
      .where(eq(remixTracks.id, trackToEdit.id));
    assert.equal(editedTrack.volume, 0.95);
    assert.equal(editedTrack.pan, 0.1);

    const [editedClip] = await db
      .select()
      .from(remixClips)
      .where(eq(remixClips.id, clipToEdit.id));
    assert.equal(editedClip.gain, 0.9);
  } finally {
    await client.close();
  }
});

test("deterministic analysis selection and beat snapping gating across competing source analyses", async () => {
  const client = new PGlite();
  const arenaRoot = fileURLToPath(new URL("../../../../", import.meta.url));

  try {
    await applyDesktopMigrationsToPGlite(client, join(arenaRoot, "desktop-migrations"));
    const db = drizzle(client);

    const ownerId = randomUUID();
    const [project] = await db.insert(projects).values({
      ownerId,
      title: "Analysis Selection Project",
    }).returning();

    const [source] = await db.insert(sourceAssets).values({
      projectId: project.id,
      originalFilename: "competing-track.wav",
      mimeType: "audio/wav",
      storageKey: `projects/${project.id}/competing-track.wav`,
      checksumSha256: "a".repeat(64),
      durationSeconds: 120,
      sampleRate: 44_100,
      channels: 2,
      codec: "pcm_s16le",
      fileSizeBytes: 120 * 44100 * 4,
    }).returning();

    // Insert initial analysis
    const initialGrid = Array.from({ length: 17 }, (_, index) => index * 500);
    const [currentAnalysis] = await db.insert(sourceAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `analysis-${randomUUID()}`,
      analysisEngine: "arena-js-dsp",
      analysisEngineVersion: "1.4.0",
      sourceChecksumSha256: "a".repeat(64),
      bpm: 128,
      bpmConfidence: 0.95,
      musicalKey: "A minor",
      keyConfidence: 0.88,
      beatConfidence: 0.92,
      beatGrid: JSON.stringify(initialGrid),
      completedAt: new Date(),
      createdAt: new Date(),
    }).returning();

    const [sectionAnalysis] = await db.insert(sourceSectionAnalyses).values({
      projectId: project.id,
      sourceAssetId: source.id,
      sourceAnalysisId: currentAnalysis.id,
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: `sections-${randomUUID()}`,
      analysisEngine: DESKTOP_SECTION_ENGINE,
      analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
      completedAt: new Date(),
    }).returning();
    await db.insert(sourceSections).values({
      id: `section-${randomUUID()}`,
      projectId: project.id,
      sourceAssetId: source.id,
      sourceAnalysisId: currentAnalysis.id,
      sourceSectionAnalysisId: sectionAnalysis.id,
      sectionIndex: 0,
      startMs: 0,
      endMs: 8_000,
      startBeatIndex: 0,
      endBeatIndex: 16,
      startBar: 1,
      endBar: 4,
      label: "chorus",
      labelConfidence: 0.8,
      structuralConfidence: 0.8,
      analysisEngine: DESKTOP_SECTION_ENGINE,
      analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
      passageFingerprint: testPassageFingerprint(source.checksumSha256),
    });

    // Query analysis using loadSourceProfile
    const profile = await loadSourceProfile(project.id, source.id, "instrumental", db);
    assert.ok(profile, "Profile should load");
    assert.equal(profile.bpm, 128);
    assert.equal(profile.musicalKey, "A minor");
    assert.equal(profile.keyConfidence, 0.88);
    assert.equal(profile.bpmConfidence, 0.95);
    assert.equal(profile.beatConfidence, 0.92);
    assert.deepEqual(profile.beatGridMs, initialGrid);
    assert.equal(profile.sections.length, 1);
    assert.equal(profile.sections[0]?.label, "chorus");
    assert.equal(profile.sections[0]?.startMs, 0);
    assert.equal(profile.sections[0]?.endMs, 8_000);
    assert.equal(profile.sections[0]?.passageFingerprint?.sourceChecksumSha256, source.checksumSha256);
    assert.equal(profile.evidence?.features.sections.status, "measured");
    if (profile.evidence?.features.sections.status === "measured") {
      assert.equal(profile.evidence.features.sections.provenance.sourceChecksumSha256, source.checksumSha256);
      assert.equal(profile.evidence.features.sections.provenance.analysisId, sectionAnalysis.id);
      assert.equal(profile.evidence.features.sections.value[0]?.passageFingerprint?.sourceChecksumSha256, source.checksumSha256,
        "source-checksum-verified passage fingerprints must survive in the shared evidence packet");
    }
    const matchedPlan = planMashup({
      role: "vocals",
      bpm: 128,
      bpmConfidence: 0.95,
      musicalKey: "A minor",
      keyConfidence: 0.88,
      beatConfidence: 0.92,
      durationMs: 120_000,
      sections: [{
        id: "donor-section",
        label: "section",
        startMs: 0,
        endMs: 8_000,
        startBeatIndex: 0,
        endBeatIndex: 16,
        passageFingerprint: testPassageFingerprint("c".repeat(64)),
      }],
      vocalPhrases: [{ startMs: 1_000, endMs: 2_000, confidence: 0.9 }],
    }, profile);
    assert.ok(matchedPlan.ok);
    assert.ok(matchedPlan.plan.rationale.some((line) => line.includes("aligned voice-bearing donor section donor-section")),
      "the production planner must consume passage fingerprints reloaded from the database-backed profile");

    // Stale section rows must not leak back into the source profile.
    await db.update(sourceSections)
      .set({ sourceChecksumSha256: "b".repeat(64) })
      .where(eq(sourceSections.sourceAssetId, source.id));
    const profileWithStaleSection = await loadSourceProfile(project.id, source.id, "instrumental", db);
    assert.deepEqual(profileWithStaleSection?.sections, []);
    assert.equal(profileWithStaleSection?.evidence?.features.sections.status, "unavailable");

    // Verify scoping: query with a different project ID yields null
    const foreignProjectProfile = await loadSourceProfile(randomUUID(), source.id, "instrumental", db);
    assert.equal(foreignProjectProfile, null, "Should return null for foreign project ID");

    // Verify snapping gating: with high confidence beat grid, snapping is enabled
    const validatedGrid = trustedAnalysisBeatGrid(profile.beatGridMs, profile.bpmConfidence, profile.beatConfidence);
    assert.deepEqual(validatedGrid, initialGrid);

    // If beat grid or confidence drops below threshold, snapping is disabled
    const untrustedGrid = trustedAnalysisBeatGrid(profile.beatGridMs, 0.4, profile.beatConfidence);
    assert.equal(untrustedGrid, null);
  } finally {
    await client.close();
  }
});
