/**
 * Deep-engine preparation routes — the UI-to-backend contract.
 *
 * GET and the consent gate are exercised against the REAL
 * environment discovery (this machine's actual interpreters,
 * checkpoint and FFmpeg), proving self-diagnosis is honest.
 * Starting a real installation is deliberately NOT done here
 * (it would download ~1 GB); the consent gate is what is
 * asserted, plus the import route's real checksum validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetPreparationManagerForTests } from "@/lib/waveyard/separation/provision-store";
import { DEEP_CHECKPOINT_FILE } from "@/lib/waveyard/separation/deep";

// Bind the manager to throwaway directories before any route
// runs, so no test touches the real .data tree.
const directory = await mkdtemp(join(tmpdir(), "wy-route-"));
process.env.WAVEYARD_DEEP_ENV_DIR = join(directory, "env");
process.env.WAVEYARD_MODELS_DIR = join(directory, "models");
resetPreparationManagerForTests();

const { GET, POST } = await import("./route");
const { POST: importCheckpoint } = await import("./import/route");
const { POST: cancel } = await import("./cancel/route");
const { POST: recover } = await import("./recover/route");

test("GET returns the durable status and the honest runtime boundary", async () => {
  const response = await GET(new Request("http://localhost/api"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    status: { state: string };
    runtime: { processingMode: string; engine: { prepared: boolean } };
  };
  assert.equal(typeof body.status.state, "string");
  assert.equal(body.status.state === "ready", false, "a fresh sandbox is not prepared");
  assert.equal(typeof body.runtime.processingMode, "string");
  assert.equal(typeof body.runtime.engine.prepared, "boolean");
});

test("GET ?inspect=1 reports the real machine and a plan with consent", async () => {
  const response = await GET(new Request("http://localhost/api?inspect=1"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    report: { python: Array<{ version: string | null; demucsVersion: string | null }>; checkpoint: { present: boolean } };
    plan: { needsConsent: boolean; consent: Array<{ id: string; source: string; license: string }> };
  };
  assert.ok(body.report !== undefined, "a fresh report is computed");
  // On a machine with no Demucs install, the plan requires
  // consent for the material steps.
  assert.equal(body.plan.needsConsent, true);
  assert.ok(body.plan.consent.length > 0);
  for (const item of body.plan.consent) {
    assert.ok(item.source.length > 0, "every consent item names its verified source");
    assert.ok(item.license.length > 0, "every consent item names its licensing condition");
  }
});

test("POST without the required consent is refused before anything runs", async () => {
  const response = await POST(
    new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent: [] }),
    }),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { outcome: string; missing: string[] };
  assert.equal(body.outcome, "consent-missing");
  assert.ok(body.missing.length > 0, "the missing consents are named");
});

test("a wrong checkpoint import is refused with an honest error", async () => {
  const modelsDir = process.env.WAVEYARD_MODELS_DIR as string;
  const wrong = join(directory, "wrong.th");
  await writeFile(wrong, Buffer.from("not the htdemucs_6s weights"));
  const form = new FormData();
  form.set("checkpoint", new File([await (await import("node:fs/promises")).readFile(wrong)], "checkpoint.th", { type: "application/octet-stream" }));
  const response = await importCheckpoint(
    new Request("http://localhost/api", { method: "POST", body: form }),
  );
  assert.equal(response.status, 422, "a wrong file is refused, not accepted");
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? "", /not the htdemucs_6s checkpoint|checkpoint/i);
  // And nothing was placed.
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(modelsDir, DEEP_CHECKPOINT_FILE)), false);
});

test("cancel and recover answer honestly when nothing is running", async () => {
  const cancelResponse = await cancel();
  assert.ok(cancelResponse.status === 200 || cancelResponse.status === 409);
  const recoverResponse = await recover();
  assert.equal(recoverResponse.status, 200);
});

// Clean up the throwaway tree.
test("teardown", async () => {
  await rm(directory, { recursive: true, force: true });
});
