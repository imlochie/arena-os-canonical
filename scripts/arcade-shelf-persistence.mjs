import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL("../generated-artifacts/arcade-shelf-persistence/", import.meta.url);
await mkdir(output, { recursive: true });
const userDataDir = await mkdtemp(path.join(tmpdir(), "arcade-shelf-persistence-"));
const report = [];
let browser;
let context;
let page;

function hooks() {
  if (window.__arcadeShelfHooksInstalled) return;
  window.__arcadeShelfHooksInstalled = true;
  window.__arcadeShelfOps = [];
  const proto = IDBObjectStore.prototype;
  for (const method of ["put", "delete", "clear", "get"]) {
    const original = proto[method];
    proto[method] = function (...args) {
      // This suite measures source-shelf transactions, not independent runtime
      // metadata/save databases which can legitimately write during rendering.
      if (this.transaction.db.name !== "arenaforge-imported-games" || this.name !== "games") return original.apply(this, args);
      const value = args[0];
      const info = method === "put"
        ? { id: value?.id ?? null, kind: value?.kind ?? null, byteLength: value?.romData?.byteLength ?? 0 }
        : { key: method === "delete" || method === "get" ? args[0] : null };
      window.__arcadeShelfOps.push({ method, transactionMode: this.transaction.mode, ...info });
      if (method === "put" && window.__failArcadeShelfPut) {
        throw new DOMException("Injected deterministic shelf failure", "QuotaExceededError");
      }
      if (method === "delete" && window.__failArcadeShelfDelete) {
        throw new DOMException("Injected deterministic shelf failure", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  }
  const originalOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) {
    const request = originalOpen.apply(this, args);
    if (args[0] !== "arenaforge-imported-games" || !window.__holdNextShelfOpen) return request;
    window.__holdNextShelfOpen = false;
    let proto = request;
    let descriptor;
    while (proto && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(proto, "onsuccess");
      proto = Object.getPrototypeOf(proto);
    }
    if (!descriptor?.set) return request;
    let handler = null;
    Object.defineProperty(request, "onsuccess", {
      configurable: true,
      get: () => handler,
      set: next => {
        handler = next;
        descriptor.set.call(request, event => {
          window.__heldShelfOpenReady = true;
          window.__releaseHeldShelfOpen = () => next.call(request, event);
        });
      },
    });
    return request;
  };
}

function makeNesRom() {
  // Original, hand-authored NROM fixture also used by arena-smoke.
  const header = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]).copy(header);
  const prg = Buffer.alloc(0x4000, 0xea);
  Buffer.from([
    0x78,0xd8,0xa2,0x40,0x8e,0x17,0x40,0xa2,0xff,0x9a,0xe8,
    0x8e,0x00,0x20,0x8e,0x01,0x20,0x2c,0x02,0x20,0x10,0xfb,
    0xa9,0x3f,0x8d,0x06,0x20,0xa9,0x00,0x8d,0x06,0x20,0xa9,
    0x21,0x8d,0x07,0x20,0xa9,0x08,0x8d,0x01,0x20,0xa9,0x01,
    0x8d,0x16,0x40,0xa9,0x00,0x8d,0x16,0x40,0xad,0x16,0x40,
    0x29,0x01,0xf0,0x12,0xa9,0x3f,0x8d,0x06,0x20,0xa9,0x00,
    0x8d,0x06,0x20,0xa9,0x30,0x8d,0x07,0x20,0x4c,0x2a,0x80,
    0xa9,0x3f,0x8d,0x06,0x20,0xa9,0x00,0x8d,0x06,0x20,0xa9,
    0x21,0x8d,0x07,0x20,0x4c,0x2a,0x80,
  ]).copy(prg);
  Buffer.from([0x00,0x80,0x00,0x80,0x00,0x80]).copy(prg, 0x3ffa);
  return Buffer.concat([header, prg, Buffer.alloc(0x2000)]);
}

async function launchPersistent() {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    if (window === window.top && localStorage.getItem("af_local_mode") === null) {
      localStorage.setItem("af_local_mode", "1");
    }
  });
  await context.addInitScript(hooks);
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.route("**/loader.js", route => route.fulfill({
    status: 200, contentType: "application/javascript",
    body: "window.__arcadeCoreLoaderIntercepted=true;",
  }));
  const testOrigin = new URL(base).origin;
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/loader.js")) return route.fallback();
    if (["http:", "https:"].includes(url.protocol) && url.origin !== testOrigin) return route.abort();
    return route.fallback();
  });
  return context;
}

