import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILD_TOOLS, BuildTools } from "./build-tools.mjs";
import { packageDirectory } from "./directory-package.mjs";
import { packageKey, safePackagePath, validatePackageDescriptor } from "./packages.mjs";
import { downloadPinnedZip, extractSelectedZip, sha256File } from "./pinned-zip.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const categories = ["downloads", "staging", "installed", "profiles", "build-cache"];
const RECIPES = Object.freeze({
  godot: "godot4-standard-pack-v1",
  sdl: "sdl2-single-c-windows-x64-v1",
});
/** The sandbox is stopped before main-process output handling. Reject reparse
 * points/hard links anywhere in its writable tree BEFORE host reads/copies or
 * writes provenance; never follow a tool-script-created junction as the owner. */
export async function verifyStoppedWorkspace(root, managedRoot) {
  const relative = path.relative(managedRoot, root);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Build workspace escaped its managed root.");
  let cursor = managedRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Build replaced a workspace ancestor with a link.");
  }
  let entries = 0, bytes = 0;
  const { readdir } = await import("node:fs/promises");
  const walk = async directory => {
    for (const name of await readdir(directory)) {
      if (++entries > 20000) throw new Error("Build workspace exceeds its entry budget.");
      const filename = path.join(directory, name), info = await lstat(filename);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error("Build created a link; owner-side output handling is blocked.");
      if (info.isDirectory()) await walk(filename);
      else if (!info.isFile() || (bytes += info.size) > 1024 * 1024 * 1024) throw new Error("Build workspace exceeds its regular-file byte budget.");
    }
  };
  await walk(root);
}
export function sourceBuildIdentity(snapshot) {
  return hash(JSON.stringify({ revision: snapshot.provenance.revision, files: snapshot.files.map(({ path, sha }) => [path, sha]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    recipe: RECIPES[snapshot.projectType], tools: snapshot.projectType === "godot" ? [BUILD_TOOLS.godot.sha256] : [BUILD_TOOLS.llvm.sha256, BUILD_TOOLS.sdl.sha256] }));
}
export function repositoryIdentity(repository, folder) {
  return `repo-${hash(`github:${repository.toLowerCase()}:${folder}`).slice(0, 32)}`;
}
export function validateSourceSnapshot(snapshot) {
  if (!snapshot || !RECIPES[snapshot.projectType] || typeof snapshot.folder !== "string" ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(snapshot.provenance?.repository ?? "") ||
      !/^[a-f0-9]{40}$/.test(snapshot.provenance?.revision ?? "") ||
      typeof snapshot.provenance?.license?.text !== "string" || snapshot.provenance.license.text.length > 128 * 1024 ||
      !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 256) throw new Error("Invalid source review.");
  if (snapshot.folder) safePackagePath(snapshot.folder.replace(/\/$/, ""));
  const seen = new Set(); let total = 0;
  for (const file of snapshot.files) {
    safePackagePath(file.path);
    if (!file.path.startsWith(snapshot.folder) || seen.has(file.path.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{40}$/.test(file.sha) ||
        typeof file.contentBase64 !== "string" || file.contentBase64.length > Math.ceil(file.size / 3) * 4) throw new Error("Source paths or sizes differ from the reviewed project.");
    seen.add(file.path.toLowerCase()); total += file.size;
    if (total > 16 * 1024 * 1024) throw new Error("Source exceeds its 16 MiB budget.");
    const bytes = Buffer.from(file.contentBase64, "base64");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (bytes.length !== file.size || blob !== file.sha) throw new Error(`Pinned source blob mismatch: ${file.path}`);
  }
  if (snapshot.projectType === "godot" && !seen.has(`${snapshot.folder}project.godot`.toLowerCase())) throw new Error("Godot project entry is missing.");
  if (snapshot.projectType === "sdl" && (!seen.has(`${snapshot.folder}main.c`.toLowerCase()) ||
      snapshot.files.filter(file => /\.(?:c|cpp|cc|cxx)$/i.test(file.path)).length !== 1)) throw new Error("The bounded SDL recipe supports one root main.c, local headers and assets. Multi-unit/C++ layouts require a separate recipe.");
  return snapshot;
}
async function requireWindowsPE(filename) {
  const file = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const offset = buffer.readUInt32LE(0x3c);
    if (bytesRead < 64 || buffer.toString("ascii", 0, 2) !== "MZ" || offset < 64 || offset + 6 > bytesRead ||
        buffer.toString("ascii", offset, offset + 4) !== "PE\0\0" || buffer.readUInt16LE(offset + 4) !== 0x8664) throw new Error("Build output is not a Windows x64 PE executable.");
  } finally { await file.close(); }
}
/** Owns source builds independently of browser games/saves. Repository strings
 * never become shell commands; all executable paths and flags come from recipes. */
export class RepositoryBuilds {
  constructor({ packages, host }) {
    this.packages = packages; this.host = host;
    this.filename = path.join(packages.root, "repository-builds.json");
    this.state = { schemaVersion: 1, catalog: [], projects: {}, jobs: [] };
    this.active = null;
    this.tools = new BuildTools({ packages, preflight: bytes => this.preflight(bytes), log: text => this.log(text) });
  }
  async initialize() {
    try {
      const raw = await readFile(this.filename, "utf8");
      if (raw.length > 16 * 1024 * 1024) throw new Error("Repository catalog is oversized; original files retained.");
      const state = JSON.parse(raw);
      if (state.schemaVersion !== 1 || !Array.isArray(state.catalog) || state.catalog.length > 128 ||
          !Array.isArray(state.jobs) || state.jobs.length > 32 || !state.projects || typeof state.projects !== "object" || Array.isArray(state.projects)) throw new Error("Unsupported repository acquisition state; original files retained.");
      for (const descriptor of state.catalog) {
        validatePackageDescriptor(descriptor);
        if (this.packages.catalog.has(packageKey(descriptor)) && this.packages.catalog.get(packageKey(descriptor)).sha256 !== descriptor.sha256) throw new Error("Repository catalog collides with the installer catalog.");
        this.packages.catalog.set(packageKey(descriptor), descriptor);
      }
      for (const descriptor of state.catalog) for (const key of descriptor.runtimes) if (this.packages.catalog.get(key)?.kind !== "runtime") throw new Error("Repository runtime dependency is unavailable.");
      this.state = state;
      for (const job of state.jobs) if (["acquiring", "building", "packaging"].includes(job.phase)) {
        job.phase = "interrupted"; job.detail = "Desktop stopped before completion. Retry the repository review; previous installed versions and saves were retained.";
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  async save() {
    await mkdir(this.packages.root, { recursive: true });
    const temp = `${this.filename}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx");
    try { await file.writeFile(JSON.stringify(this.state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, this.filename);
  }
  snapshot() {
    return { jobs: structuredClone(this.state.jobs), projects: structuredClone(Object.values(this.state.projects)),
      toolPins: Object.values(BUILD_TOOLS).map(({ id, version, bytes, license }) => ({ id, version, bytes, license })) };
  }
  log(text) {
    if (!this.active) return;
    const job = this.active.job;
    job.log = `${job.log ?? ""}${String(text).slice(0, 2048)}\n`.slice(-32768);
  }
  async preflight(required) {
    const storage = await this.packages.storage();
    if (storage.warning || categories.some(key => storage[key] === null)) throw new Error("Storage cannot be safely accounted for; no build will start.");
    const used = categories.reduce((sum, key) => sum + storage[key], 0);
    if (used + required > storage.budgetBytes || storage.freeBytes - required < storage.reserveBytes) throw new Error(`Insufficient build space. This step needs up to ${Math.ceil(required / 1048576)} MiB in addition to the retained ${Math.ceil(storage.reserveBytes / 1048576)} MiB free-space reserve. Previous installations and saves are unchanged.`);
  }
  async register(descriptor) {
    const key = packageKey(descriptor);
    const prior = this.packages.catalog.get(key);
    if (prior && prior.sha256 !== descriptor.sha256) throw new Error("An immutable package version cannot be replaced.");
    if (!this.state.catalog.some(row => packageKey(row) === key)) {
      if (this.state.catalog.length >= 128) throw new Error("Repository version catalog is full. Review retained versions before adding more.");
      this.state.catalog.push(descriptor);
    }
    this.packages.catalog.set(key, descriptor);
    await this.save();
    return key;
  }
  async retainArchive(descriptor, filename, signal) {
    const destination = path.join(this.packages.root, "downloads", `${descriptor.sha256}.tar`);
    try {
      if (await sha256File(destination, signal) === descriptor.sha256) return destination;
      throw new Error("Retained package cache changed; repair its integrity before reusing this immutable output.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(filename, destination);
    return destination;
  }
  rememberBuiltVersion(snapshot, key, buildIdentity) {
    const id = repositoryIdentity(snapshot.provenance.repository, snapshot.folder);
    const project = this.state.projects[id] ?? { id, repository: snapshot.provenance.repository, folder: snapshot.folder, versions: [] };
    if (!project.versions.some(version => version.key === key)) project.versions.unshift({ key, revision: snapshot.provenance.revision,
      sourceUrl: snapshot.provenance.sourceUrl, recipe: RECIPES[snapshot.projectType], buildIdentity, builtAt: Date.now(),
      evidence: "Compiler/export completed; native startup and gameplay have not been verified." });
    project.activeKey = key; this.state.projects[id] = project;
  }
  async runtime(tool, signal, workspace) {
    const id = tool.pin.id === "godot" ? "arena.repo.godot" : "arena.repo.sdl2";
    const version = `${tool.pin.version}-${tool.pin.sha256.slice(0, 12)}`;
    const key = `${id}@${version}`;
    if (this.packages.state.packages[key]?.phase === "ready") { await this.packages.verify(key, signal); return key; }
    const directory = path.join(workspace, `runtime-${tool.pin.id}`); await mkdir(directory);
    if (tool.pin.id === "godot") {
      for (const name of ["Godot_v4.7.2-stable_win64.exe", tool.pin.executable]) await cp(path.join(tool.directory, name), path.join(directory, name), { errorOnExist: true });
    } else await cp(path.join(tool.directory, tool.pin.executable), path.join(directory, "SDL2.dll"), { errorOnExist: true });
    await writeFile(path.join(directory, "PROVENANCE.txt"), `${tool.pin.license}\nPublisher archive: ${tool.pin.url}\nSHA256: ${tool.pin.sha256}\n`, { flag: "wx" });
    const archive = path.join(workspace, `${id}.tar`);
    const descriptor = await packageDirectory(directory, archive, { id, version, kind: "runtime", runtimes: [], license: tool.pin.license }, signal);
    await this.register(descriptor);
    await this.packages.install(key, archive, { signal });
    return key;
  }
  async execute(executable, readRoot, runtimeRoot, writable, args, signal) {
    signal.throwIfAborted();
    await this.preflight(32 * 1024 * 1024);
    let child, forceTimer;
    const cancel = () => {
      if (!child) return;
      child.stdin?.write("stop\n");
      forceTimer = setTimeout(() => child.kill(), 12_000);
    };
    const moniker = `arena.build.${hash(`${this.packages.root}:${this.active.job.id}`).slice(0, 40)}`;
    const owner = this.active;
    let checking = false;
    const monitor = setInterval(async () => {
      if (checking || this.active !== owner) return;
      checking = true;
      try {
        const space = await statfs(this.packages.root);
        if (this.active !== owner) return;
        if (Number(space.bavail) * Number(space.bsize) < this.packages.reserveBytes) {
          owner.controller.abort(new Error("Build stopped to preserve the free-space reserve."));
        }
      } catch { if (this.active === owner) owner.controller.abort(new Error("Build storage could not be monitored.")); }
      finally { checking = false; }
    }, 250);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const code = await this.host.execute(["run", moniker, executable, readRoot, runtimeRoot, writable, "--", ...args], event => {
        if (event.event === "log") this.log(event.text ?? event.data ?? "");
        if (event.event === "error") this.log(event.message ?? "Native build supervisor failed.");
      }, 300_000, value => { child = value; if (signal.aborted) cancel(); });
      signal.throwIfAborted();
      if (code !== 0) throw new Error(`Isolated build command exited ${code}. Inspect its log; no new game version was activated.`);
      await verifyStoppedWorkspace(writable, this.packages.root);
    } finally { clearInterval(monitor); clearTimeout(forceTimer); signal.removeEventListener("abort", cancel); }
  }
  async build(snapshot, controller) {
    validateSourceSnapshot(snapshot);
    if (this.active) throw new Error("A repository build is already active.");
    if (!this.host.requirements().supportedHost) throw new Error(this.host.requirements().message);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    const job = { id: randomUUID(), phase: "acquiring", repository: snapshot.provenance.repository, revision: snapshot.provenance.revision,
      createdAt: Date.now(), detail: "Acquiring pinned SDKs; no repository commands run on the host.", log: "" };
    this.state.jobs.unshift(job); this.state.jobs = this.state.jobs.slice(0, 32);
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    this.active = { job, controller, finished };
    const workspace = path.join(this.packages.root, "build-cache", `repository-${job.id}`);
    try {
      await this.save(); await this.host.probe(); signal.throwIfAborted();
      const identity = repositoryIdentity(snapshot.provenance.repository, snapshot.folder);
      const fingerprint = sourceBuildIdentity(snapshot);
      const cached = this.state.projects[identity]?.versions.find(version => version.buildIdentity === fingerprint);
      if (cached && this.packages.state.packages[cached.key]?.phase === "ready") {
        await this.packages.verify(cached.key, signal);
        this.state.projects[identity].activeKey = cached.key;
        job.phase = "installed"; job.key = cached.key;
        job.detail = "Reused integrity-verified build with identical pinned source, recipe and SDK inputs; no new compiler execution.";
        await this.save(); return cached.key;
      }
      const interruptedKey = `${identity}@${snapshot.provenance.revision.slice(0, 12)}-${fingerprint.slice(0, 12)}`;
      const retained = this.packages.catalog.get(interruptedKey);
      if (retained) {
        const archive = path.join(this.packages.root, "downloads", `${retained.sha256}.tar`);
        if (this.packages.state.packages[interruptedKey]?.phase === "ready" || await sha256File(archive, signal).then(value => value === retained.sha256, error => {
          if (error.code === "ENOENT") return false; throw error;
        })) {
          for (const dependency of retained.runtimes) if (this.packages.state.packages[dependency]?.phase !== "ready") {
            const runtime = this.packages.catalog.get(dependency);
            await this.packages.install(dependency, path.join(this.packages.root, "downloads", `${runtime.sha256}.tar`), { signal });
          }
          await this.packages.install(interruptedKey, archive, { signal });
          this.rememberBuiltVersion(snapshot, interruptedKey, fingerprint);
          job.phase = "installed"; job.key = interruptedKey; job.detail = "Recovered the exact retained compiled artifact without rerunning source tools.";
          await this.save(); return interruptedKey;
        }
      }
      await this.preflight(400 * 1024 * 1024); await mkdir(workspace, { recursive: true });
      const source = path.join(workspace, "source"), output = path.join(workspace, "output");
      await mkdir(source); await mkdir(output);
      for (const file of snapshot.files) {
        signal.throwIfAborted();
        const target = path.join(source, ...file.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.contentBase64, "base64"), { flag: "wx" });
      }
      const project = path.join(source, snapshot.folder), id = repositoryIdentity(snapshot.provenance.repository, snapshot.folder);
      let runtime, entry, runtimeEntry, args = [], workingDirectory;
      if (snapshot.projectType === "godot") {
        const sdk = await this.tools.ensure("godot", signal);
        runtime = await this.runtime(sdk, signal, workspace);
        job.phase = "building"; job.detail = "Importing and exporting the Godot pack inside LPAC isolation."; await this.save();
        const executable = path.join(sdk.directory, sdk.pin.executable);
        // Own preset, never a README/shell command. Editor tool scripts still
        // execute only inside the native OS sandbox.
        await writeFile(path.join(project, "export_presets.cfg"), '[preset.0]\nname="Arena Windows"\nplatform="Windows Desktop"\nrunnable=true\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter=""\nscript_export_mode=2\n[preset.0.options]\nbinary_format/architecture="x86_64"\n');
        await this.execute(executable, sdk.directory, sdk.directory, workspace, ["--headless", "--path", project, "--editor", "--import"], signal);
        entry = "game.pck"; runtimeEntry = sdk.pin.executable;
        await this.execute(executable, sdk.directory, sdk.directory, workspace, ["--headless", "--path", project, "--export-pack", "Arena Windows", path.join(output, entry)], signal);
        if (!(await lstat(path.join(output, entry))).isFile()) throw new Error("Godot did not create a pack.");
        args = ["--main-pack", "{install}/game.pck", "--rendering-method", "gl_compatibility", "--rendering-driver", "opengl3"];
      } else {
        const compiler = await this.tools.ensure("llvm", signal), sdk = await this.tools.ensure("sdl", signal);
        runtime = await this.runtime(sdk, signal, workspace);
        job.phase = "building"; job.detail = "Compiling one SDL2 C translation unit inside LPAC isolation."; await this.save();
        const main = path.join(project, "main.c");
        const code = await readFile(main, "utf8");
        const sdlRoot = path.join(sdk.directory, "x86_64-w64-mingw32");
        const mainHandled = /^\s*#\s*define\s+SDL_MAIN_HANDLED\b/m.test(code);
        entry = "game.exe"; workingDirectory = "entry";
        await this.execute(path.join(compiler.directory, compiler.pin.executable), compiler.directory, sdk.directory, workspace, [
          "--target=x86_64-w64-windows-gnu", `--sysroot=${path.join(compiler.directory, "x86_64-w64-mingw32")}`,
          "-O2", "-fno-ident", "-Werror=date-time", `-ffile-prefix-map=${workspace}=.`, "-Wl,--no-insert-timestamp",
          "-I", path.join(sdlRoot, "include", "SDL2"), main, "-L", path.join(sdlRoot, "lib"),
          ...(mainHandled ? ["-mconsole"] : ["-mwindows", "-lmingw32", "-lSDL2main"]), "-lSDL2", "-lm", "-o", path.join(output, entry),
        ], signal);
        await requireWindowsPE(path.join(output, entry));
        for (const file of snapshot.files) {
          const relative = file.path.slice(snapshot.folder.length);
          if (/\.(?:png|jpe?g|bmp|gif|wav|ogg|mp3|ttf|json|txt|dat|map)$/i.test(relative)) {
            const target = path.join(output, relative); await mkdir(path.dirname(target), { recursive: true });
            await cp(path.join(source, file.path), target);
          }
        }
      }
      job.phase = "packaging"; job.detail = "Verifying output; previous versions remain installed."; await this.save();
      const buildIdentity = fingerprint;
      await writeFile(path.join(output, "ARENA-PROVENANCE.txt"), `${JSON.stringify({ ...snapshot.provenance, folder: snapshot.folder, recipe: RECIPES[snapshot.projectType], buildIdentity }, null, 2)}\n\n${snapshot.provenance.license.text}\n`);
      const descriptor = await packageDirectory(output, path.join(workspace, "game.tar"), {
        id, version: `${snapshot.provenance.revision.slice(0, 12)}-${buildIdentity.slice(0, 12)}`, kind: "game", entry, runtimeEntry,
        arguments: args, workingDirectory, runtimes: [runtime], license: `${snapshot.provenance.license.spdx}; source: ${snapshot.provenance.sourceUrl}`,
      }, signal);
      const retainedArchive = await this.retainArchive(descriptor, path.join(workspace, "game.tar"), signal);
      const key = await this.register(descriptor);
      await this.packages.install(key, retainedArchive, { signal });
      this.rememberBuiltVersion(snapshot, key, buildIdentity);
      job.phase = "installed"; job.key = key; job.detail = "Build installed. Launch separately from Native games; gameplay has not been verified.";
      await this.save(); return key;
    } catch (error) {
      job.phase = signal.aborted ? "cancelled" : "failed"; job.detail = String(error.message).slice(0, 2000); this.log(job.detail); await this.save(); throw error;
    } finally { this.active = null; await rm(workspace, { recursive: true, force: true }).catch(() => {}); finish(); }
  }
  async selectVersion(key) {
    const project = Object.values(this.state.projects).find(project => project.versions.some(version => version.key === key));
    if (!project || this.packages.state.packages[key]?.phase !== "ready") throw new Error("Choose a retained installed repository version.");
    if (project.versions.some(version => this.host.runningKeys().includes(version.key))) throw new Error("Stop this project's running version before switching versions.");
    await this.packages.verify(key); project.activeKey = key; await this.save();
  }
  async removed(key) {
    for (const project of Object.values(this.state.projects)) if (project.activeKey === key) {
      const remaining = project.versions.find(version => this.packages.state.packages[version.key]?.phase === "ready");
      if (remaining) project.activeKey = remaining.key;
      else delete project.activeKey;
    }
    await this.save();
  }
  async installRelease(plan, controller) {
    const asset = plan?.asset, provenance = plan?.provenance;
    if (!this.host.requirements().supportedHost) throw new Error(this.host.requirements().message);
    if (this.active || !asset || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") || !Number.isSafeInteger(asset.bytes) ||
        asset.bytes <= 0 || asset.bytes > 512 * 1024 * 1024 || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(provenance?.repository ?? "") ||
        !/^[a-f0-9]{40}$/.test(provenance?.revision ?? "") || !/^[a-zA-Z0-9_.-]{1,128}$/.test(plan.tag ?? "") ||
        typeof provenance.license?.text !== "string" || provenance.license.text.length > 128 * 1024 ||
        asset.url !== `https://github.com/${provenance.repository}/releases/download/${plan.tag}/${encodeURIComponent(asset.name)}`) throw new Error("Invalid reviewed native release pin.");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
    const job = { id: randomUUID(), phase: "acquiring", repository: provenance.repository, revision: provenance.revision,
      createdAt: Date.now(), detail: "Downloading a publisher-digested portable release; nothing executes during installation.", log: "" };
    this.state.jobs.unshift(job); this.state.jobs = this.state.jobs.slice(0, 32);
    let finish; const finished = new Promise(resolve => { finish = resolve; });
    this.active = { job, controller, finished };
    const workspace = path.join(this.packages.root, "build-cache", `release-${job.id}`);
    try {
      await this.save(); await this.preflight(asset.bytes + 3 * 450 * 1024 * 1024);
      await mkdir(workspace, { recursive: true });
      const archive = path.join(workspace, "publisher.zip"), directory = path.join(workspace, "portable");
      await downloadPinnedZip({ url: asset.url, bytes: asset.bytes, sha256: asset.sha256 }, archive, signal);
      await extractSelectedZip(archive, directory, name => name, signal, { maxFiles: 2000, maxBytes: 450 * 1024 * 1024 });
      const executables = [];
      const { readdir } = await import("node:fs/promises");
      const findExecutables = async (folder = "") => {
        for (const row of await readdir(path.join(directory, folder), { withFileTypes: true })) {
          signal.throwIfAborted();
          const name = folder ? `${folder}/${row.name}` : row.name;
          if (row.isDirectory()) await findExecutables(name);
          else if (/\.exe$/i.test(name)) executables.push(name);
        }
      };
      await findExecutables();
      if (executables.length !== 1 || /^(?:setup|install|unins)/i.test(path.basename(executables[0]))) throw new Error("Portable releases must have exactly one game executable and no installer. Ambiguous layouts need an explicit recipe.");
      await requireWindowsPE(path.join(directory, executables[0]));
      await writeFile(path.join(directory, "ARENA-PROVENANCE.txt"), `${JSON.stringify({ ...provenance, tag: plan.tag, asset }, null, 2)}\n${provenance.license.text}\n`, { flag: "wx" });
      job.phase = "packaging"; await this.save();
      const id = repositoryIdentity(provenance.repository, "");
      const descriptor = await packageDirectory(directory, path.join(workspace, "game.tar"), {
        id, version: `release-${asset.sha256.slice(0, 24)}`, kind: "game", entry: executables[0], arguments: [], workingDirectory: "entry",
        runtimes: [], license: `${provenance.license.spdx}; ${provenance.sourceUrl}`,
      }, signal);
      const retainedArchive = await this.retainArchive(descriptor, path.join(workspace, "game.tar"), signal);
      const key = await this.register(descriptor);
      await this.packages.install(key, retainedArchive, { signal });
      const project = this.state.projects[id] ?? { id, repository: provenance.repository, folder: "", versions: [] };
      if (!project.versions.some(version => version.key === key)) project.versions.unshift({ key, revision: provenance.revision,
        sourceUrl: provenance.sourceUrl, recipe: "publisher-portable-zip-v1", builtAt: Date.now(),
        evidence: "Publisher digest and x64 PE checked. No reproducible-build, startup or gameplay attestation." });
      project.activeKey = key; this.state.projects[id] = project;
      job.phase = "installed"; job.key = key; job.detail = "Pinned release installed. Launch separately; startup/gameplay are not verified.";
      await this.save(); return key;
    } catch (error) {
      job.phase = signal.aborted ? "cancelled" : "failed"; job.detail = String(error.message).slice(0, 2000); this.log(job.detail); await this.save(); throw error;
    } finally { this.active = null; await rm(workspace, { recursive: true, force: true }).catch(() => {}); finish(); }
  }
  async shutdown() {
    const active = this.active;
    active?.controller.abort(new Error("Desktop is stopping."));
    if (active) await active.finished;
  }
}
