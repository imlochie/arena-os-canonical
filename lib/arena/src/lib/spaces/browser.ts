/**
 * Space browser automation (docs/spaces-autonomy.md Phase C) — real
 * websites, real pages, real accounts, governed.
 *
 * Every space gets its OWN persistent browser profile
 * (.data/space-workspaces/<spaceId>/browser-profile): cookies, logins, and
 * sessions belong to that space and survive across missions — one space's
 * accounts are never visible to another.
 *
 * Tool surface (through the SAME executeTool + governance gate as everything
 * else — see governance.ts for the action classes):
 *   browser_navigate  {url}                    view  — auto-executed, journaled
 *   browser_extract   {selector?, limit?}      view  — bounded text/link extraction
 *   browser_screenshot {}                      view  — saved into the workspace
 *   browser_snapshot  {}                       view  — accessibility tree (roles + names) of the page
 *   browser_click     {selector}               interact — APPROVAL-GATED
 *   browser_fill      {selector, value}        interact — APPROVAL-GATED
 *
 * Honesty contract: nothing is pretended. If no Chromium is available
 * (playwright-core ships without browsers), every tool returns an honest,
 * actionable error — never a fabricated page. Navigation and extraction see
 * the REAL DOM. Video pages yield their real titles/descriptions/available
 * transcript text; headless automation does not "watch" video content and
 * never claims to.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "./tools";
import { assertOutboundUrl } from "../security/outbound-url";
import { configuredChromiumPath } from "./runtime-paths";

export interface PageSnapshot {
  url: string;
  title: string;
  text: string; // bounded visible text
}

export interface BrowserEngine {
  /** Launch (or reuse) the browser with the given profile directory. */
  ensure(profileDir: string): Promise<void>;
  navigate(url: string): Promise<PageSnapshot>;
  extract(selector: string, limit: number): Promise<string[]>;
  screenshot(workspaceDir: string): Promise<string>;
  /** Accessibility tree of the current page (roles and accessible names), bounded. */
  snapshot(): Promise<string>;
  click(selector: string): Promise<string>;
  fill(selector: string, value: string): Promise<string>;
  close(): Promise<void>;
}

// ---------------- real engine (playwright-core, lazily imported) ----------------

/** Each instance belongs to one space: context, cookies and active page never cross workspaces. */
export function createPlaywrightEngine(
  loadChromium: () => Promise<{ chromium: any }> = () => import("playwright-core"),
): BrowserEngine {
  let context: any = null;
  let page: any = null;
  let sessionFile: string | null = null;
  let restoreError: string | null = null;
  const saveLocation = async () => {
    if (sessionFile && page && /^https?:\/\//i.test(page.url())) {
      await writeFile(sessionFile, JSON.stringify({ url: page.url() }), { mode: 0o600 });
    }
  };

  const activePage = () => {
    if (!context || !page || page.isClosed()) {
      throw new Error("no browser page is open in this workspace; navigate to a page first");
    }
    if (restoreError) throw new Error(restoreError);
    return page;
  };

  return {
    async ensure(profileDir: string) {
      await mkdir(profileDir, { recursive: true });
      if (context) return;
      const { chromium } = await loadChromium().catch(() => {
        throw new Error(
          "browser automation is unavailable: playwright-core is not installed in this environment",
        );
      });
      try {
        const replitChromium = await access("/repl/tools/bin/chromium").then(() => "/repl/tools/bin/chromium").catch(() => undefined);
        const executablePath = configuredChromiumPath() ?? replitChromium;
        if (executablePath) await access(executablePath);
        context = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          serviceWorkers: "block",
          viewport: { width: 1280, height: 800 },
          ...(executablePath ? { executablePath } : {}),
          ...(process.platform === "linux" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
        });
        // Browser pages can follow redirects or load subresources. Apply the
        // outbound policy to every request, not just the initial navigation,
        // so a public page cannot reach local services or private networks.
        await context.route("**/*", async (route: any) => {
          const requestUrl = route.request().url();
          if (!/^https?:\/\//i.test(requestUrl)) {
            await route.abort("blockedbyclient");
            return;
          }
          try {
            await assertOutboundUrl(requestUrl, "public");
            await route.continue();
          } catch {
            await route.abort("blockedbyclient");
          }
        });
        page = context.pages()[0] ?? await context.newPage();
        sessionFile = path.join(profileDir, "arena-session.json");
        try {
          const saved = JSON.parse(await readFile(sessionFile, "utf8"));
          await assertOutboundUrl(saved.url, "public");
          await page.goto(saved.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            restoreError = "The last workspace page could not be restored; open a page before resuming";
          }
        }
      } catch (e) {
        await context?.close().catch(() => {});
        context = null;
        page = null;
        throw new Error(
          "browser automation is unavailable: Chromium could not start — install Chromium with `npx playwright install chromium` or set CHROMIUM_PATH " +
            `(detail: ${e instanceof Error ? e.message.split("\n")[0] : "launch failed"})`,
        );
      }
    },
    async navigate(url: string) {
      if (!context) throw new Error("browser engine not launched — call ensure() first");
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      restoreError = null;
      const title = await page.title();
      const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 20_000);
      await saveLocation();
      return { url: page.url(), title, text, status: response?.status() };
    },
    async extract(selector: string, limit: number) {
      const found = await activePage().locator(selector).allInnerTexts();
      return found.slice(0, limit);
    },
    async snapshot() {
      const tree: string = await activePage().locator("body").ariaSnapshot({ timeout: 15_000 });
      return tree.slice(0, 20_000);
    },
    async screenshot(workspaceDir: string) {
      const file = path.join(workspaceDir, `browser-${Date.now()}.png`);
      await activePage().screenshot({ path: file, fullPage: false });
      return file;
    },
    async click(selector: string) {
      await activePage().click(selector, { timeout: 15_000 });
      await saveLocation();
      return `clicked ${selector} — page is now: ${page.url()}`;
    },
    async fill(selector: string, value: string) {
      await activePage().fill(selector, value, { timeout: 15_000 });
      return `filled ${selector}`;
    },
    async close() {
      try { await saveLocation(); }
      finally {
        await context?.close();
        context = null;
        page = null;
        restoreError = null;
      }
    },
  };
}

