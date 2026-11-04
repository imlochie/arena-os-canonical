import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const projectId = "11111111-1111-4111-8111-111111111111";
const remixId = "22222222-2222-4222-8222-222222222222";
const laneStemId = "33333333-3333-4333-8333-333333333333";
const donorStemId = "44444444-4444-4444-8444-444444444444";
const laneSourceId = "55555555-5555-4555-8555-555555555555";
const donorSourceId = "66666666-6666-4666-8666-666666666666";
const laneId = "77777777-7777-4777-8777-777777777777";
const clipId = "88888888-8888-4888-8888-888888888888";

function toneWav(frequency: number, seconds = 8): Buffer {
  const sampleRate = 16_000;
  const sampleCount = sampleRate * seconds;
  const dataBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(
      Math.round(12_000 * Math.sin((2 * Math.PI * frequency * index) / sampleRate)),
      44 + index * 2,
    );
  }
  return wav;
}

test("Studio reload previews the clip donor and keeps seek, mute, and stop working", async () => {
  const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
  const { chromium } = apiRequire("playwright-core") as { chromium: { launch: (options: unknown) => Promise<any> } };
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript({ content: `
      localStorage.setItem("af_local_mode", "1");
      localStorage.setItem("af_ephemeral", "0");
    ` });
    await context.addInitScript({ content: `
      (() => {
        const starts = [];
        Object.defineProperty(window, "__waveyardBufferStarts", { value: starts });
        const originalStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          const buffer = this.buffer;
          if (buffer) {
            const samples = buffer.getChannelData(0);
            const offset = typeof args[1] === "number" ? args[1] : 0;
            const first = Math.min(samples.length - 4096, Math.max(0, Math.floor((offset + 0.05) * buffer.sampleRate)));
            const magnitude = function (frequency) {
              let real = 0;
              let imaginary = 0;
              for (let index = 0; index < 4096; index += 1) {
                const phase = (2 * Math.PI * frequency * (first + index)) / buffer.sampleRate;
                real += samples[first + index] * Math.cos(phase);
                imaginary += samples[first + index] * Math.sin(phase);
              }
              return (2 * Math.hypot(real, imaginary)) / 4096;
            };
            const record = {
              offset,
              donorTone: magnitude(997),
              laneTone: magnitude(733),
              active: true,
            };
            starts.push(record);
            this.addEventListener("ended", () => { record.active = false; }, { once: true });
          }
          return originalStart.apply(this, args);
        };
      })();
    ` });

    const page = await context.newPage();
    const browserErrors: string[] = [];
    const browserConsoleErrors: string[] = [];
    const loadedAssets: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserConsoleErrors.push(message.text());
    });

    const source = (id: string, filename: string) => ({
      id,
      originalFilename: filename,
      durationSeconds: 8,
      sampleRate: 16_000,
      channels: 1,
      codec: "pcm_s16le",
      mimeType: "audio/wav",
      fileSizeBytes: 256_044,
      checksumSha256: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
      linkedFromLibrary: true,
      analysis: null,
      sectionAnalysis: null,
      sections: [],
    });
    const stem = (id: string, sourceAssetId: string) => ({
      id,
      sourceAssetId,
      stemType: "drums",
      durationSeconds: 8,
      sampleRate: 16_000,
      channels: 1,
      codec: "pcm_s16le",
      format: "wav",
      fileSizeBytes: 256_044,
      checksumSha256: id.replaceAll("-", "").padEnd(64, "b").slice(0, 64),
      model: "browser-preview-fixture",
      modelVersion: "test",
    });
    const savedRemix = {
      remix: {
        id: remixId,
        projectId,
        version: 1,
        name: "Clip donor preview",
        masterVolume: 1,
        masterInserts: [],
        loopStartMs: 0,
        loopEndMs: null,
        tempoBpm: 120,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        gridDivision: "beat",
        snapEnabled: true,
        targetKey: null,
      },
      tracks: [{
        id: laneId,
        remixSessionId: remixId,
        stemAssetId: laneStemId,
        name: "Drums",
        sortOrder: 0,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        phaseInverted: false,
        inserts: [],
        clips: [{
          id: clipId,
          remixTrackId: laneId,
          stemAssetId: donorStemId,
          timelineStartMs: 0,
          durationMs: 6_000,
          sourceOffsetMs: 0,
          gain: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          fadeShape: "linear",
          tempoSyncEnabled: false,
          keySyncEnabled: false,
          beatSnapEnabled: false,
        }],
      }],
      automation: [],
      stems: [stem(laneStemId, laneSourceId), stem(donorStemId, donorSourceId)],
    };
    const json = (body: unknown, status = 200) => ({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    const routeBase = process.env.TEST_BASE_URL || "http://localhost:80";
    await page.route("**/api/**", async (route: any) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === `/api/waveyard/projects/${projectId}`) {
        return route.fulfill(json({
          project: { id: projectId, title: "Clip donor preview", licenseCode: "private", visibility: "private", publicationStatus: "draft" },
          role: "owner",
          build: null,
          sources: [],
          studioSources: [source(laneSourceId, "Lane default.wav"), source(donorSourceId, "Clip donor.wav")],
          stems: [stem(laneStemId, laneSourceId), stem(donorStemId, donorSourceId)],
          waveforms: [],
          waveformJobs: [],
          jobs: [],
        }));
      }
      if (pathname === `/api/waveyard/projects/${projectId}/remixes`)
        return route.fulfill(json({ remixes: [{ id: remixId }] }));
      if (pathname === `/api/remixes/${remixId}` && request.method() === "GET")
        return route.fulfill(json(savedRemix));
      if (pathname === `/api/remixes/${remixId}/versions`) return route.fulfill(json({ versions: [] }));
      if (pathname.endsWith("/waveform")) return route.fulfill(json({ peaks: [], durationSeconds: 8 }));
      const assetMatch = pathname.match(new RegExp("^/api/assets/([0-9a-f-]+)$", "i"));
      if (assetMatch) {
        const assetId = assetMatch[1];
        loadedAssets.push(assetId);
        const bytes = assetId === donorStemId ? toneWav(997) : toneWav(733);
        return route.fulfill({
          status: 200,
          contentType: "audio/wav",
          headers: { "cache-control": "private, no-store" },
          body: bytes,
        });
      }
      return route.fulfill(json({ error: `Unexpected API request: ${request.method()} ${pathname}` }, 404));
    });

    await page.goto(`${routeBase}/waveyard/projects/${projectId}?view=studio`);
    await page.getByRole("group", { name: "Drums clip 1" }).waitFor({ timeout: 15_000 });
    await page.reload();
    await page.getByRole("group", { name: "Drums clip 1" }).waitFor({ timeout: 15_000 });

    assert.notEqual(savedRemix.tracks[0].clips[0].stemAssetId, savedRemix.tracks[0].stemAssetId,
      "the reloaded clip must use a donor different from its lane default");
    const previewButton = page.getByRole("button", { name: "Preview arrangement" });
    const assetsBeforePreview = loadedAssets.length;
    await previewButton.click();
    try {
      await page.waitForFunction(() => {
        const starts = (window as any).__waveyardBufferStarts as Array<{ donorTone: number; active: boolean }>;
        return starts.some((entry) => entry.active && entry.donorTone > 0.2);
      }, undefined, { timeout: 10_000 });
    } catch (error) {
      console.error("Preview button:", await previewButton.getAttribute("aria-label"));
      console.error("Studio alerts:", await page.locator("[role='alert']").allTextContents());
      console.error("Studio status:", await page.locator("[role='status']").allTextContents());
      console.error("Loaded asset IDs:", loadedAssets);
      console.error("AudioBufferSource starts:", await page.evaluate(() => (window as any).__waveyardBufferStarts));
      console.error("Browser errors:", browserErrors);
      console.error("Console errors:", browserConsoleErrors);
      throw error;
    }
    assert.ok(loadedAssets.slice(assetsBeforePreview).includes(donorStemId), "preview fetches the clip's selected donor asset");
    const initialAudio = await page.evaluate(() => (window as any).__waveyardBufferStarts.at(-1));
    assert.ok(initialAudio.donorTone > initialAudio.laneTone * 10,
      `started buffer contains the clip donor tone, not the lane tone (${initialAudio.donorTone} vs ${initialAudio.laneTone})`);

    const seek = page.getByRole("slider", { name: "Seek project" });
    await seek.evaluate((element: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(element, "0.5");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const starts = (window as any).__waveyardBufferStarts as Array<{ offset: number; donorTone: number; active: boolean }>;
      return starts.some((entry) => entry.active && entry.offset >= 0.49 && entry.offset <= 0.51 && entry.donorTone > 0.2);
    }, undefined, { timeout: 10_000 });

    const laneMute = page.getByRole("button", { name: /^Mute Lane default\.wav/ });
    await laneMute.click();
    await page.waitForFunction(() => {
      const starts = (window as any).__waveyardBufferStarts as Array<{ active: boolean }>;
      return starts.length > 0 && starts.every((entry) => !entry.active);
    }, undefined, { timeout: 10_000 });
    assert.equal(await laneMute.getAttribute("aria-pressed"), "true", "lane mute remains available during arrangement playback");
    await laneMute.click();
    await page.waitForFunction(() => {
      const starts = (window as any).__waveyardBufferStarts as Array<{ active: boolean; donorTone: number }>;
      return starts.some((entry) => entry.active && entry.donorTone > 0.2);
    }, undefined, { timeout: 10_000 });

    await page.getByRole("button", { name: "Stop" }).click();
    await page.getByRole("button", { name: "Preview arrangement" }).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => {
      const starts = (window as any).__waveyardBufferStarts as Array<{ active: boolean }>;
      return starts.every((entry) => !entry.active);
    }, undefined, { timeout: 5_000 });
    assert.deepEqual(browserErrors, [], "reopening and previewing the saved donor raises no browser errors");
    await context.close();
  } finally {
    await browser.close();
  }
});
