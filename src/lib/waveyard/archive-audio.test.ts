/** Actual HTTP/PG/native decoding contract; locally generated owned PCM and
 * simulated Archive metadata, NOT live catalogue coverage or learned inference. */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { missionPostgres } from "../../../tests/helpers/mission-postgres";
let api: typeof import("./archive-audio"),
  pg: Awaited<ReturnType<typeof missionPostgres>>,
  root: string,
  server: ReturnType<typeof createServer>,
  fetcher: typeof fetch;
let licence: unknown = "https://creativecommons.org/publicdomain/zero/1.0/",
  restricted = false,
  downloadCount = 0,
  badHash = false,
  badAudio = false,
  fileLicence: string | undefined,
  batchFiles = false;
let pcm: Buffer;
const previous = {
  db: process.env.DATABASE_URL,
  storage: process.env.WAVEYARD_STORAGE_DIR,
  local: process.env.WAVEYARD_LOCAL_WORKER,
};
before(async () => {
  pg = await missionPostgres();
  root = await mkdtemp(join(tmpdir(), "wy-archive-contract-"));
  process.env.DATABASE_URL = pg.url;
  process.env.WAVEYARD_STORAGE_DIR = join(root, "storage");
  process.env.WAVEYARD_LOCAL_WORKER = "0";
  api = await import("./archive-audio");
  const { encodeWav16 } = await import("./mixer/synth");
  pcm = Buffer.from(
    encodeWav16(
      Float32Array.from(
        { length: 88200 },
        (_, i) => Math.sin(Math.floor(i / 2) * 0.13) * 0.2,
      ),
      44100,
    ),
  );
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url!.startsWith("/advancedsearch.php"))
      return res.end(
        JSON.stringify({
          response: {
            docs: [
              {
                identifier: "owned-fixture",
                title: "Owned controlled PCM",
                creator: "Arena test",
                licenseurl: licence,
              },
              { identifier: "../private", title: "bad" },
            ],
          },
        }),
      );
    if (req.url === "/metadata/owned-fixture")
      return res.end(
        JSON.stringify({
          metadata: {
            identifier: "owned-fixture",
            title: "Owned controlled PCM",
            creator: "Arena test",
            mediatype: "audio",
            licenseurl: licence,
            access_restricted: restricted,
          },
          files: [
            {
              name: "owned.wav",
              size: String(pcm.length),
              licenseurl: fileLicence,
              sha1: badHash
                ? "0".repeat(40)
                : createHash("sha1")
                    .update(badAudio ? Buffer.alloc(pcm.length, 97) : pcm)
                    .digest("hex"),
            },
            ...(batchFiles ? [{ name: "second.wav", title: "Second controlled recording", size: String(pcm.length), sha1: createHash("sha1").update(secondAudio()).digest("hex") }] : []),
            { name: "../secret.wav", size: "100" },
            { name: "private.wav", size: "100", private: true },
            { name: "list.m3u", size: "100" },
          ],
        }),
      );
    if (req.url === "/download/owned-fixture/second.wav") {
      res.setHeader("content-type", "audio/wav"); res.setHeader("content-length", pcm.length); return res.end(secondAudio());
    }
    if (req.url === "/download/owned-fixture/owned.wav") {
      downloadCount++;
      res.setHeader("content-type", "audio/wav");
      res.setHeader("content-length", pcm.length);
      return res.end(badAudio ? Buffer.alloc(pcm.length, 97) : pcm);
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fetcher = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.hostname, "archive.org");
    return fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}${target.pathname}${target.search}`,
      init,
    );
  };
});
after(async () => {
  const { pool } = await import("../../db");
  await pool.end();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await pg.close();
  await rm(root, { recursive: true, force: true });
  for (const [name, value] of [
    ["DATABASE_URL", previous.db],
    ["WAVEYARD_STORAGE_DIR", previous.storage],
    ["WAVEYARD_LOCAL_WORKER", previous.local],
  ]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
});

test("licence allowlist is explicit, bounded and does not upgrade ND/NC/SA, ambiguous or forged URLs", () => {
  for (const value of [
    "https://creativecommons.org/licenses/by-nc/4.0/",
    "https://creativecommons.org/licenses/by-nd/4.0/",
    "https://creativecommons.org/licenses/by-sa/4.0/",
    "https://creativecommons.org.evil.test/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/4.0/?claim=ok",
    [
      "https://creativecommons.org/publicdomain/zero/1.0/",
      "all rights reserved",
    ],
    "public domain",
  ])
    assert.equal(api.archiveLicence(value), null);
  assert.equal(
    api.archiveLicence("http://creativecommons.org/licenses/by/3.0/")
      ?.attributionRequired,
    true,
  );
  assert.equal(
    api.archiveLicence("https://creativecommons.org/publicdomain/zero/1.0/")
      ?.attributionRequired,
    false,
  );
});
test("HTTP discovery remains references, inspection excludes private/traversal files; missing consent/restricted grant acquires no audio", async () => {
  const hits = await api.searchArchiveAudio("owned", fetcher);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].state, "reference-only");
  const item = await api.inspectArchiveAudio("owned-fixture", fetcher);
  assert.deepEqual(
    item.files.map((f) => f.name),
    ["owned.wav"],
  );
  await assert.rejects(
    api.importArchiveAudio(
      {
        ownerId: "00000000-0000-4000-8000-000000000001",
        id: item.id,
        file: "owned.wav",
        rightsReviewed: false,
      },
      fetcher,
    ),
    /Review/,
  );
  licence = "https://creativecommons.org/licenses/by-nd/4.0/";
  await assert.rejects(
    api.importArchiveAudio(
      {
        ownerId: "00000000-0000-4000-8000-000000000001",
        id: item.id,
        file: "owned.wav",
        rightsReviewed: true,
      },
      fetcher,
    ),
    /No unambiguous/,
  );
  licence = "https://creativecommons.org/publicdomain/zero/1.0/";
  restricted = true;
  await assert.rejects(
    api.inspectArchiveAudio(item.id, fetcher),
    /not an accessible/,
  );
  restricted = false;
  assert.equal(downloadCount, 0);
  const args = {
    ownerId: "00000000-0000-4000-8000-000000000001",
    id: item.id,
    file: "owned.wav",
    rightsReviewed: true,
  };
  fileLicence = "https://creativecommons.org/licenses/by-nd/4.0/";
  await assert.rejects(api.importArchiveAudio(args, fetcher), /unavailable/);
  fileLicence = undefined;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    api.importArchiveAudio({ ...args, signal: cancelled.signal }, fetcher),
    /abort/i,
  );
  assert.equal(downloadCount, 0);
});
test("reviewed HTTP audio goes through native probe/storage/library, durable attribution, real asset response and pinned source session", async () => {
  const owner = "00000000-0000-4000-8000-000000000001";
  const imported = await api.importArchiveAudio(
    {
      ownerId: owner,
      id: "owned-fixture",
      file: "owned.wav",
      rightsReviewed: true,
    },
    fetcher,
  );
  assert.equal(imported.created, true);
  assert.equal(imported.separationQueued, false);
  assert.equal(downloadCount, 1);
  const library = await import("./library/service");
  const detail = await library.getTrack(owner, imported.track.id);
  assert.ok(detail);
  assert.equal(detail.playback.kind, "source");
  assert.equal(detail.banks.length, 0);
  assert.match(detail.rights!.attribution, /CC|creativecommons/);
  const { db } = await import("../../db");
  const schema = await import("../../db/waveyardSchema");
  const [source] = await db
    .select()
    .from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, detail.source.id));
  const { getStorage } = await import("./storage");
  assert.deepEqual(
    await readFile(getStorage().getLocalPath(source.storageKey)!),
    pcm,
  );
  const { GET } = await import("../../app/api/assets/[id]/route");
  const response = await GET(
    new Request(`http://localhost/api/assets/${source.id}`, {
      headers: { host: "localhost" },
    }),
    { params: Promise.resolve({ id: source.id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pcm);
  const sessions = await import("./library/session-service");
  const room = await sessions.createSession(
    owner,
    "Archive controlled contract",
  );
  await sessions.addTrackToSession({
    ownerId: owner,
    sessionId: room.id,
    trackId: imported.track.id,
  });
  const reopened = await sessions.getSession(owner, room.id);
  assert.deepEqual(reopened!.tracks[0].playback!.assetIds, [source.id]);
  const duplicate = await api.importArchiveAudio(
    {
      ownerId: owner,
      id: "owned-fixture",
      file: "owned.wav",
      rightsReviewed: true,
    },
    fetcher,
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.track.id, imported.track.id);
  assert.match(
    (await library.getTrack(owner, imported.track.id))!.rights!.notice,
    /not a rights warranty/,
  );
});

