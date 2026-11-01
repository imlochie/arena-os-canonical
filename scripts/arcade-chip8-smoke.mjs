import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { classicFixture, superChipFixture } from "./fixtures/chip8-homebrew.mjs";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const output = new URL("../generated-artifacts/arcade-chip8/", import.meta.url);
await mkdir(output, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
await context.addInitScript(() => {
  if (window === window.top) {
    localStorage.setItem("af_local_mode", "1");
    localStorage.setItem("af_ephemeral", "0");
  }
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const canvas = page.getByTestId("chip8-player").locator("canvas");
const checks = [];
const pixels = () => canvas.evaluate(element => {
  const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
  const lit = [];
  for (let i = 0; i < data.length; i += 4) if (data[i] === 96) lit.push(i / 4);
  return { width: element.width, height: element.height, lit };
});
const waitPixels = async predicate => {
  for (let i = 0; i < 80; i++) {
    const result = await pixels();
    if (predicate(result)) return result;
    await page.waitForTimeout(50);
  }
  throw new Error("Expected framebuffer change did not appear");
};
const openImports = async () => {
  await page.goto(`${base}/arcade`);
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByTestId("input-chip8-rom").waitFor({ state: "attached" });
};
const key = async value => {
  await canvas.click();
  await page.keyboard.press(value, { delay: 90 });
  await page.waitForTimeout(100);
};
const touch = async value => {
  const button = page.getByRole("button", { name: `CHIP-8 key ${value}`, exact: true });
  await button.scrollIntoViewIfNeeded();
  const bounds = await button.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
  await page.waitForTimeout(100);
};

try {
  await openImports();
  const rights = page.getByLabel(/I own this game or have permission to use and play it/);
  await rights.check();
  await page.getByTestId("input-chip8-rom").setInputFiles({
    name: "original-classic.ch8", mimeType: "application/octet-stream", buffer: classicFixture(),
  });
  await page.getByText(/Running classic CHIP-8/).waitFor();
  await key("2");
  const classic = await waitPixels(p => p.width === 64 && p.lit.length > 0);
  checks.push("classic original fixture draws after keyboard input");

  // Saving before switching games also exercises the existing classic storage key.
  await page.getByTestId("input-chip8-rom").setInputFiles({
    name: "original-super.sc8", mimeType: "application/octet-stream", buffer: superChipFixture(),
  });
  await page.getByTestId("chip8-player").filter({ has: page.locator('[data-resolution="128×64"]') }).waitFor();
  const high = await waitPixels(p => p.width === 128 && p.lit.length === 60);
  assert.equal(Math.min(...high.lit), 4 * 128 + 4);
  checks.push("explicit .sc8 dialect boots a real 16×16 high-resolution sprite");
  await touch("2");
  await waitPixels(p => Math.min(...p.lit) === 4 * 128 + 8);
  await key("q"); // physical Q = hexadecimal keypad 4
  await waitPixels(p => Math.min(...p.lit) === 4 * 128 + 4);
  await touch("8");
  const moved = await waitPixels(p => Math.min(...p.lit) === 6 * 128 + 4);
  checks.push("touch labels and keyboard map correctly; horizontal/down scrolling moves four/two pixels once per key");
  await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith("arenaforge.schip-state.v2:")), null, { timeout: 7000 });
  await openImports();
  await page.getByText(/Progress restored from this browser/).waitFor();
  const restored = await pixels();
  assert.deepEqual(restored, moved);
  checks.push("Super-CHIP high-resolution scroll state survives reload without changing identity");
  await key("x"); // hexadecimal keypad 0 -> low-resolution mode
  await waitPixels(p => p.width === 64 && p.height === 32 && p.lit.length === 60);
  await key("1");
  await waitPixels(p => p.width === 128 && p.height === 64 && p.lit.length === 60);
  checks.push("live low/high mode switches resize the actual canvas and redraw");
  await key("v"); // hexadecimal keypad F -> exit
  await page.getByText(/Program exited normally/).waitFor();
  await openImports();
  await page.getByText(/Program exited normally/).waitFor();
  checks.push("normal exit is saved and remains halted after reload");
  const savedRpl = () => page.evaluate(() => Object.keys(localStorage)
    .filter(k => k.startsWith("arenaforge.schip-state.v2:"))
    .map(k => JSON.parse(localStorage.getItem(k)).rpl[6]));
  assert.deepEqual(await savedRpl(), [42]);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Restart program", exact: true }).click();
  await page.getByText(/Progress restored from this browser/).waitFor();
  await waitPixels(p => p.width === 128 && Math.min(...p.lit) === 4 * 128 + 4);
  assert.deepEqual(await savedRpl(), [42]);
  checks.push("confirmed restart replays an exited program without losing its per-game RPL flags");
  await page.getByRole("button", { name: /original-classic.ch8/ }).click();
  await page.getByText(/Progress restored from this browser/).waitFor();
  assert.deepEqual(await pixels(), classic);
  checks.push("legacy classic progress and 64×32 behavior remain intact after Super-CHIP/reload");

  // Explicit opt-in for ambiguous .ch8 files; the .sc8 case above never changed the default.
  await rights.check();
  await page.getByRole("combobox", { name: "CHIP-8 program dialect" }).selectOption("schip");
  await page.getByTestId("input-chip8-rom").setInputFiles({
    name: "original-super-ambiguous.ch8", mimeType: "application/octet-stream", buffer: superChipFixture(),
  });
  await waitPixels(p => p.width === 128 && p.lit.length === 60);
  checks.push("ambiguous .ch8 program runs as Super-CHIP only through explicit dialect selection");
  if (process.argv.includes("--chip8-backup-only")) {
    const panel = page.getByTestId("chip8-progress-backup");
    await panel.locator("summary").click();
    const downloaded = page.waitForEvent("download");
    await panel.getByTestId("button-export-chip8-snapshot").click();
    const backupText = await readFile(await (await downloaded).path(), "utf8");
    const backup = JSON.parse(backupText);
    assert.equal(backup.dialect, "schip");
    assert.equal(backup.runtimeVersion, 2);
    const exportedPixels = await pixels();
    await touch("8");
    const newerPixels = await waitPixels(p => Math.min(...p.lit) === 6 * 128 + 4);
    const upload = text => panel.getByTestId("input-chip8-snapshot").setInputFiles({ name: "fixture.arena-snapshot.json", mimeType: "application/json", buffer: Buffer.from(text) });
    await upload(backupText);
    await panel.getByTestId("chip8-snapshot-preview").waitFor();
    assert.equal(await panel.getByTestId("button-restore-chip8-snapshot").isDisabled(), true);
    await touch("8");
    assert.deepEqual(await pixels(), newerPixels, "review pauses live gameplay");
    await panel.getByRole("button", { name: "Cancel snapshot restore", exact: true }).click();
    assert.deepEqual(await pixels(), newerPixels);
    for (const invalid of ["bad JSON", JSON.stringify({ ...backup, version: 99 }),
      JSON.stringify({ ...backup, runtimeVersion: 99 }), JSON.stringify({ ...backup, romSha256: "a".repeat(64) }),
      JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, registers: [] } }), " ".repeat(256 * 1024 + 1)]) {
      await upload(invalid);
      await panel.getByRole("alert").waitFor();
      assert.equal(await panel.getByTestId("chip8-snapshot-preview").count(), 0);
      assert.deepEqual(await pixels(), newerPixels);
    }
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (window.__failChipRestore && key.startsWith("arenaforge.schip-state.v2:")) throw new DOMException("Injected CHIP-8 quota failure", "QuotaExceededError");
        return set.call(this, key, value);
      };
    });
    await upload(backupText);
    await panel.getByTestId("chip8-snapshot-preview").waitFor();
    await page.evaluate(() => { window.__failChipRestore = true; });
    await panel.getByRole("checkbox").check();
    await panel.getByTestId("button-restore-chip8-snapshot").click();
    await panel.getByRole("alert").getByText(/Injected CHIP-8 quota failure/).waitFor();
    assert.deepEqual(await pixels(), newerPixels);
    await page.evaluate(() => { window.__failChipRestore = false; });
    await panel.getByTestId("button-restore-chip8-snapshot").click();
    await panel.getByText(/Snapshot restored locally/).waitFor();
    await waitPixels(p => JSON.stringify(p) === JSON.stringify(exportedPixels));
    assert.deepEqual(await savedRpl(), [42, 42]);
    await openImports();
    assert.deepEqual(await pixels(), exportedPixels);
    checks.push("local snapshot export, pause/cancel, version/ROM/state rejection and failed-storage retry preserve visible progress; confirmed restore survives reload and retains RPL flags");
    await touch("8");
    const portablePixels = await waitPixels(p => Math.min(...p.lit) === 6 * 128 + 4);
    await panel.locator("summary").click();
    const portableDownload = page.waitForEvent("download");
    await panel.getByTestId("button-export-chip8-snapshot").click();
    const portableText = await readFile(await (await portableDownload).path(), "utf8");
    await page.getByRole("button", { name: /original-classic.ch8/ }).click();
    const classicPanel = page.getByTestId("chip8-progress-backup");
    await classicPanel.locator("summary").click();
    await classicPanel.getByTestId("input-chip8-snapshot").setInputFiles({ name: "wrong-profile.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
    await classicPanel.getByRole("alert").getByText(/runtime profile/).waitFor();
    assert.deepEqual(await pixels(), classic);
    checks.push("Super-CHIP snapshot is rejected by the classic player without replacing its existing progress");
    const otherContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const other = await otherContext.newPage();
    other.on("pageerror", error => errors.push(error.message));
    await other.goto(`${base}/arcade`);
    await other.getByRole("tab", { name: "Import and emulate" }).click();
    await other.getByLabel(/I own this game or have permission to use and play it/).check();
    await other.getByTestId("input-chip8-rom").setInputFiles({ name: "matching-copy.sc8", mimeType: "application/octet-stream", buffer: superChipFixture() });
    const otherCanvas = other.getByTestId("chip8-player").locator("canvas");
    await other.getByTestId("chip8-player").locator('canvas[data-resolution="128×64"]').waitFor();
    const otherPanel = other.getByTestId("chip8-progress-backup");
    await otherPanel.locator("summary").click();
    // Use an actual second download with visibly moved progress, not a
    // fabricated state or the fixture's identical fresh screen.
    await otherPanel.getByTestId("input-chip8-snapshot").setInputFiles({ name: "copy.arena-snapshot.json", mimeType: "application/json", buffer: Buffer.from(portableText) });
    await otherPanel.getByText(/new import identity with an exact ROM match/).waitFor();
    assert.equal(await otherPanel.getByTestId("button-restore-chip8-snapshot").isDisabled(), true);
    await otherPanel.getByRole("checkbox").check();
    await otherPanel.getByTestId("button-restore-chip8-snapshot").click();
    await otherPanel.getByText(/Snapshot restored locally/).waitFor();
    const otherLit = () => otherCanvas.evaluate(element => {
      const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
      return Array.from({ length: data.length / 4 }, (_, i) => i).filter(i => data[i * 4] === 96);
    });
    await other.waitForTimeout(80);
    assert.deepEqual(await otherLit(), portablePixels.lit);
    const otherStates = await other.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith("arenaforge.schip-state.v2:")).map(k => [k, JSON.parse(localStorage.getItem(k))])));
    assert.equal(Object.keys(otherStates).length, 1);
    assert.equal(Object.keys(otherStates)[0].endsWith(backup.gameId), false);
    assert.equal(Object.values(otherStates)[0].rpl[6], 42);
    await other.reload();
    await other.getByRole("tab", { name: "Import and emulate" }).click();
    await other.getByText(/Progress restored from this browser/).waitFor();
    assert.deepEqual(await otherLit(), portablePixels.lit);
    await other.getByTestId("chip8-progress-backup").locator("summary").click();
    await other.screenshot({ path: new URL("snapshot-mobile.png", output).pathname });
    await otherContext.close();
    checks.push("fresh mobile-width browser accepts a new import only by exact ROM/profile match and confirmation; restored framebuffer and RPL state persist after reload");
  }
  assert.deepEqual(errors, []);
  await page.screenshot({ path: new URL("player.png", output).pathname, fullPage: false });
  await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks, errors, modelCallTested: false }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(new URL("failure.txt", output), `${error.stack}\n${await page.locator("body").innerText()}`);
  throw error;
} finally {
  await browser.close();
}
