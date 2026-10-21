// Real Chromium + production sandbox/routes/Next page. Model replies are
// SCRIPTED HTTP fixtures: no live inference or arbitrary creative-quality claim.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { validateGameRuntime, consumeFreshRuntimeCheck } from "../../src/lib/games/runtime-validation.ts";
import { sandboxGameDocument } from "../../src/lib/games/sandbox.ts";
import { generateGameOffline, validateGameCode } from "../../src/lib/games/index.ts";
import { missionPostgres } from "../helpers/mission-postgres.ts";
import { photographyGame, crashingGame, inertGame, networkGame, navigationGame } from "../fixtures/arcade-game.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const evidence = path.resolve(process.env.ARENA_ARCADE_EVIDENCE_DIR ?? ".data/arcade-acceptance");
await mkdir(evidence, { recursive: true });
const receipts = { scope: "Real browser/production execution with scripted model HTTP replies. Not live inference, arbitrary prompt fidelity, subjective fun, or Electron acceptance.", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), probes: [] };
const persist = () => writeFile(path.join(evidence, "receipt.json"), JSON.stringify(receipts, null, 2));

test("browser contract rejects static-valid crashes, inertia and sandbox violations; known templates and custom game execute", { timeout: 90000 }, async () => {
  try {
    for (const prompt of ["snake", "breakout", "2048"]) {
      const result = await validateGameRuntime(generateGameOffline(prompt).code);
      receipts.probes.push({ label: `known-template-${prompt}`, ...result }); assert.equal(result.ok, true, result.issues.join("; "));
    }
    for (const [label, code] of Object.entries({ photographyGame, crashingGame, inertGame, networkGame, navigationGame })) {
      assert.equal(validateGameCode(code).ok, true, `${label} must pass static checks so the browser is genuinely exercised`);
      const result = await validateGameRuntime(code); receipts.probes.push({ label, ...result });
      assert.equal(result.ok, label === "photographyGame", result.issues.join("; "));
      if (result.ok) {
        assert.equal(consumeFreshRuntimeCheck(code, JSON.parse(JSON.stringify(result))), false, "Serialized/client reports cannot forge a publication proof");
        assert.equal(consumeFreshRuntimeCheck(code, result), true);
        assert.equal(consumeFreshRuntimeCheck(code, result), false, "Fresh proof is one-use");
      }
    }
    const previous = process.env.ARENA_ARCADE_CHROMIUM_PATH;
    try {
      process.env.ARENA_ARCADE_CHROMIUM_PATH = path.join(tmpdir(), "deliberately-missing-arena-chromium");
      const unavailable = await validateGameRuntime(photographyGame);
      assert.equal(unavailable.status, "unavailable"); assert.equal(unavailable.ok, false);
      receipts.probes.push({ label: "missing-runtime-honest-unavailability", ...unavailable });
    } finally {
      if (previous === undefined) delete process.env.ARENA_ARCADE_CHROMIUM_PATH; else process.env.ARENA_ARCADE_CHROMIUM_PATH = previous;
    }
  } finally { await persist(); }
});

