// Isolated WebKit evidence for imported HTML progress backup portability.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { webkit } = require("playwright-core");
const headless = process.env.WEBKIT_HEADLESS !== "0";
const browser = await webkit.launch({
  ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}),
  headless,
});
const output = new URL("../generated-artifacts/arcade-progress-webkit/", import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const source = `<!doctype html><html><head><title>Portable progress fixture</title></head><body>
<h1>Portable progress fixture</h1><label>Progress value<input id="value"></label>
<button id="save">Save progress</button><output id="stored"></output>
<script>const field=document.getElementById("value"),stored=document.getElementById("stored");function draw(){stored.textContent=localStorage.getItem("progress")||"unset"}document.getElementById("save").onclick=()=>{localStorage.setItem("progress",field.value);draw()};draw();</script>
</body></html>`;
const otherSource = `<!doctype html><html><head><title>Separate game fixture</title></head><body>
<h1>Separate game fixture</h1><label>Progress value<input id="value"></label>
<button id="save">Save progress</button><output id="stored"></output>
<script>const field=document.getElementById("value"),stored=document.getElementById("stored");function draw(){stored.textContent=localStorage.getItem("progress")||"unset"}document.getElementById("save").onclick=()=>{localStorage.setItem("progress",field.value);draw()};draw();</script>
</body></html>`;
const checks = [];
const errors = [];
let context;
let page;
const records = (target = page) => target.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("arenaforge-imported-games");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const request = db.transaction("games", "readonly").objectStore("games").getAll();
    request.onsuccess = () => { resolve(request.result); db.close(); };
    request.onerror = () => { reject(request.error); db.close(); };
  };
}));
const saves = (target = page) => target.evaluate(() => Object.fromEntries(Object.keys(localStorage)
  .filter(key => key.startsWith("arenaforge.game-save.v1:"))
  .map(key => [key.slice("arenaforge.game-save.v1:".length), localStorage.getItem(key)])));
const selectedFrame = name => page.frameLocator(`iframe[title="Playable game: ${name}"]`);
const openShelf = async target => {
  await target.goto(`${base}/arcade`);
  await target.getByRole("tab", { name: "Import and emulate" }).click();
};
const importGame = async (name, html) => {
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[type="file"][accept*=".html"]').setInputFiles({
    name, mimeType: "text/html", buffer: Buffer.from(html),
  });
  await selectedFrame(name).getByRole("heading", { name: html === source ? "Portable progress fixture" : "Separate game fixture" }).waitFor();
  return (await records()).find(game => game.name === name);
};
const selectGame = async (game, name) => {
  await page.getByTestId(`button-select-imported-game-${game.id}`).click();
  await selectedFrame(name).locator("#stored").waitFor();
};
const saveProgress = async (game, name, value) => {
  const player = selectedFrame(name);
  await player.getByLabel("Progress value").fill(value);
  await player.getByRole("button", { name: "Save progress", exact: true }).click();
  await player.locator("#stored").filter({ hasText: new RegExp(`^${value}$`) }).waitFor();
  await page.waitForFunction(({ id, value }) =>
    JSON.parse(localStorage.getItem(`arenaforge.game-save.v1:${id}`) || "{}").progress === value,
  { id: game.id, value });
};
const backupPanel = () => page.getByTestId("imported-progress-backup");
const uploadBackup = text => backupPanel().getByTestId("input-imported-progress-backup").setInputFiles({
  name: "portable-fixture.arena-progress.json", mimeType: "application/json", buffer: Buffer.from(text),
});

