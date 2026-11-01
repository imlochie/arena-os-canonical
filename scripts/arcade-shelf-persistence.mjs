import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
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
  for (const method of ["put", "delete", "clear"]) {
    const original = proto[method];
    proto[method] = function (...args) {
      const value = args[0];
      const info = method === "put"
        ? { id: value?.id ?? null, kind: value?.kind ?? null, byteLength: value?.romData?.byteLength ?? 0 }
        : { key: method === "delete" ? args[0] : null };
      window.__arcadeShelfOps.push({ method, ...info });
      if (method === "delete" && window.__failArcadeShelfDelete) {
        throw new DOMException("Injected deterministic shelf failure", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
  }
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
async function shelfTab() { await page.getByRole("tab", { name: "Import and emulate" }).click(); }
async function importHtml(name, html) {
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
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
  await page.getByRole("button", { name: "Save progress" }).click();
  await page.getByText("Progress saved on this browser.").waitFor();
  const nesId = await getId("original-homebrew.nes");
  const idleColor = [0x3c, 0xab, 0xff];
  await page.waitForFunction(color => {
    const pixel = document.querySelector('canvas[aria-label="NES game screen"]')?.getContext("2d")?.getImageData(128,120,1,1).data;
    return pixel && pixel[0] === color[0] && pixel[1] === color[1] && pixel[2] === color[2];
  }, idleColor);
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
  await page.getByRole("button", { name: /persisted-score\.html/ }).click();
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
