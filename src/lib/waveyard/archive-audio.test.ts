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
  downloadCount = 0, badHash = false, badAudio = false, fileLicence: string | undefined;
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
            { name: "owned.wav", size: String(pcm.length), licenseurl: fileLicence, sha1: badHash ? "0".repeat(40) : createHash("sha1").update(badAudio ? Buffer.alloc(pcm.length, 97) : pcm).digest("hex") },
            { name: "../secret.wav", size: "100" },
            { name: "private.wav", size: "100", private: true },
            { name: "list.m3u", size: "100" },
          ],
        }),
      );
    if (req.url === "/download/owned-fixture/owned.wav") {
      downloadCount++;
      res.setHeader("content-type", "audio/wav");
      res.setHeader("content-length", pcm.length);
      return res.end(badAudio ? Buffer.alloc(pcm.length,97) : pcm);
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
  const args = { ownerId: "00000000-0000-4000-8000-000000000001", id: item.id, file: "owned.wav", rightsReviewed: true };
  fileLicence = "https://creativecommons.org/licenses/by-nd/4.0/";
  await assert.rejects(api.importArchiveAudio(args, fetcher), /unavailable/);fileLicence=undefined;
  const cancelled = new AbortController();cancelled.abort();
  await assert.rejects(api.importArchiveAudio({...args,signal:cancelled.signal},fetcher), /abort/i);
  assert.equal(downloadCount,0);
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
  const ownerId="00000000-0000-4000-8000-000000000001", args={ownerId,id:"owned-fixture",file:"owned.wav",rightsReviewed:true};
  const library=await import("./library/service"),before=await library.listTracks({ownerId});
  badHash=true;await assert.rejects(api.importArchiveAudio(args,fetcher),/provider SHA-1/);badHash=false;
  badAudio=true;await assert.rejects(api.importArchiveAudio(args,fetcher));badAudio=false;
  assert.deepEqual(await library.listTracks({ownerId}),before);
  const {writeFile}=await import("node:fs/promises");const filePath=join(root,"duplicate-owned.wav");await writeFile(filePath,pcm);
  await assert.rejects(library.addTrackFromAudioFile({ownerId,filePath,filename:"duplicate-owned.wav",mimeType:"audio/wav",prepareSeparation:false,provenance:{method:"authorized-url",sourceUrl:"https://different.example/claim"}}),/different acquisition/);
  assert.deepEqual(await library.listTracks({ownerId}),before);
});
