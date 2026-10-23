// Controlled provider/HTTP failures exercise real browser UI recovery, NOT
// real-provider generation, model quality, or database persistence.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
let server, browser, origin;
let deleteFails = true, libraryFails = false;
const playable = '<!DOCTYPE html><html><body><button onclick="this.textContent=\'won\'">play fixture</button></body></html>';
const draft = { code: "<script>throw new Error('NEVER_LAUNCH_DRAFT')</script>", validation: { ok: false, issues: ["missing game loop"] }, runtime: { backend: "controlled-test", modelId: "not-a-real-provider" } };
before(async () => {
  const bundle = await build({ entryPoints: ["tests/acceptance/recovery-runtime.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname;
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
    if (pathname === "/api/projects") return json({ projects: [] });
    if (pathname === "/api/artifacts") return json(libraryFails ? { error: "Artifact storage unavailable. Retry." } : { artifacts: [{ id: "saved", title: "Retained research", body: "Useful durable evidence", kind: "research", sourceType: "manual" }] }, libraryFails ? 503 : 200);
    if (pathname === "/api/artifacts/saved") return json(deleteFails ? { error: "Deletion refused by storage" } : { ok: true }, deleteFails ? 503 : 200);
    if (pathname === "/api/arcade/forge") return json({ error: "Draft failed validation", draft }, 422);
    if (pathname === "/api/arcade/saved") return json({ game: { id: "saved", prompt: "Existing playable fixture", code: playable, engine: "ai-codegen", gameType: "custom" } });
    if (pathname === "/api/arcade") return json({ games: [{ id: "saved", prompt: "Existing playable fixture", engine: "ai-codegen", gameType: "custom", bytes: playable.length }] });
    if (pathname.startsWith("/api/")) return json({});
    res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
after(async () => { await browser?.close(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); });

test("Arcade failure leaves old game playable and exposes only inert, downloadable draft text", async (t) => {
  const page = await browser.newPage(); page.setDefaultTimeout(5000); t.after(() => page.close());
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/arcade`);
  await page.getByText("Existing playable fixture", { exact: true }).click();
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "play fixture" }).click(); await expect(frame.getByRole("button", { name: "won" })).toBeVisible();
  await page.getByPlaceholder(/Describe any game/).fill("A materially different custom mechanic");
  await page.getByRole("button", { name: /Generate any game/ }).click();
  const panel = page.getByTestId("arcade-failed-draft"); await expect(panel).toBeVisible();
  await panel.locator("summary").click(); await expect(panel).toContainText("not-a-real-provider");
  await expect(frame.getByRole("button", { name: "won" })).toBeVisible();
  const download = page.waitForEvent("download"); await panel.getByRole("button", { name: "Download failed draft as text" }).click();
  const file = await download; assert.equal(file.suggestedFilename(), "arena-failed-draft.html.txt");
  assert.equal(await readFile(await file.path(), "utf8"), draft.code);
  assert.deepEqual(errors, []);
});

test("Artifact delete failure preserves the card, successful retry removes it", async (t) => {
  deleteFails = true; libraryFails = false;
  const page = await browser.newPage(); page.setDefaultTimeout(5000); t.after(() => page.close()); page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${origin}/artifacts`); await expect(page.getByText("Retained research", { exact: true })).toBeVisible();
  await page.getByText("Retained research", { exact: true }).click();
  await page.getByRole("button", { name: "Delete Retained research" }).click();
  await expect(page.getByRole("alert")).toContainText("Deletion refused");
  await expect(page.getByText("Retained research", { exact: true })).toBeVisible();
  deleteFails = false; await page.getByRole("button", { name: "Delete Retained research" }).click();
  await expect(page.getByText("Retained research", { exact: true })).toHaveCount(0);
});

test("Artifact library storage failure is not shown as an empty library; Retry retrieves work", async (t) => {
  libraryFails = true;
  const page = await browser.newPage(); page.setDefaultTimeout(5000); t.after(() => page.close()); await page.goto(`${origin}/artifacts`);
  await expect(page.getByRole("alert")).toContainText("Artifact storage unavailable");
  libraryFails = false; await page.getByRole("button", { name: "Retry loading artifacts" }).click();
  await expect(page.getByText("Retained research", { exact: true })).toBeVisible();
});
