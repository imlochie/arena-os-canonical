// Run with: pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/arcade-repository-import.mjs"
// Browser integration uses original fixture source and the real acquisition core,
// not a model response. Public GitHub availability is checked separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import {
  inspectRepository, acquireRepository, rememberRepositoryPlan, recalledRepositoryPlan,
} from "../artifacts/api-server/src/imported/arcade/repository-source.ts";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const revision = "b".repeat(40);
const sources = new Map([
  ["index.html", Buffer.from('<!doctype html><html><head><title>Offline fixture</title></head><body><button id="score">Score point</button><output id="points">0</output><script src="game.js"></script></body></html>')],
  ["game.js", Buffer.from('let points=0;document.getElementById("score").onclick=()=>document.getElementById("points").textContent=String(++points);')],
  ["LICENSE", Buffer.from("SPDX-License-Identifier: MIT\nCopyright repository-import test fixture")],
]);
const sha = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
let rawDownloads = 0;
const fixtureRead = async (url, limit) => {
  const parsed = new URL(url);
  if (parsed.hostname === "raw.githubusercontent.com") {
    rawDownloads++;
    assert.ok(parsed.pathname.includes(`/${revision}/`));
    const bytes = sources.get(parsed.pathname.split(`/${revision}/`)[1]);
    assert.ok(bytes && bytes.length <= limit);
    return bytes;
  }
  const path = parsed.pathname;
  const body = path.endsWith("/commits/main") ? { sha: revision }
    : path.endsWith(`/git/trees/${revision}`) ? { tree: [...sources].map(([path, bytes]) => ({ path, sha: sha(bytes), size: bytes.length, type: "blob", mode: "100644" })) }
    : path.endsWith("/license") ? { path: "LICENSE", encoding: "base64", content: sources.get("LICENSE").toString("base64"), license: { spdx_id: "MIT" } }
    : { private: false, default_branch: "main" };
  return Buffer.from(JSON.stringify(body));
};
const output = new URL("../generated-artifacts/arcade-repository-import/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    if (window === window.top) {
      localStorage.setItem("af_local_mode", "1");
      localStorage.setItem("af_ephemeral", "0");
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/arcade/import/repository/inspect", async route => {
    try {
      const body = route.request().postDataJSON();
      assert.equal(body.authorized, true);
      const plan = await inspectRepository(body.url, AbortSignal.timeout(5000), fixtureRead);
      await route.fulfill({ json: rememberRepositoryPlan("fixture-owner", plan) });
    } catch (error) { await route.fulfill({ status: 422, json: { error: error.message } }); }
  });
  await page.route("**/api/arcade/import/repository/acquire", async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.authorized, true);
    const plan = recalledRepositoryPlan("fixture-owner", body.token);
    await route.fulfill({ json: await acquireRepository(plan, AbortSignal.timeout(5000), fixtureRead) });
  });
  await page.goto(`${process.env.TEST_BASE_URL || "http://localhost:80"}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  assert.equal(await page.getByTestId("inspect-repository").isDisabled(), true);
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByTestId("input-repository-url").fill("https://github.com/fixture/offline-game");
  await page.getByTestId("inspect-repository").click();
  await page.getByTestId("repository-preview").waitFor();
  assert.equal(rawDownloads, 0, "preview must not acquire or run the game");
  assert.ok((await page.getByTestId("repository-preview").textContent()).includes(revision));
  await page.getByTestId("repository-files").click();
  await page.getByTestId("repository-license").click();
  assert.ok((await page.getByTestId("repository-preview").textContent()).includes("LICENSE"));
  assert.equal(await page.locator('iframe[title^="Playable game:"]').count(), 0);
  await page.getByTestId("repository-preview").screenshot({ path: new URL("preview.png", output).pathname });
  await page.getByTestId("import-reviewed-repository").click();
  const frame = page.frameLocator('iframe[title^="Playable game:"]');
  await frame.getByRole("button", { name: "Score point" }).click();
  assert.equal(await frame.locator("#points").textContent(), "1");
  assert.equal(rawDownloads, sources.size);
  await page.getByTestId("imported-repository-provenance").waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByTestId("imported-repository-provenance").waitFor();
  assert.ok((await page.getByTestId("imported-repository-provenance").textContent()).includes(revision));
  await frame.getByRole("button", { name: "Score point" }).click();
  assert.equal(await frame.locator("#points").textContent(), "1");
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByTestId("input-repository-url").fill("https://localhost/private");
  await page.getByTestId("inspect-repository").click();
  await page.getByTestId("repository-error").waitFor();
  assert.match(await page.getByTestId("repository-error").textContent(), /Only public/i);
  assert.equal(await frame.locator("#points").textContent(), "1", "a refused repository must not restart the retained game");
  assert.deepEqual(errors, []);
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, rawDownloads, checks: ["rights gate", "review before download", "pinned files", "license preview", "sandbox gameplay", "reload provenance", "unsafe-link refusal retains game"], modelCallTested: false }, null, 2));
  console.log("PASS: repository preview → pinned acquisition → sandbox play → local reload; refused links retain the current game.");
} finally { await browser.close(); }
