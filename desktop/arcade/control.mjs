import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArcadePackages } from "./packages.mjs";
import { NativeArcadeHost } from "./host.mjs";
import { nativeGameManifest } from "./manifest.mjs";
import { RepositoryBuilds, validateSourceSnapshot } from "./repository-builds.mjs";
export function assertArcadeSender(event, window, origin, payload) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
    new URL(event.senderFrame.url).origin !== origin) throw new Error("Native Arcade is restricted to the owning desktop main frame.");
  if (!payload || !["inspect", "probe", "install", "launch", "stop", "remove", "cancel", "build-source", "select-version", "install-release", "reset-build-tool"].includes(payload.action) ||
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
  const host = new NativeArcadeHost({ packages, helper: path.join(resources, "native", "arena-native-host.exe") });
  const repositories = new RepositoryBuilds({ packages, host });
  await repositories.initialize();
  await packages.initialize();
  await host.initialize();
  let storageCache, storageCheckedAt = 0;
  const inspect = async () => {
    const runtime = host.snapshot();
    if (!storageCache || Date.now() - storageCheckedAt > 30_000) { storageCache = await packages.storage(); storageCheckedAt = Date.now(); }
    return { packages: packages.snapshot(), storage: storageCache, ...runtime, operation, canCancel: !!acquisition, repository: repositories.snapshot(),
      managedGames: [...packages.catalog.values()].filter(item => item.kind === "game").map(item => nativeGameManifest(item, packages.state.packages[`${item.id}@${item.version}`], runtime.host)) };
  };
  const approve = async (message, detail) => (await dialog.showMessageBox(window, { type: "warning", message, detail, buttons: ["Approve", "Cancel"], defaultId: 1, cancelId: 1 })).response === 0;
  let operation = false;
  let acquisition;
  let workshop;
  ipcMain.handle("arena-native-mod-workshop", async (event, data) => {
    assertArcadeSender(event, window, origin, { action: "inspect" });
    if (!data || typeof data !== "object" || JSON.stringify(data).length > 32 * 1024 * 1024 || !["list", "inspect", "create", "review", "commit", "activate", "rollback", "export", "launch"].includes(data.op)) throw new Error("Invalid mod workshop request.");
    if (operation) throw new Error("Another native operation is active.");
    operation = true;
    try {
      if (!workshop) { const { NativeModWorkshop } = await import("./workshop.mjs"); workshop = new NativeModWorkshop(packages, host); await workshop.initialize(); }
      if (data.op === "list") return Promise.all([...packages.catalog].filter(([key, item]) => item.kind === "game" && packages.state.packages[key]?.phase === "ready").map(async ([key]) => (await workshop.engine.inspect(key)).game));
      if (data.op !== "commit" && (typeof data.key !== "string" || data.key.length > 200)) throw new Error("Select a managed game.");
      if (data.op === "inspect") return await workshop.engine.inspect(data.key);
      if (data.op === "create") return await workshop.engine.create(data.key, data.name, data.shareSaves, data.revision);
      if (data.op === "review") return await workshop.engine.review(data.key, data.profileId, data.change, data.revision);
      if (data.op === "export") return await workshop.engine.export(data.key, data.profileId);
      if (!await approve("Apply this native mod profile operation?", "Only the reviewed managed game profile is affected. The base installation remains immutable. Native launch still requires a successful Windows containment probe. Save sharing follows the profile's explicit setting.")) throw new Error("Native mod operation cancelled.");
      if (data.op === "commit") return await workshop.engine.commit(data.id);
      if (data.op === "activate") return await workshop.engine.activate(data.key, data.profileId, data.revision);
      if (data.op === "rollback") return await workshop.engine.rollback(data.key, data.profileId, data.revision);
      if (data.op === "launch") return await workshop.launch(data.key, data.profileId);
    } finally { operation = false; storageCache = undefined; }
  });
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
      if (payload.action === "reset-build-tool") {
        if (!["godot", "llvm", "sdl"].includes(payload.key)) throw new Error("Choose a registered SDK.");
        if (!await approve(`Reset disposable ${payload.key} build SDK cache?`, "Only this downloaded compiler/editor cache is removed. It is acquired again on the next approved build. Installed games, installed runtimes, all versions and saves remain unchanged.")) return inspect();
        await repositories.tools.reset(payload.key); return inspect();
      }
      if (payload.action === "select-version") {
        if (!await approve("Use a retained repository version?", "This switches the selected installed version only. Saves stay in the same separate game profile. Stop this game's running version first.")) return inspect();
        await repositories.selectVersion(payload.key); return inspect();
      }
      if (payload.action === "install-release") {
        if (!host.requirements().supportedHost) throw new Error(host.requirements().message);
        const match = /^([a-f0-9-]{36}):([0-3]):([0-9]|1[0-9]|2[0-3])$/.exec(payload.key ?? "");
        if (!match) throw new Error("Choose an asset from an unexpired release review.");
        acquisition = new AbortController();
        try {
          const response = await window.webContents.session.fetch(new URL("/api/arcade/import/repository/release", origin).href, {
            method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, credentials: "include",
            body: JSON.stringify({ token: match[1], releaseIndex: Number(match[2]), assetIndex: Number(match[3]), authorized: true }),
            signal: AbortSignal.any([acquisition.signal, AbortSignal.timeout(30_000)]),
          });
          if (Number(response.headers.get("content-length") ?? 0) > 256 * 1024) throw new Error("Release plan exceeds its limit.");
          const text = await response.text();
          if (text.length > 256 * 1024) throw new Error("Release plan exceeds its limit.");
          const plan = JSON.parse(text);
          if (!response.ok) throw new Error(plan.error ?? "Release review refused.");
          if (!await approve(`Install portable ${plan.provenance.repository} ${plan.tag}?`,
            `${plan.prerelease ? "PRE-RELEASE\n" : ""}${plan.asset.name}\n${plan.asset.bytes} download bytes\nPublisher SHA256: ${plan.asset.sha256}\n${plan.provenance.license.spdx}; full source notices retained.\nOnly a self-contained x64 ZIP with one game executable is accepted. No installer or game executes during acquisition. Previous versions and separate saves remain. Launch requires live LPAC verification; gameplay is not verified by this download.`)) return inspect();
          acquisition.signal.throwIfAborted(); await repositories.installRelease(plan, acquisition);
        } finally { acquisition = undefined; storageCache = undefined; }
        return inspect();
      }
      if (payload.action === "build-source") {
        if (!host.requirements().supportedHost) throw new Error(host.requirements().message);
        if (!/^[a-f0-9-]{36}$/.test(payload.key ?? "")) throw new Error("Choose an unexpired owner-bound repository review.");
        acquisition = new AbortController();
        try {
          const response = await window.webContents.session.fetch(new URL("/api/arcade/import/repository/source", origin).href, {
            method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, credentials: "include",
            body: JSON.stringify({ token: payload.key, authorized: true }),
            signal: AbortSignal.any([acquisition.signal, AbortSignal.timeout(90_000)]),
          });
          let total = 0; const chunks = [];
          if (!response.body) throw new Error("Repository source response was empty.");
          for await (const chunk of response.body) {
            total += chunk.length;
            if (total > 24 * 1024 * 1024) throw new Error("Repository source response exceeds its byte budget.");
            chunks.push(Buffer.from(chunk));
          }
          const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!response.ok) throw new Error(snapshot.error ?? "Source review was refused.");
          validateSourceSnapshot(snapshot);
          if (!await approve(`Build ${snapshot.provenance.repository} from pinned source?`,
            `${snapshot.provenance.revision}\n${snapshot.provenance.license.spdx}; source license retained.\nDownloads pinned Godot or LLVM/SDL SDKs on demand; no global installs, shell or README commands.\nLive LPAC verification is required. Build process: 512 MiB per process / 1 GiB total, 16 processes, 25% CPU, 5 minutes per command, 10-minute overall deadline. Network is disabled during execution.\nManaged budget 8 GiB with a best-effort 512 MiB free-space reserve, not a hard disk quota. Previous versions and separate saves are retained. Export/compile is not proof of playable gameplay.`)) return inspect();
          acquisition.signal.throwIfAborted();
          await repositories.build(snapshot, acquisition);
        } finally { acquisition = undefined; storageCache = undefined; }
        return inspect();
      }
      const descriptor = packages.catalog.get(payload.key);
      if (!descriptor) throw new Error("Choose a package from this build's trusted catalog.");
      if (payload.action === "install") {
        if (!await approve(`Install ${descriptor.id} ${descriptor.version}?`, `${descriptor.license}\nPinned archive: ${descriptor.sha256}\nDownload/staging: ${descriptor.downloadBytes} + ${descriptor.unpackedBytes} bytes.\nNo scripts or games execute during installation. Profiles/saves are separate.`)) return inspect();
        let source;
        if (repositories.state.catalog.some(row => `${row.id}@${row.version}` === payload.key)) {
          source = path.join(packages.root, "downloads", `${descriptor.sha256}.tar`);
        } else if (!descriptor.url) {
          const selection = await dialog.showOpenDialog(window, { title: `Choose ${payload.key}.tar from this installer build`, properties: ["openFile"], filters: [{ name: "Pinned Arena package", extensions: ["tar"] }] });
          if (selection.canceled || !selection.filePaths[0]) return inspect();
          source = selection.filePaths[0];
        }
        acquisition = new AbortController();
        try { await packages.install(payload.key, source, { signal: acquisition.signal }); }
        finally { acquisition = undefined; }
      } else if (payload.action === "launch") {
        if (!await approve(`Launch isolated ${descriptor.id}?`, "Requires a live Windows LPAC proof. Read-only game/runtime files; separate writable profile; no network or clipboard; 1 GiB Job memory, 16 processes, 25% CPU. Process startup is not verified gameplay.")) return inspect();
        if (Object.values(repositories.state.projects).some(project => project.versions.some(version => version.key === payload.key))) await repositories.selectVersion(payload.key);
        await host.launch(payload.key);
      } else if (payload.action === "remove") {
        if (!await approve(`Remove ${descriptor.id} ${descriptor.version}?`, "Only this managed installation is removed. Saves/profiles and other versions stay intact. Referenced or running runtimes cannot be removed.")) return inspect();
        await packages.remove(payload.key, host.runningKeys());
        await repositories.removed(payload.key);
      }
      return inspect();
    } finally { operation = false; storageCache = undefined; }
  });
  return { shutdown: async () => { acquisition?.abort(new Error("Desktop is stopping.")); await repositories.shutdown(); await host.shutdown(); },
    dispose: () => { ipcMain.removeHandler("arena-native-arcade"); ipcMain.removeHandler("arena-native-mod-workshop"); } };
}
