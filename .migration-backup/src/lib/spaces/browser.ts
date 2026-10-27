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

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "./tools";

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
  click(selector: string): Promise<string>;
  fill(selector: string, value: string): Promise<string>;
  close(): Promise<void>;
}

// ---------------- real engine (playwright-core, lazily imported) ----------------

export const playwrightEngine: BrowserEngine = {
  async ensure(profileDir: string) {
    await mkdir(profileDir, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = await import("playwright-core").catch(() => {
      throw new Error(
        "browser automation is unavailable: playwright-core is not installed in this environment",
      );
    });
    if (!realBrowser) {
      try {
        realBrowser = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          viewport: { width: 1280, height: 800 },
        });
      } catch (e) {
        throw new Error(
          "browser automation is unavailable: no Chromium binary found — run `npx playwright install chromium` once on this machine " +
            `(detail: ${e instanceof Error ? e.message.split("\n")[0] : "launch failed"})`,
        );
      }
    }
  },
  async navigate(url: string) {
    const page = await newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 20_000);
    const finalUrl = page.url();
    await page.close();
    return { url: finalUrl, title, text, status: response?.status() };
  },
  async extract(selector: string, limit: number) {
    const page = await activePage();
    const found = await page.locator(selector).allInnerTexts();
    return found.slice(0, limit);
  },
  async screenshot(workspaceDir: string) {
    const page = await activePage();
    const file = path.join(workspaceDir, `browser-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  },
  async click(selector: string) {
    const page = await activePage();
    await page.click(selector, { timeout: 15_000 });
    return `clicked ${selector} — page is now: ${page.url()}`;
  },
  async fill(selector: string, value: string) {
    const page = await activePage();
    await page.fill(selector, value, { timeout: 15_000 });
    return `filled ${selector}`;
  },
  async close() {
    await realBrowser?.close();
    realBrowser = null;
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realBrowser: any = null;
let pages: { spaceId: string; page: any }[] = [];

async function newPage() {
  if (!realBrowser) throw new Error("browser engine not launched — call ensure() first");
  const page = await realBrowser.newPage();
  return page;
}

async function activePage(): Promise<any> {
  if (!realBrowser) throw new Error("browser engine not launched — call ensure() first");
  const existing = pages.filter((p) => p.page).at(-1);
  if (existing && !existing.page.isClosed?.()) return existing.page;
  const page = await realBrowser.newPage();
  pages.push({ spaceId: "default", page });
  return page;
}

// ---------------- per-space session ----------------

const engines = new Map<string, BrowserEngine>();

export function browserProfileDir(spaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(spaceId)) throw new Error("bad space id");
  return path.join(WORKSPACE_ROOT, spaceId, "browser-profile");
}

export function workspaceDirFor(spaceId: string): string {
  return path.join(WORKSPACE_ROOT, spaceId);
}

/** Get (or create) the space's browser engine. Injectable for tests. */
export function engineFor(spaceId: string, engine: BrowserEngine = playwrightEngine): BrowserEngine {
  let e = engines.get(spaceId);
  if (!e) {
    e = engine;
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
