/**
 * Separation selection tests — the choice surface the UI offers and the
 * server-side validation of requested targets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defaultSeparationModel, isAcceptableSeparationModel, separationModelChoices } from "./selection";
import { MDX_MODELS } from "./mdx";

test("the offered choices are the fast default plus every recipe", () => {
  const choices = separationModelChoices();
  assert.equal(choices[0].id, MDX_MODELS[0].id);
  assert.equal(choices[0].stemCount, 2);
  const fourStem = choices.find((choice) => choice.id === "stems_4");
  assert.ok(fourStem !== undefined);
  assert.equal(fourStem.stemCount, 4);
});

test("acceptable model ids cover registry models and recipes, nothing else", () => {
  for (const model of MDX_MODELS) assert.equal(isAcceptableSeparationModel(model.id), true);
  assert.equal(isAcceptableSeparationModel("stems_4"), true);
  // htdemucs is the server worker's model: acceptable exactly when it is
  // this machine's resolved default (the local registry doesn't know it).
  assert.equal(isAcceptableSeparationModel("htdemucs"), defaultSeparationModel() === "htdemucs");
  assert.equal(isAcceptableSeparationModel("../etc/passwd"), false);
});

test("default separation model is registry-acceptable on this machine", () => {
  assert.equal(isAcceptableSeparationModel(defaultSeparationModel()), true);
});