test("provider integrity mismatch and native decode failure never add library audio; duplicate rights are not overwritten", async () => {
  const ownerId = "00000000-0000-4000-8000-000000000001",
    args = {
      ownerId,
      id: "owned-fixture",
      file: "owned.wav",
      rightsReviewed: true,
    };
  const library = await import("./library/service"),
    before = await library.listTracks({ ownerId });
  badHash = true;
  await assert.rejects(api.importArchiveAudio(args, fetcher), /provider SHA-1/);
  badHash = false;
  badAudio = true;
  await assert.rejects(api.importArchiveAudio(args, fetcher));
  badAudio = false;
  assert.deepEqual(await library.listTracks({ ownerId }), before);
  const { writeFile } = await import("node:fs/promises");
  const filePath = join(root, "duplicate-owned.wav");
  await writeFile(filePath, pcm);
  await assert.rejects(
    library.addTrackFromAudioFile({
      ownerId,
      filePath,
      filename: "duplicate-owned.wav",
      mimeType: "audio/wav",
      prepareSeparation: false,
      provenance: {
        method: "authorized-url",
        sourceUrl: "https://different.example/claim",
      },
    }),
    /different acquisition/,
  );
  assert.deepEqual(await library.listTracks({ ownerId }), before);
});

test("bank selection and explicit legacy repair retain exact lane order after PostgreSQL physically reverses rows", async () => {
  // Persistence-only fixture banks, NOT inference. Existing PCM/storage is real.
  const { db, pool } = await import("../../db");
  const schema = await import("../../db/waveyardSchema");
  const library = await import("./library/service");
  const sessions = await import("./library/session-service");
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const [track] = await library.listTracks({ ownerId });
  const detail = (await library.getTrack(ownerId, track.id))!;
  const [source] = await db
    .select()
    .from(schema.sourceAssets)
    .where(eq(schema.sourceAssets.id, detail.source.id));
  const jobIds: string[] = [];
  for (let bank = 0; bank < 2; bank++) {
    const [job] = await db
      .insert(schema.processingJobs)
      .values({
        projectId: source.projectId,
        sourceAssetId: source.id,
        type: "separation",
        status: "complete",
        stage: "complete",
        model: "stems_4",
        requestedDevice: "cpu",
        idempotencyKey: crypto.randomUUID(),
      })
      .returning();
    jobIds.push(job.id);
    for (const stemType of ["drums", "vocals", "bass", "other"]) {
      const storage = (await import("./storage")).getStorage(),
        storageKey = `${source.storageKey}-${bank}-${stemType}.wav`;
      await storage.putFile(
        storageKey,
        storage.getLocalPath(source.storageKey)!,
      );
      await db
        .insert(schema.stemAssets)
        .values({
          projectId: source.projectId,
          sourceAssetId: source.id,
          separationJobId: job.id,
          stemType,
          engine: "mdx-net",
          model: "controlled-persistence-fixture",
          modelVersion: "not-inference",
          storageKey,
          checksumSha256: source.checksumSha256,
          durationSeconds: source.durationSeconds,
          sampleRate: source.sampleRate,
          channels: source.channels,
          codec: source.codec,
          format: source.mimeType,
          fileSizeBytes: source.fileSizeBytes,
        });
    }
  }
  const before = (await library.getTrack(ownerId, track.id, {
    bankId: jobIds[0],
  }))!;
  const room = await sessions.createSession(
    ownerId,
    "Lane order persistence regression",
  );
  const pinned = await sessions.addTrackToSession({
    ownerId,
    sessionId: room.id,
    trackId: track.id,
    bankId: jobIds[0],
  });
  // Simulate a pre-upgrade explicit snapshot whose order was not canonical.
  const originalPinnedOrder = [...before.playback.assetIds].reverse();
  await db.update(schema.listenSessionTracks).set({ assetSelection: JSON.stringify({ kind: "stems", assetIds: originalPinnedOrder }) }).where(eq(schema.listenSessionTracks.id,pinned.tracks[0].id));
  const [legacy] = await db
    .insert(schema.listenSessionTracks)
    .values({
      sessionId: room.id,
      trackId: track.id,
      position: 1,
      stemMix: '{"drums":0.37}',
    })
    .returning();
  await pool.query(
    "CREATE INDEX acceptance_reverse_stems ON stem_assets (stem_type DESC, id DESC); CLUSTER stem_assets USING acceptance_reverse_stems; ANALYZE stem_assets;",
  );
  const after = (await library.getTrack(ownerId, track.id, {
    bankId: jobIds[0],
  }))!;
  assert.deepEqual(
    after.playback.assetIds,
    before.playback.assetIds,
    "same bank must not take its lane order from heap/index traversal",
  );
  const repaired = await sessions.updateSessionTrack(
    ownerId,
    room.id,
    legacy.id,
    { bankId: jobIds[0] },
  );
  assert.deepEqual(
    repaired.tracks[0].playback!.assetIds,
    originalPinnedOrder,
    "existing pinned order is not silently rewritten",
  );
  assert.deepEqual(
    repaired.tracks[1].playback!.assetIds,
    before.playback.assetIds,
    "explicit legacy repair selects the same ordered bank",
  );
  assert.equal(repaired.tracks[1].stemMix.drums, 0.37);
  assert.deepEqual(
    after.stems.map((stem) => stem.stemType),
    ["vocals", "drums", "bass", "other"],
  );
});

