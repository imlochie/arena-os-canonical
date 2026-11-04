import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

export function makeHomebrewNesRom() {
  // Original, hand-authored NROM. A turns the screen white while held;
  // each B press toggles a persistent blue/white progress bit in CPU RAM.
  // No third-party game code or assets are used.
  const header = Buffer.alloc(16);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0]).copy(header);
  const prg = Buffer.alloc(0x4000, 0xea);
  const code = [
    0x78, 0xd8, 0xa2, 0x40, 0x8e, 0x17, 0x40, 0xa2, 0xff, 0x9a, 0xe8,
    0x8e, 0x00, 0x20, 0x8e, 0x01, 0x20, 0x2c, 0x02, 0x20, 0x10, 0xfb,
    0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20, 0xa9,
    0x21, 0x8d, 0x07, 0x20, 0xa9, 0x08, 0x8d, 0x01, 0x20,
    0xa9, 0x00, 0x85, 0x00, 0x85, 0x01, // clear progress and previous B
  ];
  const labels = {};
  const fixups = [];
  const label = name => { labels[name] = code.length; };
  const branch = (opcode, name) => { code.push(opcode, 0); fixups.push({ at: code.length - 1, name }); };
  label("poll");
  code.push(
    0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40,
    0xad, 0x16, 0x40, 0x29, 0x01, 0x85, 0x02, // A -> $02
    0xad, 0x16, 0x40, 0x29, 0x01, // B
  );
  branch(0xf0, "rememberB"); // released
  code.push(0xa6, 0x01); // previous B
  branch(0xd0, "rememberB"); // held: do not toggle again
  code.push(0xa6, 0x00, 0xe8, 0x8a, 0x29, 0x01, 0x85, 0x00, 0xa9, 0x01);
  label("rememberB");
  code.push(0x85, 0x01, 0xa5, 0x00, 0x05, 0x02); // progress OR A
  branch(0xf0, "blue");
  code.push(0xa9, 0x30);
  branch(0xd0, "paint"); // $30 is nonzero
  label("blue");
  code.push(0xa9, 0x21);
  label("paint");
  code.push(
    0xaa, 0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20,
    0x8a, 0x8d, 0x07, 0x20, 0x4c, labels.poll & 0xff, 0x80,
  );
  for (const { at, name } of fixups) {
    const offset = labels[name] - (at + 1);
    assert(offset >= -128 && offset <= 127, `Branch to ${name} must fit`);
    code[at] = offset & 0xff;
  }
  Buffer.from(code).copy(prg);
  Buffer.from([0x00, 0x80, 0x00, 0x80, 0x00, 0x80]).copy(prg, 0x3ffa);
  return Buffer.concat([header, prg, Buffer.alloc(0x2000)]);
}

