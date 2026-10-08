/**
 * Listening-layer domain model tests (docs/waveyard-evolution-plan.md P1).
 *
 * These rules are the ONE definition shared by the player, session, and API
 * layers — so their edge cases are pinned here: the four-default-channel
 * view (N-stem capable), honest stem availability (including the engine's
 * passthrough-unseparated bridge), stem-mix validation/clamping/persistence
 * round-trips, and intake metadata derivation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STEM_CHANNEL_TYPES,
  PASSTHROUGH_ENGINE,
  buildStemChannels,
  deriveTrackMetadata,
  libraryContainerProjectName,
  normalizeStemMix,
  parseStemMix,
  resolveStemAvailability,
  serializeStemMix,
  withUnityDefaults,
} from "./model";

test("buildStemChannels: the four defaults render in stable order, all available when separated", () => {
  const channels = buildStemChannels(["drums", "other", "vocals", "bass"]);
  assert.deepEqual(
    channels.map((channel) => channel.stemType),
    ["vocals", "drums", "bass", "other"],
  );
  assert.ok(channels.every((channel) => channel.available));
  assert.equal(channels[3].label, "Melody", "the 'other' stem is displayed as Melody");
});

test("buildStemChannels: missing stems stay visible but honestly unavailable", () => {
  const channels = buildStemChannels(["vocals", "bass"]);
  const byType = Object.fromEntries(channels.map((channel) => [channel.stemType, channel]));
  assert.equal(byType.vocals.available, true);
  assert.equal(byType.drums.available, false);
  assert.equal(byType.bass.available, true);
  assert.equal(byType.other.available, false);
});

test("buildStemChannels: extra stem types beyond the four are appended (no four-stem hard-coding)", () => {
  const channels = buildStemChannels(["vocals", "drums", "bass", "other", "piano"]);
  assert.equal(channels.length, 5);
  const piano = channels[channels.length - 1];
  assert.equal(piano.stemType, "piano");
  assert.equal(piano.label, "Piano");
  assert.equal(piano.available, true);
});

test("resolveStemAvailability: real separated stems", () => {
  const availability = resolveStemAvailability({
    stems: [
      { stemType: "vocals", engine: "demucs" },
      { stemType: "drums", engine: "demucs" },
      { stemType: "bass", engine: "demucs" },
      { stemType: "other", engine: "demucs" },
    ],
  });
  assert.deepEqual(availability, { status: "separated", stemCount: 4 });
});

test("resolveStemAvailability: passthrough bridge = source-only, with the honest reason", () => {
  const availability = resolveStemAvailability({
    stems: [{ stemType: "source", engine: PASSTHROUGH_ENGINE }],
  });
  assert.equal(availability.status, "source-only");
  assert.match(availability.reason, /unseparated source/);
});

test("resolveStemAvailability: separation pending = processing", () => {
  const availability = resolveStemAvailability({ stems: [], separationPending: true });
  assert.equal(availability.status, "processing");
  assert.match(availability.reason, /still running/);
});

test("resolveStemAvailability: nothing at all = unavailable with a real reason", () => {
  const availability = resolveStemAvailability({ stems: [] });
  assert.equal(availability.status, "unavailable");
  assert.match(availability.reason, /No stems exist/);
});

test("normalizeStemMix: clamps to 0..2, drops junk, keeps valid values", () => {
  const mix = normalizeStemMix({
    vocals: 0.8,
    drums: 10, // clamped down
    bass: -3, // clamped to 0
    other: "0.5", // numeric string tolerated
    garbage: "not-a-number",
    "": 1,
  });
  assert.deepEqual(mix, { vocals: 0.8, drums: 2, bass: 0, other: 0.5 });
});

test("normalizeStemMix: non-object input yields an empty mix, never throws", () => {
  assert.deepEqual(normalizeStemMix(null), {});
  assert.deepEqual(normalizeStemMix(undefined), {});
  assert.deepEqual(normalizeStemMix("vocals"), {});
  assert.deepEqual(normalizeStemMix(42), {});
  assert.deepEqual(normalizeStemMix(Number.NaN), {});
});

test("withUnityDefaults: complete mix for every channel without inventing gains", () => {
  const mix = withUnityDefaults({ vocals: 0.4 }, DEFAULT_STEM_CHANNEL_TYPES);
  assert.deepEqual(mix, { vocals: 0.4, drums: 1, bass: 1, other: 1 });
});

test("stem-mix persistence round-trip is lossless for valid mixes", () => {
  const original = { vocals: 0.8, drums: 0, bass: 1.5, other: 1 };
  const parsed = parseStemMix(serializeStemMix(original));
  assert.deepEqual(parsed, original);
});

test("parseStemMix: corrupt persisted JSON degrades to empty (unity), never crashes playback", () => {
  assert.deepEqual(parseStemMix("{not json"), {});
  assert.deepEqual(parseStemMix(null), {});
  assert.deepEqual(parseStemMix(""), {});
  assert.deepEqual(parseStemMix('{"vocals": "louder please"}'), {});
});

test("deriveTrackMetadata: 'Artist - Title' split on the first separator only", () => {
  assert.deepEqual(deriveTrackMetadata("Aphex Twin - Windowlicker.mp3"), {
    artist: "Aphex Twin",
    title: "Windowlicker",
  });
  // Second separator stays in the title (feat./remix text is part of it).
  assert.deepEqual(deriveTrackMetadata("Artist - Song - Live.mp3"), {
    artist: "Artist",
    title: "Song - Live",
  });
});

test("deriveTrackMetadata: leading track numbers are stripped", () => {
  assert.deepEqual(deriveTrackMetadata("07 - Artist - Title.wav"), { artist: "Artist", title: "Title" });
  assert.deepEqual(deriveTrackMetadata("07. Artist - Title.flac"), { artist: "Artist", title: "Title" });
  assert.deepEqual(deriveTrackMetadata("07_Title.mp3"), { title: "07_Title", artist: "" });
});

test("deriveTrackMetadata: no separator = filename (minus extension) as title", () => {
  assert.deepEqual(deriveTrackMetadata("Windowlicker.mp3"), { title: "Windowlicker", artist: "" });
  assert.deepEqual(deriveTrackMetadata("some.dir/track name.ogg"), { title: "some.dir/track name", artist: "" });
});

test("deriveTrackMetadata: degenerate inputs never throw", () => {
  assert.deepEqual(deriveTrackMetadata(".mp3"), { title: ".mp3", artist: "" });
  assert.deepEqual(deriveTrackMetadata(""), { title: "", artist: "" });
  assert.deepEqual(deriveTrackMetadata("   "), { title: "   ", artist: "" });
});

test("libraryContainerProjectName: library containers are recognizably named", () => {
  assert.equal(libraryContainerProjectName("Windowlicker"), "Library · Windowlicker");
});
