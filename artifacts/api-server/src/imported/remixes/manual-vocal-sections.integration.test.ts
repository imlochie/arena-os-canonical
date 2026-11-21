import assert from "node:assert/strict";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { LOCAL_OWNER_ID } from "@workspace/db/schema";
import {
  manualVocalSectionSets,
  processingJobs,
  projects,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
  vocalAnalyses,
  vocalActivityIntervals,
} from "@workspace/db/waveyardSchema";
import { GET as readRemix, PUT as saveRemix } from "./[id]/route.ts";
import { GET as readVocalSections, PUT as saveVocalSections } from "./[id]/manual-vocal-sections/route.ts";
import { POST as findMeetingPoints, PUT as acceptMeetingPoint } from "./[id]/meeting-points/route.ts";

function request(method: string, url: string, body?: unknown) {
  return new Request(`http://localhost/api${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("private vocal markers persist, guide placement without detector sections, and protect stale edits", async () => {
  process.env.NODE_ENV = "test";
  const [project] = await db.insert(projects).values({
    ownerId: LOCAL_OWNER_ID,
    title: "Temporary vocal-section acceptance",
  }).returning({ id: projects.id });
  try {
    const [vocalSource, bedSource, hostVocalSource] = await db.insert(sourceAssets).values([
      {
        projectId: project.id, originalFilename: "vocal.wav", mimeType: "audio/wav",
        storageKey: `test/manual-vocal/${crypto.randomUUID()}/vocal.wav`, checksumSha256: "a".repeat(64),
        durationSeconds: 60, sampleRate: 48_000, channels: 2, codec: "pcm_s16le", fileSizeBytes: 10,
      },
      {
        projectId: project.id, originalFilename: "bed.wav", mimeType: "audio/wav",
        storageKey: `test/manual-vocal/${crypto.randomUUID()}/bed.wav`, checksumSha256: "b".repeat(64),
        durationSeconds: 60, sampleRate: 48_000, channels: 2, codec: "pcm_s16le", fileSizeBytes: 10,
      },
      {
        projectId: project.id, originalFilename: "host-vocal.wav", mimeType: "audio/wav",
        storageKey: `test/manual-vocal/${crypto.randomUUID()}/host-vocal.wav`, checksumSha256: "f".repeat(64),
        durationSeconds: 60, sampleRate: 48_000, channels: 2, codec: "pcm_s16le", fileSizeBytes: 10,
      },
    ]).returning();
    const [vocalJob, bedJob, hostVocalJob] = await db.insert(processingJobs).values([
      { projectId: project.id, sourceAssetId: vocalSource.id, type: "separation", idempotencyKey: crypto.randomUUID(), model: "fixture", requestedDevice: "cpu" },
      { projectId: project.id, sourceAssetId: bedSource.id, type: "separation", idempotencyKey: crypto.randomUUID(), model: "fixture", requestedDevice: "cpu" },
      { projectId: project.id, sourceAssetId: hostVocalSource.id, type: "separation", idempotencyKey: crypto.randomUUID(), model: "fixture", requestedDevice: "cpu" },
    ]).returning();
    const [vocalStem, bedStem, hostVocalStem] = await db.insert(stemAssets).values([
      {
        projectId: project.id, sourceAssetId: vocalSource.id, separationJobId: vocalJob.id, stemType: "vocals",
        engine: "fixture", model: "fixture", modelVersion: "1", storageKey: `test/manual-vocal/${crypto.randomUUID()}/vocals.wav`,
        checksumSha256: "c".repeat(64), durationSeconds: 60, sampleRate: 48_000, channels: 2,
        codec: "pcm_s16le", format: "wav", fileSizeBytes: 10,
      },
      {
        projectId: project.id, sourceAssetId: bedSource.id, separationJobId: bedJob.id, stemType: "drums",
        engine: "fixture", model: "fixture", modelVersion: "1", storageKey: `test/manual-vocal/${crypto.randomUUID()}/drums.wav`,
        checksumSha256: "d".repeat(64), durationSeconds: 60, sampleRate: 48_000, channels: 2,
        codec: "pcm_s16le", format: "wav", fileSizeBytes: 10,
      },
      {
        projectId: project.id, sourceAssetId: hostVocalSource.id, separationJobId: hostVocalJob.id, stemType: "vocals",
        engine: "fixture", model: "fixture", modelVersion: "1", storageKey: `test/manual-vocal/${crypto.randomUUID()}/host-vocals.wav`,
        checksumSha256: "g".repeat(64), durationSeconds: 60, sampleRate: 48_000, channels: 2,
        codec: "pcm_s16le", format: "wav", fileSizeBytes: 10,
      },
    ]).returning();
    const grid = Array.from({ length: 121 }, (_, index) => index * 500);
    await db.insert(sourceAnalyses).values([
      {
        projectId: project.id, sourceAssetId: vocalSource.id, status: "complete", stage: "complete",
        idempotencyKey: crypto.randomUUID(), analysisEngine: "fixture", analysisEngineVersion: "1",
        sourceChecksumSha256: vocalSource.checksumSha256, bpm: 120, bpmConfidence: 1,
        musicalKey: "C major", keyConfidence: 1, beatGrid: JSON.stringify(grid), beatConfidence: 1,
      },
      {
        projectId: project.id, sourceAssetId: bedSource.id, status: "complete", stage: "complete",
        idempotencyKey: crypto.randomUUID(), analysisEngine: "fixture", analysisEngineVersion: "1",
        sourceChecksumSha256: bedSource.checksumSha256, bpm: 120, bpmConfidence: 1,
        musicalKey: "C major", keyConfidence: 1, beatGrid: JSON.stringify(grid), beatConfidence: 1,
      },
      {
        projectId: project.id, sourceAssetId: hostVocalSource.id, status: "complete", stage: "complete",
        idempotencyKey: crypto.randomUUID(), analysisEngine: "fixture", analysisEngineVersion: "1",
        sourceChecksumSha256: hostVocalSource.checksumSha256, bpm: 120, bpmConfidence: 1,
        musicalKey: "C major", keyConfidence: 1, beatGrid: JSON.stringify(grid), beatConfidence: 1,
      },
    ]);
    const [hostVocalAnalysis] = await db.insert(vocalAnalyses).values({
      projectId: project.id,
      sourceAssetId: hostVocalSource.id,
      stemAssetId: hostVocalStem.id,
      status: "complete",
      stage: "complete",
      attempts: 1,
      idempotencyKey: crypto.randomUUID(),
      analysisEngine: "fixture",
      analysisEngineVersion: "1",
      sourceChecksumSha256: hostVocalSource.checksumSha256,
      stemChecksumSha256: hostVocalStem.checksumSha256,
      startedAt: new Date(),
      analyzedAt: new Date(),
      completedAt: new Date(),
    }).returning({ id: vocalAnalyses.id });
    await db.insert(vocalActivityIntervals).values({
      vocalAnalysisId: hostVocalAnalysis.id,
      intervalIndex: 0,
      startMs: 0,
      endMs: 8_000,
      confidence: 0.9,
    });
    const [remix] = await db.insert(remixSessions).values({
      projectId: project.id, ownerId: LOCAL_OWNER_ID, name: "Private marker acceptance",
      tempoBpm: 120, targetKey: "C major",
    }).returning();
    const [bedTrack] = await db.insert(remixTracks).values({
      remixSessionId: remix.id, stemAssetId: bedStem.id, name: "Bed drums", sortOrder: 0,
    }).returning();
    const [hostVocalTrack] = await db.insert(remixTracks).values({
      remixSessionId: remix.id, stemAssetId: hostVocalStem.id, name: "Host vocals", sortOrder: 1,
    }).returning();
    const [bedClip] = await db.insert(remixClips).values({
      remixTrackId: bedTrack.id, stemAssetId: bedStem.id, timelineStartMs: 16_000, durationMs: 16_000,
      sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0,
      tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: true,
    }).returning();
    await db.insert(remixClips).values({
      remixTrackId: hostVocalTrack.id, stemAssetId: hostVocalStem.id, timelineStartMs: 16_000, durationMs: 16_000,
      sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0,
      tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: true,
    });

    const params = Promise.resolve({ id: remix.id, sourceAssetId: vocalSource.id, stemAssetId: vocalStem.id });
    const initial = await readVocalSections(request("GET", "/"), { params });
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json() as { sections: unknown[] }).sections, []);

    const section = {
      // Deliberately preserve a 250 ms pickup rather than snapping it to beat 0.
      id: crypto.randomUUID(), label: "verse", title: "", startMs: 250, endMs: 16_250,
    };
    const saved = await saveVocalSections(request("PUT", "/", {
      expectedRevision: 0, sections: [section],
    }), { params });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { revision: number }).revision, 1);
    const reopened = await readVocalSections(request("GET", "/"), { params });
    assert.deepEqual((await reopened.json() as { sections: unknown[] }).sections, [section]);
    const concurrentSave = await saveVocalSections(request("PUT", "/", {
      expectedRevision: 0, sections: [],
    }), { params });
    assert.equal(concurrentSave.status, 409);

    // There are deliberately no detector-generated source sections here.
    const recommendations = await findMeetingPoints(request("POST", "/", {
      stemAssetId: vocalStem.id, sourceSectionId: section.id,
    }), { params: Promise.resolve({ id: remix.id }) });
    assert.equal(recommendations.status, 200);
    const points = (await recommendations.json() as { points: Array<{
      id: string;
      state: string;
      sectionAligned: boolean;
      beatSnapEnabled: boolean;
      reasons: string[];
      vocalSlotEvidence: { status: string; overlapRatio: number | null } | null;
    }> }).points;
    assert.equal(points.length, 2);
    assert.equal(points[0].state, "ready");
    assert.equal(points[0].sectionAligned, false);
    assert.equal(points[0].beatSnapEnabled, false, "manual vocal source time must not be quantized to a beat");
    assert.ok(points[0].reasons.some((reason) => reason.includes("marked by the user")));
    assert.deepEqual(points[0].vocalSlotEvidence, { status: "measured", overlapRatio: 0.5 });
    assert.ok(points[0].reasons.some((reason) => reason.includes("activity overlaps 50%")));

    await db.update(stemAssets).set({ checksumSha256: "h".repeat(64) }).where(eq(stemAssets.id, hostVocalStem.id));
    const staleHostRecommendations = await findMeetingPoints(request("POST", "/", {
      stemAssetId: vocalStem.id, sourceSectionId: section.id,
    }), { params: Promise.resolve({ id: remix.id }) });
    const staleHostPoints = (await staleHostRecommendations.json() as { points: typeof points }).points;
    assert.ok(staleHostPoints.length > 0);
    assert.ok(staleHostPoints.every((point) => point.vocalSlotEvidence?.status === "unavailable"),
      "stale host-vocal activity must remain unavailable, not become a measured silent window");

    const accepted = await acceptMeetingPoint(request("PUT", "/", {
      stemAssetId: vocalStem.id, sourceSectionId: section.id, meetingPointId: points[0].id,
    }), { params: Promise.resolve({ id: remix.id }) });
    assert.equal(accepted.status, 201);
    const [vocalTrack] = await db.select().from(remixTracks).where(eq(remixTracks.stemAssetId, vocalStem.id));
    const [vocalClip] = await db.select().from(remixClips).where(eq(remixClips.remixTrackId, vocalTrack.id));
    assert.equal(vocalTrack.stemAssetId, vocalStem.id);
    assert.equal(vocalClip.sourceOffsetMs, section.startMs);
    assert.equal(vocalClip.durationMs, bedClip.durationMs);
    assert.equal(vocalClip.tempoSyncEnabled, false);
    assert.equal(vocalClip.beatSnapEnabled, false);

    // The standard Studio save route resolves beat snapping from the persisted
    // clip flag. A later ordinary edit/save must retain the marked pickup too.
    const hydrated = await readRemix(request("GET", "/"), { params: Promise.resolve({ id: remix.id }) });
    const hydratedBody = await hydrated.json() as {
      remix: Record<string, unknown>;
      tracks: Array<Record<string, unknown>>;
      automation: unknown[];
    };
    const savedAgain = await saveRemix(request("PUT", "/", {
      ...hydratedBody.remix,
      tracks: hydratedBody.tracks,
      automation: hydratedBody.automation,
      expectedVersion: hydratedBody.remix.version,
    }), { params: Promise.resolve({ id: remix.id }) });
    assert.equal(savedAgain.status, 200);
    const [clipAfterSave] = await db.select().from(remixClips).where(eq(remixClips.remixTrackId, vocalTrack.id));
    assert.equal(clipAfterSave.sourceOffsetMs, section.startMs, "a normal persisted save must not move the human-marked vocal pickup");
    assert.equal(clipAfterSave.beatSnapEnabled, false);

    await db.update(stemAssets).set({ checksumSha256: "e".repeat(64) }).where(eq(stemAssets.id, vocalStem.id));
    const stale = await readVocalSections(request("GET", "/"), { params });
    assert.equal((await stale.json() as { stale: boolean }).stale, true);
    const staleSave = await saveVocalSections(request("PUT", "/", { expectedRevision: 1, sections: [section] }), { params });
    assert.equal(staleSave.status, 409);
    const confirmed = await saveVocalSections(request("PUT", "/", {
      expectedRevision: 1, confirmCurrentAudio: true, sections: [section],
    }), { params });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json() as { revision: number }).revision, 2);
    assert.equal((await db.select().from(manualVocalSectionSets).where(eq(manualVocalSectionSets.remixSessionId, remix.id))).length, 1);
  } finally {
    const sessions = await db.select({ id: remixSessions.id }).from(remixSessions).where(eq(remixSessions.projectId, project.id));
    if (sessions.length) {
      const tracks = await db.select({ id: remixTracks.id }).from(remixTracks)
        .where(inArray(remixTracks.remixSessionId, sessions.map((session) => session.id)));
      if (tracks.length) await db.delete(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id)));
    }
    await db.delete(projects).where(eq(projects.id, project.id));
  }
});
