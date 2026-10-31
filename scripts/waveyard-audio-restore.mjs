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
  const uploads = [];

  await context.route("**/api/library/audio-backup/restore", async (route) => {
    const request = route.request();
    uploads.push({
      contentType: await request.headerValue("content-type"),
      bytes: request.postDataBuffer(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(uploads.length === 1
        ? { totalTracks: 2, restored: 1, duplicates: 0, failed: 1, results: [{ status: "restored", title: "Acceptance fixture" }, { status: "failed", title: "Unreadable fixture" }] }
        : { totalTracks: 2, restored: 0, duplicates: 1, failed: 0, results: [{ status: "duplicate", title: "Acceptance fixture" }, { status: "restored", title: "Unreadable fixture" }] }),
    });
  });

  await page.goto(`${base}/waveyard`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Apple Music catalog backup" }).click();
  await page.getByText(/exports retain playlist order and available track details and listening stats/i).waitFor({ timeout: 10000 });
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
  await page.getByRole("status").filter({ hasText: "1 failed" }).waitFor({ timeout: 10000 });

  const retryButton = page.getByRole("button", { name: "Retry failed tracks" });
  assert.equal(await retryButton.isEnabled(), true, "a partial result keeps the archive available for retry");
  assert.equal(await page.getByRole("checkbox", { name: /enough disk space/i }).isChecked(), true);
  await retryButton.click();
  await page.getByRole("status").filter({ hasText: "skipped 1 duplicate" }).waitFor({ timeout: 10000 });

  assert.equal(uploads.length, 2, "the same archive can be retried after a partial restore");
  for (const upload of uploads) {
    assert.equal(upload.contentType, "application/zip");
    assert.deepEqual(upload.bytes, archiveBytes, "the selected ZIP is sent intact as the raw request body");
  }
  assert.equal(await page.getByRole("checkbox", { name: /enough disk space/i }).isChecked(), false);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS: Apple metadata backup is discoverable; Waveyard ZIP restore requires disk confirmation, uploads the selected bytes, retains partial archives, and retries safely.");
} finally {
  await browser.close();
}
