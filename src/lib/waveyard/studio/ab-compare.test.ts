/**
 * A//B comparison engine tests — ID3 artwork extraction (synthetic tags
 * with real frame layouts), generative cover determinism, the crossfade
 * law, and the showcase timeline.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildShowcasePlan,
  equalPowerCrossfade,
  hashSeed,
  parseId3Artwork,
  proceduralCoverSpec,
  showcaseDividerAt,
} from "./ab-compare";

// ---------------------------------------------------------------- ID3

/** Build a synthetic ID3v2 tag with one APIC frame (fake image payload). */
function id3Tag(major: 3 | 4, imageBytes: Uint8Array): Uint8Array {
  // APIC body: encoding 0 (latin1) + "image/jpeg\0" + type 3 (front) + "" desc + \0 + data
  const mime = "image/jpeg";
  const body = [0];
  for (const char of mime) body.push(char.charCodeAt(0));
  body.push(0, 3, 0);
  const bodyBytes = new Uint8Array(body.length + imageBytes.length);
  bodyBytes.set(body, 0);
  bodyBytes.set(imageBytes, body.length);

  const frameSize = bodyBytes.length;
  const frame = new Uint8Array(10 + frameSize);
  frame.set([0x41, 0x50, 0x49, 0x43], 0); // "APIC"
  if (major === 4) {
    // v2.4: syncsafe frame size.
    frame[4] = (frameSize >>> 21) & 0x7f;
    frame[5] = (frameSize >>> 14) & 0x7f;
    frame[6] = (frameSize >>> 7) & 0x7f;
    frame[7] = frameSize & 0x7f;
  } else {
    // v2.3: plain big-endian.
    frame[4] = (frameSize >>> 24) & 0xff;
    frame[5] = (frameSize >>> 16) & 0xff;
    frame[6] = (frameSize >>> 8) & 0xff;
    frame[7] = frameSize & 0xff;
  }
  frame.set(bodyBytes, 10);

  const tagSize = frame.length;
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, major, 0, 0], 0);
  // Tag size is syncsafe in BOTH versions.
  header[6] = (tagSize >>> 21) & 0x7f;
  header[7] = (tagSize >>> 14) & 0x7f;
  header[8] = (tagSize >>> 7) & 0x7f;
  header[9] = tagSize & 0x7f;

  const out = new Uint8Array(header.length + frame.length);
  out.set(header, 0);
  out.set(frame, header.length);
  return out;
}

function fakeJpeg(length = 512): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  for (let i = 2; i < length; i += 1) bytes[i] = i % 251;
  return bytes;
}

test("ID3v2.3 artwork is extracted from an MP3's leading bytes", () => {
  const image = fakeJpeg();
  const artwork = parseId3Artwork(id3Tag(3, image));
  assert.ok(artwork !== null);
  assert.equal(artwork.mime, "image/jpeg");
  assert.equal(artwork.data.length, image.length);
  assert.equal(artwork.data[0], 0xff);
  assert.equal(artwork.data[1], 0xd8);
});

test("ID3v2.4 artwork is extracted (syncsafe frame sizes)", () => {
  const image = fakeJpeg(300);
  const artwork = parseId3Artwork(id3Tag(4, image));
  assert.ok(artwork !== null);
  assert.equal(artwork.data.length, 300);
});

test("non-MP3s, tiny files, and art-less tags return null honestly", () => {
  assert.equal(parseId3Artwork(new Uint8Array(8)), null);
  assert.equal(parseId3Artwork(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null, "no ID3 magic");
  // Valid tag but a non-APIC frame only.
  const mime = "TIT2";
  const body = new Uint8Array([0, 116, 101, 115, 116, 0]);
  const frame = new Uint8Array(10 + body.length);
  frame.set([0x54, 0x49, 0x54, 0x50], 0); // "TIT2" — wait, that's 4 chars: T I T 2
  frame[7] = body.length;
  frame.set(body, 10);
  const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frame.length]);
  const tag = new Uint8Array(header.length + frame.length);
  tag.set(header, 0);
  tag.set(frame, header.length);
  assert.equal(parseId3Artwork(tag), null, "no APIC frame → null");
  assert.ok(mime.length === 4);
});

