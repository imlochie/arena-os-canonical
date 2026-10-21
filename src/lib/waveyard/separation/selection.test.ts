/**
 * Separation selection tests — the choice surface the UI offers and the
 * server-side validation of requested targets.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { defaultSeparationModel, isAcceptableSeparationModel, separationModelChoices } from "./selection";
import { MDX_MODELS } from "./mdx";
import { DEEP_MODEL_ID, DEEP_STEM_TYPES, separationTargetOptions } from "./modes";

test("the offered choices are the fast default plus every recipe", () => {
  const choices = separationModelChoices();
  assert.equal(choices[0].id, MDX_MODELS[0].id);
  assert.equal(choices[0].stemCount, 2);
  const fourStem = choices.find((choice) => choice.id === "stems_4");
  assert.ok(fourStem !== undefined);
  assert.equal(fourStem.stemCount, 4);
});

test("the deep pass is offered with its six lanes and its own engine", () => {
  const choices = separationModelChoices();
  const deep = choices.find((choice) => choice.id === DEEP_MODEL_ID);
  assert.ok(deep !== undefined, "deep mode offered");
  assert.equal(deep!.stemCount, DEEP_STEM_TYPES.length);
  assert.equal(deep!.engine, "demucs");

  // The intake selects and the server choices agree — one registry.
  const targetIds = separationTargetOptions().map((target) => target.id);
  assert.ok(targetIds.includes(DEEP_MODEL_ID));
  assert.ok(targetIds.includes(""));
  assert.ok(targetIds.includes("stems_4"));
});

test("acceptable model ids cover registry models and recipes, nothing else", () => {
  for (const model of MDX_MODELS) assert.equal(isAcceptableSeparationModel(model.id), true);
  assert.equal(isAcceptableSeparationModel("stems_4"), true);
  assert.equal(isAcceptableSeparationModel(DEEP_MODEL_ID), true, "the deep mode is a valid target");
  // htdemucs is the server worker's model: acceptable exactly when it is
  // this machine's resolved default (the local registry doesn't know it).
  assert.equal(isAcceptableSeparationModel("htdemucs"), defaultSeparationModel() === "htdemucs");
  assert.equal(isAcceptableSeparationModel("../etc/passwd"), false);
});

test("default separation model is registry-acceptable on this machine", () => {
  assert.equal(isAcceptableSeparationModel(defaultSeparationModel()), true);
});

test("native trained four-source Demucs is explicit and never aliases the MDX four recipe", () => {
  const native = separationModelChoices().find(choice => choice.id === "deep_4s");
  assert.equal(native?.engine, "demucs"); assert.equal(native?.stemCount, 4);
  assert.equal(isAcceptableSeparationModel("deep_4s"), true);
  assert.equal(separationModelChoices().find(choice => choice.id === "stems_4")?.engine, "mdx");
  assert.ok(separationTargetOptions().some(choice => choice.id === "deep_4s"));
});
