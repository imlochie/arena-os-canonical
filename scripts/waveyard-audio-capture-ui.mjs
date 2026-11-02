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
  let signalPhase = "silent";
  let applicationPresent = true;
  let applicationSupported = true;
  let mediaMetadataTitle = "Application capture test";
  let mediaMetadataReads = 0;
  let startPayload;
  let markerPayload;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await context.route("**/api/library/audio-capture**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      if (new URL(request.url()).searchParams.get("mediaMetadata") === "1") {
        mediaMetadataReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            mediaMetadata: {
              available: true,
              sourceAppId: "AuthorizedPlayer.exe",
              metadata: {
                title: mediaMetadataTitle,
                artist: "Authorized Artist",
                album: "Authorized Album",
                trackNumber: 2,
              },
            },
          }),
        });
        return;
      }
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
          processLoopbackSupported: applicationSupported,
          processLoopbackReason: applicationSupported ? undefined : "Application isolation is unavailable in this test host.",
          applications: applicationPresent
            ? [{ processId: 4242, processStartTime: "123456789", name: "AuthorizedPlayer.exe" }] : [],
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
    if (route.request().method() === "POST") {
      markerPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "capture-ui-test",
          title: "Application capture test",
          status: "recording",
          elapsedSeconds: 6,
          discontinuityCount: 0,
          format: { sampleRate: 48_000, channels: 2, bitsPerSample: 16, blockAlign: 4 },
          markers: [{ id: "marker-ui-test", sampleFrame: 192_000, metadata: markerPayload }],
        }),
      });
      return;
    }
    if (signalPhase !== "missing") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: "capture-ui-test", title: "Authorized capture test",
          status: signalPhase === "ended" ? "completed" : "recording",
          captureMode: startPayload?.processId ? "process-loopback" : "system-loopback",
          processId: startPayload?.processId,
          ...(signalPhase === "ended" ? { message: "The selected application exited. Save captured audio." } : {}),
          elapsedSeconds: 6, discontinuityCount: 0,
          format: { sampleRate: 48_000, channels: 2, bitsPerSample: 16, blockAlign: 4 },
          signal: {
            state: signalPhase === "ended" ? "active" : signalPhase, peak: signalPhase === "active" ? 0.5 : 0,
            capturedSeconds: 4, signalSeen: signalPhase !== "silent",
            clippedSamples: 0, invalidSamples: 0,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Capture session not found." }),
    });
  });
  await context.route("**/api/library/audio-capture/capture-ui-test/stop", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        track: { title: "Silent recording" }, separationQueued: false,
        signal: { state: "silent", peak: 0, capturedSeconds: 4, signalSeen: false, clippedSamples: 0, invalidSamples: 0 },
      }),
    });
  });

  await page.goto(`${base}/waveyard`, { waitUntil: "domcontentloaded" });
  const captureShortcut = page.getByRole("link", { name: "Record playback audio", exact: true });
  assert.equal(await captureShortcut.getAttribute("href"), "#waveyard-audio-capture");
  await captureShortcut.click();
  await page.waitForFunction(() => window.location.hash === "#waveyard-audio-capture");
  assert.equal(await page.locator("#waveyard-audio-capture").getAttribute("aria-label"), "Record Windows playback");
  const deviceSelect = page.getByLabel("Windows playback device");
  await deviceSelect.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('select[aria-label="Windows playback device"]')?.value === "speakers-a");

  await page.getByRole("button", { name: "Refresh devices" }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Windows playback device"]')?.value === "speakers-b");
  await page.getByLabel("Track title").fill("Authorized capture test");
  await page.getByRole("checkbox", { name: /authorized to record this audio/i }).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  await page.getByText("Recording ·", { exact: false }).waitFor({ timeout: 10000 });
  await page.getByText("PCM received, but no signal above -80 dBFS", { exact: false }).waitFor();
  await page.getByText(/Check that audio is playing through the selected output/).waitFor();
  signalPhase = "active";
  await page.getByText("Audio signal detected", { exact: false }).waitFor();
  assert.equal(await page.getByRole("meter", { name: "Captured audio peak" }).getAttribute("value"), "0.5");
  await page.setViewportSize({ width: 390, height: 844 });
  const meterBounds = await page.getByRole("meter", { name: "Captured audio peak" }).boundingBox();
  assert(meterBounds && meterBounds.x >= 0 && meterBounds.x + meterBounds.width <= 390,
    "the signal meter stays inside the mobile viewport");
  await page.setViewportSize({ width: 1280, height: 1000 });
  signalPhase = "waiting";
  await page.getByText("No PCM arriving from the playback device", { exact: false }).waitFor();
  signalPhase = "missing";
  await page.getByRole("button", { name: "Recover to library" }).waitFor({ timeout: 10000 });

  assert.equal(optionsRequests, 3, "the UI refreshed device state and reloaded preserved recordings after a missing session");
  assert.equal(startPayload?.deviceId, "speakers-b", "start uses the refreshed, still-valid endpoint");
  await page.getByText(/preserved audio is ready to recover below/i).waitFor();
  assert.equal(await page.getByText("Preserved recordings").isVisible(), true);
  signalPhase = "silent";
  await page.getByLabel("Capture source").selectOption("application");
  assert.equal(await page.getByRole("button", { name: "Start recording" }).isDisabled(), true);
  await page.getByLabel("Windows application").selectOption("4242:123456789");
  await page.setViewportSize({ width: 390, height: 844 });
  const sourceBounds = await page.getByLabel("Windows application").boundingBox();
  assert(sourceBounds && sourceBounds.x >= 0 && sourceBounds.x + sourceBounds.width <= 390,
    "application selection fits the mobile viewport");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByLabel("Track title").fill("Application capture test");
  await page.getByRole("button", { name: "Start recording" }).click();
  assert.equal(startPayload.title, "Application capture test");
  assert.equal(startPayload.processId, 4242);
  assert.equal(startPayload.processStartTime, "123456789");
  assert.equal("deviceId" in startPayload, false, "isolated capture must never send an output endpoint");
  const mediaWatch = page.getByRole("checkbox", { name: "Suggest tags when the Windows media session changes" });
  await mediaWatch.check();
  await page.getByText(/Watching media tags from AuthorizedPlayer\.exe/).waitFor({ timeout: 10000 });
  assert(mediaMetadataReads > 0, "enabling the watch polls the optional Windows media metadata endpoint");
  mediaMetadataTitle = "Second authorized track";
  const mediaSuggestion = page.getByTestId("media-track-suggestion");
  await mediaSuggestion.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const suggestionBounds = await mediaSuggestion.boundingBox();
  assert(suggestionBounds && suggestionBounds.x >= 0 && suggestionBounds.x + suggestionBounds.width <= 390,
    "the media-session suggestion fits the mobile viewport");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: "Confirm boundary at current audio frame", exact: true }).click();
  assert.deepEqual(markerPayload, {
    title: "Second authorized track",
    artist: "Authorized Artist",
    album: "Authorized Album",
    trackNumber: 2,
  });
  await page.getByText(/Boundary saved.*Second authorized track/).waitFor();
  await page.getByRole("button", { name: "Stop and add to library" }).click();
  await page.getByText(/Warning: no signal above -80 dBFS was detected/).waitFor();
  await page.getByText(/Automatic stem separation was not requested/).waitFor();
  await page.getByLabel("Track title").fill("Source exit test");
  await page.getByRole("checkbox", { name: /authorized to record this audio/i }).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  signalPhase = "ended";
  await page.getByRole("button", { name: "Add captured audio to library", exact: true }).waitFor();
  await page.locator(".library-audio-capture-session").getByText("The selected application exited. Save captured audio.").waitFor();
  await page.getByRole("button", { name: "Add captured audio to library", exact: true }).click();
  await page.getByLabel("Track title").waitFor();
  applicationPresent = false;
  await page.getByRole("button", { name: "Refresh devices" }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Windows application"]')?.value === "");
  assert.equal(await page.getByLabel("Capture source").inputValue(), "application",
    "an exited source does not silently change to whole output");
  applicationSupported = false;
  await page.getByRole("button", { name: "Refresh devices" }).click();
  await page.getByText("Application isolation is unavailable in this test host.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start recording" }).isDisabled(), true);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log("PASS: explicit device/application selection and isolated payload; PCM signal UI; media-session tag suggestions with user-confirmed PCM-frame markers; mobile bounds; missing-session recovery and silent-file warning (mocked HTTP, not Windows audio).");
} finally {
  await browser.close();
}
