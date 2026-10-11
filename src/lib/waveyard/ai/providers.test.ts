/**
 * AI provider adapter + workflow + bridge tests — real HTTP against a local
 * server standing in for the provider endpoint (the adapter logic itself is
 * fully real; only the endpoint address differs). Malformed output,
 * unavailable providers, and validator authority are exercised end to end.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { AI_WORKFLOWS, findWorkflow } from "./workflows";
import {
  buildPrompt,
  extractJsonObject,
  listProviders,
  providerStatus,
  requestFromProvider,
} from "./providers";
import { buildAnalysisPacket } from "./packet";
import { mixerStateFromRemix, remixUpdateFromMixerState, type RemixSessionView } from "./remix-bridge";
import { applyProposal } from "./proposal";
import { parseInserts, serializeInserts } from "../mixer/inserts";

const FS = 48000;

function quietPcm(): Float32Array {
  const frames = Math.round(1.2 * FS);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / FS;
    const s = 0.2 * Math.sin(2 * Math.PI * 200 * t);
    pcm[i * 2] = s;
    pcm[i * 2 + 1] = s;
  }
  return pcm;
}

test("the 16 workflows are registered, unique, and honestly labelled", () => {
  assert.equal(AI_WORKFLOWS.length, 16);
  const ids = new Set(AI_WORKFLOWS.map((workflow) => workflow.id));
  assert.equal(ids.size, 16);
  for (const workflow of AI_WORKFLOWS) {
    assert.ok(workflow.label.length > 0);
    assert.ok(workflow.promptFocus.length > 0);
    assert.ok(workflow.expectation === "analysis" || workflow.expectation === "proposal");
  }
  assert.notEqual(findWorkflow("analyze-mix"), null);
  assert.equal(findWorkflow("does-not-exist"), null);
});

test("providers without keys are honestly unavailable with the exact reason", () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const statuses = listProviders();
  assert.equal(statuses.length, 2);
  for (const status of statuses) {
    assert.equal(status.state, "unavailable");
    assert.match(status.reason, /is not set on this machine/);
  }
});

test("the prompt tells the model it did NOT receive audio and includes the packet", () => {
  const packet = buildAnalysisPacket({ target: { kind: "mix", name: "Mix" }, pcm: quietPcm(), sampleRate: FS });
  const prompt = buildPrompt({
    workflow: findWorkflow("fix-harshness")!,
    packet,
    channelMenu: [{ id: "stem:abc", name: "Vocals" }, { id: "master", name: "Master" }],
  });
  assert.match(prompt, /You did NOT receive audio/);
  assert.match(prompt, /audio-derived|derived from real measurements/);
  assert.ok(prompt.includes("waveyard-analysis-packet-v1"));
  assert.ok(prompt.includes("stem:abc"));
  assert.ok(prompt.includes("softclip"));
});

test("extractJsonObject survives model prose around the JSON", () => {
  assert.deepEqual(extractJsonObject('Sure! {"a": 1} Hope that helps.'), { a: 1 });
  assert.equal(extractJsonObject("no json at all"), null);
  assert.equal(extractJsonObject("{broken"), null);
});

test("adapter returns a validated proposal from a real HTTP exchange", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:0"; // replaced below
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk));
    request.on("end", () => {
      assert.equal(request.headers.authorization, "Bearer test-key");
      assert.ok(body.includes("waveyard-analysis-packet-v1"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: 'Here is my plan: {"rationale":"tame hum","changes":[{"targetChannelId":"stem:stem-1","processor":"notch","parameters":{"freqHz":50,"q":18},"reason":"measured 50 Hz tone"}]}' } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;

  try {
    const packet = buildAnalysisPacket({ target: { kind: "mix", name: "Mix" }, pcm: quietPcm(), sampleRate: FS });
    const result = await requestFromProvider({
      providerId: "openai",
      workflow: findWorkflow("clean-up")!,
      packet,
      channelMenu: [{ id: "stem:stem-1", name: "Lead" }],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.capability, "audio-derived");
      const candidate = extractJsonObject(result.raw);
      const session: RemixSessionView = {
        masterVolume: 0.9,
        masterInsertsRaw: "[]",
        tracks: [{
          id: "track-1", stemAssetId: "stem-1", name: "Lead",
          volume: 1, pan: 0, muted: false, solo: false, insertsRaw: "[]",
        }],
      };
      const state = mixerStateFromRemix(session);
      const application = applyProposal(state, candidate);
      assert.equal(application.status, "applied");
      assert.equal(application.applied[0].processor, "notch");
      // Bridge back to remix persistence and round-trip through storage format.
      const update = remixUpdateFromMixerState(session, application.next!);
      assert.equal(update.tracks[0].inserts.length, 1);
      const restored = parseInserts(JSON.parse(serializeInserts(update.tracks[0].inserts)));
      assert.deepEqual(restored?.[0].params, { freqHz: 50, q: 18 });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
});

test("malformed model output is rejected by the validator, never applied", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{ message: { content: '{"rationale":"oops","changes":[{"targetChannelId":"stem:ghost","processor":"notch","parameters":{},"reason":"x"},{"targetChannelId":"stem:stem-1","processor":"vocoder","parameters":{},"reason":"y"}]}' } }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;

  try {
    const packet = buildAnalysisPacket({ target: { kind: "mix", name: "Mix" }, pcm: quietPcm(), sampleRate: FS });
    const result = await requestFromProvider({
      providerId: "openai",
      workflow: findWorkflow("clean-up")!,
      packet,
      channelMenu: [{ id: "stem:stem-1", name: "Lead" }],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const session: RemixSessionView = {
        masterVolume: 1, masterInsertsRaw: "[]",
        tracks: [{ id: "track-1", stemAssetId: "stem-1", name: "Lead", volume: 1, pan: 0, muted: false, solo: false, insertsRaw: "[]" }],
      };
      const application = applyProposal(mixerStateFromRemix(session), extractJsonObject(result.raw));
      assert.equal(application.status, "rejected");
      assert.ok(application.errors.some((message) => message.includes("unknown target channel")));
      assert.ok(application.errors.some((message) => message.includes("unknown processor")));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
});

test("provider HTTP failure surfaces the honest reason (no fallback content)", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  const server = createServer((_request, response) => {
    response.statusCode = 429;
    response.end(JSON.stringify({ error: "rate limited" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const packet = buildAnalysisPacket({ target: { kind: "mix", name: "Mix" }, pcm: quietPcm(), sampleRate: FS });
    const result = await requestFromProvider({
      providerId: "openai",
      workflow: findWorkflow("analyze-mix")!,
      packet,
      channelMenu: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /HTTP 429/);
      assert.equal(result.httpStatus, 429);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
});

test("unreachable network is an honest failure, not silent success", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9"; // discard port — nothing listens
  try {
    const packet = buildAnalysisPacket({ target: { kind: "mix", name: "Mix" }, pcm: quietPcm(), sampleRate: FS });
    const result = await requestFromProvider({
      providerId: "openai",
      workflow: findWorkflow("analyze-mix")!,
      packet,
      channelMenu: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.reason.length > 0);
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
});

test("bridge maps remix rows to mixer channels and back with volume/pan fidelity", () => {
  const session: RemixSessionView = {
    masterVolume: 0.7079, // ≈ −3 dB
    masterInsertsRaw: serializeInserts([{ id: "m", processor: "softclip", enabled: true, wet: 1, params: { ceilingDb: -1 } }]),
    tracks: [{ id: "track-1", stemAssetId: "stem-1", name: "Lead", volume: 0.5, pan: -0.25, muted: false, solo: false, insertsRaw: "[]" }],
  };
  const state = mixerStateFromRemix(session);
  const stem = state.channels.find((channel) => channel.id === "stem:stem-1");
  assert.notEqual(stem, undefined);
  assert.ok(Math.abs(stem!.faderDb - (-6.02)) < 0.1);
  assert.equal(stem!.pan, -0.25);
  const master = state.channels.find((channel) => channel.kind === "master");
  assert.notEqual(master, undefined);
  assert.equal(master!.inserts.length, 1);

  const round = remixUpdateFromMixerState(session, state);
  assert.ok(Math.abs(round.tracks[0].volume - 0.5) < 0.01);
  assert.equal(round.tracks[0].pan, -0.25);
  assert.ok(Math.abs(round.masterVolume - 0.7079) < 0.01);
  assert.equal(round.masterInserts.length, 1);
});

test("bridge preserves pre-existing chains across an AI apply (bare-array storage form)", () => {
  // Regression: the bridge used to parse remix rows with the envelope form,
  // so bare-array stored chains read as [] and AI applies REPLACED manual work.
  const manual = [
    { id: "fx-1", processor: "notch", enabled: true, wet: 1, params: { freqHz: 50, q: 18 } },
    { id: "fx-2", processor: "eq-band", enabled: true, wet: 0.8, params: { freqHz: 3000, gainDb: 2, q: 0.9 } },
  ];
  const session: RemixSessionView = {
    masterVolume: 1,
    masterInsertsRaw: JSON.stringify([{ id: "m-1", processor: "softclip", enabled: true, wet: 1, params: { ceilingDb: -1 } }]),
    tracks: [{ id: "track-1", stemAssetId: "stem-1", name: "Lead", volume: 1, pan: 0, muted: false, solo: false, insertsRaw: JSON.stringify(manual) }],
  };
  const state = mixerStateFromRemix(session);
  const stem = state.channels.find((channel) => channel.id === "stem:stem-1")!;
  assert.equal(stem.inserts.length, 2, "stored bare-array chain must load (not read as empty)");
  const master = state.channels.find((channel) => channel.kind === "master")!;
  assert.equal(master.inserts.length, 1);

  const application = applyProposal(state, {
    rationale: "tighten low end",
    changes: [{ targetChannelId: "stem:stem-1", processor: "highpass", parameters: { cutoffHz: 45, q: 0.7071 }, reason: "measured sub energy" }],
  });
  assert.equal(application.status, "applied");
  const update = remixUpdateFromMixerState(session, application.next!);
  assert.equal(update.tracks[0].inserts.length, 3, "AI apply must APPEND to the manual chain, not replace it");
  assert.equal(update.tracks[0].inserts[0].processor, "notch");
  assert.equal(update.tracks[0].inserts[2].processor, "highpass");
  assert.equal(update.masterInserts.length, 1, "untouched master chain must survive");
});

test("providerStatus reports availability when a key exists", () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const status = providerStatus("anthropic");
  assert.equal(status.state, "available");
  delete process.env.ANTHROPIC_API_KEY;
});
