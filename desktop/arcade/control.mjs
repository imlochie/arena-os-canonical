import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArcadePackages } from "./packages.mjs";
import { NativeArcadeHost } from "./host.mjs";
import { nativeGameManifest } from "./manifest.mjs";
export function assertArcadeSender(event, window, origin, payload) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== origin) throw new Error("Native Arcade is restricted to the owning desktop main frame.");
  if (!payload || !["inspect", "probe", "install", "launch", "stop", "remove", "cancel"].includes(payload.action) ||
    Object.keys(payload).some(key => !["action", "key"].includes(key)) ||
    (payload.key !== undefined && (typeof payload.key !== "string" || payload.key.length > 200 || /[\0\r\n]/.test(payload.key))))
    throw new Error("Invalid structured native control request.");
}
export async function createArcadeControl({ root, resources, window, origin, ipcMain, dialog }) {
  let catalog = [];
  try {
    const raw = await readFile(path.join(resources, "arcade-catalog.json"), "utf8");
    if (raw.length > 2 * 1024 * 1024) throw new Error("Native catalog is oversized.");
    const value = JSON.parse(raw);
    if (value.schemaVersion !== 1 || !Array.isArray(value.packages)) throw new Error("Native catalog schema is unsupported.");
    catalog = value.packages;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const packages = new ArcadePackages({ root: path.join(root, "arcade"), catalog });
  await packages.initialize();
  const host = new NativeArcadeHost({ packages, helper: path.join(resources, "native", "arena-native-host.exe") });
  await host.initialize();
  const inspect = async () => {
    const runtime = host.snapshot();
    return { packages: packages.snapshot(), storage: await packages.storage(), ...runtime, operation, canCancel: !!acquisition,
      managedGames: [...packages.catalog.values()].filter(item => item.kind === "game").map(item => nativeGameManifest(item, packages.state.packages[`${item.id}@${item.version}`], runtime.host)) };
  };
  const approve = async (message, detail) => (await dialog.showMessageBox(window, { type: "warning", message, detail, buttons: ["Approve", "Cancel"], defaultId: 1, cancelId: 1 })).response === 0;
  let operation = false;
  let acquisition;
  ipcMain.handle("arena-native-arcade", async (event, payload) => {
    assertArcadeSender(event, window, origin, payload);
    if (payload.action === "inspect") return inspect();
    if (payload.action === "cancel") {
      if (!acquisition) throw new Error("No cancellable install is active. Use Cancel in the desktop approval/file dialog.");
      acquisition.abort(); return inspect();
    }
    if (payload.action === "stop") { await host.stop(payload.key); return inspect(); }
    if (operation) throw new Error("Another native approval or operation is still active.");
    operation = true;
    try {
      if (payload.action === "probe") { await host.probe(); return inspect(); }
      const descriptor = packages.catalog.get(payload.key);
      if (!descriptor) throw new Error("Choose a package from this build's trusted catalog.");
      if (payload.action === "install") {
        if (!await approve(`Install ${descriptor.id} ${descriptor.version}?`, `${descriptor.license}\nPinned archive: ${descriptor.sha256}\nDownload/staging: ${descriptor.downloadBytes} + ${descriptor.unpackedBytes} bytes.\nNo scripts or games execute during installation. Profiles/saves are separate.`)) return inspect();
        let source;
        if (!descriptor.url) {
          const selection = await dialog.showOpenDialog(window, { title: `Choose ${payload.key}.tar from this installer build`, properties: ["openFile"], filters: [{ name: "Pinned Arena package", extensions: ["tar"] }] });
          if (selection.canceled || !selection.filePaths[0]) return inspect();
          source = selection.filePaths[0];
        }
        acquisition = new AbortController();
        try { await packages.install(payload.key, source, { signal: acquisition.signal }); }
        finally { acquisition = undefined; }
      } else if (payload.action === "launch") {
        if (!await approve(`Launch isolated ${descriptor.id}?`, "Requires a live Windows LPAC proof. Read-only game/runtime files; separate writable profile; no network or clipboard; 1 GiB Job memory, 16 processes, 25% CPU. Process startup is not verified gameplay.")) return inspect();
        await host.launch(payload.key);
      } else if (payload.action === "remove") {
        if (!await approve(`Remove ${descriptor.id} ${descriptor.version}?`, "Only this managed installation is removed. Saves/profiles and other versions stay intact. Referenced or running runtimes cannot be removed.")) return inspect();
        await packages.remove(payload.key, host.runningKeys());
      }
      return inspect();
    } finally { operation = false; }
  });
  return { shutdown: () => host.shutdown(), dispose: () => ipcMain.removeHandler("arena-native-arcade") };
}
