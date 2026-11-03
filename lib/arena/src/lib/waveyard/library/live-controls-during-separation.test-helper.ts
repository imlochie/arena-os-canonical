import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { LiveSeparationContext } from "./api-responsiveness.test-helper";

type BrowserDriver = {
  onPrepared(context: LiveSeparationContext): Promise<void>;
  onVerifiedPhase(phase: string, context: LiveSeparationContext): Promise<void>;
  onCompleted(context: LiveSeparationContext): Promise<void>;
  close(): Promise<void>;
};

export async function installLiveAudioProbe(context: any) {
  await context.addInitScript(() => {
    const target = window as typeof window & {
      audioProbe?: {
        sources: Array<{ media: HTMLMediaElement; inputNode?: AudioNode }>;
        gains: Array<GainNode & { nextNode?: AudioNode }>;
      };
    };
    target.audioProbe = { sources: [], gains: [] };
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      createGain() {
        const gain = super.createGain() as GainNode & { nextNode?: AudioNode };
        const connect = gain.connect.bind(gain);
        gain.connect = ((destination: AudioNode, ...args: unknown[]) => {
          gain.nextNode = destination;
          return connect(destination, ...(args as [number?, number?, number?]));
        }) as typeof gain.connect;
        target.audioProbe!.gains.push(gain);
        return gain;
      }

      createMediaElementSource(media: HTMLMediaElement) {
        const source = super.createMediaElementSource(media) as MediaElementAudioSourceNode & {
          media?: HTMLMediaElement;
          inputNode?: AudioNode;
        };
        const connect = source.connect.bind(source);
        source.connect = ((destination: AudioNode, ...args: unknown[]) => {
          source.inputNode = destination;
          return connect(destination, ...(args as [number?, number?, number?]));
        }) as typeof source.connect;
        source.media = media;
        target.audioProbe!.sources.push(source as typeof source & { media: HTMLMediaElement });
        return source;
      }
    };
  });
}

export async function readLiveAudioState(page: any): Promise<Array<{
  assetId: string | undefined;
  paused: boolean;
  currentTime: number;
  readyState: number;
  gain: number | null;
  sourceCount: number;
}>> {
  return page.evaluate(() => {
    const probe = (window as typeof window & {
      audioProbe?: { sources: Array<{ media: HTMLMediaElement; inputNode?: AudioNode }> };
    }).audioProbe;
    return [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')].map(audio => {
      const source = probe?.sources.find(item => item.media === audio) as
        | (MediaElementAudioSourceNode & { inputNode?: AudioNode })
        | undefined;
      const stemGain = source?.inputNode as (AudioNode & { nextNode?: AudioNode }) | undefined;
      const gain = stemGain?.nextNode instanceof GainNode ? stemGain.nextNode.gain.value : null;
      return {
        assetId: new URL(audio.currentSrc || audio.src).pathname.split("/").at(-1),
        paused: audio.paused,
        currentTime: audio.currentTime,
        readyState: audio.readyState,
        gain,
        sourceCount: probe?.sources.filter(item => item.media === audio).length ?? 0,
      };
    });
  });
}

