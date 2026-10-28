import { app, BrowserWindow, dialog, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { dataRoot } from "./data-paths.mjs";
import { DesktopDatabase } from "./database.mjs";

app.setName("Arena");
app.setAppUserModelId("ai.arena.os");
let server;
let database;
let origin;
let window;
let stopping = false;
let log = () => {};

function port() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const value = socket.address().port;
      socket.close(error => error ? reject(error) : resolve(value));
    });
  });
}

// Reuse the original secret file instead of changing the password of an
// existing cluster. Corrupt secrets fail explicitly, never silently regenerate.
function password(root) {
  const file = path.join(root, "runtime/db-password.json");
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, "utf8")).password;
    if (typeof value !== "string" || value.length < 16) throw new Error("Invalid local database password file; restore its backup");
    return value;
  }
  if (existsSync(path.join(root, "data/postgres/PG_VERSION"))) throw new Error("Existing database has no password file. Restore runtime/db-password.json from backup; no data was changed.");
  const value = randomBytes(24).toString("hex");
  writeFileSync(file, JSON.stringify({ password: value }), { mode: 0o600, flag: "wx" });
  return value;
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const child = server;
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.connected) child.send("shutdown");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      log("shutdown", "API did not stop gracefully; forcing termination");
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  }
  await database?.stop();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void stop().catch(error => {
      log("shutdown", error.message);
      dialog.showErrorBox("ArenaForge shutdown error", error.message);
    }).finally(() => app.quit());
  });
  void start().catch(async error => {
    log("startup", error.message);
    await app.whenReady();
    dialog.showErrorBox("ArenaForge could not start", `${error.message}\n\nYour existing data has not been deleted.`);
    app.quit();
  });
}

async function start() {
  await app.whenReady();
  const root = dataRoot({ exeDir: path.dirname(app.getPath("exe")), exists: existsSync });
  for (const dir of ["runtime", "logs", "data", "waveyard/storage", "waveyard/models"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  log = (scope, text) => appendFileSync(path.join(root, "logs/desktop.log"), `${new Date().toISOString()} [${scope}] ${text.trim()}\n`);
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "stage");
  const dbPassword = password(root);
  const dbPort = await port();
  database = new DesktopDatabase({ resources, root, port: dbPort, password: dbPassword, log });
  await database.start();

  // A stable origin preserves browser-local model selections across restarts.
  const portFile = path.join(root, "runtime/vite-express-port.json");
  let serverPort;
  if (existsSync(portFile)) {
    serverPort = JSON.parse(readFileSync(portFile, "utf8")).port;
    if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) throw new Error("Invalid persisted API port");
  } else {
    serverPort = await port();
    writeFileSync(portFile, JSON.stringify({ port: serverPort }), { mode: 0o600 });
  }
  origin = `http://127.0.0.1:${serverPort}`;
  const chromium = path.join(resources, "chromium/chrome.exe");
  if (!existsSync(chromium)) throw new Error("Packaged Chromium is missing; rebuild this Windows package");
  server = spawn(process.execPath, [path.join(resources, "server/index.mjs")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production",
      ARENA_DESKTOP_MODE: "1", ARENA_DATA_DIR: root, ARENA_RESOURCES_DIR: resources,
      ARENA_WEB_ROOT: path.join(resources, "web"), CHROMIUM_PATH: chromium,
      PORT: String(serverPort),
      DATABASE_URL: `postgres://arena:${encodeURIComponent(dbPassword)}@127.0.0.1:${dbPort}/arena`,
      WAVEYARD_STORAGE_DIR: process.env.ARENA_TEST_WAVEYARD_STORAGE_DIR ?? path.join(root, "waveyard/storage"),
      WAVEYARD_MODELS_DIR: process.env.ARENA_TEST_WAVEYARD_MODELS_DIR ?? path.join(root, "waveyard/models"),
      REDIS_URL: "",
    },
  });
  let failure;
  server.stdout.on("data", chunk => log("api", String(chunk)));
  server.stderr.on("data", chunk => log("api", String(chunk)));
  server.on("error", error => { failure = error.message; });
  server.on("exit", code => {
    failure = `API exited (${code})`;
    if (window && !stopping) {
      dialog.showErrorBox("ArenaForge API stopped", `${failure}. Restart ArenaForge; see the desktop log if this repeats.`);
      app.quit();
    }
  });
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (failure) throw new Error(failure);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
    } catch { /* wait for the local API to bind */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!healthy) throw new Error("Vite/Express runtime did not become healthy. Check logs/desktop.log; the saved port may be in use.");
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 650,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Report/capture popouts stay inside the local app; websites open outside it.
    if (new URL(url).origin === origin) return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // A normal launch never enables remote debugging. Acceptance is explicit.
  log("runtime", `ready; platform=${process.platform}; version=${app.getVersion()}; data=${root}`);
  await window.loadURL(`${origin}/spaces`);
}
