/**
 * Arena desktop shell — Electron main process (Phase 1).
 *
 * Owns Windows/runtime concerns only: app identity, single instance,
 * data directory, logging, crash handling, the child-process registry,
 * a hardened window, the native menu, and the typed IPC surface.
 * The Arena application itself is untouched and remains a Next.js app;
 * Phase 2 embeds its server behind the real /api/health handshake.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  DesktopAppInfoSchema,
  DesktopDiagnosticsSchema,
  DESKTOP_DIAGNOSTICS_CHANNEL,
  DESKTOP_INFO_CHANNEL,
  type DesktopAppInfo,
  type DesktopDiagnostics,
} from "./contracts";
import { ArenaLogger } from "./log";
import { resolveArenaDataDirs, type ArenaDataDirs } from "./paths";
import { ChildProcessRegistry } from "./processes";
import { isAllowedFrameUrl, type FramePolicy } from "./security";
import { ArenaRuntimeSupervisor, resolveRuntimeConfig, type RuntimeStatus } from "./runtime";

const smokePath = process.env.ARENA_DESKTOP_SMOKE;

if (smokePath) app.disableHardwareAcceleration();
app.setName("Arena");
app.setAppUserModelId("ai.arena.os");

let logger: ArenaLogger | undefined;
let mainWindow: BrowserWindow | undefined;
let dirs: ArenaDataDirs | undefined;
let supervisor: ArenaRuntimeSupervisor | undefined;
let runtimeServerUrl: string | undefined;
let quitting = false;

/** Every child process the shell ever spawns is tracked here. */
const childProcesses = new ChildProcessRegistry();

// ---------------------------------------------------------------------------
// Single instance + deep-link groundwork
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((arg) => arg.startsWith("arena://"));
    if (deepLink)
      void logger?.info("protocol", "deep link received", { link: deepLink });
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void bootstrap();
}

async function bootstrap(): Promise<void> {
  const ready = app.whenReady();
  dirs = resolveDataDirs();
  for (const dir of [
    dirs.data,
    dirs.projects,
    dirs.waveyard,
    dirs.cache,
    dirs.logs,
    dirs.models,
    dirs.runtime,
    dirs.settings,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  logger = new ArenaLogger({ dir: dirs.logs });
  await logger.init();
  await logger.info("boot", "Arena desktop shell starting", {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    dataDir: dirs.root,
    dataDirSource: dirs.source,
    portable: dirs.portable,
  });

  registerCrashHandlers();
  registerIpc();
  registerWebContentsGuards();

  if (process.platform === "win32" && app.isPackaged) {
    try {
      app.setAsDefaultProtocolClient("arena");
    } catch (error) {
      await logger.warn("protocol", "could not register arena:// protocol", {
        error: String(error),
      });
    }
  }

  await ready;
  Menu.setApplicationMenu(buildMenu());
  // The local Arena server origin is added once the runtime is healthy.
  const allowedOrigins: string[] = [];
  const framePolicy: FramePolicy = {
    allowedOrigins,
    allowFileUrls: true, // Splash only, during startup.
  };
  mainWindow = createWindow(framePolicy);
  void mainWindow.loadFile(
    path.join(__dirname, "..", "splash", "index.html"),
  );
  mainWindow.webContents.once("did-finish-load", () => {
    if (smokePath) void runSmokeCheck();
  });

  if (!smokePath) {
    // The real lifecycle: DB → migrations → server → health → window.
    try {
      const config = await resolveRuntimeConfig({
        dirs,
        appRoot: resolveAppRoot(),
        nodeBinary: process.execPath,
        serverMode: app.isPackaged ? "packaged" : "dev",
      });
      supervisor = new ArenaRuntimeSupervisor(config, { logger: loggerAdapter() });
      runtimeServerUrl = await supervisor.start();
      const origin = new URL(runtimeServerUrl).origin;
      allowedOrigins.push(origin);
      await logger?.info("runtime", "server healthy; loading Arena UI", { url: runtimeServerUrl });
      if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(runtimeServerUrl);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logger?.error("runtime", "runtime startup failed", { error: message });
      showStartupFailure(message);
    }
  }

  app.on("window-all-closed", () => {
    app.quit();
  });
  app.on("activate", () => {
    // Re-open on the healthy server URL when it exists, else the splash.
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow({
        allowedOrigins: runtimeServerUrl !== undefined ? [new URL(runtimeServerUrl).origin] : [],
        allowFileUrls: true,
      });
      if (runtimeServerUrl !== undefined) void mainWindow.loadURL(runtimeServerUrl);
      else void mainWindow.loadFile(path.join(__dirname, "..", "splash", "index.html"));
    }
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      try {
        await logger?.info("boot", "shutting down; ordered runtime stop", {
          children: childProcesses.size,
        });
        await supervisor?.stop(); // server first, then Postgres
        await childProcesses.shutdownAll(4000);
      } finally {
        app.quit();
      }
    })();
  });
}