function secondAudio() { const bytes = Buffer.from(pcm); bytes[50] ^= 32; return bytes; }
test("durable multi-file acquisition persists intent/order, isolates owners, fences cancellation, rejects changed versions and publishes once", async () => {
  const jobs = await import("./acquisition-jobs"); const { db, pool } = await import("../../db");
  const schema = await import("../../db/waveyardSchema"); const { randomUUID } = await import("node:crypto");
  const ownerId = "00000000-0000-4000-8000-000000000001";
  licence = "https://creativecommons.org/publicdomain/zero/1.0/"; restricted = false; badHash = false; badAudio = false; fileLicence = undefined; batchFiles = true;
  try {
    const input = { ownerId, batchId: randomUUID(), id: "owned-fixture", files: ["second.wav", "owned.wav"], rightsReviewed: true };
    await assert.rejects(jobs.createAcquisitions({ ...input, rightsReviewed: false }, fetcher), /Review/);
    const rows = await jobs.createAcquisitions(input, fetcher);
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.sourceAssetId === null && row.status === "queued"));
    assert.deepEqual((await jobs.createAcquisitions(input, fetcher)).map(r => r.id), rows.map(r => r.id));
    assert.deepEqual((await jobs.createAcquisitions(input, async () => { throw new Error("Controlled metadata outage"); })).map(r => r.id), rows.map(r => r.id));
    await assert.rejects(jobs.createAcquisitions({ ...input, files: [...input.files].reverse() }, fetcher), /conflict/);
    await assert.rejects(jobs.ownedAcquisition(randomUUID(), rows[0].id), /owner/);
    await jobs.cancelAcquisition(ownerId, rows[0].id); await jobs.executeAcquisition(rows[0].id, fetcher);
    assert.equal((await jobs.ownedAcquisition(ownerId, rows[0].id)).status, "cancelled");
    // Mimic a dead process after claim. Resume reads persisted intent; it does
    // not require an in-memory queue record or fabricate a source on restart.
    await pool.query("UPDATE processing_jobs SET status='processing',stage='downloading',metadata=(metadata::jsonb || $2::jsonb)::text WHERE id=$1", [rows[1].id, JSON.stringify({runId: "terminated-process"})]);
    await pg.stop(); await pg.start();
    await jobs.executeAcquisition(rows[1].id, fetcher);
    const done = await jobs.ownedAcquisition(ownerId, rows[1].id); assert.equal(done.status, "complete"); assert.ok(done.sourceAssetId);
    const firstCount = (await pool.query("SELECT count(*)::int AS n FROM wy_playlist_items WHERE playlist_id=$1", [input.batchId])).rows[0].n;
    await jobs.executeAcquisition(done.id, fetcher);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM wy_playlist_items WHERE playlist_id=$1", [input.batchId])).rows[0].n, firstCount);
    await pool.query("UPDATE processing_jobs SET status='queued' WHERE id=$1", [rows[0].id]);
    badHash = true; // second file stays pinned; mutate its expected intent instead.
    await pool.query("UPDATE processing_jobs SET metadata=jsonb_set(metadata::jsonb,'{expected,sha1}',to_jsonb($2::text))::text WHERE id=$1", [rows[0].id, "0".repeat(40)]);
    await assert.rejects(jobs.executeAcquisition(rows[0].id, fetcher), /version or licence changed/);
    const failed = await jobs.ownedAcquisition(ownerId, rows[0].id); assert.equal(failed.status, "failed"); assert.match(failed.errorMessage!, /version or licence changed/);
    assert.equal(failed.sourceAssetId, null);
    assert.equal((await db.select().from(schema.playlistItems).where(eq(schema.playlistItems.playlistId, input.batchId))).length, 1);
  } finally { batchFiles = false; badHash = false; }
});
