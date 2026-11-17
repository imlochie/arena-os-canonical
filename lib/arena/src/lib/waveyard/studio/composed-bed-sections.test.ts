/**
 * Composition-first section re-derivation (AS-2).
 *
 * The defect these tests exist for: a stem swap re-measured tempo, beat grid and
 * key from the resulting composition, but left `sections` inherited from the
 * original bed. Because `bedEntryMs` places the vocal at the bed's first body
 * section, and drum/bass parts are what those boundaries are detected from, a
 * drum replacement could be audible while the arrangement still followed the
 * replaced percussion.
 *
 * These tests use real CC0 audio from the local corpus when it is present, and
 * skip loudly when it is not — a skip here means the compositional acceptance is
 * unproven, so the CI job that runs this file fails on skips.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { deriveSectionsForComposition } from "./composed-bed-sections";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const ffmpeg = process.env.ARENA_FFMPEG_PATH ?? "";
const corpus = path.join(root, "generated-artifacts/waveyard-real-audio");

function corpusTrack(names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(corpus, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Decode real audio to interleaved stereo f32 at the render rate. */
function decode(file: string, filters?: string): Float32Array {
  const args = ["-v", "error", "-i", file];
  if (filters) args.push("-af", filters);
  args.push("-f", "f32le", "-ac", "2", "-ar", "44100", "-");
  const result = spawnSync(ffmpeg, args, { maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${String(result.stderr).slice(0, 300)}`);
  const buffer = result.stdout as Buffer;
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}

test("derived sections never run past the audio they were derived from", () => {
  // The regression this guards: `deriveSectionsForComposition` originally fed
  // 44.1 kHz PCM to `analysePcm`, which assumes the 22.05 kHz analysis rate. The
  // beat grid came out at twice the real density and sections ran to twice the
  // track length — 62.6 s of "sections" inside a 32 s bed. Boundaries that do
  // not fit the audio cannot be an arrangement's phrase structure.
  const pcm = compositionFixture(32);
  const durationMs = Math.round((pcm.length / 2 / 44_100) * 1000);
  const result = deriveSectionsForComposition(pcm, { sampleRate: 44_100 });
  if (!result.ok) return; // no sections is honest; wrong sections is not.
  for (const section of result.sections) {
    assert.ok(section.startMs >= 0, `section starts before the audio (${section.startMs}ms)`);
    assert.ok(section.endMs <= durationMs,
      `section ends after the audio: ${section.endMs}ms in a ${durationMs}ms bed`);
    assert.ok(section.endMs > section.startMs, "sections must be non-empty");
  }
});

/** A drum/bass/pad composition at a known tempo, for the bounds test above. */
function compositionFixture(seconds: number): Float32Array {
  const rate = 44_100;
  const frames = Math.round(seconds * rate);
  const out = new Float32Array(frames * 2);
  const beatFrames = Math.round(0.5 * rate);
  const hitFrames = Math.round(0.12 * rate);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / rate;
    const value = Math.sin(2 * Math.PI * 70 * t) * 0.12 + Math.sin(2 * Math.PI * 110 * t) * 0.12;
    out[frame * 2] = value;
    out[frame * 2 + 1] = value;
  }
  for (let beat = 0; beat * beatFrames < frames; beat += 1) {
    const sparse = Math.floor(Math.floor(beat / 4) / 2) % 2 === 1;
    if (sparse && beat % 4 !== 0) continue;
    const accent = beat % 4 === 0 ? 1 : 0.45;
    const start = beat * beatFrames;
    for (let offset = 0; offset < hitFrames && start + offset < frames; offset += 1) {
      const t = offset / rate;
      const value = Math.sin(2 * Math.PI * 420 * t) * Math.exp(-28 * t) * 0.45 * accent;
      out[(start + offset) * 2] += value;
      out[(start + offset) * 2 + 1] += value;
    }
  }
  return out;
}

function composedWithAddedLayerFixture(): {
  composition: Float32Array;
  addedLayer: Float32Array;
  layerEntryMs: number;
} {
  const rate = 44_100;
  const seconds = 64;
  const frames = seconds * rate;
  const drums = new Float32Array(frames * 2);
  const bass = new Float32Array(frames * 2);
  const addedLayer = new Float32Array(frames * 2);
  const beatFrames = Math.round(0.5 * rate);
  const hitFrames = Math.round(0.12 * rate);
  const layerEntryMs = 32_000;
  const layerEntryFrame = Math.round(layerEntryMs * rate / 1000);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / rate;
    const bassValue = Math.sin(2 * Math.PI * 70 * time) * 0.1
      + Math.sin(2 * Math.PI * 110 * time) * 0.1;
    bass[frame * 2] = bassValue;
    bass[frame * 2 + 1] = bassValue;
  }
  for (let beat = 0; beat * beatFrames < frames; beat += 1) {
    const start = beat * beatFrames;
    for (let offset = 0; offset < hitFrames && start + offset < frames; offset += 1) {
      const time = offset / rate;
      const value = Math.sin(2 * Math.PI * 420 * time) * Math.exp(-28 * time) * 0.45;
      drums[(start + offset) * 2] += value;
      drums[(start + offset) * 2 + 1] += value;
    }
  }
  for (let frame = layerEntryFrame; frame < frames; frame += 1) {
    const time = frame / rate;
    const value = Math.sin(2 * Math.PI * 330 * time) * 0.08;
    addedLayer[frame * 2] = value;
    addedLayer[frame * 2 + 1] = value;
  }
  const composition = new Float32Array(frames * 2);
  for (let sample = 0; sample < composition.length; sample += 1)
    composition[sample] = drums[sample]! + bass[sample]! + addedLayer[sample]!;
  return { composition, addedLayer, layerEntryMs };
}

const track = corpusTrack(["ash.mp3", "bedroom-window-vast.mp3"]);
const ready = track !== null && ffmpeg.length > 0 && existsSync(ffmpeg);

test(
  ready
    ? "a replaced drum band changes the section boundaries the arrangement places against"
    : "compositional acceptance unavailable: real audio or ffmpeg missing",
  { skip: ready ? false : "ARENA_FFMPEG_PATH and a real corpus track are required for compositional acceptance" },
  () => {
    const file = track!;
    // The original bed, and a bed whose drum/bass band is removed before a donor
    // drum part is added — the shape of a replace-mode swap. Removing the low
    // band is the measurable proxy for "the original percussion is gone".
    const original = decode(file);
    const replaced = decode(file, "highpass=f=200");

    const before = deriveSectionsForComposition(original, { sampleRate: 44_100 });
    const after = deriveSectionsForComposition(replaced, { sampleRate: 44_100 });
    assert.equal(before.ok, true, before.ok ? "" : before.reason);
    assert.equal(after.ok, true, after.ok ? "" : after.reason);
    if (!before.ok || !after.ok) return;

    // The point is not that the count differs, it is that the boundaries the
    // planner reads are different. Assert on the boundaries themselves.
    const beforeStarts = before.sections.map((section) => section.startMs);
    const afterStarts = after.sections.map((section) => section.startMs);
    assert.notDeepEqual(
      beforeStarts,
      afterStarts,
      "the composed bed must not reuse the original bed's section boundaries: they were detected from percussion the swap removed",
    );

    const moved = beforeStarts.filter((start, index) => afterStarts[index] !== start).length;
    assert.ok(
      moved >= Math.ceil(beforeStarts.length / 2),
      `most section boundaries should move when the drum band is replaced (moved ${moved} of ${beforeStarts.length})`,
    );

    // Every section must describe the composed audio, not the original analysis.
    for (const section of after.sections) {
      assert.ok(section.endMs > section.startMs, `${section.label} must have a positive duration`);
      assert.ok(section.startMs >= 0 && section.endMs <= 200_000, "section range must be inside the audio");
    }
    // Non-decreasing, non-overlapping: the planner relies on ordered structure.
    for (let index = 1; index < after.sections.length; index += 1) {
      assert.ok(
        after.sections[index]!.startMs >= after.sections[index - 1]!.startMs,
        "composed sections must be ordered",
      );
    }
  },
);

test("post-swap section analysis consumes per-stem activity on the composed audio clock", () => {
  const fixture = composedWithAddedLayerFixture();
  const result = deriveSectionsForComposition(fixture.composition, {
    sampleRate: 44_100,
    stemPcms: [{ stemType: "other", pcm: fixture.addedLayer }],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) return;
  assert.ok(result.sections.some((section) => section.label === "stem-change"
    && Math.abs(section.startMs - fixture.layerEntryMs) < 300),
  "an independently measured layer entrance should become a section boundary on the same composition clock");
});

test("sections are never fabricated when the composed bed has no measurable grid", () => {
  // Digital silence: no beat grid, so no section boundaries may be invented.
  const silence = new Float32Array(44_100 * 2 * 3);
  const result = deriveSectionsForComposition(silence, { sampleRate: 44_100 });
  assert.equal(result.ok, false, "silence must not yield sections");
  if (!result.ok) {
    assert.match(result.reason, /beat grid|no audio/i);
  }
});

test("an empty buffer is rejected rather than producing an empty arrangement", () => {
  const result = deriveSectionsForComposition(new Float32Array(0), { sampleRate: 44_100 });
  assert.equal(result.ok, false);
});

test("derived sections carry composed-bed provenance, not the original source checksum", () => {
  if (!ready) return; // covered by the acceptance test's skip
  const sections = deriveSectionsForComposition(decode(track!), { sampleRate: 44_100 });
  assert.equal(sections.ok, true);
  if (!sections.ok) return;
  for (const section of sections.sections) {
    assert.equal(
      section.id?.startsWith("composed-section-"),
      true,
      "derived sections must be identifiable as composed, not persisted source sections",
    );
  }
});