function resolveDataDirs(): ArenaDataDirs {
  const appPath = (name: Parameters<typeof app.getPath>[0]): string | undefined => {
    try {
      return app.getPath(name);
    } catch {
      return undefined;
    }
  };
  return resolveArenaDataDirs({
    platform: process.platform,
    env: process.env,
    localAppData: process.env.LOCALAPPDATA,
    appDataHome: appPath("appData"),
    xdgDataHome: process.env.XDG_DATA_HOME,
    homeDir: appPath("home"),
    exeDir: app.isPackaged ? path.dirname(app.getPath("exe")) : undefined,
    fileExists: existsSync,
  });
}

// ---------------------------------------------------------------------------
// Crash handling — real diagnostics, never a generic shrug
// ---------------------------------------------------------------------------

function registerCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    void handleFatal("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    void handleFatal(
      "unhandledRejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}

async function handleFatal(kind: string, error: Error): Promise<void> {
  try {
    await logger?.error("main", `fatal: ${kind}`, {
      message: error.message,
      stack: error.stack ?? undefined,
    });
  } catch {
    /* logging must never mask the crash */
  }
  const logHint =
    dirs !== undefined ? `Logs: ${dirs.logs}` : "Logs: (data dir unresolved)";
  if (app.isReady()) {
    try {
      dialog.showMessageBoxSync({
        type: "error",
        title: "Arena — unexpected error",
        message: `Arena hit an unexpected ${kind} and must close.`,
        detail: `${error.message}\n\n${error.stack ?? ""}\n\n${logHint}`,
        buttons: ["OK"],
      });
    } catch {
      /* headless */
    }
  }
  app.exit(1);
}

// ---------------------------------------------------------------------------
// Window + security wiring
// ---------------------------------------------------------------------------

function createWindow(startupPolicy: FramePolicy): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#0b0d12",
    title: "Arena",
    icon: resolveIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  const policy = startupPolicy;
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedFrameUrl(url, policy)) {
      event.preventDefault();
      void logger?.warn("security", "blocked navigation", { url });
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // External http(s) links go to the user's browser, never a new window.
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    else void logger?.warn("security", "blocked window.open", { url });
    return { action: "deny" };
  });
  win.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback) => {
      void logger?.warn("security", "permission request denied", { permission });
      callback(false);
    },
  );
  win.webContents.on("render-process-gone", (_event, details) => {
    void logger?.error("window", "renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "error",
      title: "Arena — window crashed",
      message: `The Arena window process stopped (${details.reason}).`,
      detail: "Reload the window, or quit. Nothing was hidden from you: details are in the Logs folder.",
      buttons: ["Reload", "Quit"],
      defaultId: 0,
    });
    if (choice === 0) win.reload();
    else app.quit();
  });
  win.webContents.on("unresponsive", () => {
    void logger?.warn("window", "renderer unresponsive");
  });

  return win;
}

function resolveIcon(): string | undefined {
  const icon = path.join(__dirname, "..", "..", "assets", "icon.png");
  return existsSync(icon) ? icon : undefined;
}

function registerWebContentsGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
      void logger?.warn("security", "webview attach blocked");
    });
  });
}

// ---------------------------------------------------------------------------
// Typed IPC surface (contracts.ts is the whole allowlist)
// ---------------------------------------------------------------------------

function buildAppInfo(): DesktopAppInfo {
  return DesktopAppInfoSchema.parse({
    name: "Arena",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
    dataDir: dirs?.root ?? "",
    portable: dirs?.portable ?? false,
    channel: app.isPackaged ? "stable" : "dev",
  });
}

function registerIpc(): void {
  ipcMain.handle(DESKTOP_INFO_CHANNEL, () => buildAppInfo());
  ipcMain.handle(DESKTOP_DIAGNOSTICS_CHANNEL, () => collectDiagnostics());
}


// ---------------------------------------------------------------------------
// Runtime supervisor helpers
// ---------------------------------------------------------------------------

/** Packaged: resources/app root (extraResources target); dev: repo root. */
function resolveAppRoot(): string {
  if (app.isPackaged) {
    // extraResources are resolved relative to the executable's resources dir
    return path.join(path.dirname(app.getPath("exe")), "resources", "app");
  }
  // dev: desktop/ is compiled in place — repo root is two levels up
  return path.join(__dirname, "..", "..");
}

/** ArenaLogger → supervisor logger adapter (scope-first signatures). */
function loggerAdapter() {
  return {
    info: (scope: string, message: string, detail?: Record<string, unknown>) => void logger?.info(scope, message, detail),
    warn: (scope: string, message: string, detail?: Record<string, unknown>) => void logger?.warn(scope, message, detail),
    error: (scope: string, message: string, detail?: Record<string, unknown>) => void logger?.error(scope, message, detail),
  };
}

