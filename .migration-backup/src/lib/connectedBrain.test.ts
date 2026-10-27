/**
 * Connected-brain resolution tests — the pre-wired free-model default.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pickBrain } from "./connectedBrain";

test("groq key wins: any text alias routes via groq:free", () => {
  const brain = pickBrain({ groq: "gsk_test" });
  assert.equal(brain.provider, "groq");
  assert.equal(brain.modelId, "openai");
  assert.match(brain.detail, /groq:free/i);
  assert.ok(brain.free);
});

test("openrouter is second choice", () => {
  const brain = pickBrain({ openrouter: "sk-or-…" });
  assert.equal(brain.provider, "openrouter");
  assert.equal(brain.modelId, "openai");
});

test("turboagent local server is third and points at its catalog model", () => {
  const brain = pickBrain({ turboagent: "http://127.0.0.1:8080" });
  assert.equal(brain.provider, "turboagent");
  assert.equal(brain.modelId, "turboagent-7b");
});

test("no keys → honest offline Local Engine, labeled for what it is", () => {
  const brain = pickBrain({});
  assert.equal(brain.provider, "local");
  assert.equal(brain.modelId, "local-engine");
  assert.match(brain.detail, /cannot write arbitrary code/i);
});

test("precedence: groq over openrouter over turboagent; blank strings ignored", () => {
  assert.equal(pickBrain({ groq: "gsk_x", openrouter: "or", turboagent: "t" }).provider, "groq");
  assert.equal(pickBrain({ openrouter: "or", turboagent: "t" }).provider, "openrouter");
  assert.equal(pickBrain({ groq: "  ", openrouter: "or" }).provider, "openrouter");
});