try {
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("af_local_mode", "0");
    localStorage.setItem("af_ephemeral", "1");
    localStorage.setItem("af_key_openrouter", "webkit-progress-test-placeholder-not-a-credential");
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => {
    const request = new URL(url);
    return request.pathname === "/api/arcade" && request.searchParams.get("limit") === "30";
  }, route => route.fulfill({ json: { games: [] } }));
  await page.route(url => new URL(url).pathname === "/api/models", route => route.fulfill({ json: { models: [] } }));

  await openShelf(page);
  const originalGame = await importGame("portable-fixture.html", source);
  assert.ok(originalGame);
  await saveProgress(originalGame, "portable-fixture.html", "original-save-blue-42");
  const originalSources = await records();
  await backupPanel().locator("summary").click();
  const downloadPromise = page.waitForEvent("download");
  await backupPanel().getByTestId("button-export-imported-progress").click();
  const download = await downloadPromise;
  const backupText = await readFile(await download.path(), "utf8");
  const backup = JSON.parse(backupText);
  assert.equal(backup.gameId, originalGame.id);
  assert.equal(backup.data.progress, "original-save-blue-42");
  assert.equal("source" in backup, false);
  checks.push("exported a real imported game's saved progress without including its HTML source");

  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("af_local_mode", "0");
    localStorage.setItem("af_ephemeral", "1");
    localStorage.setItem("af_key_openrouter", "webkit-progress-test-placeholder-not-a-credential");
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(url => {
    const request = new URL(url);
    return request.pathname === "/api/arcade" && request.searchParams.get("limit") === "30";
  }, route => route.fulfill({ json: { games: [] } }));
  await page.route(url => new URL(url).pathname === "/api/models", route => route.fulfill({ json: { models: [] } }));
  await openShelf(page);
  const copy = await importGame("portable-fixture.html", source);
  assert.ok(copy && copy.id !== originalGame.id);
  await saveProgress(copy, "portable-fixture.html", "copy-before-restore");
  const other = await importGame("separate-game.html", otherSource);
  assert.ok(other && other.id !== copy.id);
  await saveProgress(other, "separate-game.html", "unrelated-save-green-8");
  const sourceSnapshot = await records();
  const otherSave = (await saves())[other.id];
  await selectGame(copy, "portable-fixture.html");

  const summary = backupPanel().locator("summary");
  await summary.scrollIntoViewIfNeeded();
  const summaryBounds = await summary.boundingBox();
  assert.ok(summaryBounds && summaryBounds.x >= 0 && summaryBounds.x + summaryBounds.width <= 391 &&
    summaryBounds.y >= 0 && summaryBounds.y + summaryBounds.height <= 845,
    "restore disclosure should fit the mobile viewport");
  await page.touchscreen.tap(summaryBounds.x + summaryBounds.width / 2, summaryBounds.y + summaryBounds.height / 2);
  await backupPanel().getByTestId("input-imported-progress-backup").waitFor();

  await uploadBackup("not JSON");
  await backupPanel().getByRole("alert").getByText(/not valid JSON/).waitFor();
  assert.equal(await backupPanel().getByTestId("imported-progress-restore-preview").count(), 0);
  assert.equal(JSON.parse((await saves())[copy.id]).progress, "copy-before-restore");
  assert.equal(await backupPanel().getByText(/Progress restored locally/).count(), 0);
  checks.push("malformed JSON shows a readable error and does not show a preview or false success");

  await backupPanel().getByTestId("input-imported-progress-backup").dispatchEvent("cancel");
  await backupPanel().getByRole("status").getByText("No file selected. The current progress was not changed.").waitFor();
  assert.equal(JSON.parse((await saves())[copy.id]).progress, "copy-before-restore");
  checks.push("cancelled file selection reports that no save changed");

  await uploadBackup(backupText);
  const preview = backupPanel().getByTestId("imported-progress-restore-preview");
  await preview.waitFor();
  await backupPanel().getByText(/Different import identity, but the HTML source matches exactly/).waitFor();
  const previewBounds = await preview.boundingBox();
  assert.ok(previewBounds && previewBounds.x >= 0 && previewBounds.x + previewBounds.width <= 391,
    "restore preview should fit the mobile viewport");
  const restoreButton = backupPanel().getByTestId("button-restore-imported-progress");
  assert.equal(await restoreButton.isDisabled(), true, "copy restore must require explicit confirmation");
  await page.evaluate(id => {
    const key = `arenaforge.game-save.v1:${id}`;
    const realSetItem = Storage.prototype.setItem;
    window.__restoreStorageFault = true;
    Storage.prototype.setItem = function(candidate, value) {
      if (window.__restoreStorageFault && candidate === key) throw new DOMException("Injected storage refusal", "QuotaExceededError");
      return realSetItem.call(this, candidate, value);
    };
  }, copy.id);
  const checkbox = backupPanel().getByRole("checkbox");
  await checkbox.focus();
  await page.keyboard.press("Space");
  assert.equal(await checkbox.isChecked(), true, "keyboard Space must set restore confirmation");
  await restoreButton.scrollIntoViewIfNeeded();
  const restoreBounds = await restoreButton.boundingBox();
  assert.ok(restoreBounds && restoreBounds.x >= 0 && restoreBounds.x + restoreBounds.width <= 391 &&
    restoreBounds.y >= 0 && restoreBounds.y + restoreBounds.height <= 845,
    "restore control should fit the mobile viewport");
  await page.screenshot({ path: new URL("mobile-confirmation.png", output).pathname });
  await page.touchscreen.tap(restoreBounds.x + restoreBounds.width / 2, restoreBounds.y + restoreBounds.height / 2);
  await backupPanel().getByRole("alert").getByText(/Injected storage refusal/).waitFor();
  assert.equal(JSON.parse((await saves())[copy.id]).progress, "copy-before-restore");
  assert.equal((await saves())[other.id], otherSave);
  assert.equal(await backupPanel().getByText(/Progress restored locally/).count(), 0,
    "storage refusal must not produce a restore success message");
  checks.push("injected storage refusal reports an error, preserves both saves, and does not report success");

  await page.evaluate(() => { window.__restoreStorageFault = false; });
  await restoreButton.click();
  await backupPanel().getByText(/Progress restored locally/).waitFor();
  await selectedFrame("portable-fixture.html").locator("#stored").filter({ hasText: /^original-save-blue-42$/ }).waitFor();
  assert.equal(JSON.parse((await saves())[copy.id]).progress, "original-save-blue-42");
  assert.equal((await saves())[other.id], otherSave);
  assert.deepEqual(await records(), sourceSnapshot);
  assert.equal(sourceSnapshot.find(game => game.id === copy.id)?.source, source);
  checks.push("confirmed copy restore changes only the selected save, keeps both HTML sources intact, and preserves the other game's progress");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await selectGame(copy, "portable-fixture.html");
  await selectedFrame("portable-fixture.html").locator("#stored").filter({ hasText: /^original-save-blue-42$/ }).waitFor();
  assert.equal(JSON.parse((await saves())[copy.id]).progress, "original-save-blue-42");
  assert.equal((await saves())[other.id], otherSave);
  await backupPanel().locator("summary").click();
  await preview.waitFor({ state: "hidden" });
  await page.screenshot({ path: new URL("mobile-restore.png", output).pathname });
  assert.deepEqual(errors, []);
  checks.push("restored progress survives reload in the new import identity; unrelated save remains unchanged");

  const report = {
    passed: true,
    engine: "playwright-webkit",
    browserVersion: browser.version(),
    playwrightVersion: require("playwright-core/package.json").version,
    host: process.platform,
    headless,
    viewport: { width: 390, height: 844 },
    checks,
    filePickerCancelSimulated: true,
    storageRefusalInjected: true,
    nativeSafariOrIOSFilesVerified: false,
    evidenceLimit: "Automated Playwright WebKit on Linux is not Apple Safari or the iOS Files picker. Download and file selection use Playwright APIs; picker cancellation and storage refusal are simulated.",
  };
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page?.locator("body").innerText().catch(() => "")}`);
  throw error;
} finally {
  await context?.close();
  await browser.close();
}
