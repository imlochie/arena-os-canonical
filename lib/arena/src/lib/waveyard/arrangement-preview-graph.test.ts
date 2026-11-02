import assert from "node:assert/strict";
import test from "node:test";
import { clearArrangementPreviewGraph } from "./arrangement-preview-graph";

test("arrangement preview cleanup disconnects every graph node and releases references", () => {
  const disconnected: string[] = [];
  const nodes = new Set([
    { disconnect: () => disconnected.push("master") },
    { disconnect: () => disconnected.push("panner") },
    { disconnect: () => disconnected.push("gain") },
    { disconnect: () => disconnected.push("source") },
  ]);

  clearArrangementPreviewGraph(nodes);

  assert.deepEqual(disconnected, ["master", "panner", "gain", "source"]);
  assert.equal(nodes.size, 0);
  assert.doesNotThrow(() => clearArrangementPreviewGraph(nodes));
});

test("one already-disconnected node does not prevent the rest of the graph from releasing", () => {
  const disconnected: string[] = [];
  const nodes = new Set([
    { disconnect: () => { throw new Error("already disconnected"); } },
    { disconnect: () => disconnected.push("remaining") },
  ]);

  clearArrangementPreviewGraph(nodes);

  assert.deepEqual(disconnected, ["remaining"]);
  assert.equal(nodes.size, 0);
});
