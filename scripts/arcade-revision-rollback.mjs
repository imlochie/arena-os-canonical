// Real UI/IndexedDB with original source fixtures and mocked model responses.
// This checks revision recovery, not model inference.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, release as osRelease } from "node:os";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium, webkit } = require("playwright-core");
const engine = process.env.TEST_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(engine), "TEST_BROWSER must be chromium or webkit");
const output = new URL(`../generated-artifacts/arcade-revision-rollback-${engine}/`, import.meta.url);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(new URL("profile-", output).pathname);
let context;
let page;
let comparison;
let browserVersion;
let userAgent;
const requests = [];
const errors = [];
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const checks = [];
const checkpoints = [];
const storage = [];
let browserReopens = 0;
let release;
let requested = "";
const original = `<!doctype html><html><head><title>Original rollback fixture</title></head><body><h1 id="version">A</h1><button id="point">Point</button><p id="score"></p><script>let n=Number(localStorage.getItem("points")||0);const draw=()=>document.getElementById("score").textContent=String(n);document.getElementById("point").onclick=()=>{localStorage.setItem("points",String(++n));draw()};draw();</script></body></html>`;
const source = version => original.replace('id="version">A', `id="version">${version}`);
async function launch() {
  context = await (engine === "webkit" ? webkit : chromium).launchPersistentContext(profile, {
    ...(engine === "chromium" ? {
      executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    } : process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}),
    headless: true, viewport: { width: 1280, height: 900 }, serviceWorkers: "block",
  });
  browserVersion = context.browser().version();
  await context.addInitScript(() => {
  if (window !== window.top) return;
  localStorage.setItem("af_local_mode", "0");
  localStorage.setItem("af_ephemeral", "1");
  localStorage.setItem("af_key_openrouter", "rollback-test-placeholder-not-a-credential");
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.transaction.db.name === "arenaforge-imported-games" && this.name === "games") {
      if (window.__failRevisionWrites === true) throw new DOMException("Injected quota failure", "QuotaExceededError");
      const request = put.apply(this, args);
      // Abort after a real put request succeeds, before transaction completion.
      if (window.__failRevisionWrites === "abort") request.addEventListener("success", () => this.transaction.abort());
      return request;
    }
    return put.apply(this, args);
  };
});
page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(15_000);
page.on("request", request => requests.push(request.url()));
page.on("pageerror", e => errors.push(e.message));
// Only the model response is mocked; source writes use the browser's real IDB.
await page.route("**/api/arcade/import/revise", async route => {
  const body = route.request().postDataJSON();
  assert.equal(body.ephemeral, true);
  assert.ok(body.priorCode.includes("Original rollback fixture"));
  requested = body.prompt;
  if (body.prompt === "cancel" || body.prompt === "stale") await new Promise(resolve => { release = resolve; });
  try {
    if (body.prompt === "network fail") await route.fulfill({ status: 503, json: { error: "Injected model outage" } });
    else await route.fulfill({ json: { code: body.prompt === "unsafe" ? '<html><script src="https://example.invalid/script.js"></script></html>' : source(body.prompt), warnings: [] } });
  } catch (error) { if (body.prompt !== "cancel") throw error; }
});
}
const frame = () => page.frameLocator('iframe[title="Playable game: rollback-fixture.html"]');
const records = () => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("arenaforge-imported-games");
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
  await frame().getByRole("heading", { name: expected, exact: true }).waitFor();
  assert.equal(await frame().locator("#version").innerText(), expected);
  assert.equal(await frame().locator("#score").innerText(), "1");
};
let gameId;
let progress;
const exact = async (active, rollback, label) => {
  const saved = await records();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, gameId);
  assert.equal(saved[0].source, source(active));
  assert.equal(saved[0].revisionRollback?.source, rollback === undefined ? undefined : source(rollback));
  assert.deepEqual(await saveBytes(), progress);
  checkpoints.push({ label, id: gameId, active: saved[0].source, rollback: saved[0].revisionRollback?.source, progress });
};
const noFalseSuccess = async () => {
  assert.equal(await page.getByText(/^(Revision applied|Revision kept|Previous version restored|Earlier version restored)/).count(), 0);
};
const revise = async prompt => {
  await page.getByLabel("Revise this browser game").fill(prompt);
  await page.getByRole("button", { name: "Apply revision", exact: true }).click();
};
const quota = value => page.evaluate(value => { window.__failRevisionWrites = value; }, value);
const older = async label => {
  const history = page.getByTestId("imported-revision-history");
  if (!await history.getAttribute("open").then(value => value !== null)) await history.locator("summary").click();
  await page.getByTestId("imported-revision-history-entry").filter({ has: page.getByText(label, { exact: true }) })
    .getByRole("button", { name: "Restore this version", exact: true }).click();
};
const reopen = async () => {
  await page.goto(`${base}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate" }).click();
};
const restart = async () => {
  // No storageState export/import: both IDB and progress must survive on disk.
  await context.close();
  await launch();
  browserReopens++;
  await reopen();
};
try {
  await launch();
  await reopen();
  userAgent = await page.evaluate(() => navigator.userAgent);
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[type="file"][accept*=".html"]').setInputFiles({ name: "rollback-fixture.html", mimeType: "text/html", buffer: Buffer.from(original) });
  await frame().getByRole("heading", { name: "A", exact: true }).waitFor();
  await frame().getByRole("button", { name: "Point", exact: true }).click();
  await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith("arenaforge.game-save.v1:")));
  await page.waitForFunction(() => Object.values(localStorage).some(value => value.includes?.('"points":"1"')));
  progress = await saveBytes();
  assert.ok(Object.keys(progress).length > 0);
  gameId = (await records())[0].id;
  await exact("A", undefined, "import");
  await revise("B");
  await page.getByTestId("imported-revision-undo").waitFor();
  await version("B");
  const pending = await records();
  assert.equal(pending[0].revisionUndoSource, original);
  await exact("B", undefined, "apply");
  const pendingProgress = await saveBytes();
  const requestsBeforeComparison = requests.length;
  await frame().locator("#version").evaluate(element => { element.dataset.comparisonMarker = "same-player"; });
  await page.getByTestId("button-compare-imported-source").click();
  comparison = page.getByTestId("imported-source-comparison");
  await comparison.waitFor();
  assert.match(await comparison.locator('[data-change="removed"]').innerText(), /id="version">A/);
  assert.match(await comparison.locator('[data-change="added"]').innerText(), /id="version">B/);
  assert.equal(await comparison.locator("script").count(), 0);
  await page.screenshot({ path: new URL("comparison.png", output).pathname });
  await comparison.getByRole("button", { name: "Back to game", exact: true }).click();
  await comparison.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.tagName === "IFRAME");
  assert.equal(await frame().locator("#version").getAttribute("data-comparison-marker"), "same-player");
  assert.deepEqual(await records(), pending);
  assert.deepEqual(await saveBytes(), pendingProgress);
  assert.equal(requests.length, requestsBeforeComparison, "comparison must not request source, inference or other network resources");
  checks.push("local comparison shows removed/added source safely, sends no requests, preserves pending data and returns focus to the same live game");
  await quota(true);
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByText(/The revision could not be kept/).waitFor();
  await noFalseSuccess();
  assert.deepEqual(await records(), pending);
  assert.equal(await page.getByTestId("button-undo-imported-revision").isVisible(), true);
  await quota(false);
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-rollback").waitFor();
  const kept = await records();
  await page.getByTestId("button-compare-imported-source").click();
  await comparison.waitFor();
  await page.keyboard.press("Escape");
  await comparison.waitFor({ state: "hidden" });
  assert.equal(kept[0].revisionRollback.source, original);
  assert.equal(kept[0].revisionUndoSource, undefined);
  await exact("B", "A", "keep");
  checks.push("keep is atomic; quota failure retains pending undo; success preserves one exact rollback source");
  await restart();
  await page.getByTestId("imported-revision-rollback").waitFor();
  await version("B");
  assert.deepEqual(await saveBytes(), progress);
  await exact("B", "A", "browser reopened after keep");
  storage.push(await page.evaluate(async () => ({
    secureContext: isSecureContext,
    persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : null,
    estimate: navigator.storage?.estimate ? await navigator.storage.estimate() : null,
  })));
  checks.push("kept rollback, exact source, stable identity and progress survive browser process close/reopen using the same disk profile");
  const unchanged = await records();
  for (const prompt of ["network fail", "unsafe"]) {
    await revise(prompt);
    await page.getByRole("alert").getByText(/Revision failed:/).waitFor();
    await noFalseSuccess();
    assert.deepEqual(await records(), unchanged);
    await version("B");
  }
  await revise("cancel");
  await page.waitForFunction(() => document.querySelector('[data-testid="button-cancel-imported-revision"]'));
  while (requested !== "cancel") await page.waitForTimeout(10);
  await page.getByTestId("button-cancel-imported-revision").click();
  release();
  await page.getByText(/Revision cancelled/).waitFor();
  await noFalseSuccess();
  assert.deepEqual(await records(), unchanged);
  assert.deepEqual(await saveBytes(), progress);
  checks.push("outage, unsafe source and cancellation preserve active source, rollback and exact progress");
  for (const failure of [true, "abort"]) {
  await quota(failure);
  await revise("C");
  await page.getByText(/The revision could not be saved/).waitFor();
  await noFalseSuccess();
  assert.deepEqual(await records(), unchanged);
  await version("B");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/The previous version could not be restored/).waitFor();
  await noFalseSuccess();
  assert.deepEqual(await records(), unchanged);
  await version("B");
  await quota(false);
  await exact("B", "A", `failed apply and restore: ${failure === true ? "quota throw" : "transaction abort after put"}`);
  }
  checks.push("quota throws and transaction aborts after successful put never publish unsaved source, overwrite rollback, change progress or report success");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await version("A");
  assert.deepEqual(await saveBytes(), progress);
  const restored = await records();
  await exact("A", "B", "restore");
  assert.equal(restored[0].id, kept[0].id);
  assert.equal(restored[0].revisionRollback.source, kept[0].source);
  await restart();
  await page.getByTestId("imported-revision-rollback").waitFor();
  await version("A");
  await exact("A", "B", "browser reopened after restore");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await version("B");
  await exact("B", "A", "reverse restore");
  await restart();
  await version("B");
  await exact("B", "A", "browser reopened after reverse restore");
  assert.deepEqual(await saveBytes(), progress);
  checks.push("restore is persistent and reversible without changing game identity or progress");
  await revise("C");
  await page.getByTestId("button-keep-imported-revision").click();
  await page.getByTestId("imported-revision-rollback").waitFor();
  const final = await records();
  assert.equal(final[0].revisionRollback.source, source("B"));
  assert.equal(final[0].source, source("C"));
  assert.deepEqual(errors, []);
  assert.equal(final[0].revisionHistory[0].source, original);
  checks.push("subsequent kept revisions retain older source copies without duplicating the head");
  await quota(true);
  await older("Earlier source");
  await page.getByText(/The previous version could not be restored/).waitFor();
  assert.deepEqual(await records(), final);
  await version("C");
  await quota(false);
  await older("Earlier source");
  await page.getByText(/Earlier version restored/).waitFor();
  await version("A");
  const earlier = (await records())[0];
  assert.equal(earlier.id, kept[0].id);
  assert.equal(earlier.revisionRollback.source, source("C"));
  assert.equal(earlier.revisionHistory[0].source, source("B"));
  assert.deepEqual(await saveBytes(), progress);
  await reopen();
  await version("A");
  await page.getByTestId("button-restore-imported-revision").click();
  await page.getByText(/Previous version restored/).waitFor();
  await version("C");
  checks.push("older restoration is atomic, survives reload, preserves other versions and progress, and is reversible");
  for (const next of ["D", "E", "F", "G", "H"]) {
    await revise(next);
    await page.getByTestId("button-keep-imported-revision").click();
    await page.getByTestId("imported-revision-rollback").waitFor();
    await version(next);
  }
  await reopen();
  await version("H");
  const bounded = (await records())[0];
  assert.deepEqual([bounded.revisionRollback, ...bounded.revisionHistory].map(copy => copy.label), ["G", "F", "E", "D", "C"]);
  assert.equal(bounded.revisionHistory.length, 4);
  assert.equal(await page.getByText(/5 of up to 5 previous versions retained locally/).isVisible(), true);
  assert.deepEqual(await saveBytes(), progress);
  await revise("pending");
  await page.getByTestId("imported-revision-undo").waitFor();
  await page.getByTestId("button-compare-imported-source").click();
  comparison = page.getByTestId("imported-source-comparison");
  await comparison.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const comparisonBounds = await comparison.boundingBox();
  assert.ok(comparisonBounds && comparisonBounds.x >= 0 && comparisonBounds.x + comparisonBounds.width <= 391);
  await page.screenshot({ path: new URL("comparison-mobile.png", output).pathname });
  await comparison.getByRole("button", { name: "Back to game", exact: true }).click();
  await comparison.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.getByTestId("imported-revision-rollback").count(), 0);
  await page.getByTestId("button-undo-imported-revision").click();
  await page.getByText(/Earlier game source restored/).waitFor();
  await version("H");
  const undone = (await records())[0];
  assert.deepEqual(undone.revisionRollback, bounded.revisionRollback);
  assert.deepEqual(undone.revisionHistory, bounded.revisionHistory);
  assert.equal(undone.revisionLabel, "H");
  await older("C");
  await page.getByText(/Earlier version restored/).waitFor();
  await version("C");
  assert.equal((await records())[0].id, kept[0].id);
  assert.deepEqual(await saveBytes(), progress);
  assert.deepEqual(errors, []);
  checks.push("five-copy retention, labeled oldest-copy restore and pending undo work without changing saved progress");
  await page.getByTestId("imported-revision-rollback").scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL("rollback.png", output).pathname });
  await writeFile(new URL("report.json", output), JSON.stringify({
    passed: true, engine, browserVersion, userAgent, host: { platform: platform(), release: osRelease() },
    browserEngineNote: "This is Playwright's Linux WPE WebKit build, not Apple Safari. Its Safari-shaped Mac user-agent string does not identify the browser host.",
    playwrightVersion: require("playwright-core/package.json").version,
    origin: new URL(base).origin, persistentProfile: true, browserReopens, storage,
    checks, checkpoints, modelCallTested: false,
    restrictions: [
      "Playwright WebKit on this host is not Apple Safari, native iOS or Windows evidence.",
      "Normal profile, first-party top-level storage; private browsing, third-party embedding, disk-full behavior and long-term eviction are not tested.",
      "Quota failure and transaction aborts are injected, not an actual exhausted disk.",
      "No retention guarantee after user-cleared or browser-evicted website data.",
      "Model responses are deterministic original fixtures, not live inference.",
    ],
  }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, modelCallTested: false }));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page?.locator("body").innerText().catch(() => "")}`);
  throw error;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
