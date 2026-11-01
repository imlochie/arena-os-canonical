import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { dataRoot } from "./data-paths.mjs";
import { DesktopDatabase } from "./database.mjs";
import { createArenaBackup, restoreArenaBackup, verifyArenaBackup } from "./arena-backup.mjs";
import { killProcessTree } from "./process-tree.mjs";
import { stopBeforeQuit, stopDesktopServices } from "./shutdown.mjs";
import { createArcadeControl } from "./arcade/control.mjs";

app.setName("Arena");
app.setAppUserModelId("ai.arena.os");
let server;
let database;
let origin;
let window;
let stopping = false;
let log = () => {};
let arcade;

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
  return stopDesktopServices({ stopNative: () => arcade?.shutdown(), stopServices: stopBackendServices });
}

async function stopBackendServices() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const child = server;
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.connected) child.send("shutdown");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      log("shutdown", "API did not stop gracefully; terminating its process tree");
      await killProcessTree(child);
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error("The API process tree did not exit; the local database was left running.");
      }
    }
  }
  await database?.stop();
}

function passphraseDialog({ title, description, confirm = false }) {
  const prompt = new BrowserWindow({
    parent: window,
    modal: true,
    width: 440,
    height: confirm ? 370 : 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title,
    webPreferences: {
      preload: path.join(__dirname, "backup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const confirmField = confirm
    ? '<label>Confirm passphrase<input id="confirm" type="password" autocomplete="new-password" required></label>'
    : "";
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#111820;color:#f4f3ed;font:14px system-ui}
    p{color:#b7c0c7;line-height:1.5}label{display:grid;gap:7px;margin-top:17px;color:#d7dedf}
    input{width:100%;padding:11px;border:1px solid #46545c;border-radius:7px;background:#0b1015;color:white;font:inherit}
    footer{display:flex;justify-content:flex-end;gap:9px;margin-top:22px}button{padding:9px 16px;border:1px solid #46545c;border-radius:7px;background:#1b252d;color:#fff;font:inherit}
    button[type=submit]{background:#a6e85c;color:#12200b;border-color:#a6e85c;font-weight:700}#error{color:#ff9b8d;min-height:20px}
  </style><h2>${title}</h2><p>${description}</p>
  <form id="form"><label>Backup passphrase<input id="password" type="password" autocomplete="new-password" minlength="12" required></label>
  ${confirmField}<p id="error" role="alert"></p><footer><button id="cancel" type="button">Cancel</button><button type="submit">Continue</button></footer></form>
  <script>
    const form=document.getElementById("form"), password=document.getElementById("password");
    document.getElementById("cancel").onclick=()=>window.arenaBackupDialog.cancel();
    form.onsubmit=event=>{event.preventDefault();const value=password.value;
      if(value.length<12){document.getElementById("error").textContent="Use at least 12 characters.";return;}
      ${confirm ? 'if(value!==document.getElementById("confirm").value){document.getElementById("error").textContent="The passphrases do not match.";return;}' : ""}
      window.arenaBackupDialog.submit(value);
    };
    password.focus();
  </script>`;
  prompt.setMenuBarVisibility(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("arena-backup-passphrase", onSubmit);
      ipcMain.removeListener("arena-backup-cancel", onCancel);
      if (!prompt.isDestroyed()) prompt.close();
      resolve(value);
    };
    const onSubmit = (event, value) => {
      if (event.sender !== prompt.webContents || typeof value !== "string" || value.length < 12) return;
      finish(value);
    };
    const onCancel = event => {
      if (event.sender === prompt.webContents) finish(null);
    };
    ipcMain.on("arena-backup-passphrase", onSubmit);
    ipcMain.on("arena-backup-cancel", onCancel);
    prompt.once("closed", () => finish(null));
    void prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

function relaunch(dataDir = null) {
  const env = { ...process.env };
  if (dataDir) env.ARENA_DATA_DIR = dataDir;
  app.relaunch({ env });
  stopping = true;
  app.exit(0);
}

function setDataMenu(root) {
  const backup = async () => {
    const folder = await dialog.showOpenDialog(window, {
      title: "Choose where to save the Arena backup",
      properties: ["openDirectory", "createDirectory"],
    });
    if (folder.canceled || !folder.filePaths[0]) return;
    const passphrase = await passphraseDialog({
      title: "Protect the Arena backup",
      description: "This passphrase encrypts the matching database credential. Arena does not save it. You will need it to restore.",
      confirm: true,
    });
    if (!passphrase) return;
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Create Arena data backup",
      message: "Arena will pause and restart to make a safe database copy.",
      detail: "Includes Arena database records and the encrypted matching database credential. Excludes Waveyard audio and other files, downloaded models, and browser profiles.",
      buttons: ["Create backup", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return;
    try {
      await stop();
      const result = await createArenaBackup({
        root,
        parentDir: folder.filePaths[0],
        passphrase,
        databaseStopped: true,
      });
      await dialog.showMessageBox({
        type: "info",
        title: "Arena backup verified",
        message: "The database backup was verified file by file.",
        detail: `${result.backupDir}\n\nRestarting Arena now. Keep the backup passphrase safe.`,
      });
      relaunch();
    } catch (error) {
      dialog.showErrorBox("Arena backup failed", `${error.message}\n\nNo live database was copied. Arena will restart with the original data.`);
      relaunch();
    }
  };

  const restore = async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: "Select a verified Arena backup folder",
      properties: ["openDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return;
    try {
      const check = await verifyArenaBackup(selected.filePaths[0]);
      if (!check.ok) throw new Error(`Backup verification failed: ${check.mismatches.slice(0, 5).join("; ")}`);
    } catch (error) {
      dialog.showErrorBox("Arena backup could not be verified", error.message);
      return;
    }
    const target = await dialog.showOpenDialog(window, {
      title: "Choose a new, empty Arena data folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (target.canceled || !target.filePaths[0]) return;
    const passphrase = await passphraseDialog({
      title: "Unlock the Arena backup",
      description: "Enter the passphrase used when this backup was created. The backup only contains database records and its matching credential; Waveyard files and browser profiles are not included.",
    });
    if (!passphrase) return;
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Restore into a new data folder",
      message: "Arena will stop and restart using the selected folder.",
      detail: `Restore target: ${target.filePaths[0]}\nThe current Arena data folder will not be overwritten. The destination must be empty.`,
      buttons: ["Restore and restart", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return;
    let stopped = false;
    try {
      await stop();
      stopped = true;
      const result = await restoreArenaBackup({
        backupDir: selected.filePaths[0],
        targetRoot: target.filePaths[0],
        passphrase,
      });
      await dialog.showMessageBox({
        type: "info",
        title: "Arena data restored",
        message: "The backup and restored database files were verified.",
        detail: `PostgreSQL ${result.pgVersion}; ${result.fileCount} database files.\nRestarting Arena with the restored data folder now.`,
      });
      relaunch(result.targetRoot);
    } catch (error) {
      dialog.showErrorBox("Arena restore failed", `${error.message}\n\nThe current data folder was not overwritten.`);
      if (stopped) relaunch();
    }
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: "Data",
    submenu: [
      { label: "Create encrypted database backup…", click: () => void backup() },
      { label: "Restore backup to a new data folder…", click: () => void restore() },
    ],
  }]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void stopBeforeQuit({
      stop,
      askBeforeForceQuit: error => dialog.showMessageBoxSync({
        type: "error",
        title: "Arena could not confirm safe shutdown",
        message: "The local database may still be running.",
        detail: `${error.message}\n\nRetry shutdown is recommended. Force quit may interrupt database writes and require recovery the next time Arena starts.`,
        buttons: ["Retry shutdown", "Force quit anyway"],
        defaultId: 0,
        cancelId: 0,
      }) === 1,
      quit: () => app.quit(),
      log: error => log("shutdown", error instanceof Error ? error.message : String(error)),
    }).catch(error => {
      log("shutdown", error instanceof Error ? error.message : String(error));
      dialog.showErrorBox(
        "Arena shutdown could not continue",
        "Arena kept its process open because it could not confirm a safe shutdown. Check logs/desktop.log before forcing it closed.",
      );
    });
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
      ARENA_APP_BIN_DIR: path.join(resources, "bin"),
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, "arcade-preload.cjs") },
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
  try { arcade = await createArcadeControl({ root, resources, window, origin, ipcMain, dialog }); }
  catch (error) {
    log("arcade", `Native control unavailable: ${error.message}`);
    ipcMain.handle("arena-native-arcade", () => { throw new Error("Native management could not initialize; original games/saves were retained. Check the desktop log."); });
  }
  // A normal launch never enables remote debugging. Acceptance is explicit.
  log("runtime", `ready; platform=${process.platform}; version=${app.getVersion()}; data=${root}`);
  await window.loadURL(`${origin}/spaces`);
  setDataMenu(root);
}
