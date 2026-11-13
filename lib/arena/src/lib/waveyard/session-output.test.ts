import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireSessionOutput } from "./session-output";

test("shared output owns one protected graph, records post-limiter and closes only after the last deck", async () => {
  const previousContext = globalThis.AudioContext;
  const previousWorklet = globalThis.AudioWorkletNode;
  const contexts: FakeContext[] = [];
  let failModule = false;
  let holdNextModule = false;
  let releaseModule: (() => void) | null = null;
  class FakeNode {
    connections: FakeNode[] = [];
    channelCount = 2;
    channelCountMode = "max";
    fftSize = 2048;
    stream = {};
    constructor(readonly kind: string) {}
    connect(node: FakeNode) { this.connections.push(node); return node; }
    disconnect() { this.connections = []; }
  }
  class FakeContext {
    state = "running";
    destination = new FakeNode("destination");
    nodes: FakeNode[] = [];
    audioWorklet = {
      addModule: async () => {
        if (holdNextModule) {
          holdNextModule = false;
          await new Promise<void>(resolve => { releaseModule = resolve; });
        }
        if (failModule) throw new Error("module failed");
      },
    };
    constructor() { contexts.push(this); }
    createGain() { const node = new FakeNode("input"); this.nodes.push(node); return node; }
    createAnalyser() { const node = new FakeNode("analyser"); this.nodes.push(node); return node; }
    createMediaStreamDestination() { const node = new FakeNode("recording"); this.nodes.push(node); return node; }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  class FakeWorklet extends FakeNode {
    constructor(ctx: FakeContext) { super("limiter"); ctx.nodes.push(this); }
  }
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = FakeWorklet as unknown as typeof AudioWorkletNode;
  try {
    const a = acquireSessionOutput("lifecycle", "processor-url");
    const b = acquireSessionOutput("lifecycle", "processor-url");
    assert.equal(a, b);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].nodes[0].connections.length, 0, "no unprotected startup bypass");
    await a.ready;
    const [input, analyser, limiter] = contexts[0].nodes;
    assert.deepEqual(input.connections, [limiter]);
    assert.deepEqual(limiter.connections, [analyser]);
    assert.deepEqual(analyser.connections, [contexts[0].destination]);
    assert.equal(a.stream(), b.stream(), "one mixed recording stream");
    assert.equal(analyser.connections.at(-1)?.kind, "recording", "recording tap is after peak protection");
    a.release();
    assert.equal(contexts[0].state, "running", "the retained deck keeps its shared output");
    b.release();
    assert.equal(contexts[0].state, "closed");
    const reopened = acquireSessionOutput("lifecycle", "processor-url");
    await reopened.ready;
    assert.equal(contexts.length, 2, "reopen gets a fresh bus");
    reopened.release();
    failModule = true;
    const failed = acquireSessionOutput("failed", "bad-url");
    await assert.rejects(failed.ready, /Protected session output could not be loaded/);
    assert.ok(contexts[2].nodes.every(node => node.connections.length === 0),
      "processor failure leaves no unprotected destination connection");
    failModule = false;
    await failed.ready;
    const [failedInput, failedAnalyser, recoveredLimiter] = contexts[2].nodes;
    assert.equal(recoveredLimiter.kind, "limiter", "retry creates the protected processor");
    assert.deepEqual(failedInput.connections, [recoveredLimiter]);
    assert.deepEqual(recoveredLimiter.connections, [failedAnalyser]);
    assert.deepEqual(failedAnalyser.connections, [contexts[2].destination]);
    failed.release();

    holdNextModule = true;
    const cancelled = acquireSessionOutput("cancel-loading", "processor-url");
    const pending = cancelled.ready;
    assert.equal(typeof releaseModule, "function", "the module load is pending");
    cancelled.release();
    releaseModule!();
    await pending;
    assert.equal(contexts[3].state, "closed", "release closes the context during loading");
    assert.ok(contexts[3].nodes.every(node => node.connections.length === 0),
      "a late module resolution after release cannot connect an output");
    assert.equal(contexts[3].nodes.some(node => node.kind === "limiter"), false,
      "a closed context never constructs the processor after cancellation");
  } finally {
    globalThis.AudioContext = previousContext;
    globalThis.AudioWorkletNode = previousWorklet;
  }
});