// ------------------------------------------------------ generative covers

test("generative covers are deterministic per track and differ between tracks", () => {
  const first = proceduralCoverSpec("track-a.wav", "Song A", "Artist A");
  const again = proceduralCoverSpec("track-a.wav", "Different Title", "Artist B");
  assert.equal(first.backgroundHue, again.backgroundHue, "seeded by identity, not labels");
  assert.deepEqual(first.shapes, again.shapes);

  const second = proceduralCoverSpec("track-b.wav", "Song B", "Artist B");
  assert.notEqual(first.backgroundHue, second.backgroundHue);

  assert.equal(first.title, "Song A");
  assert.ok(first.shapes.length >= 9 && first.shapes.length <= 16);
  for (const shape of first.shapes) {
    assert.ok(shape.x >= 0 && shape.x <= 1 && shape.y >= 0 && shape.y <= 1);
    assert.ok(shape.alpha > 0 && shape.alpha <= 1);
  }
});

test("hashSeed is stable and collision-different for different inputs", () => {
  assert.equal(hashSeed("song.mp3"), hashSeed("song.mp3"));
  assert.notEqual(hashSeed("song.mp3"), hashSeed("song.mp4"));
});

// ------------------------------------------------------------- crossfade

test("equal-power crossfade: ends are pure, the middle is constant power", () => {
  assert.deepEqual(equalPowerCrossfade(0), { a: 1, b: 0 });
  assert.deepEqual(equalPowerCrossfade(1), { a: 0, b: 1 });
  const middle = equalPowerCrossfade(0.5);
  assert.ok(Math.abs(middle.a - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(middle.b - Math.SQRT1_2) < 1e-9);
  // Constant power: a² + b² = 1 at every position.
  for (let step = 0; step <= 10; step += 1) {
    const { a, b } = equalPowerCrossfade(step / 10);
    assert.ok(Math.abs(a * a + b * b - 1) < 1e-9, `power at ${step / 10}`);
  }
  // Hostile input clamps.
  assert.deepEqual(equalPowerCrossfade(-3), { a: 1, b: 0 });
  assert.deepEqual(equalPowerCrossfade(Number.NaN), { a: 1, b: 0 }, "NaN clamps to A");
});

// ---------------------------------------------------------- showcase plan

test("the showcase timeline runs A → crossfade → B with ramping divider", () => {
  const plan = buildShowcasePlan({ aMs: 4000, crossfadeMs: 3000, bMs: 4000 });
  assert.equal(plan.phases.length, 3);
  assert.equal(plan.totalMs, 11_000);

  assert.equal(showcaseDividerAt(plan, 0), 0);
  assert.equal(showcaseDividerAt(plan, 3999), 0, "A solo holds the divider left");
  assert.ok(Math.abs(showcaseDividerAt(plan, 5500) - 0.5) < 1e-9, "mid-crossfade = 0.5");
  assert.equal(showcaseDividerAt(plan, 7000), 1);
  assert.equal(showcaseDividerAt(plan, 10_999), 1, "B solo holds the divider right");

  // Feature labels follow the phases.
  assert.equal(plan.phases[0].feature, "a");
  assert.equal(plan.phases[1].feature, "both");
  assert.equal(plan.phases[2].feature, "b");
});

test("showcase options are clamped to sane lengths", () => {
  const plan = buildShowcasePlan({ aMs: 0, crossfadeMs: 1, bMs: 100_000 });
  assert.ok(plan.phases[0].endMs >= 500);
  assert.ok(plan.phases[1].endMs - plan.phases[1].startMs >= 250);
  assert.ok(plan.totalMs <= 90_000, `total ${plan.totalMs}`);
});
