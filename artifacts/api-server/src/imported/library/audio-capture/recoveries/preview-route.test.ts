import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("streams only an owned preserved recording and leaves it available for import", async () => {
  const previousDataDir = process.env.ARENA_DATA_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const root = await mkdtemp(path.join(tmpdir(), "waveyard-recovery-preview-"));
  process.env.ARENA_DATA_DIR = root;
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL ??= "postgres://arena:arena@127.0.0.1:5432/arena_test";

  try {
    const { LOCAL_OWNER_ID } = await import("@workspace/arena/lib/waveyard/local-context");
    const { GET } = await import("./[id]/preview/route");
    const id = "12345678-1234-4234-8234-123456789abc";
    const sessionDirectory = path.join(root, "waveyard", "capture", id);
    await mkdir(sessionDirectory, { recursive: true });
    const audio = Buffer.from("RIFF-preserved-test-audio");
    const recordingPath = path.join(sessionDirectory, "recording.wav");
    await writeFile(recordingPath, audio);
    await writeFile(path.join(sessionDirectory, "session.json"), JSON.stringify({
      sessionId: id,
      ownerId: LOCAL_OWNER_ID,
      metadata: { title: "Preserved preview test" },
      createdAt: "2026-11-04T12:00:00.000Z",
      recordingFile: "recording.wav",
    }));

    const context = { params: Promise.resolve({ id }) };
    const fullResponse = await GET(new Request(`http://arena.test/api/library/audio-capture/recoveries/${id}/preview`), context);
    assert.equal(fullResponse.status, 200);
    assert.equal(fullResponse.headers.get("content-type"), "audio/wav");
    assert.equal(fullResponse.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await fullResponse.arrayBuffer()), audio);

    const rangeResponse = await GET(new Request(
      `http://arena.test/api/library/audio-capture/recoveries/${id}/preview`,
      { headers: { range: "bytes=5-13" } },
    ), context);
    assert.equal(rangeResponse.status, 206);
    assert.equal(rangeResponse.headers.get("content-range"), `bytes 5-13/${audio.length}`);
    assert.deepEqual(Buffer.from(await rangeResponse.arrayBuffer()), audio.subarray(5, 14));

    const invalidRange = await GET(new Request(
      `http://arena.test/api/library/audio-capture/recoveries/${id}/preview`,
      { headers: { range: "bytes=999-" } },
    ), context);
    assert.equal(invalidRange.status, 416);

    const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const foreignDirectory = path.join(root, "waveyard", "capture", missingId);
    await mkdir(foreignDirectory, { recursive: true });
    await writeFile(path.join(foreignDirectory, "recording.wav"), audio);
    await writeFile(path.join(foreignDirectory, "session.json"), JSON.stringify({
      sessionId: missingId,
      ownerId: "a-different-owner",
      metadata: { title: "Not this user's recording" },
      createdAt: "2026-11-04T12:00:00.000Z",
      recordingFile: "recording.wav",
    }));
    const otherOwner = await GET(new Request(
      `http://arena.test/api/library/audio-capture/recoveries/${missingId}/preview`,
    ), { params: Promise.resolve({ id: missingId }) });
    assert.equal(otherOwner.status, 404);
    assert.deepEqual(await readFile(recordingPath), audio, "preview must not delete or move the preserved recording");
    assert.equal(JSON.parse(await readFile(path.join(sessionDirectory, "session.json"), "utf8")).sessionId, id);
  } finally {
    if (previousDataDir === undefined) delete process.env.ARENA_DATA_DIR;
    else process.env.ARENA_DATA_DIR = previousDataDir;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await rm(root, { recursive: true, force: true });
  }
});
