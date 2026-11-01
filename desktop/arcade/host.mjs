import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile, rename, statfs } from "node:fs/promises";
import path from "node:path";
const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 32);
export class NativeArcadeHost {
  constructor({ packages, helper, platform = process.platform, arch = process.arch, spawnProcess = spawn }) {
    this.packages = packages; this.helper = helper; this.platform = platform; this.arch = arch; this.spawnProcess = spawnProcess;
    this.runs = new Map(); this.proof = null; this.probing = null;
    this.hostId = `desktop-session:${randomUUID()}`;
    this.writeQueue = Promise.resolve();
  }
  requirements() {
    return { supportedHost: this.platform === "win32" && this.arch === "x64", backend: "windows-lpac-job-v1",
      verified: this.proof !== null, message: this.platform !== "win32" || this.arch !== "x64"
        ? "Native execution requires Windows x64, NTFS and a successful live LPAC containment probe. Hosted/Linux previews cannot run imported Windows executables."
        : "Windows 10/11 x64, NTFS, Windows network isolation APIs and a successful live restricted-token/filesystem/network/Job probe are mandatory. There is no host-jail fallback.",
      limits: { jobMemoryMiB: 1024, processMemoryMiB: 512, processes: 16, cpuPercent: 25, network: "none", clipboard: "denied" } };
  }
  async initialize() {
    // Old PIDs are never killed: they may have been reused. The private-pipe
    // supervisor and kill-on-close Job own lifetime, not a PID journal.
    try {
      const previous = JSON.parse(await readFile(path.join(this.packages.root, "runs.json"), "utf8"));
      if (Array.isArray(previous)) for (const run of previous.slice(-32))
        if (typeof run?.id === "string" && typeof run.key === "string") this.runs.set(run.id, { id: run.id, key: run.key,
          phase: ["exited", "crashed", "stopped"].includes(run.phase) ? run.phase : "interrupted",
          gameplayVerified: false,
          logs: [...(Array.isArray(run.logs) ? run.logs.filter(line => typeof line === "string").slice(-63).map(line => line.slice(0, 8192)) : []),
            "Prior session record retained. No reused PID was touched; target-host shutdown evidence is separate."] });
    } catch (error) { if (error.code !== "ENOENT") throw new Error("Native run journal is unreadable; existing installations and saves were retained."); }
  }
  snapshot() { return { requirements: this.requirements(), host: { id: this.hostId, kind: "desktop", platform: this.platform, architecture: this.arch,
    capabilities: { "native-lpac-isolation": this.proof !== null } }, runs: [...this.runs.values()].map(({ child, exited, ...record }) => structuredClone(record)) }; }
  runningKeys() { return [...this.runs.values()].filter(run => run.child).flatMap(run => [run.key, ...(this.packages.catalog.get(run.key)?.runtimes ?? [])]); }
  persist() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const filename = path.join(this.packages.root, "runs.json");
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(this.snapshot().runs.slice(-32)), { flag: "wx", mode: 0o600 }); await rename(temp, filename);
    });
    return this.writeQueue;
  }
  environment() {
    // Never forward provider/database/session credentials into the supervisor.
    return Object.fromEntries(["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  }
  async probe() {
    if (!this.requirements().supportedHost) return this.requirements();
    if (this.probing) return this.probing;
    this.probing = (async () => {
      this.proof = null; await access(this.helper);
      const root = path.join(this.packages.root, "containment-probe"); await mkdir(root, { recursive: true });
      const events = [];
      const result = await this.execute(["probe", root], event => events.push(event), 20_000);
      const proof = events.find(event => event.event === "probe" && event.passed === true && event.backend === "windows-lpac-job-v1");
      if (result !== 0 || !proof || !["filesystem", "loopbackDenied", "restrictedToken", "jobLimits", "descendantCleanup", "overLimitMemoryDenied"].every(key => proof[key] === true))
        throw new Error(`Live Windows containment could not be verified. ${events.find(event => event.event === "error")?.message ?? "Native execution remains blocked."}`);
      this.proof = { ...proof, checkedAt: Date.now() }; return this.requirements();
    })().finally(() => { this.probing = null; });
    return this.probing;
  }
  execute(args, onEvent, timeout = 0, onChild = () => {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.helper, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: this.environment() });
      child.once("error", error => { if (timer) clearTimeout(timer); reject(error); });
      child.stdin?.on("error", () => {}); // Exiting helpers can close a stop pipe.
      onChild(child);
      let buffer = "", stderr = "", failure;
      const timer = timeout ? setTimeout(() => { failure = new Error("Native operation timed out; its owned process group was stopped."); child.kill(); }, timeout) : null;
      child.stdout?.on("data", chunk => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        if (buffer.length > 64 * 1024 || lines.some(line => line.length > 64 * 1024)) { failure = new Error("Native supervisor protocol exceeded its bound."); child.kill(); return; }
        for (const line of lines) {
          if (!line.trim()) continue;
          try { onEvent(JSON.parse(line)); } catch { failure = new Error("Invalid native supervisor protocol."); child.kill(); }
        }
      });
      child.stderr?.on("data", chunk => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
      child.once("exit", code => { if (timer) clearTimeout(timer); failure ? reject(failure) : resolve(code ?? 1); });
    });
  }
  async launch(key) {
    if (!this.requirements().supportedHost) throw new Error(this.requirements().message);
    if (!this.proof || Date.now() - this.proof.checkedAt > 300_000) await this.probe();
    const descriptor = await this.packages.verify(key);
    if (descriptor.kind !== "game" || this.packages.state.packages[key]?.phase !== "ready") throw new Error("Select an installed, integrity-verified game.");
    if ([...this.runs.values()].some(run => run.child)) throw new Error("Stop the current native game first.");
    await this.checkWritableVolumes();
    for (const runtime of descriptor.runtimes) {
      if (this.packages.state.packages[runtime]?.phase !== "ready") throw new Error(`Install pinned runtime ${runtime} first.`);
      await this.packages.verify(runtime);
    }
    if (descriptor.runtimes.length > 1) throw new Error("This initial native driver supports one independently installed runtime directory. No dependency is silently omitted.");
    const install = this.packages.filename(key);
    const runtime = descriptor.runtimes.length ? this.packages.filename(descriptor.runtimes[0]) : install;
    const profile = path.join(this.packages.root, "profiles", hash(descriptor.id), "default"); await mkdir(profile, { recursive: true });
    const args = descriptor.arguments.map(argument => argument.replaceAll("{profile}", profile).replaceAll("{runtime}", runtime).replaceAll("{install}", install));
    const executable = descriptor.runtimeEntry ? path.join(runtime, ...descriptor.runtimeEntry.split("/")) : path.join(install, ...descriptor.entry.split("/"));
    if (descriptor.runtimeEntry && !this.packages.catalog.get(descriptor.runtimes[0])?.files.some(file => file.path === descriptor.runtimeEntry)) throw new Error("Pinned runtime does not contain this game's engine executable.");
    const moniker = `arena.arcade.${hash(`${this.packages.root}:${descriptor.id}`)}`;
    const id = randomUUID();
    const record = { id, key, phase: "starting", profile, logs: [], startedAt: Date.now(), gameplayVerified: false };
    for (const [oldId, old] of this.runs) if (this.runs.size >= 32 && !old.child) this.runs.delete(oldId);
    this.runs.set(id, record);
    await this.persist();
    record.exited = this.execute([descriptor.workingDirectory === "entry" ? "play" : "run", moniker, executable, install, runtime, profile, "--", ...args], event => {
      if (event.event === "isolated") { record.phase = "process-started"; record.nativePid = event.pid; } // Not startup/gameplay evidence.
      if (event.event === "error") record.logs.push(`Supervisor: ${event.message}`);
      if (event.event === "log") record.logs.push(`${event.channel}: ${String(event.text).slice(0, 8192)}`);
      if (event.event === "log-truncated") record.logs.push("Game output exceeded the bounded log capture; later output was discarded.");
      record.logs = record.logs.slice(-64);
    }, 0, child => { record.child = child; }).then(code => {
      record.phase = code === 0 ? record.stopRequested ? "stopped" : "exited" : "crashed"; record.exitCode = code;
    }).catch(error => { record.phase = "crashed"; record.logs.push(error.message); }).finally(async () => {
      clearInterval(diskGuard);
      record.child = undefined; record.exited = undefined; record.finishedAt = Date.now(); await this.persist().catch(() => {});
    });
    // This is a free-space guard, NOT a hard NTFS per-directory quota. The
    // supervisor still enforces process/CPU/memory bounds independently.
    let checkingDisk = false;
    const diskGuard = setInterval(async () => {
      if (checkingDisk || !record.child || record.stopRequested) return;
      checkingDisk = true;
      try {
        await this.checkWritableVolumes();
      } catch (error) {
        record.logs.push(`${error.message} Writable disk has a monitored reserve, not a hard per-game quota.`);
        await this.stop(id).catch(stopError => { record.logs.push(stopError.message); });
      } finally { checkingDisk = false; }
    }, 250);
    diskGuard.unref();
    await this.persist().catch(error => { record.logs.push(`Run journal update failed; live process remains controllable: ${error.message}`); });
    return { id, phase: "starting", gameplayVerified: false };
  }
  async stop(id) {
    const record = this.runs.get(id);
    if (!record) throw new Error("This run is not owned by this desktop session.");
    if (!record.child) return this.snapshot();
    record.stopRequested = true;
    if (!record.child.stdin.writableEnded && !record.child.stdin.destroyed) record.child.stdin.end("stop\n");
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { record.child?.kill(); reject(new Error("Supervisor stop timed out; its kill-on-close Job must terminate remaining children. Target-host verification is required.")); }, 12_000); timer.unref(); });
      await Promise.race([record.exited, timeout]);
    } finally { clearTimeout(timer); }
    return this.snapshot();
  }
  async checkWritableVolumes() {
    const locations = new Set([this.packages.root, process.env.LOCALAPPDATA].filter(Boolean));
    for (const location of locations) {
      const volume = await statfs(location, { bigint: true });
      if (Number(volume.bavail * volume.bsize) < this.packages.reserveBytes) throw new Error("A writable volume reached the native free-space reserve; execution is blocked/stopped.");
    }
  }
  async shutdown() { await Promise.all([...this.runs.values()].filter(run => run.child).map(run => this.stop(run.id))); }
}
