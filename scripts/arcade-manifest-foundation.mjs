import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(() => { if (window === top) { localStorage.setItem("af_local_mode", "1"); localStorage.setItem("af_ephemeral", "1"); } });
const page = await context.newPage();
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const output = new URL("../generated-artifacts/arcade-manifests/", import.meta.url);
await mkdir(output, { recursive: true });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const checks = [];
const source = `<!doctype html><html><head><title>Original local game</title></head><body><canvas width="96" height="64"></canvas><output id="count"></output><button id="advance">Advance</button><script>
let count=Number(localStorage.getItem("count")||0);const out=document.getElementById("count");
out.textContent=count;document.getElementById("advance").onclick=()=>{out.textContent=++count;localStorage.setItem("count",String(count))};
const c=document.querySelector("canvas").getContext("2d");c.fillStyle="red";c.fillRect(0,0,30,30);
</script></body></html>`;
const old = { id: "legacy-manifest-fixture", name: "legacy.html", kind: "html", source, addedAt: 123,
  revisionRollback: { source: source.replace("Original local game", "Older local game"), savedAt: 122, label: "Original copy" },
  revisionHistory: [{ source: source.replace("Original local game", "Oldest local game"), savedAt: 121, label: "Earlier copy" }] };
const readDb = (database, store) => page.evaluate(({ database, store }) => new Promise((resolve, reject) => {
  const request = indexedDB.open(database, 1);
  request.onsuccess = () => { const db = request.result; const tx = db.transaction(store); const get = tx.objectStore(store).getAll(); get.onsuccess = () => resolve(get.result); tx.oncomplete = () => db.close(); tx.onerror = () => reject(tx.error); };
  request.onerror = () => reject(request.error);
}), { database, store });
const metadata = () => readDb("arenaforge-arcade-management", "manifests");
const records = () => readDb("arenaforge-imported-games", "games");
const imports = async () => { await page.goto(`${base}/arcade`); await page.getByRole("tab", { name: "Import and emulate" }).click(); };
const frame = () => page.frameLocator('iframe[title="Playable game: legacy.html"]');
const waitCount = async count => { await frame().locator("#count").filter({ hasText: new RegExp(`^${count}$`) }).waitFor(); };
const panel = () => page.getByTestId("arcade-game-management");
const openPanel = async () => { if (!await panel().evaluate(el => el.open)) await panel().locator(":scope > summary").click(); };
const mutateMetadata = async mutate => {
  await page.evaluate(async ({ id, mutation }) => {
    const db = await new Promise(resolve => { const request = indexedDB.open("arenaforge-arcade-management", 1); request.onsuccess = () => resolve(request.result); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("manifests", "readwrite"); const store = tx.objectStore("manifests");
      const get = store.getAll(); get.onsuccess = () => {
        const row = get.result.find(row => row.manifest.id === id);
        if (mutation === "runtime") row.manifest.runtime.id = "missing.native.executor";
        else row.manifest.schemaVersion = 99;
        store.put(row);
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { id: old.id, mutation: mutate });
};
try {
  await page.goto(`${base}/arcade`);
  await page.evaluate(async ({ old, source }) => {
    const seed = (name, row) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("games", { keyPath: "id" });
      request.onsuccess = () => { const db = request.result; const tx = db.transaction("games", "readwrite"); tx.objectStore("games").put(row); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    await seed("arenaforge-imported-games", old);
    await seed("arenaforge-offline-shelf", { id: "legacy-created-fixture", title: "Foundation created fixture", prompt: "Original fixture", gameType: "snake", engine: "ai-codegen", code: source, saveSlotId: "retained-alias", starter: false, createdAt: 120, updatedAt: 123 });
    localStorage.setItem(`arenaforge.game-save.v1:${old.id}`, '{"count":"7"}');
    localStorage.setItem("arenaforge.game-save.v1:retained-alias", '{"count":"4"}');
  }, { old, source });
  await imports(); await waitCount(7); await openPanel();
  assert.deepEqual((await records())[0], old);
  const originalManifest = (await metadata()).find(row => row.manifest.id === old.id).manifest;
  assert.equal(originalManifest.sourceRevisionCopies, 2);
  assert.equal(originalManifest.ownership, "imported-private");
  assert.equal(originalManifest.runtime.id, "arena.browser.html");
  assert.equal(JSON.stringify(originalManifest).includes(source), false);
  assert.equal(originalManifest.evidence.some(e => e.stage === "startup" || e.stage === "gameplay"), false);
  await frame().locator("#advance").click(); await waitCount(8);
  await frame().locator("body").evaluate(el => { el.dataset.live = "retained"; });
  await panel().getByRole("checkbox", { name: /observed this game open/ }).check();
  await panel().getByRole("checkbox", { name: /tested meaningful gameplay/ }).check();
  await panel().getByRole("button", { name: "Record my observation", exact: true }).click();
  await panel().getByTestId("arcade-evidence-gameplay").getByText(/user-observation/).waitFor();
  assert.equal(await frame().locator("body").getAttribute("data-live"), "retained");
  await panel().getByRole("button", { name: "Check runtime module", exact: true }).click();
  await panel().getByText(/available: Included with Arena/).waitFor();
  const downloadEvent = page.waitForEvent("download");
  await panel().getByRole("button", { name: "Export metadata", exact: true }).click();
  const exported = JSON.parse(await readFile(await (await downloadEvent).path(), "utf8"));
  assert.equal(exported.id, old.id);
  assert.equal(exported.evidence.find(e => e.stage === "gameplay").origin, "user-observation");
  await imports(); await waitCount(8); assert.deepEqual((await records())[0], old);
  checks.push("legacy source, identity, progress, alias-free import history and controls survive metadata migration/reload; observations and availability checks do not restart gameplay");
  await mutateMetadata("runtime"); await imports(); await openPanel();
  await panel().getByText(/Runtime missing.native.executor is not registered/).waitFor();
  assert.equal(await page.locator('iframe[title="Playable game: legacy.html"]').count(), 0);
  page.once("dialog", dialog => dialog.dismiss());
  await panel().getByRole("button", { name: "Rebuild metadata", exact: true }).click();
  assert.equal(await page.locator('iframe[title="Playable game: legacy.html"]').count(), 0);
  page.once("dialog", dialog => dialog.accept());
  await panel().getByRole("button", { name: "Rebuild metadata", exact: true }).click();
  await waitCount(8); await openPanel();
  await imports(); await waitCount(8); await openPanel();
  const recoveryDownload = page.waitForEvent("download");
  await panel().getByRole("button", { name: "Export recovery metadata", exact: true }).click();
  const recovery = JSON.parse(await readFile(await (await recoveryDownload).path(), "utf8"));
  assert.equal(recovery.record.previous.runtime.id, "missing.native.executor");
  await mutateMetadata("schema"); await imports(); await waitCount(8); await openPanel();
  await panel().getByRole("alert").getByText(/unsupported schema/).waitFor();
  assert.equal((await metadata()).find(row => row.manifest.id === old.id).manifest.schemaVersion, 99);
  assert.deepEqual((await records())[0], old);
  checks.push("unregistered runtime blocks launch; cancel retains it, explicit rebuild preserves recovery metadata; unsupported schema is reported without rewriting original game data");
  // Exercise atomic batch abort after one successful put, in the real browser
  // database. Legacy game databases and save keys are outside this transaction.
  const atomic = await page.evaluate(async () => {
    const { syncArcadeManifests } = await import("/src/lib/arcadeManifestStorage.ts");
    const { createArcadeManifest } = await import("/src/lib/arcadeManifest.ts");
    const { browserHtmlAdapter, currentArcadeHost } = await import("/src/lib/arcadeRuntimeAdapters.ts");
    const template = await createArcadeManifest({ id: "atomic-template", title: "Atomic fixture", source: "fixture", format: "html", scope: "imported-private", trust: "imported-code", stored: true, addedAt: 1 }, browserHtmlAdapter.definition, currentArcadeHost());
    const results = [];
    const put = IDBObjectStore.prototype.put;
    for (const kind of ["quota", "abort"]) {
      let count = 0;
      IDBObjectStore.prototype.put = function(...args) {
        if (this.name === "manifests" && ++count === 2) {
          if (kind === "abort") this.transaction.abort();
          throw new DOMException("Injected metadata failure", kind === "quota" ? "QuotaExceededError" : "AbortError");
        }
        return put.apply(this, args);
      };
      try { await syncArcadeManifests([{ ...template, id: `atomic-${kind}-a` }, { ...template, id: `atomic-${kind}-b` }]); results.push(false); }
      catch { results.push(true); }
      finally { IDBObjectStore.prototype.put = put; }
    }
    return results;
  });
  assert.deepEqual(atomic, [true, true]);
  assert.equal((await metadata()).some(row => row.manifest.id.startsWith("atomic-")), false);
  assert.deepEqual((await records())[0], old); await waitCount(8);
  checks.push("real IndexedDB batch migration rolls back all metadata writes on quota and explicit abort; original game records and progress remain intact");
  // Existing created-game identity/save aliases also use the real adapter.
  await page.getByRole("tab", { name: "Create and revise" }).click();
  await page.getByRole("button", { name: "Open offline game Foundation created fixture", exact: true }).click();
  const createdFrame = page.frameLocator('iframe[title="Original fixture"]');
  await createdFrame.locator("#count").filter({ hasText: /^4$/ }).waitFor();
  await createdFrame.locator("body").evaluate(el => { el.dataset.live = "created-stays-live"; });
  await createdFrame.locator("#advance").click();
  await createdFrame.locator("#count").filter({ hasText: /^5$/ }).waitFor();
  assert.equal(await createdFrame.locator("body").getAttribute("data-live"), "created-stays-live");
  const created = (await metadata()).find(row => row.manifest.id === "legacy-created-fixture").manifest;
  assert.match(created.locations.saves[0], /retained-alias$/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("arenaforge.game-save.v1:retained-alias")).count), "5");
  assert.equal((await readDb("arenaforge-offline-shelf", "games")).find(row => row.id === "legacy-created-fixture").code, source);
  checks.push("created games retain source and aliased save identity; first save no longer navigates the iframe");
  await openPanel();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "runtime diagnostics must fit a narrow viewport");
  checks.push("runtime management fits a 390px viewport without horizontal page overflow");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: new URL("management.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks, modelCallTested: false, nativeExecutionTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await page.screenshot({ path: new URL("failure.png", output).pathname }).catch(() => {});
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally { await browser.close(); }