async function records() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("arenaforge-imported-games", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise((resolve, reject) => {
      const req = db.transaction("games", "readonly").objectStore("games").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return Promise.all(rows.map(async row => ({
      id: row.id, name: row.name, kind: row.kind, system: row.system ?? null,
      source: row.source,
      byteLength: row.romData?.byteLength ?? 0,
      hash: row.romData ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", row.romData))]
        .map(value => value.toString(16).padStart(2, "0")).join("") : null,
    })));
  });
}

async function ops() { return page.evaluate(() => [...window.__arcadeShelfOps]); }
async function clearOps() { await page.evaluate(() => { window.__arcadeShelfOps = []; }); }
async function opsOn(targetPage) { return targetPage.evaluate(() => [...window.__arcadeShelfOps]); }
async function clearOpsOn(targetPage) { await targetPage.evaluate(() => { window.__arcadeShelfOps = []; }); }
async function shelfTab() { await page.getByRole("tab", { name: "Import and emulate" }).click(); }
async function shelfTabOn(targetPage) { await targetPage.getByRole("tab", { name: "Import and emulate" }).click(); }
function shelfRow(targetPage, name) { return targetPage.locator("aside").getByRole("button", { name }); }
async function importHtml(name, html) {
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name, mimeType: "text/html", buffer: Buffer.from(html),
  });
}
async function importHtmlOn(targetPage, name, html) {
  await targetPage.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name, mimeType: "text/html", buffer: Buffer.from(html),
  });
}
async function getId(name) {
  const row = (await records()).find(record => record.name === name);
  assert(row, `Expected ${name} to be stored`);
  return row.id;
}

