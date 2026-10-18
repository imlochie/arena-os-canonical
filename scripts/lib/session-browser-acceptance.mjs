/** Opt-in REAL staged Next UI + production API + embedded PostgreSQL + Web
 * Audio. Inputs are the desktop runner's explicit synthetic passthrough
 * tracks. Never claim Electron, learned separation or listening quality. */
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";

export async function exerciseSessionBrowser({ url, sessionId, currentId, nextId, screenshotPath }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  const observations = [], errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const Native = window.AudioContext;
      window.sessionAnalysers = [];
      window.AudioContext = class extends Native {
        constructor(...args) {
          super(...args); let first = true; const original = this.createAnalyser.bind(this);
          this.createAnalyser = () => { const node = original(); if (first) { window.sessionAnalysers.push({ node, context: this }); first = false; } return node; };
        }
      };
      window.sessionSignal = () => window.sessionAnalysers.map(({ node, context }) => {
        if (context.state === "closed") return { rms: 0, hz: 0 };
        const pcm = new Float32Array(node.fftSize), bins = new Float32Array(node.frequencyBinCount);
        node.getFloatTimeDomainData(pcm); node.getFloatFrequencyData(bins);
        let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
        return { rms: Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length), hz: peak * context.sampleRate / node.fftSize };
      });
    });
    const signal = async (frequencies) => {
      await expect.poll(() => page.evaluate((expected) => window.sessionSignal().some((x) => x.rms > 0.02 && expected.some((hz) => Math.abs(x.hz - hz) < 30)), frequencies)).toBe(true);
      return page.evaluate(() => window.sessionSignal());
    };
    const selected = (title) => expect(page.getByTestId("session-deck-current").getByRole("heading")).toContainText(title);
    const stored = async () => (await (await fetch(`${url}/api/library/sessions/${sessionId}`)).json()).session;
    await page.goto(`${url}/waveyard/session/${sessionId}`);
    try { await selected("session-a"); } catch (error) {
      await page.screenshot({path:screenshotPath,fullPage:true}); throw error;
    }
    await page.getByTestId("session-play").click();
    observations.push({ action: "play current through real UI", signal: await signal([440, 1320]) });
    await page.locator("#sess-fade").fill("0"); await page.getByTestId("session-transition").click();
    await selected("session-b");
    observations.push({ action: "hard cut through real UI", signal: await signal([660, 1760]) });
    await expect.poll(async () => (await stored()).currentSessionTrackId).toBe(nextId);
    await page.getByTestId("session-stop").click();
    await page.locator(".sess-queue-jump").filter({ hasText: "session-a" }).click();
    await selected("session-a");
    await expect.poll(async () => (await stored()).currentSessionTrackId).toBe(currentId);
    await page.getByTestId("session-play").click(); await signal([440, 1320]);
    await page.locator("#sess-fade").fill("1"); const started = Date.now();
    await page.getByTestId("session-transition").click();
    await expect.poll(() => page.evaluate(() => window.sessionSignal().filter((x) => x.rms > 0.005).length)).toBe(2);
    // Confirm an actual outgoing fade, not just an incoming fade followed by
    // a hard stop. Default session mix is {}, i.e. implicit unity levels.
    await page.evaluate(() => { window.observedFadeStart = performance.now(); });
    await expect.poll(() => page.evaluate(() => {
      if (performance.now() - window.observedFadeStart < 200) return false;
      const signal = window.sessionSignal();
      return signal.some((x) => (Math.abs(x.hz - 440) < 30 || Math.abs(x.hz - 1320) < 30) && x.rms > 0.002 && x.rms < 0.022)
        && signal.some((x) => (Math.abs(x.hz - 660) < 30 || Math.abs(x.hz - 1760) < 30) && x.rms > 0.006);
    })).toBe(true);
    await selected("session-b");
    observations.push({ action: "timed crossfade after recovery", elapsedMs: Date.now() - started, signal: await signal([660, 1760]) });
    await expect.poll(async () => (await stored()).currentSessionTrackId).toBe(nextId);
    await page.reload(); await selected("session-b");
    await expect(page.getByTestId("session-play")).toHaveText("Play");
    await page.getByTestId("session-play").click();
    observations.push({ action: "reload real saved session and play again", signal: await signal([660, 1760]) });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.getByTestId("session-stop").click();
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
    return { browser: browser.version(), evidenceKind: "staged-browser-real-api-postgres-audio", limitations: ["synthetic passthrough input, not real music or separation", "browser, not Electron", "not subjective quality acceptance"], observations, screenshotPath, rendererErrors: errors };
  } finally { await browser.close(); }
}
