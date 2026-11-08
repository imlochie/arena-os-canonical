import { access } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { validateGameCode } from "@workspace/arena/lib/games";
import { exerciseGameplay, parseGameplayContract, type GameplayReport } from "@workspace/arena/lib/games/gameplay-contract";

export type ArcadeRuntimeVerification = {
  status: "passed" | "failed" | "unavailable";
  scope: "startup-render-only" | "startup-render-and-declared-gameplay";
  issues: string[];
  browser?: string;
  canvas?: { width: number; height: number };
  animationFrames?: number;
  rendered?: boolean;
  blockedRequests?: number;
  gameplay?: GameplayReport;
};

const SCOPE = "startup-render-only" as const;
const MAX_PARALLEL_CHECKS = 2;
let activeChecks = 0;

function instrumentedDocument(code: string): string {
  const probe =
    `<script data-arena-runtime-probe>(function(){` +
    `window.__arenaRuntimeProbe={frames:0,errors:[]};` +
    `window.addEventListener("error",function(e){window.__arenaRuntimeProbe.errors.push(String(e.message||"script error").slice(0,240))},true);` +
    `window.addEventListener("unhandledrejection",function(e){window.__arenaRuntimeProbe.errors.push(String(e.reason&&e.reason.message||e.reason||"promise rejection").slice(0,240))});` +
    `var raf=window.requestAnimationFrame.bind(window);` +
    `window.requestAnimationFrame=function(cb){return raf(function(t){window.__arenaRuntimeProbe.frames++;cb(t)})};` +
    `})();</script>`;
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`;

  if (/<head\b[^>]*>/i.test(code)) {
    return code.replace(/<head\b[^>]*>/i, (head) => `${head}${csp}${probe}`);
  }
  if (/<html\b[^>]*>/i.test(code)) {
    return code.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${csp}${probe}</head>`);
  }
  return `<!doctype html><html><head>${csp}${probe}</head><body>${code}</body></html>`;
}

export async function chromiumExecutablePath(): Promise<string | undefined> {
  const resourcesChromium = process.env.ARENA_RESOURCES_DIR
    ? path.join(process.env.ARENA_RESOURCES_DIR, "chromium", process.platform === "win32" ? "chrome.exe" : "chrome")
    : undefined;
  const configured = process.env.ARENA_ARCADE_CHROMIUM_PATH || process.env.CHROMIUM_PATH || resourcesChromium;
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("CHROMIUM_PATH must be absolute.");
  }
  if (configured) {
    await access(configured);
    return configured;
  }
  for (const candidate of ["/repl/tools/bin/chromium"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try Playwright's configured default below.
    }
  }
  return undefined;
}

export function isolatedBrowserEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LD_LIBRARY_PATH",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
  );
}