// ---------------- per-space session ----------------

const engines = new Map<string, BrowserEngine>();
const busyWorkspaces = new Set<string>();

export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.allSettled([...engines.keys()].map(closeBrowserSession));
}

export function claimBrowserWorkspace(spaceId: string): (() => void) | null {
  if (busyWorkspaces.has(spaceId)) return null;
  busyWorkspaces.add(spaceId);
  return () => { busyWorkspaces.delete(spaceId); };
}

export function browserWorkspaceBusy(spaceId: string): boolean {
  return busyWorkspaces.has(spaceId);
}

export async function closeBrowserSession(spaceId: string): Promise<void> {
  const engine = engines.get(spaceId);
  engines.delete(spaceId);
  await engine?.close();
}

export function browserProfileDir(spaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(spaceId)) throw new Error("bad space id");
  return path.join(WORKSPACE_ROOT, spaceId, "browser-profile");
}

export function workspaceDirFor(spaceId: string): string {
  return path.join(WORKSPACE_ROOT, spaceId);
}

/** Get (or create) the space's browser engine. Injectable for tests. */
export function engineFor(spaceId: string, engine?: BrowserEngine): BrowserEngine {
  let e = engines.get(spaceId);
  if (!e) {
    e = engine ?? createPlaywrightEngine();
    engines.set(spaceId, e);
  }
  return e;
}

export function resetEngine(spaceId: string): void {
  engines.delete(spaceId);
}

// ---------------- tool implementations (honest output contract) ----------------

const URL_OK = /^https?:\/\//;

export async function toolBrowserNavigate(spaceId: string, url: string, engine?: BrowserEngine): Promise<string> {
  const target = String(url ?? "").trim();
  if (!URL_OK.test(target)) return "error: browser_navigate needs an absolute http(s) URL";
  try {
    await assertOutboundUrl(target, "public");
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    const snap = await e.navigate(target);
    return `navigated to ${snap.url}\ntitle: ${snap.title}\n\n${snap.text.slice(0, 8_000)}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "navigation failed"}`;
  }
}

export async function toolBrowserExtract(spaceId: string, selector: string, limit: number, engine?: BrowserEngine): Promise<string> {
  const sel = String(selector ?? "body").trim() || "body";
  const cap = Math.min(50, Math.max(1, Math.round(limit || 10)));
  try {
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    const found = await e.extract(sel, cap);
    if (found.length === 0) return `no elements matched ${sel}`;
    return found.map((t, i) => `${i + 1}. ${t.slice(0, 1_000)}`).join("\n");
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "extraction failed"}`;
  }
}

export async function toolBrowserScreenshot(spaceId: string, engine?: BrowserEngine): Promise<string> {
  try {
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    const file = await e.screenshot(workspaceDirFor(spaceId));
    return `screenshot saved: ${path.basename(file)} (in the space workspace)`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "screenshot failed"}`;
  }
}

export async function toolBrowserSnapshot(spaceId: string, engine?: BrowserEngine): Promise<string> {
  try {
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    const tree = await e.snapshot();
    if (!tree.trim()) return "the page has no accessible content yet";
    return `accessibility snapshot (roles and names; target elements with role=<role>[name="<name>"]):\n${tree.slice(0, 8_000)}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "snapshot failed"}`;
  }
}

export async function toolBrowserClick(spaceId: string, selector: string, engine?: BrowserEngine): Promise<string> {
  const sel = String(selector ?? "").trim();
  if (!sel) return "error: browser_click needs a CSS selector";
  try {
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    return await e.click(sel);
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "click failed"}`;
  }
}

export async function toolBrowserFill(spaceId: string, selector: string, value: string, engine?: BrowserEngine): Promise<string> {
  const sel = String(selector ?? "").trim();
  if (!sel) return "error: browser_fill needs a CSS selector";
  try {
    const e = engineFor(spaceId, engine);
    await e.ensure(browserProfileDir(spaceId));
    return await e.fill(sel, String(value ?? "").slice(0, 5_000));
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : "fill failed"}`;
  }
}
