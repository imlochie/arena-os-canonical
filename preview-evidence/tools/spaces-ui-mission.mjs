// Drives a mission entirely through the Spaces workbench UI.
// The model endpoint is scripted (see tools/scripted-model-server.mjs): this
// proves UI -> routing -> tool execution -> artifact storage, not model quality.
import { chromium } from "playwright-core";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const runDir = process.env.RUN_DIR ?? path.resolve(".data/acceptance/product-preview/runs/ui-mission");
const logPath = process.env.SCRIPTED_LOG ?? "/tmp/scripted-model-requests.log";
await mkdir(runDir, { recursive: true });
const results = { kind: "spaces-ui-mission", modelRuntime: "SCRIPTED (deterministic OpenAI-compatible stub, not a language model)", steps: [], consoleErrors: [], httpErrors: [], failure: null };
const callCount = async () => (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
results.modelCallsBefore = await callCount();

const browser = await chromium.launch({ executablePath: "/tmp/chromium", headless: true, chromiumSandbox: false, args: ["--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
page.on("console", m => { if (m.type() === "error") results.consoleErrors.push(m.text()); });
page.on("pageerror", e => results.consoleErrors.push(`pageerror: ${e.message}`));
page.on("response", r => { if (r.status() >= 400) results.httpErrors.push({ status: r.status(), url: r.url() }); });

try {
  await page.goto(`${BASE}/spaces`, { waitUntil: "domcontentloaded" });
  await page.getByText("Product preview space").first().click();
  await page.waitForTimeout(1000);
  results.steps.push({ step: "workbench loads with the configured space", ok: true });

  const goal = `UI-driven acceptance run ${new Date().toISOString()}`;
  await page.getByLabel("Mission goal").fill(goal);
  await page.getByRole("button", { name: /Run mission/ }).click();
  results.steps.push({ step: "mission dispatched from the UI", goal });

  await page.getByText(/done|completed/i).first().waitFor({ timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  results.modelCallsAfter = await callCount();
  results.modelCallsThisMission = results.modelCallsAfter - results.modelCallsBefore;

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  results.ui = {
    missionDone: /done/i.test(body),
    outputLinks: await page.getByRole("link", { name: /^Download / }).count(),
    showsModelProvenance: /Qwen2\.5 (32B|7B) \(TurboAgent\)/.test(body),
    showsScriptedLabel: /scripted/i.test(body),
    showsHostJailNotice: /HOST jail|no container runtime/i.test(body),
    excerpt: body.slice(0, 400),
  };
  await page.screenshot({ path: path.join(runDir, "spaces-ui-mission.png"), fullPage: false });

  const missions = await page.evaluate(async () => {
    const res = await fetch("/api/spaces/606190aa-b7e6-4761-af9e-0a93cba55b1d/mission");
    return res.ok ? await res.json() : { status: res.status };
  }).catch(e => ({ error: String(e) }));
  results.latestMission = missions?.mission ? { id: missions.mission.id, status: missions.mission.status, goal: missions.mission.goal, steps: missions.mission.steps?.length } : missions;
  results.pass = Boolean(results.ui.missionDone && results.modelCallsThisMission >= 3 && results.latestMission?.status === "done");
  if (!results.pass) results.failure = "UI mission did not complete as expected";
} catch (error) {
  results.failure = String(error?.message ?? error);
  await page.screenshot({ path: path.join(runDir, "99-failure.png"), fullPage: false }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(path.join(runDir, "spaces-ui-mission.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence: path.join(runDir, "spaces-ui-mission.json"), failure: results.failure, ui: results.ui, modelCallsThisMission: results.modelCallsThisMission, latest: results.latestMission, consoleErrors: results.consoleErrors.length, httpErrors: results.httpErrors }));
}
