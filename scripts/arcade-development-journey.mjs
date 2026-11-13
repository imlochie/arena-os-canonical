// Original authorized fixture, real browser storage/Workshop/player; no inference or owner session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtureHtml } from "./arcade-workshop-fixture.mjs";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium, firefox, webkit } = require("playwright-core");
const engine = process.env.TEST_BROWSER || "chromium";
const browserTypes = { chromium, firefox, webkit };
assert.ok(Object.hasOwn(browserTypes, engine), `Unknown TEST_BROWSER "${engine}"; choose chromium, firefox, or webkit.`);
const browserType = browserTypes[engine];
const executablePath = engine === "chromium"
  ? process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium"
  : process.env[`${engine.toUpperCase()}_PATH`];
const launchOptions = {
  headless: process.env.TEST_HEADLESS !== "0",
  ...(executablePath ? { executablePath } : {}),
  ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
};
const browser = await browserType.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL(`../generated-artifacts/arcade-development-journey/${engine}/`, import.meta.url);
await mkdir(output, { recursive: true });
await context.addInitScript(() => {
  if (window === top) {
    localStorage.setItem("af_local_mode", "0");
    localStorage.setItem("af_ephemeral", "1");
  }
});
let ownerCalls = 0;
await context.route("**/api/models", route => route.fulfill({ json: { models: [] } }));
await context.route("**/api/arcade/development", route => {
  ownerCalls++;
  return route.fulfill({ status: 401, json: { error: "No owner session in this fixture" } });
});
await context.route(url => new URL(url).pathname === "/api/arcade", route => route.fulfill({ json: { games: [] } }));
const page = await context.newPage();
const requests = [];
page.on("request", request => requests.push(request.url()));
page.on("dialog", dialog => dialog.accept());
const original = fixtureHtml;
const changed = original.replace("count++", "count+=5");
assert.notEqual(changed, original);
const hash = text => createHash("sha256").update(text).digest("hex");
const checks = [];
const read = (target, dbName, store, key) => target.evaluate(({ dbName, store, key }) => new Promise((resolve, reject) => {
  const request = indexedDB.open(dbName);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result, tx = db.transaction(store, "readonly");
    const query = key === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key);
    tx.oncomplete = () => { resolve(query.result); db.close(); };
    tx.onabort = () => { reject(tx.error); db.close(); };
  };
}), { dbName, store, key });
const records = target => read(target, "arenaforge-imported-games", "games");
let gameId, profileId, profileSaveId;
const document = () => read(page, "arenaforge-private-development", "drafts", gameId);
const workshop = () => read(page, "arenaforge-imported-games", "workshop", gameId);
const saved = id => page.evaluate(id => localStorage.getItem(`arenaforge.game-save.v1:${id}`), id);
const player = () => page.frameLocator('iframe[title="Playable game: development-fixture.html"]');
const count = async value => { await player().locator("#count").filter({ hasText: new RegExp(`^Coins: ${value}$`) }).waitFor(); };
const dev = target => target.getByTestId("arcade-development");
async function openDev(target = page) {
  await target.getByRole("tab", { name: "Develop mods", exact: true }).click();
  await target.getByTestId("select-dev-game").selectOption(gameId);
  await target.getByTestId("checkbox-dev-authorized").check();
  await dev(target).getByRole("button", { name: /Open development copy|Reopen copy/ }).click();
  await target.getByTestId("input-dev-draft").waitFor();
}
async function checkpoint(source, target = page) {
  await target.getByTestId("input-dev-draft").fill(source);
  await target.getByTestId("button-save-checkpoint").click();
  await dev(target).getByText(/Manual checkpoint saved/).waitFor();
}
async function review() {
  await page.getByTestId("button-dev-review").click();
  await page.getByTestId("panel-dev-preview").waitFor();
}
async function baseUnchanged(expectedSave) {
  const game = (await records(page)).find(item => item.id === gameId);
  assert.equal(game.source, original);
  assert.equal(await saved(gameId), expectedSave);
}
try {
  await page.goto(`${base}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate", exact: true }).click();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[type="file"][accept*=".html"]').setInputFiles({ name: "development-fixture.html", mimeType: "text/html", buffer: Buffer.from(original) });
  await count(0);
  gameId = (await records(page))[0].id;
  await player().getByRole("button", { name: "Collect coin" }).click({ clickCount: 2 });
  await count(2);
  await page.waitForFunction(id => JSON.parse(localStorage.getItem(`arenaforge.game-save.v1:${id}`) || "{}").coins === "2", gameId);
  const baseSave = await saved(gameId);
  await openDev();
  assert.equal(await page.getByTestId("select-dev-model").inputValue(), "");
  assert.equal(await page.getByTestId("button-dev-run").isDisabled(), true);
  await checkpoint(changed);
  await page.getByTestId("button-toggle-diff").click();
  assert.match(await page.getByTestId("text-diff-summary").innerText(), /added.*removed/);
  const requestStart = requests.length;
  await page.getByTestId("button-dev-check").click();
  await page.getByTestId("panel-dev-build").waitFor();
  assert.deepEqual(requests.slice(requestStart), [], "static checks must not make any network request");
  assert.match(await page.getByTestId("panel-dev-build").innerText(), new RegExp(hash(changed)));
  await checkpoint(changed.replace("count+=5", "count+=;;"));
  await page.getByTestId("button-dev-check").click();
  await dev(page).getByRole("alert").filter({ hasText: /syntax/i }).waitFor();
  assert.equal((await document()).installedHash, undefined);
  await page.getByTestId("button-dev-review").click();
  await dev(page).getByRole("alert").filter({ hasText: /syntax/i }).waitFor();
  assert.equal(await page.getByTestId("panel-dev-preview").count(), 0, "broken syntax cannot prepare an install");
  await checkpoint(changed);
  await review();
  const preview = await page.getByTestId("panel-dev-preview").innerText();
  assert(preview.includes(hash(original).slice(0, 12)) && preview.includes(hash(changed).slice(0, 12)));
  profileId = (await document()).profileId;
  profileSaveId = `workshop-${gameId}-${profileId}`;
  assert.equal((await workshop()).state.profiles.find(profile => profile.id === profileId).shareSaves, false);
  await page.getByTestId("button-dev-discard-review").click();
  await page.getByTestId("panel-dev-preview").waitFor({ state: "detached" });
  assert.equal((await document()).installedHash, undefined);
  assert.equal((await workshop()).state.profiles.find(profile => profile.id === profileId).enabled.length, 0);
  await page.reload();
  await openDev();
  assert.equal(await page.getByTestId("panel-dev-preview").count(), 0);
  assert.equal((await document()).installedHash, undefined, "discarded review cannot resume or install on reopen");
  await review();
  await page.evaluate(() => { window.__realNow = Date.now; const future = Date.now() + 300001; Date.now = () => future; });
  await page.getByTestId("button-dev-commit").click();
  await dev(page).getByRole("alert").filter({ hasText: /expired/i }).waitFor();
  await page.evaluate(() => { Date.now = window.__realNow; });
  assert.equal((await document()).installedHash, undefined);
  await review();
  await page.getByTestId("button-dev-commit").click();
  await dev(page).getByText("Installed into the development profile. The original and its saves are unchanged.", { exact: true }).waitFor();
  assert.equal((await document()).installedHash, hash(changed));
  await page.getByTestId("button-dev-play").click();
  await count(0);
  await player().getByRole("button", { name: "Collect coin" }).click();
  await count(5);
  await baseUnchanged(baseSave);
  await page.reload();
  await page.getByRole("tab", { name: "Import and emulate", exact: true }).click();
  await page.getByTestId(`button-select-imported-game-${gameId}`).click();
  await count(2);
  await openDev();
  assert.equal(await page.locator('iframe[title="Playable game: development-fixture.html"]').count(), 0, "reopening development must not automatically launch");
  await page.getByTestId("button-dev-play").click();
  await count(5);
  await player().getByRole("button", { name: "Collect coin" }).click();
  await count(10);
  await page.waitForFunction(id => JSON.parse(localStorage.getItem(`arenaforge.game-save.v1:${id}`) || "{}").coins === "10", profileSaveId);
  await openDev();
  await page.getByTestId("button-dev-rollback").click();
  await count(10);
  await player().getByRole("button", { name: "Collect coin" }).click();
  await count(11);
  await baseUnchanged(baseSave);
  checks.push("manual five-point mechanic, local static parsing, broken syntax rejection, exact hash review, cancelled/expired reviews, isolated install, reopen and rollback preserve both saves");

  await openDev();
  await page.getByTestId("input-dev-assessment").fill("Local owner observation of the fixture, not independent or model evidence.");
  await dev(page).getByRole("button", { name: "Report gameplay working", exact: true }).click();
  await dev(page).getByText(/Last report: working/).waitFor();
  assert.equal((await document()).assessmentResult, "working");
  assert.equal((await document()).mission, undefined);
  const other = await context.newPage();
  await other.goto(`${base}/arcade`);
  await openDev(other);
  const newer = changed.replace("padding:30px", "padding:31px");
  await checkpoint(newer);
  await other.getByTestId("input-dev-draft").fill(changed.replace("padding:30px", "padding:32px"));
  await other.getByTestId("button-save-checkpoint").click();
  await dev(other).getByRole("alert").filter({ hasText: /another tab/i }).waitFor();
  assert.equal((await document()).draft, newer);
  await other.close();
  await baseUnchanged(baseSave);
  checks.push("a stale development tab cannot overwrite a newer checkpoint");

  await review();
  await page.evaluate(() => {
    window.__originalDevPut = IDBObjectStore.prototype.put;
    window.__failInstalledCheckpoint = true;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === "drafts" && value.installedHash && window.__failInstalledCheckpoint) {
        this.transaction.abort(); return;
      }
      return window.__originalDevPut.call(this, value, ...args);
    };
  });
  const beforeFailedCommit = await document();
  await page.getByTestId("button-dev-commit").click();
  await dev(page).getByRole("alert").filter({ hasText: /profile was installed.*checkpoint.*could not be saved/i }).waitFor();
  assert.equal((await document()).revision, beforeFailedCommit.revision);
  const actualProfile = (await workshop()).state.profiles.find(profile => profile.id === profileId);
  assert.equal(actualProfile.outputFiles["game.html"].hash, hash(newer), "the committed installation must not be falsely reported as absent");
  assert.equal(await saved(profileSaveId), JSON.stringify({ coins: "11" }));
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalDevPut; });
  await page.getByRole("tab", { name: "Mod Workshop", exact: true }).click();
  await page.getByTestId("workshop-game").selectOption(gameId);
  await page.getByTestId(`workshop-profile-${profileId}`).click();
  await page.getByTestId("workshop-play").click();
  await count(11);
  await player().getByRole("button", { name: "Collect coin" }).click();
  await count(16);
  await baseUnchanged(baseSave);
  await page.reload();
  await openDev();
  assert.equal(await page.locator('iframe[title="Playable game: development-fixture.html"]').count(), 0);
  assert.equal((await document()).draft, newer);
  assert.equal(JSON.parse(await saved(profileSaveId)).coins, "16");
  await baseUnchanged(baseSave);
  assert.match(await dev(page).innerText(), /Owner report only, not independent verification/);
  assert.equal(ownerCalls, 0, "manual development must not invoke owner-authenticated or model operations");
  checks.push("a failed development checkpoint after a successful install reports partial success honestly, preserves both saves, and recovers through an explicit Workshop launch without automatic resume/install");
  await page.screenshot({ path: new URL("development.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, browser: { engine, version: browser.version() }, checks, realModelCall: false, ownerSession: false, evidence: "Independent browser execution of an original manual fixture, not model generation or owner-reported gameplay." }, null, 2));
  console.log(JSON.stringify({ passed: true, browser: { engine, version: browser.version() }, checks, realModelCall: false, ownerSession: false }));
} catch (error) {
  await page.screenshot({ path: new URL("failure.png", output).pathname }).catch(() => {});
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally { await browser.close(); }
