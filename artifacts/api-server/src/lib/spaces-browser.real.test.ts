import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { chromium } from "playwright-core";
import { runMission } from "@workspace/arena/lib/spaces/mission";
import { createSpace, deleteSpace } from "@workspace/arena/lib/spaces";
import { GET as getBrowserFile } from "../imported/spaces/[id]/browser/route";
import {
  browserProfileDir,
  closeBrowserSession,
  createPlaywrightEngine,
  engineFor,
  toolBrowserExtract,
  toolBrowserNavigate,
  toolBrowserScreenshot,
  workspaceDirFor,
} from "@workspace/arena/lib/spaces/browser";

test("real Chromium keeps navigation, extraction, and screenshots in an isolated space", async (t) => {
  const space = await createSpace({ title: "Temporary browser verification", prompt: "Temporary browser task verification", status: "paused" });
  const spaceId = space.id;
  const contexts: any[] = [];
  const loadChromium = async () => ({
    chromium: {
      launchPersistentContext: async (profile: string, options: any) => {
        const context = await chromium.launchPersistentContext(profile, options);
        contexts.push(context);
        return context;
      },
    },
  });
  const engine = createPlaywrightEngine(loadChromium);
  const selected = engineFor(spaceId, engine);
  const otherSpace = `browser-real-other-${Date.now()}`;
  t.after(async () => {
    await closeBrowserSession(spaceId);
    await closeBrowserSession(otherSpace);
    await rm(workspaceDirFor(spaceId), { recursive: true, force: true });
    await rm(workspaceDirFor(otherSpace), { recursive: true, force: true });
    await deleteSpace(spaceId);
  });

  const page = await toolBrowserNavigate(spaceId, "https://example.com", selected);
  assert.match(page, /title: Example Domain/);
  assert.match(page, /Example Domain/);

  const paragraph = await toolBrowserExtract(spaceId, "p", 1, selected);
  assert.match(paragraph, /domain is for use in documentation examples/);

  const screenshot = await toolBrowserScreenshot(spaceId, selected);
  assert.match(screenshot, /screenshot saved: browser-/);

  const mission = await runMission(spaceId, {
    mode: "browser",
    localOnly: true,
    goal: "Read the documentation notice on this page and save its observed result.",
    agentPlan: [{ name: "Browser operator", role: "read and report", modelId: "local-engine" }],
    maxTurnsPerAgent: 1,
  }, {
    browserEngine: selected,
    // A scripted model isolates the real runner/browser from external model
    // availability. This is not a claim that Local Engine is an AI agent.
    generate: async () => ({
      text: JSON.stringify({
        actions: [
          { tool: "browser_extract", args: { selector: "p", limit: 1 } },
          { tool: "write_file", args: { path: "reports/observed-notice.md", content: paragraph } },
        ],
        done: true,
      }),
      runtimeLevel: "arena-local", backend: "arena-local-engine", modelId: "local-engine", via: "test-script", ms: 0, fallback: false,
    }),
  });
  assert.equal(mission.status, "done");
  assert(mission.artifacts.some(artifact => artifact.path === "reports/observed-notice.md"));
  assert(mission.artifacts.every(artifact => !artifact.path.startsWith("browser-profile/")));
  const download = await getBrowserFile(
    new Request(`http://owner/api/spaces/${spaceId}/browser?file=reports%2Fobserved-notice.md`),
    { params: Promise.resolve({ id: spaceId }) },
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(await download.text(), /domain is for use in documentation examples/);

  const otherEngine = engineFor(otherSpace, createPlaywrightEngine(loadChromium));
  assert.notEqual(selected, otherEngine, "each workspace must have its own browser context");
  assert.notEqual(browserProfileDir(spaceId), browserProfileDir(otherSpace));
  await otherEngine.ensure(browserProfileDir(otherSpace));
  await contexts[0].addCookies([{ name: "workspace-isolation-check", value: "test-only", url: "https://example.com", expires: Math.floor(Date.now() / 1000) + 3600 }]);
  assert.equal((await contexts[1].cookies("https://example.com")).some((cookie: any) => cookie.name === "workspace-isolation-check"), false);
  await closeBrowserSession(spaceId);
  const reopened = engineFor(spaceId, createPlaywrightEngine(loadChromium));
  await reopened.ensure(browserProfileDir(spaceId));
  assert.equal((await contexts[2].cookies("https://example.com")).some((cookie: any) => cookie.name === "workspace-isolation-check"), true, "persistent cookies should survive reopening their own workspace");
});