test("actual /arcade page generates, browser-repairs, plays, retains failed revisions and reopens the last good game", { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "arena-arcade-ui-"));
  let pg, browser, page, server, provider, serverLog = "", escapedRequests = 0;
  const modelCalls = [];
  t.after(async () => {
    if (page) await page.context().tracing.stop({ path: path.join(evidence, "browser-trace.zip") }).catch(() => {});
    await browser?.close();
    if (server) { server.kill("SIGTERM"); await Promise.race([new Promise(resolve => server.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (server.exitCode === null) server.kill("SIGKILL"); }
    if (provider) await new Promise(resolve => provider.close(resolve));
    await pg?.close(); await rm(root, { recursive: true, force: true });
    await writeFile(path.join(evidence, "next-server.log"), serverLog); await persist();
  });
  try {
    pg = await missionPostgres();
    provider = createServer(async (req, res) => {
      if (req.url !== "/v1/chat/completions") { escapedRequests++; res.writeHead(404).end(); return; }
      let text = ""; for await (const chunk of req) text += chunk;
      const input = JSON.parse(text), prompt = input.messages.at(-1).content;
      const repairing = prompt.includes("previous attempt failed validation");
      const failAlways = prompt.includes("ALWAYS_BROKEN");
      modelCalls.push({ requestedModel: input.model, repairing, failAlways });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: failAlways || !repairing ? crashingGame : photographyGame } }] }));
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
    const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      env: { ...process.env, DATABASE_URL: pg.url, WAVEYARD_STORAGE_DIR: root, ARENA_DESKTOP_MODE: "1", WAVEYARD_LOCAL_WORKER: "0", TURBOAGENT_URL: providerUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverLog = (serverLog + chunk).slice(-100000); });
    await expect.poll(async () => { try { return (await fetch(`${origin}/arcade`)).status; } catch { return 0; } }, { timeout: 45000 }).toBe(200);
    browser = await chromium.launch({ executablePath: process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined, headless: true, args: process.env.ARENA_ARCADE_CI_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [] });
    page = await browser.newPage(); page.setDefaultTimeout(20000);
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    await page.addInitScript(url => { localStorage.setItem("af_url_turboagent", url); localStorage.setItem("af_local_mode", "0"); localStorage.setItem("af_ephemeral", "0"); }, providerUrl);
    // Explicit test-model pin, no production fixture switch or mocked API reply.
    await page.route("**/api/arcade/forge", async route => {
      const body = route.request().postDataJSON(); body.modelId = "turboagent-7b";
      await route.continue({ postData: JSON.stringify(body) });
    });
    const document = await page.goto(`${origin}/arcade`);
    assert.match(document.headers()["content-security-policy"], /frame-src 'none'/);
    const prompt = "a ghost photography game where exposure determines the score REPAIR_ONCE";
    await page.getByPlaceholder(/Describe any game/).fill(prompt);
    const generatedResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/forge` && r.request().method() === "POST");
    await page.getByRole("button", { name: "🎮 Forge game", exact: true }).click();
    const generatedHttp = await generatedResponse, generated = await generatedHttp.json();
    assert.equal(generatedHttp.status(), 200, generated.error);
    assert.equal(generated.repairsUsed, 1); assert.equal(generated.runtimeValidation.ok, true);
    assert.equal(generated.code, photographyGame);
    assert.deepEqual(modelCalls.map(call => call.repairing), [false, true]);
    const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
    await frame.getByRole("button", { name: "Start", exact: true }).click();
    await expect(frame.locator("#state")).toHaveText("playing");
    await expect.poll(async () => Number(await frame.locator("#clock").innerText())).toBeGreaterThan(0.05);
    await page.keyboard.press("ArrowRight"); await expect(frame.locator("#camera")).toHaveText("80");
    await page.keyboard.press("p"); await expect(frame.locator("#state")).toHaveText("paused");
    const paused = await frame.locator("#clock").innerText(); await page.waitForTimeout(150);
    assert.equal(await frame.locator("#clock").innerText(), paused);
    await page.keyboard.press("p");
    await frame.locator("canvas").click({ position: { x: 100, y: 200 } });
    await expect(frame.locator("#score")).toHaveText("50");
    await page.keyboard.press("Space"); await expect(frame.locator("#state")).toHaveText("won");
    await page.keyboard.press("r"); await expect(frame.locator("#score")).toHaveText("0");
    await expect(frame.locator("#state")).toHaveText("lost", { timeout: 5000 });
    const savedDocument = await page.locator("iframe[sandbox='allow-scripts']").getAttribute("srcdoc");
    await page.getByPlaceholder(/Describe any game/).fill("a ghost photography game ALWAYS_BROKEN");
    const failedResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/forge` && r.request().method() === "POST");
    await page.getByRole("button", { name: "🎮 Forge game", exact: true }).click();
    const failedHttp = await failedResponse, failed = await failedHttp.json();
    assert.equal(failedHttp.status(), 422);
    assert.equal(failed.draft.code, crashingGame); assert.equal(failed.draft.runtimeValidation.ok, false);
    assert.equal(await page.locator("iframe[sandbox='allow-scripts']").getAttribute("srcdoc"), savedDocument);
    const retainedHttp = await page.request.get(`${origin}/api/arcade/attempts?id=${failed.attemptId}`);
    assert.equal(retainedHttp.status(), 200); const retained = await retainedHttp.json();
    assert.equal(retained.attempt.value.state, "failed"); assert.equal(retained.code, crashingGame);
    const download = await page.request.get(`${origin}/api/arcade/attempts?id=${failed.attemptId}&download=1`);
    assert.equal(download.status(), 200); assert.equal(await download.text(), crashingGame);
    const bypass = await page.request.post(`${origin}/api/arcade`, { data: { prompt: "claimed verified but actually broken", clientCode: crashingGame, gameType: "custom", engine: "verified" } });
    assert.equal(bypass.status(), 422, "client-side provenance claims cannot bypass the browser gate");
    const library = await (await page.request.get(`${origin}/api/arcade?full=1`)).json();
    assert.equal(library.games.length, 1); assert.equal(library.games[0].id, generated.game.id);
    assert.equal(library.games[0].code, photographyGame);
    // Exercise the actual player sandbox with an obfuscated network attempt.
    const denied = [];
    page.on("request", r => { if (r.url().includes("example.invalid")) denied.push(r.url()); });
    await page.locator("iframe[sandbox='allow-scripts']").evaluate((node, html) => { node.srcdoc = html; }, sandboxGameDocument(networkGame));
    await page.waitForTimeout(200);
    assert.equal(denied.length, 0); assert.equal(page.url(), `${origin}/arcade`);
    await page.reload();
    await page.getByRole("button").filter({ hasText: prompt }).click();
    await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveAttribute("srcdoc", savedDocument);
    await frame.getByRole("button", { name: "Start", exact: true }).click();
    await expect(frame.locator("#state")).toHaveText("playing");
    assert.equal(modelCalls.length, 4, "reopening is not generation");
    assert.equal(escapedRequests, 0);
    // A real user acquires the real MIT source through the actual Next route,
    // persists its provenance in Artifacts and downloads the actual patch.
    await page.getByText("Source workshop · supported MIT 2048 adapter", { exact: true }).click();
    const acquiredResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/source` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Acquire source and create patch", exact: true }).click();
    const acquiredHttp = await acquiredResponse, acquired = await acquiredHttp.json();
    assert.equal(acquiredHttp.status(), 200, acquired.error);
    assert.ok(acquired.artifactId); assert.equal(acquired.persistenceError, undefined);
    assert.equal(acquired.bundle.revision, "478b6ec346e3787f589e4af751378d06ded4cbbc");
    assert.equal(acquired.bundle.license.spdx, "MIT");
    assert.match(acquired.bundle.verification.runtime, /not run/);
    await expect(page.getByText(`Saved Artifact ${acquired.artifactId}`, { exact: true })).toBeVisible();
    const patchDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download patch", exact: true }).click();
    const downloaded = await patchDownload;
    assert.equal(await readFile(await downloaded.path(), "utf8"), acquired.bundle.modification.patch);
    await page.getByRole("button", { name: "Play source preview (unverified)", exact: true }).click();
    const sourcePlayer = page.frameLocator('iframe[title="2048 source preview"]');
    await expect(sourcePlayer.locator("#tile-count")).toHaveText("3");
    await sourcePlayer.locator("canvas").click(); await page.keyboard.press("ArrowRight");
    await sourcePlayer.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(sourcePlayer.locator("#tile-count")).toHaveText("3");
    await writeFile(path.join(evidence, "source-ui-package.json"), JSON.stringify(acquired.bundle, null, 2));
    receipts.sourceWorkshop = { status: "passed", actualUi: true, artifactId: acquired.artifactId, upstreamRevision: acquired.bundle.revision, sourceFiles: acquired.bundle.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })), patchSha256: sha(acquired.bundle.modification.patch), actualOpaqueSourcePreview: { initialTiles: 3, restartedTiles: 3 }, acquisitionRuntimeClaim: "not run; subsequent actual UI play is recorded here, separate original/modded adapter acceptance still required" };
    receipts.product = { status: "passed", actualNextPage: "/arcade", loopbackDesktopTrustOnlyNotElectron: true, scriptedProvider: true, modelCalls, gameId: generated.game.id, successfulAttemptId: generated.attemptId, failedAttemptId: failed.attemptId, codeSha256: sha(photographyGame), failedDraftSha256: sha(crashingGame), behaviours: ["camera keyboard movement", "real clock advancement", "pause freezes clock", "pointer photo scores", "space photo wins", "restart resets", "timeout loses", "bounded runtime repair", "failed child cannot replace saved game", "durable exact failed draft download", "client bypass rejected", "actual player CSP blocks obfuscated fetch", "saved-game reopening without inference"] };
    await page.screenshot({ path: path.join(evidence, "arcade-completed.png"), fullPage: true });
  } catch (error) {
    receipts.product = { status: "failed", error: String(error), modelCalls };
    await page?.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  }
});
