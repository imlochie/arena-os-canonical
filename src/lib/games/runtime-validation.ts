/** Untrusted HTML runs ONLY in a fresh browser's existing opaque iframe sandbox,
 * never eval/vm in Node, never an authenticated Spaces browser profile.
 * This is a bounded 2D-canvas smoke contract, NOT semantic/fun verification. */
import { createHash } from "node:crypto";
import { ARCADE_HOST_CSP, sandboxGameDocument, type GameRuntimeReport } from "./sandbox";
import { validateGameCode } from "./index";
import type { Browser, Page } from "playwright-core";

const scope = "2D canvas browser smoke: render, visual change, exercised keyboard/pointer, runtime errors and denied egress. Prompt fidelity, causal input semantics, pause/win/loss and fun require targeted gameplay acceptance.";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let active = 0;
const freshChecks = new WeakMap<GameRuntimeReport, { hash: string; expires: number }>();
/** Only the exact in-process result of our browser can avoid a duplicate check.
 * JSON/client/Artifact copies cannot forge this transient, one-use proof. */
export function consumeFreshRuntimeCheck(code: string, report?: GameRuntimeReport): boolean {
  if (!report) return false;
  const checked = freshChecks.get(report);
  freshChecks.delete(report);
  return Boolean(checked && checked.hash === digest(code) && checked.expires > Date.now());
}

export async function validateGameRuntime(code: string): Promise<GameRuntimeReport> {
  const base = { policyVersion: 1 as const, codeSha256: digest(code), scope };
  const staticCheck = validateGameCode(code);
  if (!staticCheck.ok) return { ...base, ok: false, status: "failed", issues: staticCheck.issues };
  if (active >= 2) return { ...base, ok: false, status: "unavailable", issues: ["Browser verification busy; draft retained, retry later."] };
  active++;
  let browser: Browser | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let observedPage: Page | undefined;
  const observedIssues: string[] = [];
  try {
    const work = async (): Promise<GameRuntimeReport> => {
      const { chromium } = await import("playwright-core");
      // Never inherit model keys, DB credentials or an authenticated profile.
      browser = await chromium.launch({
        executablePath: process.env.ARENA_ARCADE_CHROMIUM_PATH || undefined,
        headless: true,
        chromiumSandbox: !(process.env.CI === "true" && process.env.ARENA_ARCADE_CI_NO_SANDBOX === "1"),
        timeout: 5000,
        env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LD_LIBRARY_PATH", "SystemRoot"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
        args: ["--disable-dev-shm-usage", "--js-flags=--max-old-space-size=96", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      const context = await browser.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: "block", acceptDownloads: false });
      const page = await context.newPage();
      observedPage = page;
      page.setDefaultTimeout(1200);
      const issues = observedIssues, hashes: string[] = [];
      let blockedRequests = 0;
      page.on("pageerror", error => issues.push(`Browser runtime error: ${error.message.slice(0, 250)}`));
      page.on("console", message => {
        if (message.type() === "error") issues.push(`Browser console error: ${message.text().slice(0, 250)}`);
      });
      await context.route("**/*", async route => {
        if (route.request().url() === "http://arena-arcade.invalid/" && route.request().frame() === page.mainFrame()) {
          await route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": ARCADE_HOST_CSP }, body: "<!doctype html><html><body><h1>Arcade verification host</h1></body></html>" });
        } else {
          blockedRequests++;
          await route.abort("blockedbyclient");
        }
      });
      await page.goto("http://arena-arcade.invalid/");
      await page.evaluate(html => {
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("referrerpolicy", "no-referrer");
        iframe.style.cssText = "width:800px;height:600px;border:0";
        iframe.srcdoc = html;
        document.body.append(iframe);
      }, sandboxGameDocument(code));
      const element = page.locator("iframe");
      const frame = await (await element.elementHandle())!.contentFrame();
      if (!frame) throw new Error("Game iframe failed to load.");
      const canvas = frame.locator("canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 2500 });
      const start = frame.getByRole("button", { name: /\b(start|play|begin)\b/i }).first();
      if (await start.isVisible()) await start.click();
      await page.waitForTimeout(100);
      const rendered = await canvas.evaluate(node => {
        if (!(node instanceof HTMLCanvasElement)) return false;
        if (node.width < 32 || node.height < 32 || node.width > 2048 || node.height > 2048) return false;
        const pixels = node.getContext("2d")?.getImageData(0, 0, node.width, node.height).data;
        if (!pixels) return false;
        for (let i = 4; i < pixels.length; i += 16) {
          if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2] || pixels[i + 3] !== pixels[3]) return true;
        }
        return false;
      });
      hashes.push(digest(await canvas.screenshot()));
      await page.waitForTimeout(120);
      hashes.push(digest(await canvas.screenshot()));
      await element.click({ position: { x: 250, y: 200 } });
      await canvas.click({ position: { x: 20, y: 20 } });
      const keys = ["ArrowRight", "ArrowLeft", "Space"];
      for (const key of keys) await page.keyboard.press(key);
      await page.waitForTimeout(120);
      hashes.push(digest(await canvas.screenshot()));
      const visualChange = new Set(hashes).size > 1;
      if (!rendered) issues.push("Game did not render non-uniform 2D canvas content.");
      if (!visualChange) issues.push("Game canvas remained inert during observation and exercised inputs.");
      if (blockedRequests) issues.push("Game attempted an unauthorized request.");
      if (page.url() !== "http://arena-arcade.invalid/" || frame.url() !== "about:srcdoc") issues.push("Game attempted to navigate outside its sandbox document.");
      return {
        ...base, ok: issues.length === 0, status: issues.length ? "failed" : "passed",
        issues: [...new Set(issues)].slice(0, 12), browser: browser.version(),
        observations: { rendered, visualChange, keyboardInputs: keys, pointerInput: true, blockedRequests, canvasHashes: hashes },
      };
    };
    const report = await Promise.race([
      work(),
      new Promise<GameRuntimeReport>(resolve => {
        timer = setTimeout(() => resolve({ ...base, ok: false, status: browser ? "failed" : "unavailable", issues: ["Browser verification exceeded its 10-second budget; game was not published."] }), 10000);
      }),
    ]);
    if (report.ok) freshChecks.set(report, { hash: base.codeSha256, expires: Date.now() + 30000 });
    return report;
  } catch (error) {
    return {
      ...base, ok: false, status: browser ? "failed" : "unavailable",
      issues: [...observedIssues, browser ? `Browser smoke failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown runtime failure"}` :
        "Browser verification unavailable. Install Chromium or configure ARENA_ARCADE_CHROMIUM_PATH; draft was not published.",
        ...(observedPage ? [`Observed frame origins: ${observedPage.frames().map(frame => { try { const url = new URL(frame.url()); return url.protocol === "about:" ? frame.url() : url.origin; } catch { return "unavailable"; } }).join(", ")}`] : []),
      ].slice(0, 12),
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Closing the browser kills hung renderers too; never retain a game profile.
    await browser?.close().catch(() => {});
    active--;
  }
}
