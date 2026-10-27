/**
 * Layer-edit planning tests — the contract between the piano roll and the
 * arrangement layer PATCH: untrusted note payloads validate or reject
 * wholesale, velocity domains convert, and the planned duration never
 * shrinks (clips already placed against a layer keep working).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { planLayerEdit } from "./layer-edit";

test("a valid edit plans synth events + a duration that covers it", () => {
  const plan = planLayerEdit({ durationSeconds: 30 }, [
    { id: "a", startMs: 0, durationMs: 500, midi: 60, velocity: 127 },
    { id: "b", startMs: 29_000, durationMs: 2500, midi: 67, velocity: 64 },
  ]);
  assert.ok(plan !== null);
  assert.equal(plan.notes.length, 2);
  assert.equal(plan.synthEvents[0].velocity, 1, "velocity 1–127 → 0–1 for the renderer");
  assert.equal(plan.synthEvents[1].velocity, 64 / 127);
  assert.equal(plan.durationSeconds, 33, "edit extends past the old end: ceil(31.5s)+1 tail room");
});

test("an edit inside the current duration keeps the layer's length", () => {
  const plan = planLayerEdit({ durationSeconds: 60 }, [
    { id: "a", startMs: 1000, durationMs: 500, midi: 60, velocity: 100 },
  ]);
  assert.ok(plan !== null);
  assert.equal(plan.durationSeconds, 60, "never shrinks — placed clips must keep working");
});

test("malformed payloads reject wholesale (null, never a partial plan)", () => {
  assert.equal(planLayerEdit({ durationSeconds: 10 }, null), null);
  assert.equal(planLayerEdit({ durationSeconds: 10 }, "notes"), null);
  assert.equal(planLayerEdit({ durationSeconds: 10 }, [{ id: "a", startMs: -1, durationMs: 500, midi: 60, velocity: 100 }]), null);
  assert.equal(planLayerEdit({ durationSeconds: 10 }, [{ id: "a", startMs: 0, durationMs: 5, midi: 60, velocity: 100 }]), null);
  assert.equal(planLayerEdit({ durationSeconds: 10 }, [{ id: "a", startMs: 0, durationMs: 500, midi: 200, velocity: 100 }]), null);
  assert.equal(planLayerEdit({ durationSeconds: 10 }, [{ startMs: 0, durationMs: 500, midi: 60, velocity: 100 }]), null);
});

test("an empty edit is legal (delete every note) and keeps the layer length", () => {
  const plan = planLayerEdit({ durationSeconds: 24 }, []);
  assert.ok(plan !== null);
  assert.deepEqual(plan.synthEvents, []);
  assert.equal(plan.durationSeconds, 24);
});
