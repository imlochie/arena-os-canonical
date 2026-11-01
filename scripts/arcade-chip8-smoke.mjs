import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
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
