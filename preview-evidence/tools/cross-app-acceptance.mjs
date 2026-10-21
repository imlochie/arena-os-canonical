#!/usr/bin/env node
/** Cross-application integration smoke: real navigation, persistence and error
 *  presentation across the rooms that this candidate touches. */
import { chromium } from "/home/user/preview-13638fe/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3000";
const root = process.cwd();
const fixture = JSON.parse(readFileSync(path.join(root, ".data/acceptance/product-preview/waveyard-fixture.json"), "utf8"));
const runDir = path.join(root, ".data/acceptance/product-preview/runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });
const results = { kind: "cross-application-navigation", pages: [], consoleErrors: [], pageErrors: [], badResponses: [], screenshots: [] };

const browser = await chromium.launch({
  executablePath: "/tmp/chromium", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp", LD_LIBRARY_PATH: "/tmp/al2023/lib" },
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", msg => { if (msg.type() === "error") results.consoleErrors.push(msg.text().slice(0, 300)); });
page.on("pageerror", error => results.pageErrors.push(error.message.slice(0, 300)));
page.on("response", response => {
  const url = response.url();
  if (response.status() >= 400 && new URL(url).pathname !== "/favicon.ico") results.badResponses.push({ status: response.status(), url: url.replace(BASE, "") });
});

const visit = async (route, name, waitFor) => {
  const started = Date.now();
  const response = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  if (waitFor) await page.getByText(waitFor).first().waitFor({ timeout: 25000 }).catch(() => {});
  const file = path.join(runDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700);
  results.pages.push({ route, name, status: response?.status(), ms: Date.now() - started, text, screenshot: file });
  results.screenshots.push(file);
  return response;
};

try {
  await visit("/", "01-home", null);
  const navLinks = await page.locator("nav a").evaluateAll(nodes => nodes.map(n => ({ text: n.textContent?.trim().slice(0, 40), href: n.getAttribute("href") })));
  results.navLinks = navLinks.filter(link => link.href);

  await visit("/rooms", "02-rooms", "Rooms");
  const roomLinks = await page.locator("a[href^='/rooms/'], a[href^='/waveyard'], a[href^='/spaces'], a[href^='/arcade']").evaluateAll(nodes => [...new Set(nodes.map(n => n.getAttribute("href")))]);
  results.roomLinks = roomLinks.slice(0, 40);

  await visit("/arcade", "03-arcade", "Source workshop");
  await page.getByText("Source workshop · supported MIT 2048 adapter").click();
  await page.getByRole("button", { name: "Refresh saved games" }).click().catch(() => {});
  await page.waitForTimeout(1500);
  const arcadeBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  results.arcade = {
    savedListVisible: /Saved source games/.test(arcadeBody),
    reopenButtons: await page.getByRole("button", { name: /^Reopen [0-9a-f-]{36}$/ }).count(),
    showsSavedGame: /2048: guaranteed-four; 4 initial tiles/.test(arcadeBody),
    showsTruthLabels: /Human review pending|Generated but not saved|Board progress is not persisted|Revision [0-9a-f-]{36}/i.test(arcadeBody),
  };

  await visit("/spaces", "04-spaces", "Space");
  const spacesBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  results.spaces = {
    showsSpace: /Product preview space/.test(spacesBody),
    showsMissionState: /done|mission|run/i.test(spacesBody),
  };
  await page.getByText("Product preview space").first().scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const detailBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const cardStart = detailBody.indexOf("Product preview space");
  results.spaceDetail = {
    cardVisible: cardStart >= 0,
    cardText: cardStart >= 0 ? detailBody.slice(cardStart, cardStart + 600) : null,
    showsFleetModels: /Qwen2\.5 (32B|7B) \(TurboAgent\)/.test(detailBody),
    historyOptions: await page.locator("select[aria-label='Mission history'] option").allTextContents().catch(() => []),
    outputDownloadLinks: await page.getByRole("link", { name: /^Download acceptance\// }).count().catch(() => 0),
  };
  await page.screenshot({ path: path.join(runDir, "05-space-card.png"), fullPage: false });

  await visit("/waveyard", "06-waveyard", null);
  await visit(fixture.sessionUrl, "07-waveyard-session", "Session");
  const sessionBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  results.waveyard = {
    loadsSession: /Product preview · live session/.test(sessionBody),
    lanes: await page.getByRole("group", { name: /^Source for / }).count(),
    honestNoDevicesNotice: /No audio output devices are currently reported by the system/.test(sessionBody),
  };

  // Back-navigation continuity: the saved session selection must still be there.
  await page.goto(`${BASE}/waveyard/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const sessionsBody = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  results.waveyardSessions = { listsPreviews: /Product preview · live session/.test(sessionsBody) };
  await page.screenshot({ path: path.join(runDir, "08-waveyard-sessions.png"), fullPage: false });

  // Shared artifact store: the arcade save and the mission outputs are both
  // readable through the one artifact library API.
  const artifacts = await (await context.request.get(`${BASE}/api/artifacts?limit=100`)).json();
  const list = artifacts.artifacts ?? [];
  results.artifacts = {
    total: list.length,
    arcadeSourcePatches: list.filter(a => a.sourceType === "arcade-source").length,
    missionOutputs: list.filter(a => a.sourceType === "mission-output").length,
  };
} catch (error) {
  results.failure = error instanceof Error ? error.message : String(error);
  try { await page.screenshot({ path: path.join(runDir, "99-failure.png"), fullPage: false }); } catch {}
} finally {
  const file = path.join(runDir, "cross-app-results.json");
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence: file, failure: results.failure ?? null, pages: results.pages.length, consoleErrors: results.consoleErrors.length, badResponses: results.badResponses.length, artifacts: results.artifacts, spaces: results.spaces, arcade: results.arcade, waveyard: results.waveyard }));
  await browser.close();
}
