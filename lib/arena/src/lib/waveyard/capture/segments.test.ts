import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspectRf64Recording, Rf64Recorder } from "./rf64";
import { splitCaptureRecording, validateCaptureTags } from "./segments";

const formatChunk = Buffer.alloc(16);
formatChunk.writeUInt16LE(1, 0);
formatChunk.writeUInt16LE(2, 2);
formatChunk.writeUInt32LE(44100, 4);
formatChunk.writeUInt32LE(44100 * 6, 8);
formatChunk.writeUInt16LE(6, 12);
formatChunk.writeUInt16LE(24, 14);
const artwork = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=";

async function fixture(t: TestContext, frames = 350_000) {
  const directory = await mkdtemp(join(tmpdir(), "capture-segments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "master.wav");
  const pcm = Buffer.alloc(frames * 6);
  for (let index = 0; index < pcm.length; index++) pcm[index] = (index * 17 + Math.floor(index / 6)) & 255;
  const recorder = await Rf64Recorder.create({ partialPath: `${path}.partial.wav`, finalPath: path, format: { formatChunk } });
  await recorder.writePcm(pcm.subarray(0, 713));
  await recorder.writePcm(pcm.subarray(713));
  assert.equal(recorder.sampleFrames, frames, "reported positions count complete PCM frames, not chunks");
  await recorder.finalize();
  return { directory, path, pcm, frames };
}

test("confirmed boundaries split 24-bit stereo PCM exactly, preserving every frame and format byte", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.path);
  const outputs = await splitCaptureRecording({
    ...f, metadata: { title: "First", artist: "Artist", album: "Album", trackNumber: 1 },
    markers: [
      { id: "second", sampleFrame: 12345, metadata: { title: "Second", trackNumber: 2 } },
      { id: "third", sampleFrame: 234567, metadata: { title: "Third", trackNumber: 3 } },
    ],
  });
  const slices: Buffer[] = [];
  for (const output of outputs) {
    const header = await inspectRf64Recording(output.path);
    const bytes = await readFile(output.path);
    assert.equal(header.sampleRate, 44100);
    assert.equal(header.bitsPerSample, 24);
    assert.equal(header.channels, 2);
    assert.deepEqual(header.format.formatChunk, formatChunk);
    assert.equal(header.sampleFrames, output.sampleFrames);
    slices.push(bytes.subarray(header.dataOffset, header.dataOffset + header.dataBytes));
  }
  assert.deepEqual(outputs.map((output) => output.startFrame), [0, 12345, 234567]);
  assert.deepEqual(Buffer.concat(slices), f.pcm);
  assert.deepEqual(await readFile(f.path), original, "the master survives splitting unchanged");
});

test("tagged WAV slices retain Unicode text, track number and local artwork; retry bytes are deterministic", async (t) => {
  const f = await fixture(t, 1000);
  const metadata = { title: "音楽 – First", artist: "An artist", album: "An album", trackNumber: 7, artworkDataUrl: artwork };
  const first = await splitCaptureRecording({ ...f, metadata, markers: [] });
  const second = await splitCaptureRecording({ ...f, metadata, markers: [] });
  const bytes = await readFile(first[0]!.path);
  assert(bytes.includes(Buffer.from("LIST")));
  assert(bytes.includes(Buffer.from("INAM")));
  assert(bytes.includes(Buffer.from("TIT2")));
  assert(bytes.includes(Buffer.from(metadata.title, "utf16le")));
  assert(bytes.includes(Buffer.from(metadata.artist, "utf16le")));
  assert(bytes.includes(Buffer.from(metadata.album, "utf16le")));
  assert(bytes.includes(Buffer.from("TRCK")));
  assert(bytes.includes(Buffer.from("APIC")));
  assert(bytes.includes(Buffer.from(artwork.split(",")[1]!, "base64")));
  assert.deepEqual(bytes, await readFile(second[0]!.path), "retries retain the same checksum for library deduplication");
});

test("invalid and repeated boundaries fail before slicing; a final empty boundary never drops audio", async (t) => {
  const f = await fixture(t, 100);
  for (const frames of [[0], [30, 30], [101], [20.5]]) {
    await assert.rejects(splitCaptureRecording({
      ...f, metadata: { title: "First" },
      markers: frames.map((sampleFrame) => ({ id: `${sampleFrame}`, sampleFrame, metadata: { title: "Next" } })),
    }), /boundaries/);
  }
  const outputs = await splitCaptureRecording({
    ...f, metadata: { title: "First" }, markers: [{ id: "end", sampleFrame: 100, metadata: { title: "No captured frames yet" } }],
  });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]!.sampleFrames, 100);
});

test("capture tags reject URL fetching, incorrect image signatures and malformed track numbers", () => {
  assert.deepEqual(validateCaptureTags({ title: "  Title  ", trackNumber: 3 }), { title: "Title", trackNumber: 3 });
  assert.throws(() => validateCaptureTags({ title: "Title", artworkDataUrl: "https://example.test/cover.jpg" }), /Artwork/);
  assert.throws(() => validateCaptureTags({ title: "Title", artworkDataUrl: "data:image/png;base64,ZmFrZQ==" }), /Artwork/);
  assert.throws(() => validateCaptureTags({ title: "Title", trackNumber: 1.5 }), /Track number/);
  assert.throws(() => validateCaptureTags({ title: " " }), /title/);
});

test("tagged capture WAVs expose text tags and cover artwork to FFprobe", async (t) => {
  const exec = promisify(execFile);
  try { await exec("ffprobe", ["-version"]); } catch { t.skip("FFprobe is not installed."); return; }
  const f = await fixture(t, 4410);
  const outputs = await splitCaptureRecording({
    ...f, metadata: { title: "Track 音楽", artist: "Artist", album: "Album", trackNumber: 7, artworkDataUrl: artwork }, markers: [],
  });
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", outputs[0]!.path]);
  const report = JSON.parse(stdout);
  assert.equal(report.format.tags.title, "Track 音楽");
  assert.equal(report.format.tags.artist, "Artist");
  assert.equal(report.format.tags.album, "Album");
  assert.equal(report.format.tags.track, "7");
  assert(report.streams.some((stream: { disposition?: { attached_pic?: number } }) => stream.disposition?.attached_pic === 1),
    "supported readers must see the embedded cover, not just arbitrary appended bytes");
});

test("odd-length mono 24-bit PCM is padded outside audio before metadata chunks", async (t) => {
  const f = await fixture(t, 100);
  const mono = Buffer.from(formatChunk);
  mono.writeUInt16LE(1, 2);
  mono.writeUInt32LE(44100 * 3, 8);
  mono.writeUInt16LE(3, 12);
  const path = join(f.directory, "mono.wav");
  const recorder = await Rf64Recorder.create({ partialPath: `${path}.partial`, finalPath: path, format: { formatChunk: mono } });
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await recorder.writePcm(pcm);
  await recorder.finalize();
  const outputs = await splitCaptureRecording({ ...f, path, metadata: { title: "Mono" }, markers: [] });
  const header = await inspectRf64Recording(outputs[0]!.path);
  const bytes = await readFile(outputs[0]!.path);
  assert.deepEqual(bytes.subarray(header.dataOffset, header.dataOffset + header.dataBytes), pcm);
  assert.equal(bytes[header.dataOffset + header.dataBytes], 0);
  assert.equal(bytes.toString("ascii", header.dataOffset + header.dataBytes + 1, header.dataOffset + header.dataBytes + 5), "LIST");
});