export async function checkNesInputs(page) {
  const checks = [];
  const canvas = page.locator('canvas[aria-label="NES game screen"]');
  await canvas.waitFor({ timeout: 10000 });
  // JSNES packs 0xBBGGRR, copied to little-endian canvas bytes. Wait for
  // palette $21 (idle), not an intermediate boot frame; $30 means A held.
  const idle = [0x3c, 0xab, 0xff];
  const pressed = [0xff, 0xff, 0xff];
  const colorIs = (color) => {
    const canvas = document.querySelector('canvas[aria-label="NES game screen"]');
    const pixel = canvas?.getContext("2d")?.getImageData(128, 120, 1, 1).data;
    return pixel && color.every((value, index) => pixel[index] === value);
  };
  const waitColor = async (color, message) => {
    await page.waitForFunction(colorIs, color, { timeout: 5000 })
      .catch(() => assert.fail(message));
  };
  const holdColor = async (message) => {
    // Several dozen frames: cleanup must not impose a short hold timeout.
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(100);
      assert(await page.evaluate(colorIs, pressed), message);
    }
  };
  await waitColor(idle, "The original ROM must finish booting to its idle color");
  await canvas.click();
  await page.keyboard.down("z");
  try {
    await waitColor(pressed, "Keyboard A must visibly affect the ROM");
    await holdColor("An uninterrupted keyboard hold must stay pressed");
  } finally {
    await page.keyboard.up("z");
  }
  await waitColor(idle, "Normal keyboard release must return to idle");
  checks.push("Normal keyboard A holds across many frames and releases visibly.");

  for (const event of ["blur", "visibilitychange", "pagehide"]) {
    await canvas.click();
    await page.keyboard.down("z");
    try {
      await waitColor(pressed, `A must be held before ${event}`);
      await page.evaluate((event) => {
        if (event === "visibilitychange") {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.dispatchEvent(new Event(event));
        } else {
          window.dispatchEvent(new Event(event));
        }
      }, event);
      // Deliberately withhold keyup until AFTER the visible release assertion.
      await waitColor(idle, `${event} must release A even when keyup is missed`);
      if (event === "visibilitychange") {
        await page.evaluate(() => {
          delete document.visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(120);
      assert(await page.evaluate(colorIs, idle), "Returning to the app must not reassert an old hold");
    } finally {
      await page.keyboard.up("z");
      if (event === "visibilitychange") await page.evaluate(() => { delete document.visibilityState; });
    }
    // A fresh down must work after every interrupted hold.
    await page.keyboard.down("z");
    await waitColor(pressed, `Keyboard must work again after ${event}`);
    await page.keyboard.up("z");
    await waitColor(idle, `Fresh keyup after ${event} must release A`);
    checks.push(`Simulated ${event} releases A without keyup, stays released on return, and accepts a fresh press.`);
  }

  const button = page.getByRole("button", { name: "A", exact: true });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await button.evaluate((element) => {
    element.dataset.cancels = "0";
    element.dataset.lostCaptures = "0";
    element.addEventListener("pointerdown", event => { element.dataset.pointerId = String(event.pointerId); });
    element.addEventListener("pointercancel", () => { element.dataset.cancels = String(Number(element.dataset.cancels) + 1); });
    element.addEventListener("lostpointercapture", () => { element.dataset.lostCaptures = String(Number(element.dataset.lostCaptures) + 1); });
  });
  const startTouch = async () => {
    await button.scrollIntoViewIfNeeded();
    const bounds = await button.boundingBox();
    assert(bounds, "A must be visible for real touch input");
    const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    assert(await button.evaluate((element, point) => element === document.elementFromPoint(point.x, point.y), point),
      "The touch must hit A, not an overlay");
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await waitColor(pressed, "Real touch A must visibly affect the ROM");
  };
  const endTouch = type => session.send("Input.dispatchTouchEvent", { type, touchPoints: [] });
  try {
    await canvas.click();
    await startTouch();
    await holdColor("An uninterrupted touch hold must stay pressed");
    await endTouch("touchEnd");
    await waitColor(idle, "Normal touch release must return to idle");
    checks.push("Real Chromium touch A holds across many frames and releases visibly.");

    await startTouch();
    await endTouch("touchCancel");
    await page.waitForFunction(
      () => Number(document.querySelector("button[data-cancels]")?.dataset.cancels) === 1,
      null,
      { timeout: 5000 },
    );
    assert.equal(await button.getAttribute("data-cancels"), "1", "The browser must deliver a real pointercancel");
    await waitColor(idle, "Touch cancellation must release A without pointerup");
    checks.push("A real CDP touchCancel delivers pointercancel and visibly releases A.");

    // Use a native mouse pointer for explicit capture loss. Real touch cancel
    // above separately covers the browser's cancelled-gesture path.
    await button.hover();
    await page.mouse.down();
    await waitColor(pressed, "Captured pointer A must visibly affect the ROM");
    const lostBefore = Number(await button.getAttribute("data-lost-captures"));
    await button.evaluate(element => element.releasePointerCapture(Number(element.dataset.pointerId)));
    // Capture changes are processed by the next native pointer event.
    const bounds = await button.boundingBox();
    await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + bounds.height / 2);
    await page.waitForFunction((before) => Number(document.querySelector('button[data-lost-captures]')?.dataset.lostCaptures) > before, lostBefore, { timeout: 5000 });
    await waitColor(idle, "Losing pointer capture must release A without pointerup");
    await page.mouse.up();
    checks.push("Native mouse lostpointercapture visibly releases A before pointerup.");

    await canvas.click();
    await page.keyboard.down("z");
    await waitColor(pressed, "Keyboard must hold A before overlapping touch");
    await startTouch();
    await endTouch("touchCancel");
    await holdColor("Cancelling touch must not release A still held by the keyboard");
    await page.keyboard.up("z");
    await waitColor(idle, "The final input owner releasing must return to idle");

    await startTouch();
    await page.keyboard.down("z");
    await page.keyboard.up("z");
    await holdColor("Keyboard release must not release A still held by touch");
    await endTouch("touchEnd");
    await waitColor(idle, "Final touch release must return to idle");
    checks.push("Overlapping keyboard/touch holds remain pressed until their final owner releases.");

    await startTouch();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await waitColor(idle, "App blur must release a touch whose end may never arrive");
    await endTouch("touchCancel");
    await startTouch();
    await endTouch("touchEnd");
    await waitColor(idle, "Touch must remain usable after app blur and a late cancellation");
    checks.push("Simulated app blur clears a held touch and late cancellation does not block the next touch.");
  } finally {
    await page.mouse.up();
    await page.keyboard.up("z");
    await endTouch("touchCancel").catch(() => {});
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.detach();
  }
  return checks;
}

export async function checkNesSaves(page, name) {
  const canvas = page.locator('canvas[aria-label="NES game screen"]');
  const blue = [0x3c, 0xab, 0xff];
  const white = [0xff, 0xff, 0xff];
  const colorIs = color => {
    const pixel = document.querySelector('canvas[aria-label="NES game screen"]')
      ?.getContext("2d")?.getImageData(128, 120, 1, 1).data;
    return pixel && color.every((value, index) => pixel[index] === value);
  };
  const waitStableColor = async (color, message) => {
    await page.waitForFunction(colorIs, color, { timeout: 10000 }).catch(() => assert.fail(message));
    // Do not accept a single stale framebuffer or a state tied to a held key.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(100);
      assert(await page.evaluate(colorIs, color), message);
    }
  };
  const toggleProgress = async (color, message) => {
    await canvas.click();
    await page.keyboard.down("x"); // NES B
    try {
      await page.waitForFunction(colorIs, color, { timeout: 5000 }).catch(() => assert.fail(message));
    } finally {
      await page.keyboard.up("x");
    }
    await waitStableColor(color, message);
  };
  await waitStableColor(blue, "The original fixture must initialize to blue before saving");
  await toggleProgress(white, "B must advance to white progress that survives button release");
  await page.getByRole("button", { name: "Save progress", exact: true }).click();
  await page.getByText("Progress saved on this browser.", { exact: true }).waitFor();
  await toggleProgress(blue, "Gameplay must diverge from the saved white progress");
  await page.getByRole("button", { name: "Restore save", exact: true }).click();
  await page.getByText("Saved progress restored.", { exact: true }).waitFor();
  await waitStableColor(white, "Restore save must visibly recover the saved white progress");
  // Leave an unsaved blue state, so reload cannot pass by preserving current
  // gameplay or by merely rebooting the ROM (whose initial screen is blue).
  await toggleProgress(blue, "Gameplay must diverge again before reloading");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByRole("button", { name: new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} NES homebrew`) }).waitFor();
  await waitStableColor(white, "Reload must automatically restore saved white progress, not unsaved blue or boot state");
  await toggleProgress(blue, "Restored gameplay must still respond to B after reload");
  await page.getByRole("button", { name: "Restore save", exact: true }).click();
  await page.getByText("Saved progress restored.", { exact: true }).waitFor();
  await waitStableColor(white, "Restore save after reload must recover the same saved white progress");
  return ["Original homebrew NES progress persists after B release; saving white, playing to blue, and restoring recovers white before and after reload. Reload also automatically restores white from browser storage."];
}

export async function runNesInputSmoke({ saveOnly = false } = {}) {
  const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const output = new URL("../generated-artifacts/arcade-nes-input/", import.meta.url);
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
  try {
    await page.goto(`${process.env.TEST_BASE_URL || "http://localhost:80"}/arcade`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: "Import and emulate" }).click();
    await page.getByLabel(/I own this game or have permission to use and play it/).check();
    await page.locator('input[accept=".nes,application/octet-stream"]').setInputFiles({
      name: "original-input-lifecycle.nes", mimeType: "application/octet-stream", buffer: makeHomebrewNesRom(),
    });
    const checks = saveOnly ? [] : await checkNesInputs(page);
    checks.push(...await checkNesSaves(page, "original-input-lifecycle.nes"));
    assert.deepEqual(errors, [], "The input checks must not crash the app");
    await page.screenshot({ path: new URL("passed.jpg", output).pathname });
    await writeFile(new URL("report.json", output), JSON.stringify({ passed: true, checks }, null, 2));
    console.log(checks.join("\n"));
  } catch (error) {
    console.error("Browser errors:", errors);
    await page.screenshot({ path: new URL("failure.jpg", output).pathname });
    throw error;
  } finally {
    await browser.close();
  }
}
