import assert from "node:assert/strict";
import test from "node:test";

import { displaySourceSectionLabel, normalizeSourceSections, sourceSectionsAreValid } from "./source-sections";

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

test("source section labels distinguish uncertain repeats from numbered cuts", () => {
  assert.equal(displaySourceSectionLabel({ sectionIndex: 0, label: "rhythm-repeat-a", labelConfidence: 0.94 }), "Repeated rhythm A");
  assert.equal(displaySourceSectionLabel({ sectionIndex: 1, label: "rhythm-repeat-b", labelConfidence: 0.7 }), "Possible Repeated rhythm B");
  assert.equal(displaySourceSectionLabel({ sectionIndex: 2, label: "section", labelConfidence: 0 }), "Section 3");
});
