/**
 * Phase D external action tests (docs/spaces-autonomy.md) — phone calls,
 * SMS, payment links: the strictest approval tier.
 *
 * No provider account exists in CI, and none is needed: the fetcher is
 * injected so the EXACT REST payloads, validation, caps, and unconfigured
 * paths are proven. The mission-level test proves the governance gate —
 * no provider request can even be attempted before a human decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { executeTool, WORKSPACE_ROOT } from "./tools";
import { runMission, type MissionAgentSpec } from "./mission";
import type { GenerateResult } from "@/lib/runtime";
import { decideApproval, listApprovals } from "./governance";
import {
  isValidE164,
  maxPaymentAmountUsd,
  toolExternalCall,
  toolExternalSms,
  toolPaymentLink,
  type Fetcher,
} from "./external";

type Call = { url: string; body: string; headers: Record<string, string> };

function recorder(responses: { match: (c: Call) => boolean; status: number; body: string }[]): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const c = { url, body: init.body, headers: init.headers };
    calls.push(c);
    for (const r of responses) {
      if (r.match(c)) return { status: r.status, body: r.body };
    }
    return { status: 200, body: "{}" };
  };
  return { fetcher, calls };
}

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_FROM_NUMBER: "+61400000000",
};

const NO_ENV = {};

test("calls: the Twilio REST payload is exact (To/From/TwiML with the approved words)", async () => {
  const { fetcher, calls } = recorder([
    { match: (c) => c.url.endsWith("/Calls.json"), status: 201, body: JSON.stringify({ sid: "CAll1" }) },
  ]);
  const out = await toolExternalCall(
    { to: "+61412345678", message: "Your table is ready" },
    { fetcher, env: TWILIO_ENV },
  );
  assert.match(out, /call placed to \+61412345678 \(Twilio SID CAll1\)/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls.json");
  assert.match(calls[0].body, /To=%2B61412345678/);
  assert.match(calls[0].body, /From=%2B61400000000/);
  assert.match(calls[0].body, /Twiml=%3CResponse%3E%3CSay/);
  assert.match(calls[0].body, /Your%20table%20is%20ready/);
  assert.match(calls[0].headers.authorization ?? "", /^Basic QUN0ZXN0OnRvaw==$/);
});

test("calls + SMS: unconfigured is honest and actionable — no request attempted, no fake success", async () => {
  const { fetcher, calls } = recorder([]);
  const call = await toolExternalCall({ to: "+61412345678", message: "hi" }, { fetcher, env: NO_ENV });
  assert.match(call, /error: phone calls are not configured/);
  assert.match(call, /TWILIO_ACCOUNT_SID/);
  const sms = await toolExternalSms({ to: "+61412345678", message: "hi" }, { fetcher, env: NO_ENV });
  assert.match(sms, /error: SMS is not configured/);
  assert.equal(calls.length, 0, "no provider request was ever attempted");
});

test("SMS: messaging service variant + provider refusals surface verbatim", async () => {
  const { fetcher, calls } = recorder([
    { match: (c) => c.url.endsWith("/Messages.json") && c.body.includes("to=%2Bbad"), status: 400, body: JSON.stringify({ message: "Invalid 'To' number" }) },
    { match: (c) => c.url.endsWith("/Messages.json"), status: 201, body: JSON.stringify({ sid: "SMxyz" }) },
  ]);
  const ok = await toolExternalSms({ to: "+61412345678", message: "meeting moved to 3pm" }, { fetcher, env: { ...TWILIO_ENV, TWILIO_FROM_NUMBER: "", TWILIO_MESSAGING_SERVICE_SID: "MGsvc" } });
  assert.match(ok, /SMS sent to \+61412345678 \(Twilio SID SMxyz\)/);
  const payload = calls.find((c) => c.url.endsWith("/Messages.json") && !c.body.includes("%2Bbad"));
  assert.ok(payload);
  assert.match(payload.body, /MessagingServiceSid=MGsvc/);
  assert.ok(!payload.body.includes("From="), "messaging service replaces the from number");
  assert.match(payload.body, /Body=meeting%20moved%20to%203pm/);
});

test("validation: bad phone numbers and empty messages are refused before any request", async () => {
  const { fetcher, calls } = recorder([]);
  assert.match(await toolExternalCall({ to: "0412", message: "hi" }, { fetcher, env: TWILIO_ENV }), /E\.164/);
  assert.match(await toolExternalSms({ to: "+61412345678", message: "" }, { fetcher, env: TWILIO_ENV }), /error: external_sms needs a message/);
  assert.equal(calls.length, 0);
  assert.ok(isValidE164("+61412345678"));
  assert.ok(!isValidE164("0412345678"));
  assert.ok(!isValidE164("+61 412 345 678"));
});

test("payments: product → price → payment link chain with the exact amount and cap enforcement", async () => {
  const { fetcher, calls } = recorder([
    { match: (c) => c.url.endsWith("/v1/products"), status: 200, body: JSON.stringify({ id: "prod_1" }) },
    { match: (c) => c.url.endsWith("/v1/prices"), status: 200, body: JSON.stringify({ id: "price_1" }) },
    { match: (c) => c.url.endsWith("/v1/payment_links"), status: 200, body: JSON.stringify({ url: "https://buy.stripe.com/test_link" }) },
  ]);
  const res = await toolPaymentLink(
    { amount: 25, description: "deposit for the weekend", currency: "aud" },
    { fetcher, env: { STRIPE_API_KEY: "sk_test_1" } },
  );
  assert.equal(res.ok, true);
  assert.match(res.output, /payment link created: https:\/\/buy\.stripe\.com\/test_link/);
  assert.match(res.output, /\$25\.00 AUD/);
  assert.equal(calls.length, 3);
  assert.match(calls[0].body, /name=deposit%20for%20the%20weekend/);
  assert.match(calls[1].body, /unit_amount=2500/);
  assert.match(calls[1].body, /currency=aud/);
  assert.match(calls[1].body, /product=prod_1/);
  assert.match(calls[2].body, /line_items%5B0%5D%5Bprice%5D=price_1/);
  assert.match(calls[2].headers.authorization, /^Bearer sk_test_1$/);

  // over the cap → refused WITHOUT any provider request
  const callsBefore = calls.length;
  const capped = await toolPaymentLink({ amount: 251, description: "too much" }, { fetcher, env: { STRIPE_API_KEY: "sk_test_1" } });
  assert.equal(capped.ok, false);
  assert.match(capped.output, /exceeds the safety cap of \$250\.00/);
  assert.equal(calls.length, callsBefore, "the capped charge never reached Stripe");

  // custom cap honored
  assert.equal(maxPaymentAmountUsd({ MAX_PAYMENT_AMOUNT_USD: "500" }), 500);
  const raised = await toolPaymentLink({ amount: 300, description: "raised cap" }, { fetcher, env: { STRIPE_API_KEY: "sk_test_1", MAX_PAYMENT_AMOUNT_USD: "500" } });
  assert.equal(raised.ok, true);

  // unconfigured → honest
  const noKey = await toolPaymentLink({ amount: 25, description: "x" }, { fetcher, env: NO_ENV });
  assert.equal(noKey.ok, false);
  assert.match(noKey.output, /STRIPE_API_KEY/);

  // bad input → honest refusal
  const bad = await toolPaymentLink({ amount: -5, description: "x" }, { fetcher, env: { STRIPE_API_KEY: "k" } });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /positive amount/);
});

test("mission gate: external_sms is approval-gated — no provider request is possible before a human decision", async (t) => {
  const spaceId = `exttest-${Date.now()}`;
  t.after(() => rm(path.join(WORKSPACE_ROOT, spaceId), { recursive: true, force: true }).catch(() => {}));
  const { fetcher, calls } = recorder([
    { match: (c) => c.url.endsWith("/Messages.json"), status: 201, body: JSON.stringify({ sid: "SMok" }) },
  ]);

  const plan: MissionAgentSpec[] = [{ name: "Solo", role: "comms", modelId: "local-engine" }];
  const gen = async (): Promise<GenerateResult> => ({
    text: JSON.stringify({
      thought: "text the guest",
      actions: [{ tool: "external_sms", args: { to: "+61412345678", message: "Your booking is confirmed" } }],
      done: false,
    }),
    runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "stub", ms: 1, fallback: false,
  });

  const m1 = await runMission(spaceId, { goal: "sms probe", timeBudgetMs: 30_000, agentPlan: plan, maxTurnsPerAgent: 1 },
    { generate: gen, externalDeps: { fetcher, env: TWILIO_ENV } });
  assert.equal(m1.status, "awaiting_approval");
  assert.equal(calls.length, 0, "no SMS request happened before approval");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === m1.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].actionClass, "external.sms");
  // the approval payload carries the exact recipient + words the human is deciding on
  const payload = (pending[0].payload ?? {}) as Record<string, string>;
  assert.equal(payload.to, "+61412345678");
  assert.equal(payload.message, "Your booking is confirmed");

  await decideApproval(pending[0].id, "approve", "test-owner");
  const m2 = await runMission(spaceId, { goal: "sms probe", timeBudgetMs: 30_000, maxTurnsPerAgent: 1 },
    { generate: gen, externalDeps: { fetcher, env: TWILIO_ENV } });
  assert.notEqual(m2.status, "awaiting_approval");
  assert.equal(calls.length, 1, "the approved SMS was really sent");
  assert.match(calls[0].body, /Body=Your%20booking%20is%20confirmed/);
});

test("mission gate: a denied external_call is terminal — nothing is ever sent", async (t) => {
  const spaceId = `exttest2-${Date.now()}`;
  t.after(() => rm(path.join(WORKSPACE_ROOT, spaceId), { recursive: true, force: true }).catch(() => {}));
  const { fetcher, calls } = recorder([]);

  const plan: MissionAgentSpec[] = [{ name: "Solo", role: "comms", modelId: "local-engine" }];
  let turn = 0;
  const gen = async (): Promise<GenerateResult> => {
    turn += 1;
    if (turn === 1) {
      return {
        text: JSON.stringify({ thought: "call the guest", actions: [{ tool: "external_call", args: { to: "+61412345678", message: "calling" } }], done: false }),
        runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "stub", ms: 1, fallback: false,
      };
    }
    return {
      text: JSON.stringify({ thought: "denied — I will not call", actions: [], done: true }),
      runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "stub", ms: 1, fallback: false,
    };
  };

  const m1 = await runMission(spaceId, { goal: "call probe", timeBudgetMs: 30_000, agentPlan: plan, maxTurnsPerAgent: 2 },
    { generate: gen, externalDeps: { fetcher, env: TWILIO_ENV } });
  assert.equal(m1.status, "awaiting_approval");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === m1.id);
  await decideApproval(pending[0].id, "deny", "test-owner");

  const m2 = await runMission(spaceId, { goal: "call probe", timeBudgetMs: 30_000, maxTurnsPerAgent: 2 },
    { generate: gen, externalDeps: { fetcher, env: TWILIO_ENV } });
  assert.equal(calls.length, 0, "a denied call never reached Twilio");
  assert.equal(m2.status, "done");
});

test("executeTool: refused payment links surface as honest failures, not successes", async () => {
  const spaceId = `exttest3-${Date.now()}`;
  const outcome = await executeTool(spaceId, { tool: "payment_link", args: { amount: 9_999, description: "way over cap" } }, {});
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /exceeds the safety cap/);
});