try {
  await launchPersistent();
  await page.goto(`${base}/arcade`);
  await shelfTab();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  const gameHtml = `<!doctype html><html><head><title>Persistence fixture</title></head><body>
    <p id="hud">Score 0</p><canvas id="game" width="240" height="160"></canvas>
    <script>const hud=document.getElementById("hud"),c=document.getElementById("game"),x=c.getContext("2d");
    let score=Number(localStorage.getItem("shelf-score")||0);hud.textContent="Score "+score;
    addEventListener("keydown",e=>{if(e.key==="ArrowRight"){score++;localStorage.setItem("shelf-score",String(score));hud.textContent="Score "+score}});
    x.fillStyle="#15b981";x.fillRect(0,0,c.width,c.height);</script></body></html>`;
  await importHtml("persisted-score.html", gameHtml);
  const htmlFrame = page.frameLocator('iframe[title="Playable game: persisted-score.html"]');
  await htmlFrame.locator("#game").waitFor();
  await htmlFrame.locator("#game").evaluate(el =>
    el.ownerDocument.defaultView.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await htmlFrame.getByText("Score 1", { exact: true }).waitFor();
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith("arenaforge.game-save.v1:")));
  const htmlId = await getId("persisted-score.html");
  report.push("Imported authorized HTML game played to Score 1; sandbox localStorage-backed save was present.");

  await page.locator('input[accept=".nes,application/octet-stream"]').setInputFiles({
    name: "original-homebrew.nes", mimeType: "application/octet-stream", buffer: makeNesRom(),
  });
  const nesCanvas = page.locator('canvas[aria-label="NES game screen"]');
  await nesCanvas.waitFor();
  const idleColor = [0x3c, 0xab, 0xff];
  await page.waitForFunction(color => {
    const pixel = document.querySelector('canvas[aria-label="NES game screen"]')?.getContext("2d")?.getImageData(128,120,1,1).data;
    return pixel && pixel[0] === color[0] && pixel[1] === color[1] && pixel[2] === color[2];
  }, idleColor);
  await page.getByRole("button", { name: "Save progress" }).click();
  await page.getByText("Progress saved on this browser.").waitFor();
  const nesId = await getId("original-homebrew.nes");
  await nesCanvas.click();
  await page.keyboard.down("z");
  await page.waitForFunction(() => {
    const p = document.querySelector('canvas[aria-label="NES game screen"]')?.getContext("2d")?.getImageData(128,120,1,1).data;
    return p && p[0] === 255 && p[1] === 255 && p[2] === 255;
  });
  await page.keyboard.up("z");
  report.push("Original generated NES fixture rendered, responded to A-button input, and had a browser save state.");

  // Deterministic original console-sized byte buffer: storage-persistence stress only, not GBA emulation.
  const gba = Buffer.alloc(32 * 1024 * 1024);
  for (let i = 0; i < gba.length; i += 1) gba[i] = (i * 31 + (i >>> 8) + 0x5a) & 0xff;
  Buffer.from("ARCADEFORGE-ORIGINAL-STORAGE-STRESS").copy(gba, 0xa0);
  const gbaHash = createHash("sha256").update(gba).digest("hex");
  await page.getByTestId("input-multisystem-rom").setInputFiles({
    name: "original-storage-stress.gba", mimeType: "application/octet-stream", buffer: gba,
  }, { timeout: 60_000 });
  await page.getByRole("heading", { name: "original-storage-stress.gba" }).waitFor();
  await page.evaluate(() => window.__arcadeCoreLoaderIntercepted === true).catch(() => {});
  let shelf = await records();
  const gbaRecord = shelf.find(record => record.name === "original-storage-stress.gba");
  assert(gbaRecord, "32 MiB stress ROM must persist");
  assert.equal(gbaRecord.byteLength, gba.length);
  assert.equal(gbaRecord.hash, gbaHash);
  report.push("32 MiB deterministic original GBA-labeled buffer persisted with exact SHA-256; storage-only evidence, not GBA emulation (loader intercepted; no core download).");

  await importHtml("disposable-item.html", "<!doctype html><html><body><p>Disposable</p></body></html>");
  await page.getByRole("heading", { name: "disposable-item.html" }).waitFor();
  const disposableId = await getId("disposable-item.html");
  const beforeRows = await records();

  await page.evaluate(() => { window.__failArcadeShelfDelete = true; });
  await page.getByRole("button", { name: "Remove disposable-item.html" }).click();
  await page.getByRole("alert").filter({ hasText: "The game could not be removed" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "disposable-item.html" }).count(), 1, "failed removal keeps selected item");
  assert.deepEqual(await records(), beforeRows, "failed deletion leaves IndexedDB rows unchanged");
  await page.evaluate(() => { window.__failArcadeShelfDelete = false; });
  await clearOps();
  await page.getByRole("button", { name: "Remove disposable-item.html" }).click();
  await page.getByRole("heading", { name: "original-storage-stress.gba" }).waitFor();
  const deleteOps = await ops();
  assert(deleteOps.some(op => op.method === "delete" && op.key === disposableId), "successful UI removal deletes disposable record");
  assert(!deleteOps.some(op => op.method === "put" && op.id === gbaRecord.id), "deleting disposable item never puts unrelated large ROM");
  assert(!deleteOps.some(op => op.method === "clear"), "deleting one item never clears shelf");
  assert(!(await records()).some(record => record.id === disposableId));
  assert.equal((await records()).find(record => record.id === gbaRecord.id).hash, gbaHash);
  report.push("Injected IDB delete QuotaExceededError showed a visible error and preserved selection/rows; restored method then removed only disposable ID (no clear or large-ROM put).");

  // A failed import must remain a playable, retryable session draft with stable identity.
  const retryHtml = `<!doctype html><html><body><p id="hud">Retry score 0</p><script>
    let score=Number(localStorage.getItem("retry-score")||0);const hud=document.getElementById("hud");
    hud.textContent="Retry score "+score;addEventListener("keydown",e=>{if(e.key==="ArrowRight"){
      score++;localStorage.setItem("retry-score",String(score));hud.textContent="Retry score "+score}});
  </script></body></html>`;
  const rowsBeforeRetryImport = await records();
  await page.evaluate(() => { window.__failArcadeShelfPut = true; });
  await importHtml("retryable-session-game.html", retryHtml);
  const retryFrame = page.frameLocator('iframe[title="Playable game: retryable-session-game.html"]');
  await retryFrame.getByText("Retry score 0", { exact: true }).waitFor();
  await page.getByText("Not saved · this tab only", { exact: true }).waitFor();
  await retryFrame.locator("body").evaluate(el =>
    el.ownerDocument.defaultView.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await retryFrame.getByText("Retry score 1", { exact: true }).waitFor();
  const retrySaveKey = await page.evaluate(() => Object.keys(localStorage).find(key =>
    key.startsWith("arenaforge.game-save.v1:") && localStorage.getItem(key)?.includes('"retry-score":"1"')));
  assert(retrySaveKey, "Session-only HTML game progress must save against its stable game identity");
  const retryId = retrySaveKey.slice("arenaforge.game-save.v1:".length);
  assert.deepEqual(await records(), rowsBeforeRetryImport, "failed new import leaves the previously persisted baseline unchanged");
  await page.getByRole("button", { name: "Retry save" }).click();
  await page.getByText("Not saved · this tab only", { exact: true }).waitFor();
  assert.deepEqual(await records(), rowsBeforeRetryImport, "retry under continued put failure leaves persisted rows unchanged");
  await page.evaluate(() => { window.__failArcadeShelfPut = false; });
  await clearOps();
  await page.getByRole("button", { name: "Retry save" }).click();
  await page.getByText("Your unsaved games are now saved on this device.").waitFor();
  await page.getByText("Not saved · this tab only", { exact: true }).waitFor({ state: "detached" });
  const retryRecord = (await records()).find(row => row.name === "retryable-session-game.html");
  assert.equal(retryRecord?.id, retryId, "retry must persist the original session-only UUID");
  assert.equal(retryRecord?.source, retryHtml, "retry must persist the exact original source");
  const retryPuts = await ops();
  assert(retryPuts.some(op => op.method === "put" && op.id === retryId), "retry must put the draft");
  assert(!retryPuts.some(op => op.method === "put" && op.id === gbaRecord.id), "retry must not rewrite the unrelated large ROM");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), retrySaveKey).then(value => value.includes('"retry-score":"1"')), true);
  report.push("Put QuotaExceededError left a playable Not saved HTML draft; retry failed without changing persisted rows, then saved the same UUID/source/save identity and did not put the large ROM.");

  // Open a second page in this same persistent profile for cross-tab reconciliation.
  const pageB = await context.newPage();
  pageB.setDefaultTimeout(10_000);
  await pageB.route("**/loader.js", route => route.fulfill({
    status: 200, contentType: "application/javascript", body: "window.__arcadeCoreLoaderIntercepted=true;",
  }));
  const origin = new URL(base).origin;
  await pageB.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/loader.js")) return route.fallback();
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) return route.abort();
    return route.fallback();
  });
  await pageB.goto(`${base}/arcade`);
  await shelfTabOn(pageB);
  await shelfRow(pageB, /retryable-session-game\.html/).waitFor();

  await importHtml("remote-added.html", "<!doctype html><html><body><p>Remote addition</p></body></html>");
  await page.getByRole("heading", { name: "remote-added.html" }).waitFor();
  await shelfRow(pageB, /remote-added\.html/).waitFor();
  await importHtml("remote-removed.html", "<!doctype html><html><body><p>Remote removal</p></body></html>");
  await page.getByRole("heading", { name: "remote-removed.html" }).waitFor();
  await page.getByRole("button", { name: "Remove remote-removed.html" }).click();
  await page.getByRole("heading", { name: "remote-added.html" }).waitFor();
  await shelfRow(pageB, /remote-removed\.html/).waitFor({ state: "detached" });
  report.push("Clean second tab auto-refreshed a committed addition and removal from the first tab.");

  // A dirty tab must keep its session-only work when another tab changes the shelf.
  await pageB.getByLabel(/I own this game or have permission to use and play it/).check();
  await pageB.evaluate(() => { window.__failArcadeShelfPut = true; });
  await importHtmlOn(pageB, "tab-session-draft.html", "<!doctype html><html><body><p id=\"draft\">Draft kept</p></body></html>");
  await pageB.getByRole("heading", { name: "tab-session-draft.html" }).waitFor();
  await pageB.getByText("Not saved · this tab only", { exact: true }).waitFor();
  await importHtml("remote-live.html", "<!doctype html><html><body><p>Remote live</p></body></html>");
  await page.getByRole("heading", { name: "remote-live.html" }).waitFor();
  await importHtml("remote-remove-while-dirty.html", "<!doctype html><html><body><p>Remote remove</p></body></html>");
  await page.getByRole("heading", { name: "remote-remove-while-dirty.html" }).waitFor();
  await page.getByRole("button", { name: "Remove remote-remove-while-dirty.html" }).click();
  await page.getByRole("heading", { name: "remote-live.html" }).waitFor();
  await pageB.getByRole("status", { name: "Shelf changed in another tab" }).waitFor();
  assert.equal(await pageB.getByRole("heading", { name: "tab-session-draft.html" }).count(), 1,
    "remote change must not replace a dirty tab's selected draft");
  let dismissedConfirmation = "";
  pageB.once("dialog", async dialog => {
    dismissedConfirmation = dialog.message();
    await dialog.dismiss();
  });
  await pageB.getByRole("button", { name: "Refresh saved shelf" }).click();
  assert.match(dismissedConfirmation, /Discard this tab’s unsaved game changes/);
  await pageB.getByRole("heading", { name: "tab-session-draft.html" }).waitFor();
  await pageB.getByText("Not saved · this tab only", { exact: true }).waitFor();
  assert(!(await records()).some(row => row.name === "tab-session-draft.html"));
  await pageB.evaluate(() => { window.__failArcadeShelfPut = false; });
  await clearOpsOn(pageB);
  await pageB.getByRole("button", { name: "Retry save" }).click();
  await pageB.getByText("Your unsaved games are now saved on this device.").waitFor();
  await pageB.getByText("Not saved · this tab only", { exact: true }).waitFor({ state: "detached" });
  await shelfRow(pageB, /remote-live\.html/).waitFor();
  await shelfRow(pageB, /remote-remove-while-dirty\.html/).waitFor({ state: "detached" });
  assert(!(await opsOn(pageB)).some(op => op.method === "put" && op.id === gbaRecord.id),
    "dirty-tab retry reconciles remote records without rewriting the large ROM");
  report.push("Dirty second tab retained its failed-import draft through remote changes and dismissed refresh confirmation; successful retry saved it and reconciled remote addition/removal without a large-ROM put.");

  const moduleImport = `/src/lib/importedGameStorage.ts?race=${Date.now()}`;
  const staleTargetId = await pageB.evaluate(async moduleUrl => {
    const storage = await import(moduleUrl);
    const rows = await storage.loadImportedGames();
    window.__staleRowsB = rows;
    return rows.find(row => row.name === "persisted-score.html").id;
  }, moduleImport);
  const updatedSource = await page.evaluate(async ({ moduleUrl, id }) => {
    const storage = await import(moduleUrl);
    const previous = await storage.loadImportedGames();
    const next = previous.map(row => row.id === id ? { ...row, source: `${row.source}\n<!-- committed-tab-A-edit -->` } : row);
    await storage.saveImportedGameChanges(previous, next);
    return next.find(row => row.id === id).source;
  }, { moduleUrl: moduleImport, id: staleTargetId });
  await clearOpsOn(pageB);
  const staleUpdateName = await pageB.evaluate(async ({ moduleUrl, id }) => {
    const storage = await import(moduleUrl);
    const old = window.__staleRowsB.find(row => row.id === id);
    try { await storage.saveImportedGameChanges([old], [{ ...old, source: `${old.source}\n<!-- stale-tab-B-edit -->` }]); return "no-conflict"; }
    catch (error) { return error.name; }
  }, { moduleUrl: moduleImport, id: staleTargetId });
  assert.equal(staleUpdateName, "ImportedGameStorageConflictError", "stale update must be rejected");
  assert.equal((await records()).find(row => row.id === staleTargetId).source, updatedSource,
    "stale edit must preserve the exact newer source");
  const conflictOps = await opsOn(pageB);
  assert.deepEqual(conflictOps.filter(op => op.method === "get" && op.transactionMode === "readwrite").map(op => op.key), [staleTargetId],
    "stale write-transaction conflict checks only the changed record, independently of read-only shelf refreshes");
  assert(!conflictOps.some(op => ["put", "delete", "clear"].includes(op.method)),
    "stale edit conflict must not write or clear records");
  report.push("Two separately loaded real Vite-module snapshots: stale B update rejected ImportedGameStorageConflictError, preserved A's exact source, and touched only the changed ID.");

  await importHtml("stale-delete-target.html", "<!doctype html><html><body><p>Deletion race</p></body></html>");
  await page.getByRole("heading", { name: "stale-delete-target.html" }).waitFor();
  await shelfRow(pageB, /stale-delete-target\.html/).waitFor();
  const deleteRaceId = await pageB.evaluate(async moduleUrl => {
    const storage = await import(moduleUrl);
    const rows = await storage.loadImportedGames();
    window.__deleteRaceSnapshotB = rows;
    return rows.find(row => row.name === "stale-delete-target.html").id;
  }, moduleImport);
  await page.evaluate(async ({ moduleUrl, id }) => {
    const storage = await import(moduleUrl), previous = await storage.loadImportedGames();
    await storage.saveImportedGameChanges(previous, previous.filter(row => row.id !== id));
  }, { moduleUrl: moduleImport, id: deleteRaceId });
  await clearOpsOn(pageB);
  const resurrectionName = await pageB.evaluate(async ({ moduleUrl, id }) => {
    const storage = await import(moduleUrl);
    const old = window.__deleteRaceSnapshotB.find(row => row.id === id);
    // Model the legitimate live shelf refresh that can arrive from tab A's
    // deletion notification while this stale save is being checked.
    const refresh = storage.loadImportedGameRecords([id]);
    const save = storage.saveImportedGameChanges([old], [{ ...old, source: `${old.source}\n<!-- stale resurrection -->` }])
      .then(() => "no-conflict", error => error.name);
    const [result] = await Promise.all([save, refresh]);
    return result;
  }, { moduleUrl: moduleImport, id: deleteRaceId });
  assert.equal(resurrectionName, "ImportedGameStorageConflictError", "stale update must not resurrect a remotely deleted item");
  assert(!(await records()).some(row => row.id === deleteRaceId), "deleted record must remain absent");
  const resurrectionOps = await opsOn(pageB);
  assert.deepEqual(resurrectionOps.filter(op => op.method === "get" && op.transactionMode === "readwrite").map(op => op.key), [deleteRaceId],
    "the stale save guards the deleted ID exactly once, excluding independent read-only refreshes");
  assert(resurrectionOps.some(op => op.method === "get" && op.transactionMode === "readonly" && op.key === deleteRaceId),
    "the regression must include an overlapping read-only shelf refresh");
  assert(!resurrectionOps.some(op => ["put", "delete", "clear"].includes(op.method)),
    "stale resurrection conflict must not write, delete, or clear records");
  report.push("A stale B update after A's committed deletion conflicted instead of resurrecting the record; the write transaction checked only the deleted ID even with an overlapping read-only refresh, and no mutations occurred.");

  // UI stale removal: pause B after open succeeds but before its helper begins the guarded transaction.
  await importHtml("ui-conflict-target.html", "<!doctype html><html><body><p>Conflict UI target</p></body></html>");
  await page.getByRole("heading", { name: "ui-conflict-target.html" }).waitFor();
  await shelfRow(pageB, /ui-conflict-target\.html/).waitFor();
  await shelfRow(pageB, /ui-conflict-target\.html/).click();
  await pageB.getByRole("heading", { name: "ui-conflict-target.html" }).waitFor();
  await pageB.evaluate(() => { window.__heldShelfOpenReady = false; window.__holdNextShelfOpen = true; });
  await pageB.getByRole("button", { name: "Remove ui-conflict-target.html" }).click();
  await pageB.waitForFunction(() => window.__heldShelfOpenReady === true);
  const uiConflictSource = await page.evaluate(async ({ moduleUrl, name }) => {
    const storage = await import(moduleUrl), previous = await storage.loadImportedGames();
    const target = previous.find(row => row.name === name);
    const source = `${target.source}\n<!-- winner from tab A -->`;
    await storage.saveImportedGameChanges(previous, previous.map(row => row.id === target.id ? { ...row, source } : row));
    return { id: target.id, source };
  }, { moduleUrl: moduleImport, name: "ui-conflict-target.html" });
  await pageB.evaluate(() => window.__releaseHeldShelfOpen?.());
  await pageB.getByRole("alert").filter({ hasText: "This game changed or was removed in another tab" }).waitFor();
  assert.equal(await pageB.getByRole("heading", { name: "ui-conflict-target.html" }).count(), 1,
    "conflicted UI removal keeps the game visible");
  assert.equal((await records()).find(row => row.id === uiConflictSource.id).source, uiConflictSource.source,
    "conflicted UI removal preserves the newer committed source");
  report.push("UI stale removal was held at IndexedDB open while A committed an edit; release produced a visible conflict, retained the selected item, and preserved A's exact saved source.");

  // Exercise real Vite-served storage module: synchronous clone error must abort clear+put transaction.
  const baseline = await records();
  await page.evaluate(async () => {
    const storage = await import(`/src/lib/importedGameStorage.ts?test=${Date.now()}`);
    const baseline = await new Promise((resolve, reject) => {
      const req = indexedDB.open("arenaforge-imported-games", 1);
      req.onsuccess = () => {
        const db = req.result, read = db.transaction("games", "readonly").objectStore("games").getAll();
        read.onsuccess = () => { resolve(read.result); db.close(); };
        read.onerror = () => reject(read.error);
      };
      req.onerror = () => reject(req.error);
    });
    let thrown;
    try { await storage.saveImportedGames([...baseline, { id: "uncloneable-test", kind: "html", source: () => 1 }]); }
    catch (error) { thrown = error; }
    if (!thrown || thrown.name !== "DataCloneError") throw new Error(`Expected DataCloneError rollback, got ${thrown?.name ?? "no error"}`);
  });
  assert.deepEqual(await records(), baseline, "DataCloneError batch must not clear existing real IndexedDB rows");
  report.push("Dynamic Vite module saveImportedGames clear+put batch rejected DataCloneError and retained the exact preexisting real IndexedDB rows.");

  await page.screenshot({ path: new URL("shelf-before-restart.png", output).pathname, fullPage: true });
  await context.close();
  context = null;
  browser = null;
  await launchPersistent(); // same user-data directory; prior Chromium process/context is fully closed
  await page.goto(`${base}/arcade`);
  await shelfTab();
  await shelfRow(page, /persisted-score\.html/).click();
  await page.getByRole("heading", { name: "persisted-score.html" }).waitFor();
  const reloadedHtml = page.frameLocator('iframe[title="Playable game: persisted-score.html"]');
  await reloadedHtml.getByText("Score 1", { exact: true }).waitFor();
  const restoredRows = await records();
  const restoredGba = restoredRows.find(record => record.name === "original-storage-stress.gba");
  assert.equal(restoredGba?.id, gbaRecord.id);
  assert.equal(restoredGba?.byteLength, gba.length);
  assert.equal(restoredGba?.hash, gbaHash);
  await page.getByRole("button", { name: "original-homebrew.nes" }).click();
  await page.locator('canvas[aria-label="NES game screen"]').waitFor();
  await page.getByRole("button", { name: "Restore save" }).click();
  await page.getByText("Saved progress restored.").waitFor();
  await page.waitForFunction(color => {
    const p = document.querySelector('canvas[aria-label="NES game screen"]')?.getContext("2d")?.getImageData(128,120,1,1).data;
    return p && p[0] === color[0] && p[1] === color[1] && p[2] === color[2];
  }, idleColor);
  await page.screenshot({ path: new URL("shelf-after-browser-restart.png", output).pathname, fullPage: true });
  report.push("After closing Chromium and relaunching the same fresh persistent profile: HTML score save restored, NES retained/rendered/restored save, and 32 MiB ROM ID/length/hash stayed exact.");
  assert(restoredRows.some(record => record.id === htmlId));
  assert(restoredRows.some(record => record.id === nesId));
  await writeFile(new URL("report.json", output), JSON.stringify({
    result: "passed", checks: report, persistentProfile: "temporary directory; removed after run",
    gbaStorageOnly: true, gbaBytes: gba.length, gbaSha256: gbaHash,
    emulatorLoader: "intercepted; no EmulatorJS core download or GBA emulation claimed",
  }, null, 2));
  console.log(JSON.stringify({ result: "passed", checks: report }, null, 2));
} catch (error) {
  try {
    if (page) await page.screenshot({ path: new URL("failure.png", output).pathname, fullPage: true });
    await writeFile(new URL("report.json", output), JSON.stringify({ result: "failed", checks: report, error: String(error?.stack ?? error) }, null, 2));
  } catch {}
  console.error(error);
  process.exitCode = 1;
} finally {
  try { await context?.close(); } catch {}
  await rm(userDataDir, { recursive: true, force: true });
}
