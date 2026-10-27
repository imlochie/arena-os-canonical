/**
 * Phase C browser tests (docs/spaces-autonomy.md) — governed browser
 * automation with per-space profiles.
 *
 * The tool surface is tested against a FAKE engine (no Chromium needed);
 * the governance path is tested against the REAL mission runner — a
 * browser_click is approval-gated BEFORE any browser is launched, which is
 * exactly the point: gated interactions cannot so much as open a page
 * without a human decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { executeTool } from "./tools";
import { runMission, type MissionAgentSpec } from "./mission";
import type { GenerateResult } from "@workspace/arena/lib/runtime";
import { browserProfileDir, resetEngine, type BrowserEngine } from "./browser";
import { decideApproval, listApprovals } from "./governance";
import { WORKSPACE_ROOT } from "./tools";

function fakeEngine(events: string[]): BrowserEngine {
  return {
    async ensure(profileDir: string) {
      events.push(`ensure:${path.basename(path.dirname(profileDir))}`);
    },
    async navigate(url: string) {
      events.push(`navigate:${url}`);
      return { url, title: `Page: ${url}`, text: "REAL PAGE TEXT — the actual DOM body text" };
    },
    async extract(selector: string, limit: number) {
      events.push(`extract:${selector}:${limit}`);
      return ["first real item", "second real item", "third real item"].slice(0, limit);
    },
    async screenshot(dir: string) {
      events.push(`screenshot:${path.basename(dir)}`);
      return path.join(dir, "browser-1.png");
    },
    async click(selector: string) {
      events.push(`click:${selector}`);
      return `clicked ${selector} — page is now: https://example.com/after`;
    },
    async fill(selector: string, value: string) {
      events.push(`fill:${selector}=${value}`);
      return `filled ${selector}`;
    },
    async close() {
      events.push("close");
    },
  };
}

function cleanup(spaceId: string) {
  resetEngine(spaceId);
  return rm(path.join(WORKSPACE_ROOT, spaceId), { recursive: true, force: true }).catch(() => {});
}

test("browser view tools execute with the real engine contract (fake engine records; output is the engine's honest result)", async (t) => {
  const spaceId = `browsertest-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const engine = fakeEngine(events);

  const nav = await executeTool(spaceId, { tool: "browser_navigate", args: { url: "https://example.com" } }, { browserEngine: engine });
  assert.equal(nav.ok, true);
  assert.match(nav.output, /REAL PAGE TEXT/);
  assert.match(nav.output, /title: Page: https:\/\/example\.com/);
  assert.ok(events[0].startsWith("ensure:"));

  const extract = await executeTool(spaceId, { tool: "browser_extract", args: { selector: "h2", limit: 2 } }, { browserEngine: engine });
  assert.equal(extract.ok, true);
  assert.match(extract.output, /1\. first real item/);
  assert.match(extract.output, /2\. second real item/);
  assert.ok(!extract.output.includes("third"), "the limit is honored");

  const shot = await executeTool(spaceId, { tool: "browser_screenshot", args: {} }, { browserEngine: engine });
  assert.equal(shot.ok, true);
  assert.match(shot.output, /screenshot saved: browser-1\.png/);
});

test("browser input validation is honest — no engine touched for bad input", async (t) => {
  const spaceId = `browsertest2-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const engine = fakeEngine(events);

  const nav = await executeTool(spaceId, { tool: "browser_navigate", args: { url: "not-a-url" } }, { browserEngine: engine });
  assert.equal(nav.ok, false);
  assert.match(nav.output, /error: browser_navigate needs an absolute http\(s\) URL/);

  const click = await executeTool(spaceId, { tool: "browser_click", args: {} }, { browserEngine: engine });
  assert.equal(click.ok, false);
  assert.match(click.output, /error: browser_click needs a CSS selector/);

  assert.deepEqual(events, [], "the engine was never launched for invalid input");
});

test("browser navigation rejects private-network targets before starting Chromium", async (t) => {
  const spaceId = `browser-ssrf-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const nav = await executeTool(
    spaceId,
    { tool: "browser_navigate", args: { url: "http://127.0.0.1:8080/api/health" } },
    { browserEngine: fakeEngine(events) },
  );
  assert.equal(nav.ok, false);
  assert.match(nav.output, /destination address is loopback/);
  assert.deepEqual(events, [], "private destinations are rejected before browser launch");
});

test("mission gate: browser_click is approval-gated — it cannot even LAUNCH a browser before a human decides", async (t) => {
  const spaceId = `browsertest3-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const engine = fakeEngine(events);

  const plan: MissionAgentSpec[] = [{ name: "Solo", role: "probe", modelId: "local-engine" }];
  const gen = async (): Promise<GenerateResult> => ({
    text: JSON.stringify({
      thought: "click the login button",
      actions: [{ tool: "browser_click", args: { selector: "#login" } }],
      done: false,
    }),
    runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "stub", ms: 1, fallback: false,
  });

  const m1 = await runMission(spaceId, { goal: "click probe", timeBudgetMs: 30_000, agentPlan: plan, maxTurnsPerAgent: 1 }, { generate: gen, browserEngine: engine });
  assert.equal(m1.status, "awaiting_approval");
  assert.equal(events.length, 0, "the gated click never touched the browser engine");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === m1.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].actionClass, "browser.interact");

  // Approve → resume: NOW the engine launches and the click really happens.
  await decideApproval(pending[0].id, "approve", "test-owner");
  const m2 = await runMission(spaceId, { goal: "click probe", timeBudgetMs: 30_000, maxTurnsPerAgent: 1 },
    { generate: gen, browserEngine: engine });
  assert.notEqual(m2.status, "awaiting_approval");
  assert.ok(events.some((e) => e.startsWith("ensure:")), "the engine launched after approval");
  assert.ok(events.includes("click:#login"), "the approved click executed");
  const approval = (await listApprovals(spaceId)).find((p) => p.id === pending[0].id);
  assert.ok(approval && (approval.status === "executed" || approval.status === "failed"));
});

test("mission gate: browser navigation is a VIEW action — it auto-executes without approval", async (t) => {
  const spaceId = `browsertest4-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const engine = fakeEngine(events);

  const plan: MissionAgentSpec[] = [{ name: "Solo", role: "probe", modelId: "local-engine" }];
  const gen = async (): Promise<GenerateResult> => ({
    text: JSON.stringify({
      thought: "read the page",
      actions: [{ tool: "browser_navigate", args: { url: "https://example.com" } }],
      done: true,
    }),
    runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "stub", ms: 1, fallback: false,
  });

  const mission = await runMission(spaceId, { goal: "read probe", timeBudgetMs: 30_000, agentPlan: plan, maxTurnsPerAgent: 1 }, { generate: gen, browserEngine: engine });
  assert.equal(mission.status, "done");
  assert.ok(events.includes("navigate:https://example.com"), "viewing a page needs no approval");
  const pending = (await listApprovals(spaceId, "pending")).filter((p) => p.missionId === mission.id);
  assert.equal(pending.length, 0, "no approval was requested for a view action");
});

test("unavailability is honest: no chromium → actionable error, never a fabricated page", async (t) => {
  const spaceId = `browsertest5-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const brokenEngine: BrowserEngine = {
    async ensure() {
      throw new Error("browser automation is unavailable: no Chromium binary found — run `npx playwright install chromium` once on this machine");
    },
    async navigate() { throw new Error("unavailable"); },
    async extract() { throw new Error("unavailable"); },
    async screenshot() { throw new Error("unavailable"); },
    async click() { throw new Error("unavailable"); },
    async fill() { throw new Error("unavailable"); },
    async close() {},
  };
  const nav = await executeTool(spaceId, { tool: "browser_navigate", args: { url: "https://example.com" } }, { browserEngine: brokenEngine });
  assert.equal(nav.ok, false);
  assert.match(nav.output, /npx playwright install chromium/);
  assert.ok(!/REAL PAGE|title:/.test(nav.output), "no page content was invented");
});

test("per-space profile isolation: each space gets its own browser-profile directory", () => {
  const a = browserProfileDir("space-a");
  const b = browserProfileDir("space-b");
  assert.notEqual(a, b);
  assert.ok(a.endsWith(path.join("space-a", "browser-profile")));
  assert.ok(b.endsWith(path.join("space-b", "browser-profile")));
});

test("browser missions cannot execute shell commands or claim a failed page visit completed", async (t) => {
  const spaceId = `browser-mode-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const engine = fakeEngine([]);
  engine.navigate = async () => { throw new Error("page unavailable"); };
  const mission = await runMission(spaceId, {
    goal: "read a page", mode: "browser", localOnly: true,
    agentPlan: [{ name: "Browser operator", role: "read page", modelId: "local-engine" }],
    maxTurnsPerAgent: 1,
  }, {
    browserEngine: engine,
    generate: async () => ({
      text: JSON.stringify({
        actions: [
          { tool: "run_command", args: { command: "echo forbidden" } },
          { tool: "browser_navigate", args: { url: "https://example.com" } },
        ],
        done: true,
      }),
      runtimeLevel: "on-device", backend: "local-server", modelId: "test-only-model", via: "test-script", ms: 0, fallback: false,
    }),
  });
  assert.equal(mission.status, "failed");
  assert.match(mission.journal[0].actions[0].output, /refused: browser tasks/);
  assert.equal(mission.journal[0].actions.every(action => !action.ok), true);
});

test("browser missions refuse deterministic fallback before touching tools", async (t) => {
  const spaceId = `browser-fallback-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const mission = await runMission(spaceId, {
    goal: "read example.com", mode: "browser", isolation: "host",
    agentPlan: [{ name: "Browser operator", role: "read page", modelId: "local-engine" }],
    maxTurnsPerAgent: 1,
  }, {
    browserEngine: fakeEngine(events),
    generate: async () => ({
      text: JSON.stringify({ actions: [{ tool: "browser_navigate", args: { url: "https://example.com" } }], done: true }),
      runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "test-double", ms: 0, fallback: true,
    }),
  });
  assert.equal(mission.status, "failed");
  assert.match(mission.statusDetail, /selected model was unavailable/);
  assert.equal(mission.mode, "browser");
  assert.deepEqual(events, []);
});

test("browser resume executes the saved approval without requiring the model to repeat it", async (t) => {
  const spaceId = `browser-resume-${Date.now()}`;
  t.after(() => cleanup(spaceId));
  const events: string[] = [];
  const engine = fakeEngine(events);
  const m1 = await runMission(spaceId, {
    goal: "read example.com and save report", mode: "browser", isolation: "host",
    agentPlan: [{ name: "Browser operator", role: "read page", modelId: "test-only-model" }],
    maxTurnsPerAgent: 1,
  }, {
    browserEngine: engine,
    generate: async () => ({
      text: JSON.stringify({ actions: [{ tool: "browser_click", args: { selector: "a" } }], done: true }),
      runtimeLevel: "on-device", backend: "local-server", modelId: "test-only-model", via: "test-double", ms: 0, fallback: false,
    }),
  });
  assert.equal(m1.status, "awaiting_approval");
  assert.equal(m1.endedAt, null);
  const pending = (await listApprovals(spaceId, "pending")).find(item => item.missionId === m1.id)!;
  await decideApproval(pending.id, "approve", "test-owner");
  const m2 = await runMission(spaceId, { goal: "", resume: true, maxTurnsPerAgent: 1 }, {
    browserEngine: engine,
    generate: async () => ({
      text: JSON.stringify({ actions: [{ tool: "write_file", args: { path: "reports/result.md", content: "Test-only report" } }], done: true }),
      runtimeLevel: "on-device", backend: "local-server", modelId: "test-only-model", via: "test-double", ms: 0, fallback: false,
    }),
  });
  assert.equal(m2.mode, "browser", "browser restrictions persist even when the resume request omits the mode");
  assert.equal(m2.status, "done");
  assert.equal(events.filter(event => event === "click:a").length, 1);
  assert.equal((await listApprovals(spaceId)).find(item => item.id === pending.id)?.status, "executed");
});
