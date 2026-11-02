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
await page.route(url => {
  const request = new URL(url);
  return request.pathname === "/api/arcade" && request.searchParams.get("limit") === "30";
}, route => route.fulfill({ json: { games: [] } }));
await page.route(url => new URL(url).pathname === "/api/models", route => route.fulfill({ json: { models: [] } }));
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
const playerState = player => player.locator("body").evaluate(body => ({
  session: body.dataset.playerSession,
  ticks: Number(body.dataset.gameTicks || 0),
  loaded: body.dataset.loadedProgress || "unset",
  title: body.querySelector("#fixture-title")?.textContent ?? "",
}));
const waitForLiveProgress = async (player, session, priorTicks, label) => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const state = await playerState(player);
    assert.equal(state.session, session, `${label}: the active player document must remain mounted`);
    if (state.ticks > priorTicks) return state;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.fail(`${label}: game animation state did not keep advancing`);
};
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

  // Exercise the created-game player with a local fixture, not a model call.
  await page.goto(`${base}/arcade`);
  const starterButton = page.getByRole("button", { name: "Open offline game Platform Adventure" });
  await starterButton.waitFor({ timeout: 15000 });
  const fixturePrompt = "Created game progress lifecycle fixture";
  const fixtureId = "task219-created-progress-fixture";
  const secondId = "task219-distinct-save-identity";
  const fixtureCode = title => `<!doctype html><html><head><title>${title}</title><meta name="arena-controls" content="Save progress with the buttons"></head><body>
<h1 id="fixture-title">${title}</h1><input id="progress" value="created-progress">
<button id="save">Save checkpoint</button><button id="remove">Remove last key</button><button id="clear">Clear game data</button>
<output id="stored"></output><canvas width="120" height="80"></canvas>
<script>
document.body.dataset.playerSession=Date.now()+"-"+Math.random().toString(36).slice(2);
const field=document.getElementById("progress"),stored=document.getElementById("stored");
document.body.dataset.loadedProgress=localStorage.getItem("checkpoint")||"unset";
function draw(){stored.textContent=localStorage.getItem("checkpoint")||"unset"}
document.getElementById("save").onclick=()=>{localStorage.setItem("checkpoint",field.value);draw()};
document.getElementById("remove").onclick=()=>{localStorage.removeItem("checkpoint");draw()};
document.getElementById("clear").onclick=()=>{localStorage.clear();draw()};
let ticks=0;function step(){document.body.dataset.gameTicks=String(++ticks);requestAnimationFrame(step)}step();draw();
</script></body></html>`;
  const fixtureSource = fixtureCode("Created original");
  const createdGames = [
    { id: fixtureId, title: "Created save lifecycle fixture", prompt: fixturePrompt, gameType: "pong", engine: "ai-codegen", code: fixtureSource, saveSlotId: "task219-created-save-slot", starter: false, createdAt: 1, updatedAt: 1 },
    { id: secondId, title: "Separate save identity fixture", prompt: "Second game save identity fixture", gameType: "pong", engine: "ai-codegen", code: fixtureCode("Second identity"), saveSlotId: "task219-other-save-slot", starter: false, createdAt: 2, updatedAt: 2 },
  ];
  await page.evaluate(games => new Promise((resolve, reject) => {
    const opening = indexedDB.open("arenaforge-offline-shelf", 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains("games")) opening.result.createObjectStore("games", { keyPath: "id" });
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction("games", "readwrite");
      for (const game of games) transaction.objectStore("games").put(game);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }), createdGames);
  await page.reload({ waitUntil: "domcontentloaded" });
  const openCreated = () => page.getByRole("button", { name: "Open offline game Created save lifecycle fixture" });
  const openSecond = () => page.getByRole("button", { name: "Open offline game Separate save identity fixture" });
  await openCreated().waitFor({ timeout: 15000 });
  await openCreated().click();
  const createdPlayer = page.frameLocator(`iframe[title="${fixturePrompt}"]`);
  await createdPlayer.locator("#fixture-title").waitFor();
  let live = await playerState(createdPlayer);
  await createdPlayer.locator("#progress").fill("first-created-save");
  await createdPlayer.getByRole("button", { name: "Save checkpoint" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  assert.equal(JSON.parse((await saves())[createdGames[0].saveSlotId]).checkpoint, "first-created-save");
  await waitForLiveProgress(createdPlayer, live.session, live.ticks, "created game first save");
  live = await playerState(createdPlayer);
  await createdPlayer.getByRole("button", { name: "Remove last key" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "detached" });
  assert.equal((await saves())[createdGames[0].saveSlotId], undefined);
  await waitForLiveProgress(createdPlayer, live.session, live.ticks, "created game removes last key");
  live = await playerState(createdPlayer);
  await createdPlayer.locator("#progress").fill("game-originated-clear");
  await createdPlayer.getByRole("button", { name: "Save checkpoint" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  live = await playerState(createdPlayer);
  await createdPlayer.getByRole("button", { name: "Clear game data" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "detached" });
  assert.equal((await saves())[createdGames[0].saveSlotId], undefined);
  await waitForLiveProgress(createdPlayer, live.session, live.ticks, "created game clears its own storage");

  await createdPlayer.locator("#progress").fill("source-compatible-progress");
  await createdPlayer.getByRole("button", { name: "Save checkpoint" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  live = await playerState(createdPlayer);
  await page.getByRole("button", { name: "Clear progress", exact: true }).click();
  await createdPlayer.locator("#fixture-title").waitFor();
  const cleared = await playerState(createdPlayer);
  assert.notEqual(cleared.session, live.session, "explicit Clear progress should intentionally reload the player");
  assert.equal(cleared.loaded, "unset", "the reloaded player must not receive explicitly cleared progress");
  assert.equal((await saves())[createdGames[0].saveSlotId], undefined);
  await createdPlayer.locator("#progress").fill("source-compatible-progress");
  await createdPlayer.getByRole("button", { name: "Save checkpoint" }).click();

  await page.evaluate(async ({ id, revisedCode }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("arenaforge-offline-shelf", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("games", "readwrite");
      const store = transaction.objectStore("games");
      const request = store.get(id);
      request.onsuccess = () => store.put({ ...request.result, code: revisedCode, updatedAt: Date.now() });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  }, { id: fixtureId, revisedCode: fixtureCode("Created revised") });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCreated().waitFor({ timeout: 15000 });
  await openCreated().click();
  await createdPlayer.getByRole("heading", { name: "Created revised", exact: true }).waitFor();
  assert.equal((await playerState(createdPlayer)).loaded, "source-compatible-progress", "a source revision must load the same game's save slot");

  await openSecond().click();
  const secondPlayer = page.frameLocator('iframe[title="Second game save identity fixture"]');
  await secondPlayer.locator("#fixture-title").waitFor();
  assert.equal((await playerState(secondPlayer)).loaded, "unset", "a different save identity must not inherit the prior game's progress");
  await secondPlayer.locator("#progress").fill("other-identity-progress");
  await secondPlayer.getByRole("button", { name: "Save checkpoint" }).click();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  await openCreated().click();
  await createdPlayer.locator("#fixture-title").waitFor();
  assert.equal((await playerState(createdPlayer)).loaded, "source-compatible-progress");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openCreated().waitFor({ timeout: 15000 });
  await openCreated().click();
  assert.equal((await playerState(createdPlayer)).loaded, "source-compatible-progress");
  await openSecond().click();
  assert.equal((await playerState(secondPlayer)).loaded, "other-identity-progress");

  await starterButton.click();
  const platformer = page.frameLocator('iframe[title*="Platform Adventure"]');
  const platformCanvas = platformer.locator("#game");
  await platformCanvas.waitFor({ timeout: 10000 });
  await platformCanvas.evaluate(canvas => canvas.ownerDocument.defaultView.__start());
  const installPlatformProbe = () => platformer.locator("body").evaluate(body => {
    const view = body.ownerDocument.defaultView;
    if (!view.__task219Probe) {
      const probe = { session: `${Date.now()}-${Math.random()}`, ticks: 0 };
      view.__task219Probe = probe;
      const advance = () => { probe.ticks++; view.requestAnimationFrame(advance); };
      view.requestAnimationFrame(advance);
    }
    return { ...view.__task219Probe };
  });
  const readPlatformProbe = () => platformer.locator("body").evaluate(body => body.ownerDocument.defaultView.__task219Probe ?? null);
  const verifyPlatformLive = async (before, label) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const current = await readPlatformProbe();
      assert.ok(current, `${label}: offline starter document must not be replaced`);
      assert.equal(current.session, before.session, `${label}: offline starter session must stay live`);
      if (current.ticks > before.ticks) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail(`${label}: offline starter animation did not advance`);
  };
  let platformLive = await installPlatformProbe();
  const setPlatformSave = () => platformCanvas.evaluate(canvas => canvas.ownerDocument.defaultView.localStorage.setItem("af_platform_unlocked", "2"));
  const removePlatformSave = () => platformCanvas.evaluate(canvas => canvas.ownerDocument.defaultView.localStorage.removeItem("af_platform_unlocked"));
  const clearPlatformSave = () => platformCanvas.evaluate(canvas => canvas.ownerDocument.defaultView.localStorage.clear());
  await setPlatformSave();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  await verifyPlatformLive(platformLive, "offline starter save");
  platformLive = await readPlatformProbe();
  await removePlatformSave();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "detached" });
  await verifyPlatformLive(platformLive, "offline starter removes last key");
  platformLive = await readPlatformProbe();
  await setPlatformSave();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor();
  platformLive = await readPlatformProbe();
  await clearPlatformSave();
  await page.getByRole("button", { name: "Clear progress", exact: true }).waitFor({ state: "detached" });
  await verifyPlatformLive(platformLive, "offline starter game-originated clear");
  checks.push("created-game and offline-starter saves, key removal, and game clears keep the live player running; explicit clear, source revisions, identities, and reload restore the right progress");

  await page.screenshot({ path: new URL("isolation.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks, modelCallTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, modelCallTested: false }));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally { await browser.close(); }
