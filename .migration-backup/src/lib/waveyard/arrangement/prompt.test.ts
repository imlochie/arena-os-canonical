/**
 * Prompt interpretation tests — the exact user example from the request:
 * "add some sinister sounding strings on this eminem beat" must map to
 * strings + sinister, with defaults honestly reported.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parsePromptToInstruction, validateAiInstruction } from "./prompt";

test("the canonical example: sinister strings on a beat", () => {
  const result = parsePromptToInstruction(
    "add some sinister sounding strings on this eminem beat",
    { sectionCount: 3 },
  );
  assert.equal(result.instruction.instrument, "strings");
  assert.equal(result.instruction.mood, "sinister");
  assert.deepEqual(result.instruction.targetSections, "all");
  assert.ok(result.interpretation.some((line) => line.includes("Instrument: strings")));
  assert.ok(result.interpretation.some((line) => line.includes("Mood: sinister")));
  // Defaults must be visible, not silent.
  assert.ok(result.usedDefaults.includes("density"));
  assert.ok(result.interpretation.some((line) => line.includes("Density: medium (default)")));
});

test("instrument synonyms and mood words map correctly", () => {
  const cello = parsePromptToInstruction("dark cello section", { sectionCount: 2 });
  assert.equal(cello.instruction.instrument, "strings");
  assert.equal(cello.instruction.mood, "dark");

  const vox = parsePromptToInstruction("ethereal choir voices, sparse, high", { sectionCount: 2 });
  assert.equal(vox.instruction.instrument, "choir");
  assert.equal(vox.instruction.mood, "dreamy");
  assert.equal(vox.instruction.density, "sparse");
  assert.equal(vox.instruction.register, "high");

  const bass = parsePromptToInstruction("deep 808 bass, dense", { sectionCount: 2 });
  assert.equal(bass.instruction.instrument, "sub-bass");
  assert.equal(bass.instruction.register, "low");
  assert.equal(bass.instruction.density, "dense");
});

test("section words resolve against the actual section count", () => {
  const intro = parsePromptToInstruction("strings for the intro", { sectionCount: 4 });
  assert.deepEqual(intro.instruction.targetSections, [0]);
  const outro = parsePromptToInstruction("pad on the outro", { sectionCount: 4 });
  assert.deepEqual(outro.instruction.targetSections, [3]);
  // No sections at all → honest fallback to all + a note.
  const none = parsePromptToInstruction("strings for the intro", { sectionCount: 0 });
  assert.equal(none.instruction.targetSections, "all");
  assert.ok(none.usedDefaults.includes("sections"));
});

test("no instrument word → honest default with an unmapped note", () => {
  const result = parsePromptToInstruction("make it sound moodier", { sectionCount: 2 });
  assert.equal(result.instruction.instrument, "pad");
  assert.ok(result.usedDefaults.includes("instrument"));
  assert.ok(result.unmappedPhrases.some((phrase) => phrase.includes("no instrument")));
});

test("empty prompt throws honestly", () => {
  assert.throws(() => parsePromptToInstruction("   ", { sectionCount: 2 }), /empty/i);
});

test("AI-instruction validation is strict (reject, never repair)", () => {
  const good = validateAiInstruction({
    format: "waveyard-arrangement-instruction-v1",
    instrument: "strings", mood: "sinister", targetSections: "all",
    density: "medium", register: "low", level: 0.6, seed: 1,
  });
  assert.notEqual(good, null);
  assert.equal(good!.instrument, "strings");
  assert.equal(validateAiInstruction({ format: "wrong" }), null);
  assert.equal(
    validateAiInstruction({
      format: "waveyard-arrangement-instruction-v1",
      instrument: "orchestra-hit", mood: "sinister", targetSections: "all",
      density: "medium", register: "low", level: 0.6, seed: 1,
    }),
    null,
  );
});
