// Run with: pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/arcade-repository-import.mjs"
// Browser integration uses original fixture source and the real acquisition core,
// not a model response. Public GitHub availability is checked separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  inspectRepository, acquireRepository, rememberRepositoryPlan, recalledRepositoryPlan,
} from "../artifacts/api-server/src/imported/arcade/repository-source.ts";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const revision = "b".repeat(40);
const sources = new Map([
  ["index.html", Buffer.from('<!doctype html><html><head><title>Offline fixture</title></head><body><button id="score">Score point</button><output id="points">0</output><script src="game.js"></script></body></html>')],
  ["game.js", Buffer.from('let points=0;document.getElementById("score").onclick=()=>document.getElementById("points").textContent=String(++points);')],
  ["LICENSE", Buffer.from(`MIT License

Copyright (c) 2026 Repository Import Test

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.`)],
]);
const sha = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
let gameFileReads = 0;
const fixtureRead = async (url, limit) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const repoPath = "/api/v1/repos/fixture/offline-game";
  assert.equal(parsed.hostname, "codeberg.org");
  assert.ok(path.startsWith(repoPath));
  let body;
  if (path === repoPath) body = { private: false, archived: false, default_branch: "main" };
  else if (path.endsWith("/branches/main")) body = { commit: { id: revision } };
  else if (path.endsWith(`/git/commits/${revision}`)) body = { sha: revision };
  else if (path.endsWith(`/git/trees/${revision}`)) {
    body = { tree: [...sources].map(([path, bytes]) => ({ path, sha: sha(bytes), size: bytes.length, type: "blob", mode: "100644" })), truncated: false };
  } else if (path.endsWith("/releases")) body = [];
  else if (path.includes("/contents/")) {
    const filePath = decodeURIComponent(path.split("/contents/")[1]);
    const bytes = sources.get(filePath);
    assert.ok(bytes && bytes.length <= limit, `unexpected pinned Codeberg file: ${filePath}`);
    if (filePath !== "LICENSE") gameFileReads++;
    body = { type: "file", path: filePath, size: bytes.length, sha: sha(bytes), encoding: "base64", content: bytes.toString("base64") };
  } else assert.fail(`unexpected Codeberg request: ${url}`);
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
  await page.getByTestId("input-repository-url").fill("https://codeberg.org/fixture/offline-game");
  await page.getByTestId("inspect-repository").click();
  await page.getByTestId("repository-preview").waitFor();
  assert.equal(gameFileReads, 0, "preview may verify the license but must not acquire or run game files");
  assert.ok((await page.getByTestId("repository-preview").textContent()).includes(revision));
  await page.getByTestId("repository-files").click();
  await page.getByTestId("repository-license").click();
  assert.ok((await page.getByTestId("repository-preview").textContent()).includes("LICENSE"));
  assert.equal(await page.locator('iframe[title^="Playable game:"]').count(), 0);
  await page.getByTestId("repository-preview").screenshot({ path: new URL("preview.png", output).pathname });
  assert.equal(await page.getByTestId("import-reviewed-repository").isDisabled(), true, "import requires explicit rights approval");
  await page.getByTestId("confirm-repository-rights").check();
  await page.getByTestId("import-reviewed-repository").click();
  const frame = page.frameLocator('iframe[title^="Playable game:"]');
  await frame.getByRole("button", { name: "Score point" }).click();
  assert.equal(await frame.locator("#points").textContent(), "1");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-imported-html").click(),
  ]);
  assert.match(download.suggestedFilename(), /\.html$/);
  const exported = await readFile(await download.path(), "utf8");
  assert.match(exported, /arena-repository-attribution/);
  assert.ok(exported.includes(revision));
  assert.equal(await frame.locator("#points").textContent(), "1", "export must not restart the active game");
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "round-trip-game.html", mimeType: "text/html", buffer: Buffer.from(exported),
  });
  await page.locator('iframe[title="Playable game: round-trip-game.html"]').waitFor();
  assert.ok((await page.getByTestId("imported-repository-provenance").textContent()).includes(revision));
  await page.reload();
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.locator('iframe[title="Playable game: round-trip-game.html"]').waitFor();
  await frame.getByRole("button", { name: "Score point" }).click();
  assert.equal(await frame.locator("#points").textContent(), "1");
  assert.ok((await page.getByTestId("imported-repository-provenance").textContent()).includes("MIT"));
  assert.equal(gameFileReads, sources.size - 1);
  await page.getByTestId("imported-repository-provenance").waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByTestId("imported-repository-provenance").waitFor();
  assert.ok((await page.getByTestId("imported-repository-provenance").textContent()).includes(revision));
  await frame.getByRole("button", { name: "Score point" }).click();
  assert.equal(await frame.locator("#points").textContent(), "1");
  await page.getByLabel(/I own this game or have permission to use and play it/).check();
  await page.getByTestId("input-repository-url").fill("https://localhost/private");
  assert.equal(await page.getByTestId("inspect-repository").isDisabled(), true, "unsupported hosts must be refused before an API request");
  assert.equal(await frame.locator("#points").textContent(), "1", "a refused repository must not restart the retained game");
  assert.deepEqual(errors, []);
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, provider: "codeberg", gameFileReads, checks: ["rights gate", "review before download", "pinned Codeberg files", "license preview", "sandbox gameplay", "reload provenance", "HTML download retains active game", "HTML reimport/reload retains source and license", "unsafe-link refusal retains game"], modelCallTested: false }, null, 2));
  console.log("PASS: repository import/play/reload and native HTML export/reimport/reload preserve source attribution; refused links retain the current game.");
} finally { await browser.close(); }
