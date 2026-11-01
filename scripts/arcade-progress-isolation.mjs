// Real sandboxed players and browser persistence; only inference is mocked.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(() => {
  if (window !== window.top) return;
  localStorage.setItem("af_local_mode", "0");
  localStorage.setItem("af_ephemeral", "1");
  localStorage.setItem("af_key_openrouter", "isolation-test-placeholder-not-a-credential");
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL("../generated-artifacts/arcade-progress-isolation/", import.meta.url);
await mkdir(output, { recursive: true });
const original = `<!doctype html><html><head><title>Original shared-key fixture</title></head><body>
<h1 id="version">Original</h1><label>Progress value<input id="value"></label>
<button id="save">Save progress</button><button id="remove">Remove key</button><button id="clear">Clear game data</button><output id="stored"></output>
<script>const field=document.getElementById("value"),stored=document.getElementById("stored");function draw(){stored.textContent=localStorage.getItem("progress")||"unset"}document.getElementById("save").onclick=()=>{localStorage.setItem("progress",field.value);draw()};document.getElementById("remove").onclick=()=>{localStorage.removeItem("progress");draw()};document.getElementById("clear").onclick=()=>{localStorage.clear();draw()};draw();</script></body></html>`;
const revised = original.replace('id="version">Original', 'id="version">Revised');
let modelCalls = 0;
await page.route("**/api/arcade/import/revise", async route => {
  modelCalls++;
  const body = route.request().postDataJSON();
  assert.equal(body.ephemeral, true);
  assert.equal(body.priorCode, original);
  assert.equal(JSON.stringify(body).includes("private-progress-"), false, "player saves must not enter the model request");
  await route.fulfill({ json: { code: revised, warnings: [] } });
});
const frame = () => page.frameLocator('iframe[title="Playable game: same-name.html"]');
const saves = (target = page) => target.evaluate(() => Object.fromEntries(Object.keys(localStorage)
  .filter(key => key.startsWith("arenaforge.game-save.v1:")).map(key => [key.slice("arenaforge.game-save.v1:".length), localStorage.getItem(key)])));
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
const expectStored = async value => {
  await frame().locator("#stored").filter({ hasText: new RegExp(`^${value}$`) }).waitFor();
};
const expectVersion = async value => { await frame().getByRole("heading", { name: value, exact: true }).waitFor(); };
const select = async (id, value, version = "Original") => {
  await page.getByTestId(`button-select-imported-game-${id}`).click();
  await expectVersion(version);
  await expectStored(value);
};
const save = async (id, value) => {
  await frame().getByLabel("Progress value").fill(value);
  await frame().getByRole("button", { name: "Save progress", exact: true }).click();
  await expectStored(value);
  await page.waitForFunction(({ id, value }) => JSON.parse(localStorage.getItem(`arenaforge.game-save.v1:${id}`) || "{}").progress === value, { id, value });
};
const reopen = async () => {
  await page.goto(`${base}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate" }).click();
};
const importGame = async () => {
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[type="file"][accept*=".html"]').setInputFiles({ name: "same-name.html", mimeType: "text/html", buffer: Buffer.from(original) });
  await expectVersion("Original");
};
const checks = [];
try {
  await reopen();
  await importGame();
  const first = (await records())[0];
  await frame().locator("#version").evaluate(element => { element.dataset.livePlayer = "first-live-player"; });
  await save(first.id, "private-progress-red-11");
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  assert.equal(await frame().locator("#version").getAttribute("data-live-player"), "first-live-player", "first save must not restart the active game");
  const red = (await saves())[first.id];
  await importGame();
  await expectStored("unset");
  const second = (await records()).find(record => record.id !== first.id);
  assert.ok(second && second.id !== first.id);
  assert.equal(second.name, first.name);
  assert.equal(second.source, first.source);
  await save(second.id, "private-progress-blue-22");
  const blue = (await saves())[second.id];
  assert.equal((await saves())[first.id], red);
  assert.equal(await page.evaluate(() => localStorage.getItem("progress")), null);
  await select(first.id, "private-progress-red-11");
  await save(first.id, "private-progress-red-13");
  const beforeReload = await saves();
  await select(second.id, "private-progress-blue-22");
  assert.equal((await saves())[second.id], blue);
  await reopen();
  await select(first.id, "private-progress-red-13");
  await select(second.id, "private-progress-blue-22");
  assert.deepEqual(await saves(), beforeReload);
  checks.push("identical source and filenames get distinct identities; shared-key values stay isolated through switching and page reload");

  await select(first.id, "private-progress-red-13");
  await page.evaluate(() => {
    window.__isolationProbeCount = 0;
    window.addEventListener("message", event => { if (event.data?.isolationProbe) window.__isolationProbeCount++; });
  });
  await frame().locator("body").evaluate((_, otherId) => {
    for (const op of ["set", "remove", "clear"]) parent.postMessage({ channel: "arenaforge-game-save", gameId: otherId, op, key: "progress", value: "forged", isolationProbe: true }, "*");
  }, second.id);
  await page.evaluate(id => {
    const message = { channel: "arenaforge-game-save", gameId: id, op: "set", key: "progress", value: "forged", isolationProbe: true };
    window.postMessage(message, "*");
    const sibling = document.createElement("iframe");
    sibling.id = "untrusted-save-probe";
    sibling.setAttribute("sandbox", "allow-scripts");
    sibling.srcdoc = `<script>parent.postMessage(${JSON.stringify(message)},"*")</script>`;
    document.body.append(sibling);
  }, first.id);
  await page.waitForFunction(() => window.__isolationProbeCount === 5);
  assert.deepEqual(await saves(), beforeReload);
  await expectStored("private-progress-red-13");
  await page.locator("#untrusted-save-probe").evaluate(element => element.remove());
  checks.push("active player cannot set/remove/clear another game's namespace; parent and sibling frames cannot impersonate the authorized player");

  const secondBeforeRevision = (await records()).find(record => record.id === second.id);
  await page.getByLabel("Revise this browser game").fill("Change the heading to Revised, preserving the progress controls.");
  await page.getByRole("button", { name: "Apply revision", exact: true }).click();
  await page.getByTestId("imported-revision-undo").waitFor();
  await expectVersion("Revised");
  await expectStored("private-progress-red-13");
  assert.deepEqual(await saves(), beforeReload);
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-rollback").waitFor();
  assert.deepEqual((await records()).find(record => record.id === second.id), secondBeforeRevision);
  await save(first.id, "private-progress-red-14");
  assert.equal((await saves())[second.id], blue);
  await reopen();
  await select(second.id, "private-progress-blue-22");
  await select(first.id, "private-progress-red-14", "Revised");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await expectVersion("Original");
  await expectStored("private-progress-red-14");
  assert.equal((await saves())[second.id], blue);
  assert.equal(modelCalls, 1);
  checks.push("revision, keep, reload and rollback preserve the selected identity and never change the other game's source or save; model input excludes both saves");

  await frame().locator("#version").evaluate(element => { element.dataset.livePlayer = "after-restore"; });
  await frame().getByRole("button", { name: "Remove key", exact: true }).click();
  await expectStored("unset");
  await page.waitForFunction(id => !JSON.parse(localStorage.getItem(`arenaforge.game-save.v1:${id}`) || "{}").progress, first.id);
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await frame().locator("#version").getAttribute("data-live-player"), "after-restore");
  assert.equal((await saves())[second.id], blue);
  await save(first.id, "private-progress-red-15");
  await frame().getByRole("button", { name: "Clear game data", exact: true }).click();
  await expectStored("unset");
  await page.waitForFunction(id => localStorage.getItem(`arenaforge.game-save.v1:${id}`) === null, first.id);
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await frame().locator("#version").getAttribute("data-live-player"), "after-restore", "game-originated clears must not restart gameplay");
  assert.equal((await saves())[second.id], blue);
  await save(first.id, "private-progress-red-16");
  await page.getByRole("button", { name: "Clear progress", exact: true }).click();
  await expectStored("unset");
  await page.waitForFunction(id => localStorage.getItem(`arenaforge.game-save.v1:${id}`) === null, first.id);
  await select(second.id, "private-progress-blue-22");
  await reopen();
  await select(first.id, "unset");
  await select(second.id, "private-progress-blue-22");
  assert.equal((await saves())[second.id], blue);
  assert.equal((await saves())[first.id], undefined);
  assert.deepEqual(errors, []);
  checks.push("ordinary saves and game-originated remove/clear never restart the player; all clear controls affect only the active game, including after reload");
  if (process.argv.includes("--progress-backup-only")) {
    const panel = page.getByTestId("imported-progress-backup");
    await panel.locator("summary").click();
    const downloadEvent = page.waitForEvent("download");
    await panel.getByTestId("button-export-imported-progress").click();
    const download = await downloadEvent;
    const backupText = await readFile(await download.path(), "utf8");
    const backup = JSON.parse(backupText);
    assert.equal(backup.gameId, second.id);
    assert.equal(backup.data.progress, "private-progress-blue-22");
    assert.equal("source" in backup, false);
    const sourcesBefore = await records();
    const upload = async text => {
      await panel.getByTestId("input-imported-progress-backup").setInputFiles({ name: "fixture.arena-progress.json", mimeType: "application/json", buffer: Buffer.from(text) });
    };
    const confirm = async () => {
      await panel.getByRole("checkbox").check();
      await panel.getByTestId("button-restore-imported-progress").click();
    };
    await save(second.id, "private-progress-blue-23");
    await upload(backupText);
    await panel.getByTestId("imported-progress-restore-preview").waitFor();
    assert.equal(await panel.getByTestId("button-restore-imported-progress").isDisabled(), true);
    await panel.getByRole("button", { name: "Cancel restore", exact: true }).click();
    assert.equal(JSON.parse((await saves())[second.id]).progress, "private-progress-blue-23");
    for (const invalid of ["not JSON", JSON.stringify({ ...backup, version: 999 }),
      JSON.stringify({ ...backup, gameId: "unrelated-id", sourceSha256: "a".repeat(64) }),
      JSON.stringify({ ...backup, data: { progress: 1 } }), " ".repeat(256 * 1024 + 1)]) {
      await upload(invalid);
      await panel.getByRole("alert").waitFor();
      assert.equal(await panel.getByTestId("imported-progress-restore-preview").count(), 0);
      assert.equal(JSON.parse((await saves())[second.id]).progress, "private-progress-blue-23");
    }
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (window.__failProgressRestore && key.startsWith("arenaforge.game-save.v1:")) throw new DOMException("Injected progress quota failure", "QuotaExceededError");
        return set.call(this, key, value);
      };
    });
    await upload(backupText);
    await panel.getByTestId("imported-progress-restore-preview").waitFor();
    await page.evaluate(() => { window.__failProgressRestore = true; });
    await confirm();
    await panel.getByRole("alert").getByText(/Injected progress quota failure/).waitFor();
    assert.equal(JSON.parse((await saves())[second.id]).progress, "private-progress-blue-23");
    await page.evaluate(() => { window.__failProgressRestore = false; });
    await panel.getByTestId("button-restore-imported-progress").click();
    await panel.getByText(/Progress restored locally/).waitFor();
    await expectStored("private-progress-blue-22");
    assert.deepEqual(await records(), sourcesBefore);
    assert.equal((await saves())[first.id], undefined);
    checks.push("backup export, cancel, malformed/mismatched/oversized rejection and quota-safe retry preserve source and unrelated progress");
    await upload(backupText);
    await panel.getByTestId("imported-progress-restore-preview").waitFor();
    await save(second.id, "private-progress-blue-24");
    await confirm();
    await panel.getByRole("alert").getByText(/Progress changed/).waitFor();
    assert.equal(JSON.parse((await saves())[second.id]).progress, "private-progress-blue-24");
    await upload(backupText);
    await panel.getByTestId("imported-progress-restore-preview").waitFor();
    await confirm();
    await panel.getByText(/Progress restored locally/).waitFor();
    await reopen();
    await select(second.id, "private-progress-blue-22");
    assert.deepEqual(await records(), sourcesBefore);
    checks.push("changed progress invalidates an old preview; a confirmed fresh restore survives page reload without changing source or history");
    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const other = await otherContext.newPage();
    other.on("pageerror", error => errors.push(error.message));
    await other.goto(`${base}/arcade`);
    await other.getByRole("tab", { name: "Import and emulate" }).click();
    await other.getByLabel(/I own this game or have permission to use and play it/).check();
    await other.locator('input[type="file"][accept*=".html"]').setInputFiles({ name: "same-name.html", mimeType: "text/html", buffer: Buffer.from(original) });
    const otherFrame = other.frameLocator('iframe[title="Playable game: same-name.html"]');
    await otherFrame.locator("#stored").filter({ hasText: /^unset$/ }).waitFor();
    const otherGame = (await records(other))[0];
    assert.notEqual(otherGame.id, second.id);
    const otherPanel = other.getByTestId("imported-progress-backup");
    await otherPanel.locator("summary").click();
    await otherPanel.getByTestId("input-imported-progress-backup").setInputFiles({ name: "fixture.arena-progress.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
    await otherPanel.getByText(/Different import identity, but the HTML source matches exactly/).waitFor();
    assert.equal(await otherPanel.getByTestId("button-restore-imported-progress").isDisabled(), true);
    await otherPanel.getByRole("checkbox").check();
    await otherPanel.getByTestId("button-restore-imported-progress").click();
    await otherPanel.getByText(/Progress restored locally/).waitFor();
    await otherFrame.locator("#stored").filter({ hasText: /^private-progress-blue-22$/ }).waitFor();
    assert.deepEqual(Object.keys(await saves(other)), [otherGame.id]);
    await other.reload();
    await other.getByRole("tab", { name: "Import and emulate" }).click();
    await otherFrame.locator("#stored").filter({ hasText: /^private-progress-blue-22$/ }).waitFor();
    assert.equal((await records(other))[0].source, original);
    assert.equal(JSON.parse((await saves())[second.id]).progress, "private-progress-blue-22");
    await other.getByTestId("imported-progress-backup").locator("summary").click();
    await other.screenshot({ path: new URL("backup-mobile.png", output).pathname });
    await otherContext.close();
    assert.deepEqual(errors, []);
    checks.push("a fresh browser context restores to a new identity only after exact-source matching and explicit copy confirmation; progress survives its reload");
  }
  await page.screenshot({ path: new URL("isolation.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks, modelCallTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, modelCallTested: false }));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally { await browser.close(); }
