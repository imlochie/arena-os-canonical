// Real source, real Next UI, owned PostgreSQL, immutable object/revision storage
// and fresh opaque browser frames. No mocked persistence or model inference.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";
import { missionPostgres } from "../helpers/mission-postgres.ts";
import { validate2048Bundle, preview2048Mod } from "../../src/lib/games/source-2048.ts";
import { verify2048Rule } from "../../src/lib/games/source-rule-validation.ts";

const sha = x => createHash("sha256").update(x).digest("hex");
const evidence = path.resolve(".data/arcade-source");
test("actual UI modifies real spawning, verifies, saves and reopens immutable gameplay; failures preserve the working revision", { timeout: 180000 }, async t => {
  await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), "arena-rule-reopen-"));
  const receipt = { status: "running", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktreeClean: !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), humanReview: "OPEN: product owner must inspect selected rule, visible gameplay difference, find/reopen and truthful verification labels", scope: "Supported guaranteed-four spawning, not general modding, live model quality, catalogue publication, Electron or in-progress board persistence", uiObservations: [] };
  let pg, server, browser, page, log = "";
  t.after(async () => {
    if (page) await page.context().tracing.stop({ path: `${evidence}/rule-reopen-trace.zip` }).catch(() => {});
    await browser?.close();
    if (server) { server.kill("SIGTERM"); await Promise.race([new Promise(r => server.once("exit", r)), new Promise(r => setTimeout(r, 3000))]); if (server.exitCode === null) server.kill("SIGKILL"); }
    await pg?.close(); await rm(root, { recursive: true, force: true });
    await writeFile(`${evidence}/rule-next.log`, log);
    await writeFile(`${evidence}/rule-reopen-receipt.json`, JSON.stringify(receipt, null, 2));
  });
  try {
    pg = await missionPostgres();
    const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], { env: { ...process.env, DATABASE_URL: pg.url, WAVEYARD_STORAGE_DIR: root, ARENA_DESKTOP_MODE: "1", WAVEYARD_LOCAL_WORKER: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-100000); });
    await expect.poll(async () => { try { return (await fetch(`${origin}/arcade`)).status; } catch { return 0; } }, { timeout: 45000 }).toBe(200);
    browser = await chromium.launch({ executablePath: process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined, headless: true, chromiumSandbox: !(process.env.CI === "true" && process.env.ARENA_ARCADE_CI_NO_SANDBOX === "1"), args: ["--disable-dev-shm-usage"] });
    page = await browser.newPage(); page.setDefaultTimeout(20000);
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    // Deterministic observations only. Production source/package retain normal
    // Math.random; no verifier/test-only controls are saved into the game.
    await page.addInitScript(() => {
      if (location.href === "about:srcdoc") Math.random = () => .01;
      else { localStorage.setItem("af_local_mode", "0"); localStorage.setItem("af_ephemeral", "0"); }
    });
    await page.goto(`${origin}/arcade`);
    await page.getByText("Source workshop · supported MIT 2048 adapter", { exact: true }).click();
    await page.getByLabel("Initial tiles", { exact: true }).fill("3");
    await page.getByLabel("Spawning rule", { exact: true }).selectOption("guaranteed-four");
    const createdResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/source` && r.request().method() === "POST");
    await page.getByRole("button", { name: "Acquire source and create patch", exact: true }).click();
    const createdHttp = await createdResponse, created = await createdHttp.json();
    assert.equal(createdHttp.status(), 200, created.error); assert.equal(created.artifactId, undefined);
    await expect(page.getByText("Generated but not saved; browser execution unverified.", { exact: true })).toBeVisible();
    const bundle = validate2048Bundle(created.bundle);
    assert.equal(bundle.modification.spawnRule, "guaranteed-four");
    assert.ok(bundle.modification.content.includes("    var value = 4;"));
    assert.equal(bundle.files.find(f => f.path === "js/game_manager.js").sha256, bundle.modification.originalSha256);
    assert.ok(!preview2048Mod(bundle).includes("Math.random ="));
    // Replay on disk, not a string-existence assertion.
    await mkdir(path.join(root, "js"));
    await writeFile(path.join(root, "js/game_manager.js"), bundle.files.find(f => f.path === "js/game_manager.js").content);
    execFileSync("git", ["apply", "--check", "-"], { cwd: root, input: bundle.modification.patch });
    execFileSync("git", ["apply", "-"], { cwd: root, input: bundle.modification.patch });
    assert.equal(await readFile(path.join(root, "js/game_manager.js"), "utf8"), bundle.modification.content);
    const tampered = structuredClone(bundle); tampered.modification.content += "\n// substituted";
    assert.throws(() => validate2048Bundle(tampered), /mismatch/);
    const wrongPin = structuredClone(bundle); wrongPin.revision = "unrecognized";
    assert.throws(() => validate2048Bundle(wrongPin), /identity/);
    await page.getByRole("button", { name: "Play source preview (unverified)", exact: true }).click();
    async function observe(label) {
      const frame = page.frameLocator('iframe[title="2048 source preview"]');
      await expect(frame.locator("#tile-count")).toHaveText("3");
      const board = async () => JSON.parse(await frame.locator("#board-values").textContent());
      const initial = await board();
      assert.deepEqual(initial.map(t => t.value), [4, 4, 4]);
      const before = initial.reduce((s, t) => s + t.value, 0);
      await frame.locator("canvas").click(); await page.keyboard.press("ArrowDown");
      const after = (await board()).reduce((s, t) => s + t.value, 0);
      assert.equal(after - before, 4, "actual keyboard move spawns four; merges conserve board sum");
      await frame.getByRole("button", { name: "Restart", exact: true }).click();
      assert.deepEqual((await board()).map(t => t.value), [4, 4, 4]);
      receipt.uiObservations.push({ label, before, after, spawnedValue: after - before, restartValues: (await board()).map(t => t.value) });
    }
    await observe("before-save");
    const savedResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/source` && r.request().postDataJSON()?.action === "save");
    await page.getByRole("button", { name: "Verify rule and save immutable game", exact: true }).click();
    const savedHttp = await savedResponse, saved = await savedHttp.json();
    assert.equal(savedHttp.status(), 200, JSON.stringify(saved));
    assert.equal(saved.runtime.status, "passed");
    assert.deepEqual(saved.runtime.observations.map(o => o.spawnedValue), [2, 4, 4, 4], "original .01/.95 rule is unchanged, modified always four");
    assert.equal(saved.runtime.sourceSha256, bundle.modification.modifiedSha256);
    assert.equal(saved.runtime.patchSha256, sha(bundle.modification.patch));
    await expect(page.getByText("Saved + browser-verified selected rule. Human review pending.", { exact: true })).toBeVisible();
    const downloadedResponse = await page.request.get(`${origin}${saved.artifactDownloadUrl}`); assert.equal(downloadedResponse.status(), 200);
    const downloaded = await downloadedResponse.text(), stored = JSON.parse(downloaded);
    assert.deepEqual(validate2048Bundle(stored), bundle); assert.deepEqual(stored.runtime, saved.runtime);
    const downloadedSha = sha(downloaded);
    // New page retrieval uses real owner-scoped Artifact listing+revision bytes.
    await page.reload();
    await page.getByText("Source workshop · supported MIT 2048 adapter", { exact: true }).click();
    const reopenedResponse = page.waitForResponse(r => r.url() === `${origin}/api/arcade/source` && r.request().postDataJSON()?.action === "reopen");
    await page.getByRole("button", { name: `Reopen ${saved.artifactId}`, exact: true }).click();
    const reopenedHttp = await reopenedResponse, reopened = await reopenedHttp.json();
    assert.equal(reopenedHttp.status(), 200, JSON.stringify(reopened));
    assert.equal(reopened.artifactId, saved.artifactId); assert.equal(reopened.revisionId, saved.revisionId);
    assert.deepEqual(reopened.bundle, bundle); assert.equal(reopened.runtime.status, "passed");
    await observe("after-reload-and-immutable-reopen");
    // Real invalid package rejected without write; unavailable runtime does not
    // masquerade as verification; bad reopen UI retains last working preview.
    const rejected = await page.request.post(`${origin}/api/arcade/source`, { data: { action: "save", bundle: tampered } });
    assert.equal(rejected.status(), 422);
    const foreign = await page.request.post(`${origin}/api/arcade/source`, { data: { action: "reopen", artifactId: "00000000-0000-4000-8000-000000000001", revisionId: saved.revisionId } });
    assert.equal(foreign.status(), 404);
    const metadataResponse = await page.request.get(`${origin}/api/artifacts/${saved.artifactId}`), metadata = (await metadataResponse.json()).artifact;
    assert.equal(metadata.currentRevisionId, saved.revisionId);
    // Actual owned-volume publication failure, not a fake 200 or mocked API:
    // retain the working directory, temporarily make its path a non-directory.
    await rename(path.join(root, "owners"), path.join(root, "owners-retained"));
    try {
      await writeFile(path.join(root, "owners"), "deliberate acceptance storage outage");
      const failedSave = await page.request.post(`${origin}/api/arcade/source`, { data: { action: "save", bundle } });
      assert.equal(failedSave.status(), 422);
    } finally {
      await rm(path.join(root, "owners"), { force: true });
      await rename(path.join(root, "owners-retained"), path.join(root, "owners"));
    }
    // A real corrupted immutable object must fail closed on reopening, without
    // overwriting the last acknowledged revision or the prior playable UI.
    const objectPath = path.join(root, "owners", sha(metadata.ownerId), "artifact-objects", `${metadata.contentObject.sha256}.bin`);
    const acknowledgedBytes = await readFile(objectPath);
    await writeFile(objectPath, "deliberately corrupted acceptance bytes");
    try {
      const failedReopen = page.waitForResponse(r => r.url() === `${origin}/api/arcade/source` && r.request().postDataJSON()?.action === "reopen");
      await page.getByRole("button", { name: `Reopen ${saved.artifactId}`, exact: true }).click();
      assert.equal((await failedReopen).status(), 422);
      await expect(page.getByText(/Failed attempts retained for inspection/)).toBeVisible();
    } finally { await writeFile(objectPath, acknowledgedBytes); }
    await observe("last-working-preview-after-corrupted-object-reopen");
    const oldPath = process.env.ARENA_ARCADE_CHROMIUM_PATH;
    try {
      process.env.ARENA_ARCADE_CHROMIUM_PATH = path.join(root, "missing-chromium");
      assert.equal((await verify2048Rule(bundle)).status, "unavailable");
    } finally { if (oldPath === undefined) delete process.env.ARENA_ARCADE_CHROMIUM_PATH; else process.env.ARENA_ARCADE_CHROMIUM_PATH = oldPath; }
    const again = await page.request.get(`${origin}${saved.artifactDownloadUrl}`);
    assert.equal(again.status(), 200); assert.equal(sha(await again.text()), downloadedSha);
    const library = await (await page.request.get(`${origin}/api/artifacts?kind=source-patch`)).json();
    assert.equal(library.artifacts.length, 1, "failed save cannot create/replace the acknowledged revision");
    receipt.status = "automated-passed-human-review-open";
    receipt.artifact = { id: saved.artifactId, revisionId: saved.revisionId, packageSha256: downloadedSha, sourceSha256: bundle.modification.modifiedSha256, patchSha256: sha(bundle.modification.patch), object: metadata.contentObject };
    receipt.serverBrowserReport = saved.runtime; receipt.reopenedBrowserReport = reopened.runtime;
    receipt.failureChecks = ["tampered patch rejected", "incompatible upstream rejected", "missing immutable revision returns 404", "real storage publication outage cannot replace acknowledged revision", "corrupt-object UI reopen fails closed and retains playable prior preview", "missing Chromium is unavailable", "saved immutable bytes unchanged"];
    await writeFile(`${evidence}/rule-saved-package.json`, downloaded);
    await page.screenshot({ path: `${evidence}/rule-reopened.png`, fullPage: true });
  } catch (error) {
    receipt.status = "failed"; receipt.error = String(error);
    await page?.screenshot({ path: `${evidence}/rule-failure.png`, fullPage: true }).catch(() => {});
    throw error;
  }
});
