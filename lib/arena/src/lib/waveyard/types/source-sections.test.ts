import "../worker-local/_separation-test-env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  displaySourceSectionLabel,
  normalizeSourceSections,
  sourceSectionStatus,
  sourceSectionsAreValid,
} from "./source-sections";
import { desktopSectionId } from "../worker-local/sections";
import { desktopSectionIdempotencyKey } from "../worker-local/analysis";

test("source section normalization preserves a supported structural role label", () => {
  const beatGrid = Array.from({ length: 33 }, (_, index) => index * 500);
  const sections = normalizeSourceSections(
    [{
      startBeatIndex: 0,
      endBeatIndex: 16,
      label: "chorus",
      labelConfidence: 0.91,
      structuralConfidence: 0.84,
    }],
    beatGrid,
    {
      analysisEngine: "test-structure",
      analysisEngineVersion: "test-1",
      sourceChecksumSha256: "a".repeat(64),
    },
    ({ sectionIndex }) => `section-${sectionIndex}`,
  );

  assert.equal(sections[0]?.label, "chorus");
  assert.equal(sourceSectionsAreValid(sections, beatGrid), true);
  assert.equal(displaySourceSectionLabel(sections[0]), "Chorus");
});

test("source section normalization discards empty role labels", () => {
  const beatGrid = Array.from({ length: 33 }, (_, index) => index * 500);
  const sections = normalizeSourceSections(
    [{
      startBeatIndex: 0,
      endBeatIndex: 16,
      label: "   ",
      labelConfidence: 1,
      structuralConfidence: 1,
    }],
    beatGrid,
    {
      analysisEngine: "test-structure",
      analysisEngineVersion: "test-1",
      sourceChecksumSha256: "b".repeat(64),
    },
    ({ sectionIndex }) => `section-${sectionIndex}`,
  );

  assert.deepEqual(sections, []);
});

test("source section repeats show their measured similarity instead of probability-style confidence", () => {
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 0, label: "rhythm-repeat-a", labelConfidence: 0.94 }),
    "Repeated rhythm A · 94% rhythm similarity",
  );
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 1, label: "rhythm-repeat-b", labelConfidence: 0.7 }),
    "Candidate rhythm B · 70% rhythm similarity",
  );
  assert.equal(displaySourceSectionLabel({ sectionIndex: 2, label: "section", labelConfidence: 0 }), "Section 3");
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 3, label: "stem-change", labelConfidence: 0.75 }),
    "Stem activity shift · normalized signal strength 75%",
  );
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 3, label: "vocal-change", labelConfidence: 0.65 }),
    "Vocal activity shift · sustained presence change 65%",
  );
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 3, label: "pattern-repeat-a", labelConfidence: 0.94 }),
    "Repeated audio pattern A · 94% rhythm+chroma similarity",
  );
  assert.equal(
    displaySourceSectionLabel({ sectionIndex: 3, label: "vocal-pattern-repeat-a", labelConfidence: 0.94 }),
    "Repeated audio pattern A · 94% rhythm+chroma and vocal-activity agreement",
  );
  assert.equal(displaySourceSectionLabel({ sectionIndex: 4, label: "energy-rise", labelConfidence: 0.6 }), "Possible Dynamic rise");
});

test("normalizes deterministic ordered beat/bar ranges and their provenance", () => {
  const grid = Array.from({ length: 25 }, (_, index) => index * 500);
  const provenance = {
    analysisEngine: "test-engine",
    analysisEngineVersion: "1.0.0",
    sourceChecksumSha256: "checksum-a",
  };
  const result = normalizeSourceSections([
    { startBeatIndex: 8, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.7 },
    { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: -2, structuralConfidence: 2 },
    { startBeatIndex: 16, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.5 },
  ], grid, provenance, ({ startBeatIndex, endBeatIndex, sectionIndex }) => `stable:${sectionIndex}:${startBeatIndex}:${endBeatIndex}`);

  assert.equal(result.length, 3);
  assert.equal(result[0]?.id, "stable:0:0:8");
  assert.equal(result[0]?.sectionIndex, 0);
  assert.equal(result[0]?.startMs, 0);
  assert.equal(result[0]?.endMs, 4000);
  assert.equal(result[0]?.startBar, 1);
  assert.equal(result[0]?.endBar, 2);
  assert.equal(result[0]?.structuralConfidence, 1);

  assert.equal(result[1]?.id, "stable:1:8:16");
  assert.equal(result[1]?.startMs, 4000);
  assert.equal(result[1]?.endMs, 8000);

  assert.equal(result[2]?.id, "stable:2:16:24");
  assert.equal(result[2]?.startMs, 8000);
  assert.equal(result[2]?.endMs, 12000);

  assert.equal(sourceSectionsAreValid(result, grid), true);
});

