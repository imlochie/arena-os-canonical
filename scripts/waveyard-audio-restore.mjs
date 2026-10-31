import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const base = process.env.TEST_BASE_URL || "http://localhost:80";
const archiveBytes = Buffer.from("small fake ZIP payload used only by this mocked browser acceptance test");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    if (window === window.top && localStorage.getItem("af_local_mode") === null) {
      localStorage.setItem("af_local_mode", "1");
    }
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let uploadedType = null;
  let uploadedBytes = null;

  await context.route("**/api/library/audio-backup/restore", async (route) => {
    const request = route.request();
    uploadedType = await request.headerValue("content-type");
    uploadedBytes = request.postDataBuffer();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ totalTracks: 1, restored: 1, duplicates: 0, failed: 0, results: [{ status: "restored", title: "Acceptance fixture" }] }),
    });
  });

  await page.goto(`${base}/waveyard`, { waitUntil: "domcontentloaded" });
  const restoreButton = page.getByRole("button", { name: "Restore originals" });
  await restoreButton.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await restoreButton.isDisabled(), true, "restore stays disabled until a ZIP and disk-space confirmation are provided");

  await page.getByLabel("Choose Waveyard audio backup ZIP").setInputFiles({
    name: "waveyard-audio-backup-test.zip",
    mimeType: "application/zip",
    buffer: archiveBytes,
  });
  assert.equal(await restoreButton.isDisabled(), true, "choosing a file alone is not consent to use the required disk space");

  await page.getByRole("checkbox", { name: /enough disk space/i }).check();
  assert.equal(await restoreButton.isEnabled(), true);
  await restoreButton.click();
  await page.getByRole("status").filter({ hasText: "Restored 1 original" }).waitFor({ timeout: 10000 });

  assert.equal(uploadedType, "application/zip");
  assert.deepEqual(uploadedBytes, archiveBytes, "the selected ZIP is sent intact as the raw request body");
  assert.equal(await page.getByRole("status").filter({ hasText: "Restored 1 original" }).count(), 1);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS: Waveyard ZIP restore requires disk confirmation, uploads the selected bytes, and shows the returned result.");
} finally {
  await browser.close();
}
