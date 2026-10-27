/**
 * Display-name regression tests: the deep pass's `other` lane is "Other",
 * never the MDX recipe's "Melody" — and the engine vocabulary follows each
 * segment of a layered stem to the engine that produced it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEEP_MODEL_ID, DEEP_STEM_TYPES } from "./modes";
import { laneDisplayName, parentLaneModel, stemDisplayName } from "./stem-display";

test("MDX stems keep the product vocabulary: `other` is the Melody lane", () => {
  assert.equal(stemDisplayName("vocals", { model: "kim_vocal_2" }), "Vocals");
  assert.equal(stemDisplayName("instrumental", { model: "kim_vocal_2" }), "Instrumental");
  assert.equal(stemDisplayName("other", { model: "kuielab_b_other" }), "Melody");
  // No model known at all (legacy callers): the MDX vocabulary, unchanged.
  assert.equal(stemDisplayName("other"), "Melody");
});

test("deep stems: `other` is the residual and reads Other — guitar and piano are their own lanes", () => {
  assert.deepEqual(
    DEEP_STEM_TYPES.map((stemType) => stemDisplayName(stemType, { model: DEEP_MODEL_ID })),
    ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
  );
  assert.notEqual(stemDisplayName("other", { model: DEEP_MODEL_ID }), "Melody", "the deep residual must never claim to be the melody");
});

test("layered stems name each segment by the engine that produced it", () => {
  // The flagship flow: the deep pass run on the MDX Melody lane.
  assert.equal(
    stemDisplayName("other/guitar", { model: DEEP_MODEL_ID, parentModel: "kuielab_b_other" }),
    "Melody · Guitar",
  );
  assert.equal(
    stemDisplayName("other/other", { model: DEEP_MODEL_ID, parentModel: "kuielab_b_other" }),
    "Melody · Other",
  );
  // Deep on deep: the parent IS the deep residual.
  assert.equal(
    stemDisplayName("other/vocals", { model: DEEP_MODEL_ID, parentModel: DEEP_MODEL_ID }),
    "Other · Vocals",
  );
  // MDX layers of an MDX stem (stem-layers): both segments in the MDX vocabulary.
  assert.equal(stemDisplayName("other/vocals", { model: "kim_vocal_2", parentModel: "kuielab_b_other" }), "Melody · Vocals");
  // Parent unknown: the MDX vocabulary for the parent, the stem's own engine for the child.
  assert.equal(stemDisplayName("vocals/other", { model: DEEP_MODEL_ID }), "Vocals · Other");
  assert.equal(stemDisplayName("other/guitar", { model: DEEP_MODEL_ID }), "Melody · Guitar");
});

test("laneDisplayName resolves the parent's engine among the rendered lanes — the same answer on every surface", () => {
  const source = "source-a";
  const mdxMelody = { stemType: "other", model: "kuielab_b_other", sourceAssetId: source };
  const deepOther = { stemType: "other", model: DEEP_MODEL_ID, sourceAssetId: source };

  // Deep on deep: the parent IS the deep residual → "Other · Vocals", never "Melody · Vocals".
  const deepOnDeep = { stemType: "other/vocals", model: DEEP_MODEL_ID, sourceAssetId: source };
  assert.equal(laneDisplayName(deepOnDeep, [deepOther, deepOnDeep]), "Other · Vocals");
  assert.equal(parentLaneModel(deepOnDeep, [deepOther, deepOnDeep]), DEEP_MODEL_ID);

  // The flagship flow: the deep pass run on the MDX Melody lane.
  const deepOfMelody = { stemType: "other/guitar", model: DEEP_MODEL_ID, sourceAssetId: source };
  assert.equal(laneDisplayName(deepOfMelody, [mdxMelody, deepOfMelody]), "Melody · Guitar");

  // MDX layers (stem-layers) pulled out of the deep residual: the parent's engine names the parent.
  const mdxOfDeep = { stemType: "other/vocals", model: "kim_vocal_2", sourceAssetId: source };
  assert.equal(laneDisplayName(mdxOfDeep, [deepOther, mdxOfDeep]), "Other · Vocals");

  // A same-typed lane of ANOTHER source is not this stem's parent.
  const otherSourceDeep = { stemType: "other", model: DEEP_MODEL_ID, sourceAssetId: "source-b" };
  assert.equal(parentLaneModel(deepOnDeep, [otherSourceDeep, deepOnDeep]), undefined);
  assert.equal(laneDisplayName(deepOnDeep, [otherSourceDeep, deepOnDeep]), "Melody · Vocals", "no parent lane in view → the documented MDX fallback");

  // Two parents of that type with different engines: ambiguous → the documented fallback, consistently.
  assert.equal(parentLaneModel(deepOnDeep, [mdxMelody, deepOther, deepOnDeep]), undefined);
  assert.equal(laneDisplayName(deepOnDeep, [mdxMelody, deepOther, deepOnDeep]), "Melody · Vocals");

  // Top-level lanes never look for a parent.
  assert.equal(parentLaneModel(deepOther, [mdxMelody, deepOther]), undefined);
  assert.equal(laneDisplayName(deepOther, [mdxMelody, deepOther]), "Other");
  assert.equal(laneDisplayName(mdxMelody, [mdxMelody, deepOther]), "Melody");
});
