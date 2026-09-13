import assert from "node:assert/strict";
import test from "node:test";
import { handoffDestination, parseSource } from "./handoffs";

test("persisted handoff navigation carries identity but no inherited content", () => {
  const inherited = "private inherited context that must not enter the URL";
  for (const target of ["arena", "collab", "council"] as const) {
    const destination = handoffDestination(target, "handoff-id", "session-id");
    assert.match(destination, /handoffId=handoff-id/);
    assert.match(destination, /sessionId=session-id/);
    assert.doesNotMatch(destination, new RegExp(inherited));
    assert.doesNotMatch(destination, /prompt=|challenge=|material=/);
  }
});

test("legacy source references remain parseable during migration", () => {
  assert.deepEqual(parseSource("council:run-id"), { type: "council", id: "run-id" });
  assert.equal(parseSource(null), null);
});