function showStartupFailure(message: string): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  const html = `data:text/html,${encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><title>Arena — startup failed</title>` +
      `<style>body{font:14px system-ui;background:#0b0d12;color:#e8eaf0;padding:40px;max-width:640px;margin:auto}` +
      `h1{font-size:18px}pre{white-space:pre-wrap;background:#14171f;padding:12px;border-radius:8px;color:#ff9d9d}</style></head>` +
      `<body><h1>Arena could not start its local runtime</h1>` +
      `<p>The application server, database, or worker did not become healthy. Nothing was skipped or faked:</p>` +
      `<pre>${message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c)}</pre>` +
      `<p>Details are in the logs folder (File → Open Logs Folder). The app will close when you close this window.</p></body></html>`,
  )}`;
  void mainWindow.loadURL(html);
}

async function collectDiagnostics(): Promise<DesktopDiagnostics> {
  const runtime: RuntimeStatus | null = supervisor?.status ?? null;
  let subsystems: DesktopDiagnostics["subsystems"] = null;
  if (runtimeServerUrl !== undefined) {
    try {
      const response = await fetch(`${runtimeServerUrl}/api/desktop/diagnostics`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const parsed = z.object({ overall: z.enum(["READY", "DEGRADED", "UNAVAILABLE"]), components: z.record(z.string(), z.any()), checkedAt: z.string() }).safeParse(await response.json());
        if (parsed.success) subsystems = parsed.data;
      }
    } catch {
      // server unreachable: report honestly below
    }
  }
  return DesktopDiagnosticsSchema.parse({
    runtime: runtime ?? { phase: "idle", serverUrl: null, stages: [], postgres: null, lastError: null },
    subsystems,
    source: subsystems === null ? "main-process-server-unreachable" : "main-process",
  });
}

// ---------------------------------------------------------------------------
// Native menu
// ---------------------------------------------------------------------------

function buildMenu(): Menu {
  const openFolder = (target: string, label: string) => async () => {
    const errorMessage = await shell.openPath(target);
    if (errorMessage !== "")
      await logger?.error("menu", `could not open ${label}`, {
        target,
        errorMessage,
      });
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Open Data Folder", click: () => void openFolder(dirs?.root ?? "", "data folder") },
        { label: "Open Logs Folder", click: () => void openFolder(dirs?.logs ?? "", "logs folder") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "About Arena",
          click: () => {
            const info = buildAppInfo();
            dialog.showMessageBoxSync({
              type: "info",
              title: "About Arena",
              message: `Arena ${info.version} (${info.channel})`,
              detail: [
                `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
                `Platform: ${info.platform} ${info.arch}${info.portable ? " (portable)" : ""}`,
                `Data: ${info.dataDir}`,
              ].join("\n"),
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------
// Smoke mode: launch, verify the shell end-to-end, write results, exit
// ---------------------------------------------------------------------------

function armSmokeWatchdog(): void {
  const watchdog = setTimeout(() => {
    writeSmokeResult({ ok: false, error: "smoke watchdog timeout (30s)" });
    app.exit(1);
  }, 30_000);
  watchdog.unref?.();
}

function writeSmokeResult(result: Record<string, unknown>): void {
  if (!smokePath) return;
  try {
    writeFileSync(smokePath, JSON.stringify(result, null, 2), "utf8");
  } catch {
    /* the harness treats a missing file as failure */
  }
}

async function runSmokeCheck(): Promise<void> {
  const win = mainWindow;
  if (win === undefined) {
    writeSmokeResult({ ok: false, error: "no main window" });
    app.exit(1);
    return;
  }
  const result: Record<string, unknown> = {
    singleInstance: gotLock,
    windowCreated: true,
    appVersion: app.getVersion(),
  };
  try {
    const bridgePresent =
      await win.webContents.executeJavaScript(
        "typeof window.arenaDesktop === 'object' && typeof window.arenaDesktop.getInfo === 'function'",
      );
    result.preloadBridge = bridgePresent;
    const raw = await win.webContents.executeJavaScript(
      "window.arenaDesktop.getInfo()",
    );
    const parsed = DesktopAppInfoSchema.safeParse(raw);
    result.ipcRoundtrip = parsed.success;
    if (parsed.success) result.info = parsed.data;
    result.ok = bridgePresent === true && parsed.success === true;
  } catch (error) {
    result.ok = false;
    result.error = String(error);
  }
  void logger?.info("smoke", "smoke check finished", { ok: result.ok });
  writeSmokeResult(result);
  app.exit(result.ok === true ? 0 : 1);
}