export async function createLiveControlsBrowserDriver(): Promise<BrowserDriver> {
  const apiPackage = fileURLToPath(new URL(
    "../../../../../../artifacts/api-server/package.json",
    import.meta.url,
  ));
  const require = createRequire(apiPackage);
  const { chromium } = require("playwright-core") as { chromium: any };
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  let page: any;
  let apiOrigin = "";
  let currentContext: LiveSeparationContext | undefined;
  const pageErrors: string[] = [];
  await installLiveAudioProbe(context);
  const currentAudioState = () => readLiveAudioState(page);
  const readSession = async () => page.evaluate(async (sessionId: string) => {
    const response = await fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Session refresh failed: HTTP ${response.status}`);
    return await response.json() as { session: Record<string, any> };
  }, currentContext!.sessionId);

  return {
    async onPrepared(nextContext) {
      currentContext = nextContext;
      apiOrigin = nextContext.origin;
      page = await context.newPage();
      page.on("pageerror", (error: Error) => pageErrors.push(error.message));
      await context.route("**/api/**", async (route: any) => {
        const requested = new URL(route.request().url());
        const headers = { ...route.request().headers() };
        delete headers.host;
        headers.origin = apiOrigin;
        headers.referer = `${apiOrigin}${requested.pathname}${requested.search}`;
        const response = await route.fetch({
          url: `${apiOrigin}${requested.pathname}${requested.search}`,
          headers,
        });
        await route.fulfill({ response });
      });
      await page.goto(`http://localhost:80/waveyard/session/${nextContext.sessionId}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const expectedAssets = nextContext.playbackStemAssets.map(stem => stem.id);
      await page.waitForFunction((assetIds: string[]) => {
        const elements = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        const loadedIds = elements.map(audio => new URL(audio.currentSrc || audio.src).pathname.split("/").at(-1));
        return elements.length === 4
          && elements.every(audio => audio.readyState >= 2)
          && assetIds.every(id => loadedIds.includes(id));
      }, expectedAssets, { timeout: 30_000 });
      const playButton = page.getByTestId("session-play");
      if (await playButton.getAttribute("aria-pressed") !== "true") await playButton.click();
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(item => !item.paused);
      }, undefined, { timeout: 5_000 });
      await page.waitForFunction(() => {
        const probe = (window as typeof window & { audioProbe?: { sources: unknown[] } }).audioProbe;
        return (probe?.sources.length ?? 0) >= 4;
      }, undefined, { timeout: 10_000 });
      const initialAudio = await currentAudioState();
      assert.equal(initialAudio.length, 4, "the prepared current track routes all four stems");
      assert.ok(initialAudio.every(item => item.sourceCount === 1),
        "each current stem owns one media-element source, with no duplicate playback engine");
      assert.ok(initialAudio.every(item => item.gain !== null), "each stem is connected through a real gain node");
    },

    async onVerifiedPhase(phase, activeContext) {
      assert.equal(activeContext, currentContext);
      const status = await page.evaluate(async (trackId: string) => {
        const response = await fetch("/api/library/tracks", { cache: "no-store" });
        if (!response.ok) throw new Error(`Library refresh failed: HTTP ${response.status}`);
        const body = await response.json() as { tracks: Array<{ id: string; stemAvailability: { status: string } }> };
        return body.tracks.find(track => track.id === trackId)?.stemAvailability.status;
      }, activeContext.separatingTrackId);
      assert.equal(status, "processing", `the other real library track is visibly processing during ${phase}`);

      if (phase === "1/4") {
        const playButton = page.getByTestId("session-play");
        await playButton.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')].every(audio => audio.paused),
        );
        await playButton.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')].every(audio => !audio.paused),
        );
        const before = await currentAudioState();
        await page.waitForTimeout(250);
        const after = await currentAudioState();
        assert.ok(after[0]!.currentTime > before[0]!.currentTime + 0.05,
          "playback clock advances after pause/resume while the actual worker is processing");
      } else if (phase === "2/4") {
        const playButton = page.getByTestId("session-play");
        await playButton.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')].every(audio => audio.paused),
        );
        const seek = page.getByTestId("seek-deck-0");
        await seek.evaluate((element: HTMLInputElement) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(element, "12");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.waitForFunction(() => {
          const audio = document.querySelector<HTMLAudioElement>('[data-role="current"] audio');
          return audio !== null && Math.abs(audio.currentTime - 12) < 0.5;
        });
        await playButton.click();
      } else if (phase === "3/4") {
        const vocalsAssetId = activeContext.playbackStemAssets.find(stem => stem.stemType === "vocals")?.id;
        assert.ok(vocalsAssetId);
        const fader = page.getByLabel("vocals level, current deck", { exact: true });
        await fader.evaluate((element: HTMLInputElement) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(element, "0.42");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await page.waitForFunction((assetId: string) => {
          const probe = (window as typeof window & {
            audioProbe?: { sources: Array<{ media: HTMLMediaElement; inputNode?: AudioNode }> };
          }).audioProbe;
          const audio = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')]
            .find(item => new URL(item.currentSrc || item.src).pathname.endsWith(`/${assetId}`));
          const source = probe?.sources.find(item => item.media === audio) as
            | (MediaElementAudioSourceNode & { inputNode?: AudioNode })
            | undefined;
          const stemGain = source?.inputNode as (AudioNode & { nextNode?: AudioNode }) | undefined;
          return stemGain?.nextNode instanceof GainNode
            && Math.abs(stemGain.nextNode.gain.value - 0.42) < 0.03;
        }, vocalsAssetId);
      } else if (phase === "4/4") {
        await page.getByTestId("quick-isolate-vocals").click();
        await page.waitForFunction(() =>
          document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "true",
        );
        const state = await currentAudioState();
        const vocalsId = activeContext.playbackStemAssets.find(stem => stem.stemType === "vocals")?.id;
        assert.ok(state.find(item => item.assetId === vocalsId)?.gain! > 0,
          "isolated vocals remain routed to an audible gain");
        assert.ok(state.filter(item => item.assetId !== vocalsId).every(item => Math.abs(item.gain ?? 1) < 0.02),
          "the other stem routes are muted by the isolation control");
        await page.getByTestId("quick-isolate-vocals").click();
      }

      const sessionState = await readSession();
      assert.equal(sessionState.session.currentSessionTrackId, activeContext.playbackSessionTrackId,
        `session selection is unchanged after control work during ${phase}`);
    },

    async onCompleted(completedContext) {
      assert.equal(completedContext, currentContext);
      await page.waitForTimeout(350);
      const savedBeforeReload = await readSession();
      assert.equal(savedBeforeReload.session.currentSessionTrackId, completedContext.playbackSessionTrackId,
        "worker completion does not replace the selected playback track");
      assert.ok(savedBeforeReload.session.positionSeconds >= 11.5,
        "the seek position survives the worker completing");

      await page.reload({ waitUntil: "domcontentloaded" });
      const expectedAssets = completedContext.playbackStemAssets.map(stem => stem.id);
      await page.waitForFunction((assetIds: string[]) => {
        const elements = [...document.querySelectorAll<HTMLAudioElement>('[data-role="current"] audio')];
        const loadedIds = elements.map(audio => new URL(audio.currentSrc || audio.src).pathname.split("/").at(-1));
        return elements.length === 4 && assetIds.every(id => loadedIds.includes(id));
      }, expectedAssets, { timeout: 30_000 });
      const restoredSession = await readSession();
      assert.equal(restoredSession.session.currentSessionTrackId, completedContext.playbackSessionTrackId,
        "reopening the real session restores the same current track after processing");
      const restoredFader = await page.getByLabel("vocals level, current deck", { exact: true }).inputValue();
      assert.equal(Number(restoredFader), 0.42,
        "the changed stem level remains available after the worker completes and the session reloads");
      assert.deepEqual(pageErrors, [], `the playback page reported runtime errors: ${pageErrors.join("; ")}`);
    },

    async close() {
      await browser.close();
    },
  };
}