test("normalizes the one-past-last exclusive beat boundary and clamps it to source duration", () => {
  const grid = Array.from({ length: 8 }, (_, index) => index * 500);
  const provenance = {
    analysisEngine: "test-engine",
    analysisEngineVersion: "1.0.0",
    sourceChecksumSha256: "checksum-tail",
  };
  const candidate = [{
    startBeatIndex: 0,
    endBeatIndex: grid.length,
    label: "section",
    labelConfidence: 0,
    structuralConfidence: 0.8,
  }];
  const result = normalizeSourceSections(candidate, grid, provenance, () => "tail-section", 3_900);

  assert.equal(result.length, 1);
  assert.equal(result[0]?.endBeatIndex, grid.length);
  assert.equal(result[0]?.endMs, 3_900);
  assert.equal(sourceSectionsAreValid(result, grid, 3_900), true);
  assert.equal(sourceSectionsAreValid(result, grid, 3_899), false);
});

test("suppresses duplicate and overlapping candidates without fabricating a whole-song range", () => {
  const grid = Array.from({ length: 25 }, (_, index) => index * 500);
  const provenance = {
    analysisEngine: "test-engine",
    analysisEngineVersion: "1.0.0",
    sourceChecksumSha256: "checksum-a",
  };
  const result = normalizeSourceSections([
    { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.4 },
    { startBeatIndex: 0, endBeatIndex: 8, label: "section", labelConfidence: 0, structuralConfidence: 0.9 },
    { startBeatIndex: 7, endBeatIndex: 16, label: "section", labelConfidence: 0, structuralConfidence: 0.7 },
    { startBeatIndex: 16, endBeatIndex: 24, label: "section", labelConfidence: 0, structuralConfidence: 0.6 },
  ], grid, provenance, ({ startBeatIndex, endBeatIndex }) => `${startBeatIndex}:${endBeatIndex}`);

  assert.deepEqual(result.map(({ startBeatIndex, endBeatIndex }) => [startBeatIndex, endBeatIndex]), [[0, 8], [16, 24]]);
  assert.deepEqual(normalizeSourceSections([], grid, provenance, () => "never"), []);
  assert.deepEqual(normalizeSourceSections([{ startBeatIndex: 0, endBeatIndex: 1, label: "section", labelConfidence: 0, structuralConfidence: 1 }], null, provenance, () => "never"), []);
});

test("reports historical/no-grid inputs explicitly instead of a false complete empty result", () => {
  const grid = Array.from({ length: 25 }, (_, index) => index * 500);
  assert.equal(sourceSectionStatus(undefined, undefined, undefined), "insufficient_analysis");
  assert.equal(sourceSectionStatus(undefined, "complete", grid), "not_started");
  assert.equal(sourceSectionStatus("processing", "complete", grid), "processing");
  assert.equal(sourceSectionStatus("unavailable", "complete", grid), "unavailable");
  assert.equal(sourceSectionStatus("complete", "failed", grid), "insufficient_analysis");
});

test("does not collide section identities when separate source assets share a checksum", () => {
  const first = desktopSectionId("source-a", "same-audio-checksum", 0, 16);
  const duplicate = desktopSectionId("source-a", "same-audio-checksum", 0, 16);
  const secondUpload = desktopSectionId("source-b", "same-audio-checksum", 0, 16);
  assert.equal(first, duplicate);
  assert.notEqual(secondUpload, first);
});

test("uses stable lifecycle idempotency on retry", () => {
  const sourceId = "source-a";
  assert.equal(desktopSectionIdempotencyKey(sourceId), desktopSectionIdempotencyKey(sourceId));
});
