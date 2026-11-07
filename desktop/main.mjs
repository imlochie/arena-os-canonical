import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ARENA_BACKUP_SCOPES, ARENA_WAVEYARD_BACKUP_PARTS, dataRoot } from "./data-paths.mjs";
import { DesktopDatabase } from "./database.mjs";
import {
  backupContentSummary,
  createArenaBackup,
  estimateArenaBackup,
  readArenaBackupManifest,
  restoreArenaBackup,
  waveyardSelectionFromManifest,
} from "./arena-backup.mjs";
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
let serverStopRequested = false;
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

function formatBackupBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
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
    serverStopRequested = true;
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

function backupScopeDialog() {
  const prompt = new BrowserWindow({
    parent: window,
    modal: true,
    width: 570,
    height: 590,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Choose backup folders",
    webPreferences: {
      preload: path.join(__dirname, "backup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const choices = [
    ...ARENA_WAVEYARD_BACKUP_PARTS.map(part => [part.id, part.label, part.description]),
    ...ARENA_BACKUP_SCOPES
      .filter(scope => scope.id !== "waveyard-storage")
      .map(scope => [scope.id, scope.label, scope.id === "waveyard-models"
        ? "Locally downloaded model files; these can be large."
        : scope.id === "workspace-files"
          ? "Local project and workspace files. Browser profiles remain excluded."
          : "Highly sensitive: may include cookies, saved sessions, browsing history, and logged-in accounts. Excluded unless you check this box."]),
  ];
  const rows = choices.map(([id, title, description]) =>
    `<label class="${id === "browser-profiles" ? "sensitive" : ""}"><input type="checkbox" value="${id}"><span><strong>${title}</strong><small>${description}</small></span></label>`,
  ).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Choose backup folders</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#111820;color:#f4f3ed;font:14px system-ui}
    p{color:#b7c0c7;line-height:1.5}.choices{display:grid;gap:9px;margin-top:18px}
    label{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid #46545c;border-radius:8px;background:#182129}
    label.sensitive{border-color:#b77e46;background:#2a2119}input{margin-top:3px;accent-color:#a6e85c}
    span{display:grid;gap:4px}small{color:#b7c0c7;line-height:1.4}
    footer{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}button{padding:9px 16px;border:1px solid #46545c;border-radius:7px;background:#1b252d;color:#fff;font:inherit}
    button[type=submit]{background:#a6e85c;color:#12200b;border-color:#a6e85c;font-weight:700}
  </style><h2>Choose folders to include</h2>
  <p>The backup always includes Arena's database and matching credential. The passphrase encrypts every included file. Optional folders come from Arena's local data folder and restore into the new data folder.</p>
  <form id="form"><div class="choices">${rows}</div><footer><button id="cancel" type="button">Cancel</button><button type="submit">Continue</button></footer></form>
  <script>
    const form=document.getElementById("form");
    document.getElementById("cancel").onclick=()=>window.arenaBackupDialog.cancel();
    form.onsubmit=event=>{event.preventDefault();window.arenaBackupDialog.submitScope([...form.querySelectorAll("input:checked")].map(input=>input.value));};
  </script>`;
  prompt.setMenuBarVisibility(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("arena-backup-scope-submit", onSubmit);
      ipcMain.removeListener("arena-backup-cancel", onCancel);
      if (!prompt.isDestroyed()) prompt.close();
      resolve(value);
    };
    const onSubmit = (event, value) => {
      const validChoice = id =>
        ARENA_WAVEYARD_BACKUP_PARTS.some(part => part.id === id) ||
        ARENA_BACKUP_SCOPES.some(scope => scope.id === id && scope.id !== "waveyard-storage");
      if (event.sender === prompt.webContents && Array.isArray(value) && value.every(validChoice)) {
        finish([...new Set(value)]);
      }
    };
    const onCancel = event => {
      if (event.sender === prompt.webContents) finish(null);
    };
    ipcMain.on("arena-backup-scope-submit", onSubmit);
    ipcMain.on("arena-backup-cancel", onCancel);
    prompt.once("closed", () => finish(null));
    void prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

async function backupProgressDialog(controller) {
  const prompt = new BrowserWindow({
    parent: window,
    modal: true,
    width: 470,
    height: 370,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Creating Arena backup",
    webPreferences: {
      preload: path.join(__dirname, "backup-preload.mjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Creating Arena backup</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#111820;color:#f4f3ed;font:14px system-ui}
    p{color:#b7c0c7;line-height:1.5}.track{height:12px;background:#29343c;border-radius:8px;overflow:hidden}
    .bar{height:100%;width:0;background:#a6e85c;transition:width .12s}.section{margin:20px 0}
    .label{display:flex;justify-content:space-between;margin-bottom:7px}footer{display:flex;justify-content:flex-end;margin-top:22px}
    button{padding:9px 16px;border:1px solid #46545c;border-radius:7px;background:#1b252d;color:#fff;font:inherit}
  </style><h2>Creating Arena backup</h2><p id="status">Preparing to stop Arena safely…</p>
  <div class="section"><div class="label"><strong>Copying files</strong><span id="copy-count">Waiting</span></div><div class="track"><div class="bar" id="copy-bar"></div></div><p id="copy-size">Not started</p></div>
  <div class="section"><div class="label"><strong>Verifying backup</strong><span id="verify-count">Waiting</span></div><div class="track"><div class="bar" id="verify-bar"></div></div><p id="verify-size">Not started</p></div>
  <footer><button id="cancel" type="button">Cancel backup</button></footer>
  <script>
    const format=n=>{if(!Number.isFinite(n))return "—";if(n<1024)return n+" B";const u=["KiB","MiB","GiB","TiB"];let v=n,i=-1;do{v/=1024;i++;}while(v>=1024&&i<u.length-1);return v.toFixed(1)+" "+u[i];};
    window.arenaBackupDialog.onProgress(value=>{
      const phase=value.phase==="verify"?"verify":"copy";
      const count=document.getElementById(phase+"-count"),size=document.getElementById(phase+"-size"),bar=document.getElementById(phase+"-bar");
      const done=value.completedFiles||0,total=value.totalFiles||0,bytes=value.completedBytes||0,totalBytes=value.totalBytes||0;
      count.textContent=done+" / "+total+" files";
      size.textContent=format(bytes)+" / "+format(totalBytes);
      bar.style.width=(totalBytes>0?Math.min(100,bytes/totalBytes*100):(total>0?done/total*100:0))+"%";
      document.getElementById("status").textContent=phase==="copy"?"Encrypting selected files…":"Checking every backup file…";
    });
    document.getElementById("cancel").onclick=()=>{document.getElementById("cancel").disabled=true;document.getElementById("status").textContent="Canceling safely…";window.arenaBackupDialog.cancelBackup();};
  </script>`;
  prompt.setMenuBarVisibility(false);
  let closedNormally = false;
  const onCancel = event => {
    if (event.sender === prompt.webContents && !controller.signal.aborted) {
      controller.abort(new Error("Arena backup canceled."));
    }
  };
  ipcMain.on("arena-backup-progress-cancel", onCancel);
  prompt.once("closed", () => {
    ipcMain.removeListener("arena-backup-progress-cancel", onCancel);
    if (!closedNormally && !controller.signal.aborted) {
      controller.abort(new Error("Arena backup canceled."));
    }
  });
  await prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return {
    update: value => {
      if (!prompt.isDestroyed()) prompt.webContents.send("arena-backup-progress", value);
    },
    close: () => {
      closedNormally = true;
      if (!prompt.isDestroyed()) prompt.close();
      ipcMain.removeListener("arena-backup-progress-cancel", onCancel);
    },
  };
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
    const selectedFolders = await backupScopeDialog();
    if (!selectedFolders) return;
    const waveyardSelection = selectedFolders.filter(id =>
      ARENA_WAVEYARD_BACKUP_PARTS.some(part => part.id === id),
    );
    const localFolders = selectedFolders.filter(id => !waveyardSelection.includes(id));
    const selectedFolderLabels = selectedFolders.map(id =>
      ARENA_WAVEYARD_BACKUP_PARTS.find(part => part.id === id)?.label ??
      ARENA_BACKUP_SCOPES.find(scope => scope.id === id)?.label ??
      id,
    );
    let estimate;
    try {
      estimate = await estimateArenaBackup({ root, localFolders, waveyardSelection });
    } catch (error) {
      dialog.showErrorBox("Arena backup estimate failed", `${error.message}\n\nArena has not paused and no backup was created.`);
      return;
    }
    const folder = await dialog.showOpenDialog(window, {
      title: "Choose where to save the Arena backup",
      properties: ["openDirectory", "createDirectory"],
    });
    if (folder.canceled || !folder.filePaths[0]) return;
    const passphrase = await passphraseDialog({
      title: "Protect the Arena backup",
      description: "This passphrase encrypts every included file. Arena does not save it; if you lose it, the backup cannot be restored.",
      confirm: true,
    });
    if (!passphrase) return;
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Create Arena data backup",
      message: `Arena will pause and restart to make a safe database copy. Estimated total: ${estimate.fileCount} files (${formatBackupBytes(estimate.totalBytes)}).`,
      detail: `Estimated files by folder:\n${estimate.folderEstimates.map(group => `${group.label}: ${group.fileCount} files (${formatBackupBytes(group.totalBytes)})`).join("\n")}\n\nIncludes selected folders: ${selectedFolderLabels.join(", ") || "none"}. Sizes are estimates and may change before copying. The passphrase encrypts every included file. Browser profiles ${localFolders.includes("browser-profiles") ? "can contain cookies, saved sessions, browsing history, and logged-in accounts; include them only if you accept copying that sensitive data." : "are excluded."}`,
      buttons: ["Create backup", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return;
    const controller = new AbortController();
    let progress;
    try {
      progress = await backupProgressDialog(controller);
      await stop();
      if (controller.signal.aborted) throw controller.signal.reason;
      progress.update({ phase: "copy", completedFiles: 0, totalFiles: estimate.fileCount, completedBytes: 0, totalBytes: estimate.totalBytes });
      const result = await createArenaBackup({
        root,
        parentDir: folder.filePaths[0],
        passphrase,
        databaseStopped: true,
        localFolders,
        waveyardSelection,
        signal: controller.signal,
        onProgress: value => progress.update(value),
      });
      progress.close();
      progress = null;
      const summary = result.summary;
      await dialog.showMessageBox({
        type: "info",
        title: "Arena backup verified",
        message: `Every included file was verified. Database: ${summary.databaseFileCount} files (${formatBackupBytes(summary.databaseBytes)}); optional local files: ${summary.localFileCount} (${formatBackupBytes(summary.localBytes)}).`,
        detail: `${result.backupDir}\n\nAll file contents in this backup are encrypted. Keep the passphrase safe; Arena cannot recover it.\nRestarting Arena now.`,
      });
      relaunch();
    } catch (error) {
      progress?.close();
      const canceled = controller.signal.aborted;
      dialog.showErrorBox(
        canceled ? "Arena backup canceled" : "Arena backup failed",
        `${canceled ? "The incomplete backup was removed." : error.message}\n\nArena will restart with the original data.`,
      );
      relaunch();
    }
  };

  const restore = async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: "Select an Arena backup folder",
      properties: ["openDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return;
    let manifest;
    try {
      manifest = await readArenaBackupManifest(selected.filePaths[0]);
    } catch (error) {
      dialog.showErrorBox("Arena backup could not be opened", error.message);
      return;
    }
    const target = await dialog.showOpenDialog(window, {
      title: "Choose a new, empty Arena data folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (target.canceled || !target.filePaths[0]) return;
    const summary = backupContentSummary(manifest);
    const waveyardSelection = waveyardSelectionFromManifest(manifest);
    const includesWaveyardFiles = waveyardSelection.length > 0;
    const waveyardFileCount = summary?.waveyardFileCount ?? null;
    const legacyReadableBackup = manifest.version === 1;
    const backupScopes = manifest.localFolders ??
      (includesWaveyardFiles ? ["waveyard-storage"] : []);
    const selectedFolderLabels = [
      ...waveyardSelection.map(id =>
        ARENA_WAVEYARD_BACKUP_PARTS.find(part => part.id === id)?.label ?? id,
      ),
      ...backupScopes
        .filter(id => id !== "waveyard-storage")
        .map(id => ARENA_BACKUP_SCOPES.find(scope => scope.id === id)?.label ?? id),
    ];
    const waveyardRestoreDetail = !includesWaveyardFiles
      ? "This backup does not contain Waveyard files."
      : legacyReadableBackup
        ? waveyardFileCount === 0
          ? "No Waveyard files were present."
          : `Included Waveyard folders: ${waveyardSelection.map(id => ARENA_WAVEYARD_BACKUP_PARTS.find(part => part.id === id)?.label ?? id).join(", ")}.`
        : `Only files in these selected Waveyard folders are restored: ${waveyardSelection.map(id => ARENA_WAVEYARD_BACKUP_PARTS.find(part => part.id === id)?.label ?? id).join(", ")}.`;
    const passphrase = await passphraseDialog({
      title: "Unlock the Arena backup",
      description: legacyReadableBackup
        ? `This older backup encrypts only the database credential; its database and optional files are readable. Included folders: ${selectedFolderLabels.join(", ") || "none"}.`
        : `Enter the passphrase used when this backup was created. It encrypts all included files. Included folders: ${selectedFolderLabels.join(", ") || "none"}. Browser profiles ${backupScopes.includes("browser-profiles") ? "may contain cookies, saved sessions, browsing history, and logged-in accounts" : "are not included"}.`,
    });
    if (!passphrase) return;
    const confirmation = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Restore into a new data folder",
      message: "Arena will stop and restart using the selected folder.",
      detail: `Restore target: ${target.filePaths[0]}\nSelected folders: ${selectedFolderLabels.join(", ") || "none"}. ${legacyReadableBackup ? "This older backup contains readable database and optional files." : "Files are encrypted and will be decrypted locally into the new folder."} ${backupScopes.includes("browser-profiles") ? "Included browser profiles may contain cookies, saved sessions, history, and logged-in accounts." : "Browser profiles are not included."}\n${waveyardRestoreDetail}\nThe current Arena data folder will not be overwritten. The destination must be empty.`,
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
      const hasRestoredWaveyardFiles = result.waveyardFileCount > 0;
      await dialog.showMessageBox({
        type: "info",
        title: "Arena data restored",
        message: hasRestoredWaveyardFiles
          ? "The database and Waveyard files were restored and verified."
          : includesWaveyardFiles
            ? "The database was restored and verified; this backup contained no Waveyard files."
            : "The backup and restored files were verified.",
        detail: `PostgreSQL ${result.pgVersion}; ${result.fileCount} database files; ${result.localFileCount} optional files${includesWaveyardFiles ? `, including ${result.waveyardFileCount} Waveyard files (${formatBackupBytes(result.waveyardBytes)})` : ""}.\nRestarting Arena with the restored data folder now.`,
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
      { label: "Create encrypted Arena backup…", click: () => void backup() },
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
    // A stop Arena asked for (backup restore, shutdown) is not a crash.
    if (window && !stopping && !serverStopRequested) {
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
