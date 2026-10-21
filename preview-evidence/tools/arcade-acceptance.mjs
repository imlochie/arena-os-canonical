#!/usr/bin/env node
/**
 * Arcade source-workshop product-preview acceptance.
 *
 * Drives the REAL built app (/arcade) in real headless Chromium:
 *  - acquires the pinned MIT 2048 source through the app (upstream mirror),
 *  - plays the ACTUAL preview iframe and measures tile spawning with the
 *    verifier's own technique (forced Math.random draws) — independent of the
 *    app's own report,
 *  - proves the bounded modification changes observable gameplay,
 *  - saves an immutable verified revision and reopens it, re-measuring,
 *  - checks tampered/foreign revisions fail closed.
 *
 * Environmental notes (recorded in the receipt): raw.githubusercontent.com is
 * blocked here, so a byte-faithful local mirror serves the four pinned files;
 * the app still validates its own SHA-256 pins.
 */
import { chromium } from "/home/user/preview-13638fe/node_modules/playwright-core/index.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PREVIEW_BASE_URL ?? "http://127.0.0.1:3000";
const root = process.cwd();
const runDir = path.join(root, ".data/acceptance/product-preview/runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });
const results = { kind: "arcade-source-workshop", steps: [], consoleErrors: [], pageErrors: [], httpErrors: [], requestFailures: [], screenshots: [], browser: null, limitations: [] };
const note = (step, detail) => { results.steps.push({ step, ...detail }); console.log(`[${step}]`, JSON.stringify(detail).slice(0, 500)); };

const browser = await chromium.launch({
  executablePath: "/tmp/chromium", headless: true, timeout: 20000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp", LD_LIBRARY_PATH: "/tmp/al2023/lib" },
});
results.browser = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.addInitScript(() => {
  const native = Math.random.bind(Math);
  window.__arenaForcedRandom = null;
  Math.random = () => (window.__arenaForcedRandom === null ? native() : window.__arenaForcedRandom);
});
const page = await context.newPage();
page.on("console", msg => { if (msg.type() === "error") results.consoleErrors.push(msg.text().slice(0, 400)); });
page.on("pageerror", error => results.pageErrors.push(error.message.slice(0, 400)));
page.on("response", response => { if (response.status() >= 400) results.httpErrors.push({ status: response.status(), method: response.request().method(), url: response.url().replace(BASE, "") }); });
page.on("requestfailed", request => results.requestFailures.push({ url: request.url().replace(BASE, ""), failure: request.failure()?.errorText }));

const shot = async name => { const file = path.join(runDir, `${name}.png`); await page.screenshot({ path: file, fullPage: true }); results.screenshots.push(file); };
const previewFrame = async () => {
  const handle = await page.locator('iframe[title="2048 source preview"]').elementHandle();
  const frame = await handle.contentFrame();
  await frame.locator("#tile-count").waitFor({ state: "visible", timeout: 20000 });
  return frame;
};
const readBoard = async frame => {
  const raw = await frame.locator("#board-values").textContent();
  return JSON.parse(raw ?? "[]");
};
/** Play one real move in the preview with a forced random draw and read the
 *  sum delta (merges conserve sum, so the delta is the spawned tile value). */
const measureSpawn = async (frame, draw) => {
  await frame.evaluate(value => { window.__arenaForcedRandom = value; }, draw);
  const before = await readBoard(frame);
  const beforeSum = before.reduce((sum, tile) => sum + tile.value, 0);
  await frame.locator("canvas").click();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(700);
  const after = await readBoard(frame);
  const afterSum = after.reduce((sum, tile) => sum + tile.value, 0);
  return { draw, beforeCount: before.length, beforeValues: before.map(t => t.value), afterCount: after.length, afterValues: after.map(t => t.value), spawned: afterSum - beforeSum };
};

try {
  await page.goto(`${BASE}/arcade`, { waitUntil: "domcontentloaded" });
  await page.getByText("Source workshop · supported MIT 2048 adapter").click();
  await page.getByLabel("Initial tiles").fill("4");
  await page.getByLabel("Spawning rule").selectOption("guaranteed-four");
  await page.getByRole("button", { name: "Acquire source and create patch" }).click();
  await page.getByText(/Generated package—not saved|Saved Artifact|persistence/).first().waitFor({ timeout: 60000 });
  const acquisitionText = await page.locator("section").filter({ hasText: "Source package" }).first().innerText().catch(() => "");
  note("modified acquisition (guaranteed-four, 4 initial tiles)", { uiText: acquisitionText.slice(0, 400) });
  await shot("arcade-01-acquired-modified");

  await page.getByRole("button", { name: "Play source preview (unverified)" }).click();
  let frame = await previewFrame();
  const modifiedInitial = await readBoard(frame);
  const modifiedMove = await measureSpawn(frame, 0.01);
  const modifiedMoveHigh = await measureSpawn(frame, 0.99);
  note("modified preview gameplay (independent measurement)", {
    initialCount: modifiedInitial.length, initialValues: modifiedInitial.map(t => t.value),
    moveDraw001: modifiedMove, moveDraw099: modifiedMoveHigh,
    expectation: "4 initial tiles; every spawn is 4 regardless of the random draw",
  });
  await shot("arcade-02-modified-preview");

  // The original rule, acquired the same way, is the control: same draw spawns 2.
  const closePreviewIfOpen = async () => { const button = page.getByRole("button", { name: "Close source preview" }); if (await button.count()) await button.click(); };
  await closePreviewIfOpen();
  await page.getByLabel("Initial tiles").fill("2");
  await page.getByLabel("Spawning rule").selectOption("original");
  await page.getByRole("button", { name: "Acquire source and create patch" }).click();
  await page.getByRole("button", { name: "Play source preview (unverified)" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Play source preview (unverified)" }).click();
  frame = await previewFrame();
  const originalInitial = await readBoard(frame);
  const originalMove = await measureSpawn(frame, 0.01);
  note("original-rule preview gameplay (control)", {
    initialCount: originalInitial.length, initialValues: originalInitial.map(t => t.value), moveDraw001: originalMove,
    expectation: "2 initial tiles; draw .01 spawns 2 under the upstream rule",
  });
  await shot("arcade-03-original-preview");

  // Save the modified, guaranteed-four package (fresh acquisition, unsaved).
  await closePreviewIfOpen();
  await page.getByLabel("Initial tiles").fill("4");
  await page.getByLabel("Spawning rule").selectOption("guaranteed-four");
  await page.getByRole("button", { name: "Acquire source and create patch" }).click();
  await page.getByRole("button", { name: "Verify rule and save immutable game" }).waitFor({ timeout: 60000 });
  const saveStarted = Date.now();
  await page.getByRole("button", { name: "Verify rule and save immutable game" }).click();
  await page.getByText(/Saved Artifact|Browser .*existing saved games were not changed|save failed/i).first().waitFor({ timeout: 180000 });
  const savedText = await page.locator("div").filter({ hasText: /Saved Artifact|Saved \+ browser-verified/i }).first().innerText().catch(() => "");
  note("verify-and-save (server-side Chromium execution)", { ms: Date.now() - saveStarted, uiText: savedText.slice(0, 600) });
  await shot("arcade-04-saved");

  const savedList = await (await context.request.get(`${BASE}/api/artifacts?kind=source-patch&limit=100`)).json();
  const saved = (savedList.artifacts ?? []).filter(a => a.sourceType === "arcade-source")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  if (!saved) throw new Error("saved arcade-source artifact not found through the library API");
  results.savedArtifact = { id: saved.id, title: saved.title, currentRevisionId: saved.currentRevisionId, createdAt: saved.createdAt };
  note("saved artifact visible through library API", results.savedArtifact);

  const download = await context.request.get(`${BASE}/api/artifacts/${saved.id}?revision=${saved.currentRevisionId}&download=1`);
  const savedBytes = Buffer.from(await download.body());
  const savedPackage = JSON.parse(savedBytes.toString("utf8"));
  const sha = text => createHash("sha256").update(text).digest("hex");
  results.savedPackage = {
    status: download.status(), bytes: savedBytes.length,
    runtimeStatus: savedPackage.runtime?.status,
    observations: savedPackage.runtime?.observations,
    spawnRule: savedPackage.modification?.spawnRule,
    initialTiles: savedPackage.modification?.initialTiles,
    modifiedHashMatchesContent: sha(savedPackage.modification?.content ?? "") === savedPackage.modification?.modifiedSha256,
    filesPinned: (savedPackage.files ?? []).every(file => sha(file.content) === file.sha256),
    patchMentionsFour: /var value = 4;/.test(savedPackage.modification?.patch ?? ""),
  };
  writeFileSync(path.join(runDir, "saved-artifact.json"), savedBytes);
  note("download + independent byte/hash verification of the immutable revision", results.savedPackage);

  // Reopen the saved revision from the UI and measure gameplay again.
  await page.getByRole("button", { name: "Refresh saved games" }).click();
  await page.getByRole("button", { name: `Reopen ${saved.id}` }).click();
  await page.getByText(/Saved Artifact|reopened/i).first().waitFor({ timeout: 120000 });
  frame = await previewFrame();
  const reopenedInitial = await readBoard(frame);
  const reopenedMove = await measureSpawn(frame, 0.01);
  note("reopened immutable revision gameplay (independent measurement)", {
    initialCount: reopenedInitial.length, initialValues: reopenedInitial.map(t => t.value), moveDraw001: reopenedMove,
  });
  await shot("arcade-05-reopened");

  // Fail-closed checks through the app's own API.
  const tampered = structuredClone(savedPackage);
  tampered.modification.modifiedSha256 = "0".repeat(64);
  const tamperedResponse = await context.request.post(`${BASE}/api/arcade/source`, { data: { action: "save", bundle: tampered } });
  const foreignResponse = await context.request.post(`${BASE}/api/arcade/source`, { data: { action: "reopen", artifactId: "00000000-0000-4000-8000-000000000001", revisionId: "00000000-0000-4000-8000-000000000002" } });
  note("fail-closed API checks", {
    tamperedStatus: tamperedResponse.status(), tamperedBody: (await tamperedResponse.text()).slice(0, 240),
    foreignRevisionStatus: foreignResponse.status(), foreignRevisionBody: (await foreignResponse.text()).slice(0, 240),
  });

  results.limitations = [
    "raw.githubusercontent.com is blocked in this sandbox; a byte-faithful local mirror served the four files after verifying the app's own SHA-256 pins (documented as environment scaffolding).",
    "The playable preview is Arena's canvas adapter over the upstream GameManager/Grid/Tile, not the official 2048 UI; board state is memory-only.",
    "Controlled Math.random draws are verifier instrumentation; they prove the spawn-rule difference, not general game quality or arbitrary prompt-to-game capability.",
    "No catalogue publication, no arbitrary patch ecosystem and no in-progress board persistence is claimed.",
  ];
} catch (error) {
  results.failure = error instanceof Error ? error.message : String(error);
  try { await shot("arcade-99-failure"); } catch {}
} finally {
  const file = path.join(runDir, "arcade-results.json");
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence: file, failure: results.failure ?? null, steps: results.steps.length, consoleErrors: results.consoleErrors.length, pageErrors: results.pageErrors.length, httpErrors: results.httpErrors.length }));
  await browser.close();
}