export async function verifyArcadeRuntime(
  code: string,
  signal?: AbortSignal,
  options: { requireGameplay?: boolean } = {},
): Promise<ArcadeRuntimeVerification> {
  const staticCheck = validateGameCode(code);
  if (!staticCheck.ok) {
    return { status: "failed", scope: SCOPE, issues: staticCheck.issues.slice(0, 12) };
  }
  let contract;
  try {
    contract = parseGameplayContract(code, options.requireGameplay);
  } catch (error) {
    return {
      status: "failed",
      scope: SCOPE,
      issues: [error instanceof Error ? error.message : "Invalid gameplay contract."],
    };
  }
  if (activeChecks >= MAX_PARALLEL_CHECKS) {
    return {
      status: "unavailable",
      scope: SCOPE,
      issues: ["Browser verification is busy. The draft was retained and can be retried."],
    };
  }

  activeChecks++;
  let browser: Browser | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const work = async (): Promise<ArcadeRuntimeVerification> => {
      if (signal?.aborted) {
        return { status: "unavailable", scope: SCOPE, issues: ["Browser verification was cancelled."] };
      }
      const executablePath = await chromiumExecutablePath();
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        timeout: 8_000,
        env: isolatedBrowserEnvironment(),
        args: process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [],
      });
      if (signal?.aborted) {
        return { status: "unavailable", scope: SCOPE, issues: ["Browser verification was cancelled."] };
      }
      const context = await browser.newContext({
        viewport: { width: 900, height: 700 },
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(8_000);
      page.setDefaultTimeout(4_000);

      const issues: string[] = [];
      let blockedRequests = 0;
      page.on("pageerror", (error) => {
        issues.push(`Browser error: ${error.message.slice(0, 240)}`);
      });
      page.on("console", (message) => {
        if (message.type() === "error") {
          issues.push(`Browser console error: ${message.text().slice(0, 240)}`);
        }
      });
      await context.route("**/*", async (route) => {
        if (route.request().url() === "http://arcade-validation.invalid/" &&
            route.request().frame() === page.mainFrame()) {
          await route.fulfill({
            contentType: "text/html",
            headers: {
              "Content-Security-Policy":
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'",
            },
            body: "<!doctype html><html><body></body></html>",
          });
          return;
        }
        if (/^(?:https?|wss?):/i.test(route.request().url())) {
          blockedRequests++;
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });

      await page.goto("http://arcade-validation.invalid/");
      await page.evaluate((html) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.style.cssText = "width:800px;height:600px;border:0";
        frame.srcdoc = html;
        document.body.append(frame);
      }, instrumentedDocument(code));

      const iframe = page.locator("iframe");
      await iframe.waitFor({ state: "attached" });
      const frame = await (await iframe.elementHandle())?.contentFrame();
      if (!frame) throw new Error("The isolated game frame did not load.");
      const canvas = frame.locator("canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 5_000 });
      const dimensions = await canvas.evaluate((element) => ({
        width: (element as HTMLCanvasElement).width,
        height: (element as HTMLCanvasElement).height,
      }));
      if (dimensions.width < 32 || dimensions.height < 32 ||
          dimensions.width > 2048 || dimensions.height > 2048) {
        issues.push("The game canvas has invalid dimensions.");
      }

      const start = frame.getByRole("button", { name: /\b(start|play|begin)\b/i }).first();
      if (await start.isVisible().catch(() => false)) await start.click();
      await page.waitForTimeout(220);

      // A running loop over a uniform canvas is not a rendered game.
      const rendered = await canvas.evaluate((element) => {
        const node = element as HTMLCanvasElement;
        const pixels = node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data;
        if (!pixels) return false;
        for (let i = 4; i < pixels.length; i += 4) {
          if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] ||
              pixels[i + 2] !== pixels[2] || pixels[i + 3] !== pixels[3]) return true;
        }
        return false;
      }).catch(() => false);
      if (!rendered) issues.push("The game canvas stayed uniform; nothing was drawn.");

      const probe = await frame.evaluate(() => {
        const runtime = (window as any).__arenaRuntimeProbe;
        return {
          frames: Number(runtime?.frames ?? 0),
          errors: Array.isArray(runtime?.errors) ? runtime.errors.map(String) : [],
        };
      });
      if (probe.frames < 2) issues.push("The game did not advance its animation loop.");
      issues.push(...probe.errors.map((message: string) => `Game startup error: ${message}`));
      if (blockedRequests > 0) issues.push("The game attempted to make an external network request.");
      if (page.url() !== "http://arcade-validation.invalid/" || frame.url() !== "about:srcdoc") {
        issues.push("The game attempted to navigate outside its isolated frame.");
      }

      // Declared gameplay scenarios run only after the smoke checks pass, each
      // in a fresh opaque document, driven by real browser input.
      const gameplay = contract && issues.length === 0
        ? await exerciseGameplay(contract, async () => {
            const element = await iframe.elementHandle();
            await element!.evaluate((node, html) => new Promise<void>((resolve) => {
              node.addEventListener("load", () => resolve(), { once: true });
              (node as HTMLIFrameElement).srcdoc = html;
            }), instrumentedDocument(code));
            const fresh = await (await iframe.elementHandle())?.contentFrame();
            if (!fresh) throw new Error("Gameplay frame unavailable.");
            await fresh.locator("canvas").first().waitFor({ state: "visible" });
            const begin = fresh.getByRole("button", { name: /\b(start|play|begin)\b/i }).first();
            if (await begin.isVisible().catch(() => false)) await begin.click();
            await page.waitForTimeout(40);
            return fresh;
          })
        : undefined;
      if (gameplay?.status === "failed") {
        issues.push(...gameplay.scenarios.flatMap((s) => s.issues.map((issue) => `${s.kind}/${s.name}: ${issue}`)));
      }

      await context.close();
      return {
        status: issues.length ? "failed" : "passed",
        scope: gameplay ? "startup-render-and-declared-gameplay" : SCOPE,
        gameplay,
        issues: [...new Set(issues)].slice(0, 12),
        browser: browser?.version(),
        canvas: dimensions,
        animationFrames: probe.frames,
        rendered,
        blockedRequests,
      };
    };

    const timed = new Promise<ArcadeRuntimeVerification>((resolve) => {
      timeout = setTimeout(() => resolve({
        status: browser ? "failed" : "unavailable",
        scope: SCOPE,
        issues: ["Browser startup verification exceeded 20 seconds; the game was not published."],
      }), 20_000);
    });
    const cancelled = signal
      ? new Promise<ArcadeRuntimeVerification>((resolve) => {
          abortHandler = () => {
            void browser?.close().catch(() => {});
            resolve({ status: "unavailable", scope: SCOPE, issues: ["Browser verification was cancelled."] });
          };
          signal.addEventListener("abort", abortHandler, { once: true });
          if (signal.aborted) abortHandler();
        })
      : undefined;
    return await Promise.race([work(), timed, ...(cancelled ? [cancelled] : [])]);
  } catch (error) {
    return {
      status: browser ? "failed" : "unavailable",
      scope: SCOPE,
      issues: [
        browser
          ? `Isolated browser verification failed: ${error instanceof Error ? error.message.slice(0, 240) : "unknown error"}`
          : "Chromium is unavailable. Configure CHROMIUM_PATH or install Chromium; the generated draft was not published.",
      ],
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    await browser?.close().catch(() => {});
    activeChecks--;
  }
}
