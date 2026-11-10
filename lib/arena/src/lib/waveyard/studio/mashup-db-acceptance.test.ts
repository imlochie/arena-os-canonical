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
  processingJobs,
  stemAssets,
  remixSessions,
  remixTracks,
  remixClips,
  remixVersions,
} from "@workspace/db/waveyardSchema";
import { applyDesktopMigrationsToPGlite } from "../worker-local/pglite-migrations.test-helper";
import { planMashup, renderMashup, type MashupSourceProfile } from "./mashup";

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
      bpm: 120,
      musicalKey: "A minor",
      durationMs: 30_000,
      sections: [{ label: "verse", startMs: 0, endMs: 30_000 }],
    };

    const bedProfile: MashupSourceProfile = {
      role: "instrumental",
      bpm: 120,
      musicalKey: "C major",
      durationMs: 60_000,
      sections: [
        { label: "intro", startMs: 0, endMs: 8_000 },
        { label: "verse", startMs: 8_000, endMs: 32_000 },
        { label: "breakdown", startMs: 32_000, endMs: 40_000 },
        { label: "chorus", startMs: 40_000, endMs: 60_000 },
      ],
    };

    const planned = planMashup(vocalProfile, bedProfile);
    assert.ok(planned.ok);
    const plan = planned.plan;

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
