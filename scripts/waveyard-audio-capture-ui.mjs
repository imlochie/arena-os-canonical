import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    if (window === window.top && localStorage.getItem("af_local_mode") === null) {
      localStorage.setItem("af_local_mode", "1");
    }
  });

  let optionsRequests = 0;
  let startPayload;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await context.route("**/api/library/audio-capture", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      optionsRequests += 1;
      const devices = optionsRequests === 1
        ? [
            { id: "speakers-a", name: "Speakers A", isDefault: true },
          ]
        : [{ id: "speakers-b", name: "Speakers B", isDefault: true }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available: true,
          devices,
          storage: { availableBytes: 8 * 1024 ** 3, reserveBytes: 1024 ** 3, canRecord: true },
          ...(optionsRequests >= 3 ? {
            recoveries: [{
              sessionId: "capture-ui-test",
              title: "Authorized capture test",
              artist: "Local artist",
              createdAt: "2026-11-01T00:00:00.000Z",
            }],
          } : {}),
        }),
      });
      return;
    }

    startPayload = JSON.parse(request.postData() ?? "{}");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "capture-ui-test",
        status: "recording",
        startedAt: new Date().toISOString(),
        format: { sampleRate: 48_000, channels: 2, bitsPerSample: 16, blockAlign: 4 },
      }),
    });
  });

  await context.route("**/api/library/audio-capture/capture-ui-test", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Capture session not found." }),
    });
  });

  await page.goto(`${base}/waveyard`, { waitUntil: "domcontentloaded" });
  const deviceSelect = page.getByLabel("Windows playback device");
  await deviceSelect.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('select[aria-label="Windows playback device"]')?.value === "speakers-a");

  await page.getByRole("button", { name: "Refresh devices" }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Windows playback device"]')?.value === "speakers-b");
  await page.getByLabel("Track title").fill("Authorized capture test");
  await page.getByRole("checkbox", { name: /authorized to record this audio/i }).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByText("Recording ·", { exact: false }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Recover to library" }).waitFor({ timeout: 10000 });

  assert.equal(optionsRequests, 3, "the UI refreshed device state and reloaded preserved recordings after a missing session");
  assert.equal(startPayload?.deviceId, "speakers-b", "start uses the refreshed, still-valid endpoint");
  await page.getByText(/preserved audio is ready to recover below/i).waitFor();
  assert.equal(await page.getByText("Preserved recordings").isVisible(), true);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS: capture device refresh selects a valid endpoint; a missing session refreshes and exposes preserved audio without reloading.");
} finally {
  await browser.close();
}
