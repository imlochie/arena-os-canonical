/**
 * Library collections tests — rating/label normalization, smart-rule
 * evaluation (all/any), time-explicit matching, and serialization.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTIONS_FORMAT,
  evaluateCollection,
  evaluateRule,
  filterByCollection,
  groupByCollections,
  normalizeLabels,
  normalizeRating,
  parseSmartCollections,
  serializeSmartCollections,
  type CollectionTrack,
  type SmartCollection,
} from "./collections";

const NOW = 1_750_000_000_000; // fixed clock: 2025-06-15T13:46:40Z-ish
const DAY_MS = 86_400_000;

function track(overrides: Partial<CollectionTrack> = {}): CollectionTrack {
  return {
    id: "t-1",
    title: "Night Drive",
    artist: "Neon Cafe",
    addedAtMs: NOW - 10 * DAY_MS,
    playCount: 4,
    durationSeconds: 210,
    rating: 3,
    labels: ["driving", "synthwave"],
    ...overrides,
  };
}

test("normalizeRating clamps and rounds to 0..5", () => {
  assert.equal(normalizeRating(4), 4);
  assert.equal(normalizeRating(4.6), 5);
  assert.equal(normalizeRating(-3), 0);
  assert.equal(normalizeRating(99), 5);
  assert.equal(normalizeRating(Number.NaN), 0);
  assert.equal(normalizeRating("3" as unknown), 0);
});

test("normalizeLabels trims, dedupes case-insensitively, caps length", () => {
  assert.deepEqual(normalizeLabels(["  Driving ", "driving", "DRIVING"]), ["Driving"]);
  assert.deepEqual(normalizeLabels(["a", "", "  ", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeLabels("nope" as unknown), []);
  assert.deepEqual(normalizeLabels([3, null, undefined]), []);
  const many = normalizeLabels(Array.from({ length: 50 }, (_, i) => `label-${i}`));
  assert.equal(many.length, 32);
  const long = normalizeLabels(["x".repeat(200)]);
  assert.equal(long[0].length, 64);
});

test("text rules: is and contains are case-insensitive; numeric ops never match text", () => {
  const t = track();
  assert.equal(evaluateRule(t, { field: "title", op: "is", value: "night drive" }, NOW), true);
  assert.equal(evaluateRule(t, { field: "title", op: "is", value: "night" }, NOW), false);
  assert.equal(evaluateRule(t, { field: "artist", op: "contains", value: "neon" }, NOW), true);
  assert.equal(evaluateRule(t, { field: "title", op: "contains", value: "" }, NOW), false);
  assert.equal(evaluateRule(t, { field: "title", op: ">=", value: 1 }, NOW), false);
});

test("label rules match any label", () => {
  const t = track();
  assert.equal(evaluateRule(t, { field: "label", op: "is", value: "Synthwave" }, NOW), true);
  assert.equal(evaluateRule(t, { field: "label", op: "is", value: "jazz" }, NOW), false);
  assert.equal(evaluateRule(t, { field: "label", op: "contains", value: "synth" }, NOW), true);
  assert.equal(evaluateRule(track({ labels: undefined }), { field: "label", op: "is", value: "synthwave" }, NOW), false);
});

test("numeric rules: rating, playCount, durationSeconds", () => {
  const t = track();
  assert.equal(evaluateRule(t, { field: "rating", op: ">=", value: 3 }, NOW), true);
  assert.equal(evaluateRule(t, { field: "rating", op: "<=", value: 2 }, NOW), false);
  assert.equal(evaluateRule(t, { field: "rating", op: "is", value: 3 }, NOW), true);
  assert.equal(evaluateRule(t, { field: "playCount", op: ">=", value: 5 }, NOW), false);
  assert.equal(evaluateRule(t, { field: "durationSeconds", op: "<=", value: 240 }, NOW), true);
  // Missing numeric fields never match.
  assert.equal(evaluateRule(track({ playCount: undefined }), { field: "playCount", op: ">=", value: 0 }, NOW), false);
});

test("addedDaysAgo compares whole days against the explicit clock", () => {
  const t = track(); // added 10 days before NOW
  assert.equal(evaluateRule(t, { field: "addedDaysAgo", op: "<=", value: 14 }, NOW), true);
  assert.equal(evaluateRule(t, { field: "addedDaysAgo", op: ">=", value: 30 }, NOW), false);
  assert.equal(evaluateRule(t, { field: "addedDaysAgo", op: "is", value: 10 }, NOW), true);
  // Partial days floor toward zero.
  const fresh = track({ addedAtMs: NOW - 3 * DAY_MS - 1000 });
  assert.equal(evaluateRule(fresh, { field: "addedDaysAgo", op: "is", value: 3 }, NOW), true);
  // A future addedAt clamps to 0 days.
  assert.equal(evaluateRule(track({ addedAtMs: NOW + DAY_MS }), { field: "addedDaysAgo", op: "is", value: 0 }, NOW), true);
  assert.equal(evaluateRule(track({ addedAtMs: undefined }), { field: "addedDaysAgo", op: "<=", value: 999 }, NOW), false);
});

test("collections combine rules with all/any; empty rules match everything", () => {
  const recent: SmartCollection = {
    id: "c-recent",
    name: "Recently added",
    match: "all",
    rules: [
      { field: "addedDaysAgo", op: "<=", value: 14 },
      { field: "rating", op: ">=", value: 3 },
    ],
  };
  assert.equal(evaluateCollection(track(), recent, NOW), true);
  assert.equal(evaluateCollection(track({ rating: 1 }), recent, NOW), false);
  assert.equal(evaluateCollection(track({ addedAtMs: NOW - 60 * DAY_MS }), recent, NOW), false);

  const anyRule: SmartCollection = {
    id: "c-any",
    name: "Driving or favourites",
    match: "any",
    rules: [
      { field: "label", op: "is", value: "driving" },
      { field: "rating", op: ">=", value: 5 },
    ],
  };
  assert.equal(evaluateCollection(track(), anyRule, NOW), true); // label matches
  assert.equal(evaluateCollection(track({ labels: [] }), anyRule, NOW), false); // neither

  const empty: SmartCollection = { id: "c-all", name: "All tracks", match: "all", rules: [] };
  assert.equal(evaluateCollection(track(), empty, NOW), true);
});

test("filterByCollection preserves order; groupByCollections buckets per id", () => {
  const tracks = [
    track({ id: "a", rating: 5 }),
    track({ id: "b", rating: 1 }),
    track({ id: "c", rating: 4 }),
  ];
  const favourites: SmartCollection = {
    id: "favs",
    name: "Favourites",
    match: "all",
    rules: [{ field: "rating", op: ">=", value: 4 }],
  };
  assert.deepEqual(filterByCollection(tracks, favourites, NOW).map((t) => t.id), ["a", "c"]);

  const groups = groupByCollections(tracks, [favourites, { id: "all", name: "All", match: "all", rules: [] }], NOW);
  assert.deepEqual(groups.favs.map((t) => t.id), ["a", "c"]);
  assert.equal(groups.all.length, 3);
});

test("serialization round-trips and rejects foreign formats", () => {
  const collections: SmartCollection[] = [
    {
      id: "c-1",
      name: "Late night",
      match: "any",
      rules: [{ field: "label", op: "contains", value: "night" }],
    },
  ];
  const text = serializeSmartCollections(collections);
  assert.deepEqual(parseSmartCollections(text), collections);
  // Empty and null parse to []; junk and foreign formats are rejected.
  assert.deepEqual(parseSmartCollections(""), []);
  assert.deepEqual(parseSmartCollections(null), []);
  assert.equal(parseSmartCollections("{not json"), null);
  assert.equal(parseSmartCollections(JSON.stringify({ format: "something-else", collections: [] })), null);
  assert.equal(
    parseSmartCollections(JSON.stringify({ format: COLLECTIONS_FORMAT, collections: [{ id: "x", name: "Y", match: "xor", rules: [] }] })),
    null,
  );
});
