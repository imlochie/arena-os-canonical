// Real UI/IndexedDB with original source fixtures and mocked model responses.
// This checks revision recovery, not model inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(() => {
  if (window !== window.top) return;
  localStorage.setItem("af_local_mode", "0");
  localStorage.setItem("af_ephemeral", "1");
  localStorage.setItem("af_key_openrouter", "rollback-test-placeholder-not-a-credential");
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === "games" && window.__failRevisionWrites) throw new DOMException("Injected quota failure", "QuotaExceededError");
    return put.apply(this, args);
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const output = new URL("../generated-artifacts/arcade-revision-rollback/", import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const original = `<!doctype html><html><head><title>Original rollback fixture</title></head><body><h1 id="version">A</h1><button id="point">Point</button><p id="score"></p><script>let n=Number(localStorage.getItem("points")||0);const draw=()=>document.getElementById("score").textContent=String(n);document.getElementById("point").onclick=()=>{localStorage.setItem("points",String(++n));draw()};draw();</script></body></html>`;
const source = version => original.replace('id="version">A', `id="version">${version}`);
let release;
let requested = "";
await page.route("**/api/arcade/import/revise", async route => {
  const body = route.request().postDataJSON();
  assert.equal(body.ephemeral, true);
  assert.ok(body.priorCode.includes("Original rollback fixture"));
  requested = body.prompt;
  if (body.prompt === "cancel" || body.prompt === "stale") await new Promise(resolve => { release = resolve; });
  try {
    if (body.prompt === "network fail") await route.fulfill({ status: 503, json: { error: "Injected model outage" } });
    else await route.fulfill({ json: { code: body.prompt === "unsafe" ? '<html><script src="https://example.invalid/script.js"></script></html>' : source(body.prompt === "C" ? "C" : "B"), warnings: [] } });
  } catch (error) { if (body.prompt !== "cancel") throw error; }
});
const frame = () => page.frameLocator('iframe[title="Playable game: rollback-fixture.html"]');
const records = () => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("arenaforge-imported-games", 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const get = db.transaction("games", "readonly").objectStore("games").getAll();
    get.onsuccess = () => { resolve(get.result); db.close(); };
    get.onerror = () => { reject(get.error); db.close(); };
  };
}));
const saveBytes = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith("arenaforge.game-save.v1:")).map(k => [k, localStorage.getItem(k)])));
const version = async expected => {
  await frame().locator("#version").waitFor();
  assert.equal(await frame().locator("#version").innerText(), expected);
};
const revise = async prompt => {
  await page.getByLabel("Revise this browser game").fill(prompt);
  await page.getByRole("button", { name: "Apply revision", exact: true }).click();
};
const quota = value => page.evaluate(value => { window.__failRevisionWrites = value; }, value);
const reopen = async () => {
  await page.goto(`${base}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate" }).click();
};
const checks = [];
try {
  await reopen();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[type="file"][accept*=".html"]').setInputFiles({ name: "rollback-fixture.html", mimeType: "text/html", buffer: Buffer.from(original) });
  await version("A");
  await frame().getByRole("button", { name: "Point", exact: true }).click();
  await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith("arenaforge.game-save.v1:")));
  const progress = await saveBytes();
  await revise("B");
  await page.getByTestId("imported-revision-undo").waitFor();
  await version("B");
  const pending = await records();
  await quota(true);
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByText(/The revision could not be kept/).waitFor();
  assert.deepEqual(await records(), pending);
  assert.equal(await page.getByTestId("button-undo-imported-revision").isVisible(), true);
  await quota(false);
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-rollback").waitFor();
  const kept = await records();
  assert.equal(kept[0].revisionRollback.source, original);
  assert.equal(kept[0].revisionUndoSource, undefined);
  checks.push("keep is atomic; quota failure retains pending undo; success preserves one exact rollback source");
  await reopen();
  await page.getByTestId("imported-revision-rollback").waitFor();
  await version("B");
  assert.deepEqual(await saveBytes(), progress);
  checks.push("kept rollback, source and progress survive reload");
  const unchanged = await records();
  for (const prompt of ["network fail", "unsafe"]) {
    await revise(prompt);
    await page.getByRole("alert").getByText(/Revision failed:/).waitFor();
    assert.deepEqual(await records(), unchanged);
    await version("B");
  }
  await revise("cancel");
  await page.waitForFunction(() => document.querySelector('[data-testid="button-cancel-imported-revision"]'));
  while (requested !== "cancel") await page.waitForTimeout(10);
  await page.getByTestId("button-cancel-imported-revision").click();
  release();
  await page.getByText(/Revision cancelled/).waitFor();
  assert.deepEqual(await records(), unchanged);
  assert.deepEqual(await saveBytes(), progress);
  checks.push("outage, unsafe source and cancellation preserve active source, rollback and exact progress");
  await quota(true);
  await revise("C");
  await page.getByText(/The revision could not be saved/).waitFor();
  assert.deepEqual(await records(), unchanged);
  await version("B");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/The previous version could not be restored/).waitFor();
  assert.deepEqual(await records(), unchanged);
  await version("B");
  await quota(false);
  checks.push("failed revision commit and failed restoration never publish unsaved source or overwrite rollback");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await version("A");
  assert.deepEqual(await saveBytes(), progress);
  const restored = await records();
  assert.equal(restored[0].id, kept[0].id);
  assert.equal(restored[0].revisionRollback.source, kept[0].source);
  await reopen();
  await page.getByTestId("imported-revision-rollback").waitFor();
  await version("A");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await version("B");
  assert.deepEqual(await saveBytes(), progress);
  checks.push("restore is persistent and reversible without changing game identity or progress");
  await revise("C");
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-rollback").waitFor();
  const final = await records();
  assert.equal(final[0].revisionRollback.source, source("B"));
  assert.equal(final[0].source, source("C"));
  assert.deepEqual(errors, []);
  checks.push("a subsequent kept revision replaces the single bounded rollback, rather than accumulating history");
  await page.getByTestId("imported-revision-rollback").scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL("rollback.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks, modelCallTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, modelCallTested: false }));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally { await browser.close(); }
