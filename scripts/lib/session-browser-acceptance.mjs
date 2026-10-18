import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
/** Opt-in REAL staged Next UI + production API + embedded PostgreSQL + Web
 * Audio. Inputs are the desktop runner's explicit synthetic passthrough
 * tracks. Never claim Electron, learned separation or listening quality. */
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";

export async function exerciseSessionBrowser({ url, sessionId, currentId, nextId, screenshotPath, ffmpegPath, ffprobePath }) {
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
    await expect.poll(async () => (await stored()).tracks[0].transition.cue?.toSessionTrackId).toBe(nextId);
    observations.push({ action: "timed crossfade after recovery", elapsedMs: Date.now() - started, signal: await signal([660, 1760]) });
    await expect.poll(async () => (await stored()).currentSessionTrackId).toBe(nextId);
    await page.reload(); await selected("session-b");
    await expect(page.getByTestId("session-play")).toHaveText("Play");
    await page.getByTestId("session-play").click();
    observations.push({ action: "reload real saved session and play again", signal: await signal([660, 1760]) });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await page.getByTestId("session-stop").click();
    await page.getByTestId("session-handoff").click();
    await expect(page.getByTestId("handoff-confirmation")).toContainText("Completed transitions preserve");
    await page.getByTestId("handoff-transitions").click();
    const openStudio = page.getByRole("link", { name: "Open it in the Studio", exact: true });
    const studioPath = await openStudio.getAttribute("href");
    await expect(openStudio).toHaveAttribute("href", /\/waveyard\/projects\//);
    await openStudio.click();
    await page.getByTestId("waveyard-mode-studio").click();
    await expect(page.getByRole("button", { name: "Save now", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Remix timeline", exact: true })).toBeVisible();
    observations.push({ action: "completed-transition handoff opens the actual reusable Studio arrangement", studioPath });
    const studioProjectId = studioPath.split("/").at(-1);
    const json = async (path, init) => { const response = await fetch(`${url}${path}`, init); if (!response.ok) throw new Error(`Studio acceptance HTTP ${response.status}: ${path}`); return response.json(); };
    const listing = await json(`/api/waveyard/projects/${studioProjectId}/remixes`);
    const remixId = listing.remixes[0].id;
    const initialArrangement = await json(`/api/remixes/${remixId}`);
    const savedCue = (await stored()).tracks[0].transition.cue;
    if (!savedCue || initialArrangement.automation.length !== 2) throw new Error("Completed transition did not reconstruct both lane envelopes");
    const nextClip = initialArrangement.tracks[1].clips[0];
    if (Math.abs(nextClip.timelineStartMs - savedCue.fromSeconds * 1000) > 1 || Math.abs(nextClip.sourceOffsetMs - savedCue.incomingSeconds * 1000) > 1)
      throw new Error("Studio arrangement lost completed transition source/timeline identity");
    const expectedDuration = savedCue.fromSeconds + 12 - savedCue.incomingSeconds;
    const master = page.getByRole("slider", { name: "Master volume", exact: true }).first();
    await master.fill("0.4");
    await page.getByRole("button", { name: "Save now", exact: true }).click();
    await expect.poll(async () => (await json(`/api/remixes/${remixId}`)).remix.masterVolume).toBe(0.4);
    await page.reload(); await page.getByTestId("waveyard-mode-studio").click();
    await expect(page.getByRole("slider", { name: "Master volume", exact: true }).first()).toHaveValue("0.4");
    const versionResponse = page.waitForResponse((response) => response.url().endsWith(`/api/remixes/${remixId}/versions`) && response.request().method() === "POST");
    page.once("dialog", (dialog) => dialog.accept("UI acceptance saved master"));
    await page.getByRole("button", { name: "Save version", exact: true }).click();
    const response = await versionResponse;
    if (!response.ok()) throw new Error("Studio UI version save failed");
    const version = (await response.json()).version;
    const request = await json(`/api/remix-versions/${version.id}/exports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "wav" }) });
    let rendered;
    await expect.poll(async () => { rendered = (await json(`/api/remix-versions/${version.id}/exports`)).exports.find((entry) => entry.id === request.job.id); return rendered?.status; }, { timeout: 30000 }).toMatch(/^(complete|failed)$/);
    if (rendered.status !== "complete") throw new Error(`Studio render failed: ${JSON.stringify(rendered)}`);
    const media = await fetch(`${url}/api/exports/${rendered.id}/media`);
    if (!media.ok) throw new Error("Studio render download failed");
    const bytes = Buffer.from(await media.arrayBuffer()), downloadPath = `${screenshotPath}.studio.wav`;
    await writeFile(downloadPath, bytes);
    const probe = JSON.parse(execFileSync(ffprobePath, ["-v", "error", "-show_entries", "format=duration,size", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", downloadPath], { encoding: "utf8" }));
    const decoded = execFileSync(ffmpegPath, ["-v", "error", "-i", downloadPath, "-f", "s16le", "-ac", "1", "-ar", "44100", "-"], { maxBuffer: 10 * 1024 * 1024 });
    let power = 0; for (let i = 0; i < decoded.length; i += 2) power += (decoded.readInt16LE(i) / 32768) ** 2;
    const rms = Math.sqrt(power / (decoded.length / 2));
    if (Math.abs(Number(probe.format.duration) - expectedDuration) > 0.03 || rms < 0.005) throw new Error("Studio UI-saved arrangement exported unexpected duration or silence");
    const arrangement = await json(`/api/remixes/${remixId}`);
    const envelopes = (state) => state.automation.map((lane) => ({ track: lane.remixTrackId, points: lane.points.map(({ timelineMs, value }) => ({ timelineMs, value })) })).sort((a, b) => a.track.localeCompare(b.track));
    if (JSON.stringify(envelopes(arrangement)) !== JSON.stringify(envelopes(initialArrangement))) throw new Error("Studio save/reload changed the transition envelopes");
    observations.push({ action: "Studio UI master edit/save/reload/version, then API render/download/decode", savedCue, expectedDuration, remixId, versionId: version.id, exportId: rendered.id, masterVolume: arrangement.remix.masterVolume, boundAssetIds: arrangement.tracks.flatMap((track) => track.clips.map((clip) => clip.stemAssetId)), downloadPath, sha256: createHash("sha256").update(bytes).digest("hex"), probe, rms, limitation: "export was requested through the production API, not a Studio export button; inputs remain synthetic passthrough" });

    await page.screenshot({ path: `${screenshotPath}.studio.png`, fullPage: true });
    if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
    return { browser: browser.version(), evidenceKind: "staged-browser-real-api-postgres-audio", limitations: ["synthetic passthrough input, not real music or separation", "browser, not Electron", "not subjective quality acceptance"], observations, screenshotPath, rendererErrors: errors };
  } finally { await browser.close(); }
}
