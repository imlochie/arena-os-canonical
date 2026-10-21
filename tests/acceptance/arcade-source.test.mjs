// Genuine pinned upstream acquisition + real patch replay + original/modded
// upstream GameManager in the existing opaque browser sandbox. No live model.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { create2048Mod, preview2048Mod } from "../../src/lib/games/source-2048.ts";
import { ARCADE_HOST_CSP, sandboxGameDocument } from "../../src/lib/games/sandbox.ts";
import { validateGameCode } from "../../src/lib/games/index.ts";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
test("official MIT source is acquired, actually patched, executed in browser and packaged reproducibly", { timeout: 90000 }, async t => {
  const evidence = ".data/arcade-source"; await mkdir(evidence, { recursive: true });
  const receipt = { scope: "One real MIT upstream, one supported constructor mod; Arena canvas/input/storage adapter, not official UI/full game QA, arbitrary modding or live inference", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeClean: !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), status: "running", previews: [] };
  let browser;
  const root = await mkdtemp(path.join(tmpdir(), "arena-source-patch-"));
  t.after(async () => { await browser?.close(); await rm(root, { recursive: true, force: true }); });
  try {
    const bundle = await create2048Mod(3);
    await writeFile(`${evidence}/source-package.json`, JSON.stringify(bundle, null, 2));
    await mkdir(path.join(root, "js"));
    const original = bundle.files.find(x => x.path === "js/game_manager.js").content;
    await writeFile(path.join(root, "js/game_manager.js"), original);
    execFileSync("git", ["apply", "--check", "-"], { cwd: root, input: bundle.modification.patch });
    execFileSync("git", ["apply", "-"], { cwd: root, input: bundle.modification.patch });
    assert.equal(await readFile(path.join(root, "js/game_manager.js"), "utf8"), bundle.modification.content);
    receipt.upstream = { repository: bundle.upstream, revision: bundle.revision, license: bundle.license.spdx, files: bundle.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
    receipt.patchReplaySha256 = sha(await readFile(path.join(root, "js/game_manager.js")));
    assert.equal(receipt.patchReplaySha256, bundle.modification.modifiedSha256);
    browser = await chromium.launch({ executablePath: process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined, headless: true, chromiumSandbox: !(process.env.CI === "true" && process.env.ARENA_ARCADE_CI_NO_SANDBOX === "1"), env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LD_LIBRARY_PATH", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]]] : [])), args: ["--disable-dev-shm-usage"] });
    for (const baseline of [true, false]) {
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const page = await context.newPage(); let denied = 0;
      await context.route("**/*", route => {
        if (route.request().url() === "http://arena-source.invalid/" && route.request().frame() === page.mainFrame()) return route.fulfill({ headers: { "Content-Security-Policy": ARCADE_HOST_CSP }, contentType: "text/html", body: "<!doctype html><body>Source workshop verification</body>" });
        denied++; return route.abort();
      });
      await page.goto("http://arena-source.invalid/");
      const html = preview2048Mod(bundle, baseline);
      assert.equal(validateGameCode(html).ok, true, JSON.stringify(validateGameCode(html)));
      await page.evaluate(html => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.style.cssText = "width:800px;height:650px"; f.srcdoc = html; document.body.append(f); }, sandboxGameDocument(html));
      const frame = page.frameLocator("iframe"), count = frame.locator("#tile-count");
      const expected = baseline ? "2" : "3";
      await count.waitFor({ state: "visible" }); const initialObserved = Number(await count.innerText()); assert.equal(String(initialObserved), expected);
      await frame.locator("canvas").click();
      for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft"]) await page.keyboard.press(key);
      await frame.getByRole("button", { name: "Restart", exact: true }).click();
      assert.equal(await count.innerText(), expected); assert.equal(await frame.locator("#score").innerText(), "0");
      assert.equal(denied, 0);
      await page.screenshot({ path: `${evidence}/${baseline ? "baseline" : "modified"}.png` });
      receipt.previews.push({ baseline, expectedInitialTiles: Number(expected), observedInitialTiles: initialObserved, restartCount: Number(await count.innerText()), browser: browser.version(), htmlSha256: sha(html), deniedRequests: denied });
      await context.close();
    }
    receipt.status = "passed";
  } catch (e) { receipt.status = "failed"; receipt.error = String(e); throw e; }
  finally { await writeFile(`${evidence}/receipt.json`, JSON.stringify(receipt, null, 2)); }
});
