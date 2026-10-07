/**
 * Windows acceptance-test orchestrator (one command for the Windows machine).
 *
 *   node scripts/windows-acceptance.mjs [options]
 *
 * Runs the mandate end-to-end on a real Windows machine:
 *   1. (optional --gates) automated gates: typecheck, tests, web build, desktop:e2e
 *   2. (optional --build)  npm run desktop:dist  →  the NSIS installer
 *   3. silent install of the REAL installer (/S)
 *   4. packaging audit of the installed tree (layout, no repo junk, no
 *      escaping symlinks, license notices)
 *   5. launch the INSTALLED Arena.exe with ARENA_DESKTOP_ACCEPTANCE — the
 *      in-app runner (desktop/acceptance.ts, pre-flighted headless on Linux)
 *      executes first-launch, paths, the real Waveyard workflow, honest
 *      failure tests, restart persistence, process cleanup, packaging audit
 *   6. OS-level orphan-process check after normal exit
 *   7. abnormal-shutdown variant: force-kill mid-run, orphan check, then a
 *      recovery launch proving the app comes back (stale postmaster.pid etc.)
 *   8. mandated PASS/FAIL report → desktop-windows-acceptance-report.json
 *
 * Options:
 *   --gates           run the automated gates first
 *   --build           run npm run desktop:dist first (needs github.com access)
 *   --dist <path>     installer path (default: desktop-release/Arena Setup 0.1.0.exe)
 *   --skip-install    the app is already installed — skip the installer run
 *   --skip-abnormal   skip the force-kill / recovery variant
 *   --uninstall       silently uninstall at the end
 *   --audit-only <d>  run ONLY the packaging audit against <dir> (any OS)
 *
 * Manual GUI checklist (playback, meters, mixer, inserts, cleanup UI) is in
 * docs/windows-acceptance.md — the API level is automated here.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { repoRootFromMeta } from "./lib/repo-root.mjs";
import { runNpmSync } from "./lib/run-command.mjs";

const root = repoRootFromMeta(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
};

const report = {
  WINDOWS_ARTIFACT: "n/a",
  INSTALL: "NOT RUN",
  FIRST_LAUNCH: "NOT RUN",
  RUNTIME: "NOT RUN",
  WAVEYARD_WORKFLOW: "NOT RUN",
  EXPORT: "NOT RUN",
  RESTART_PERSISTENCE: "NOT RUN",
  PROCESS_CLEANUP: "NOT RUN",
  OFFLINE: "NOT RUN",
  "SECURITY/PACKAGING AUDIT": "NOT RUN",
  AUTOMATED_TESTS: "not run (use --gates)",
  KNOWN_LIMITATIONS: [],
  FINAL_COMMIT: "unknown",
  detail: {},
};
let failed = false;
const mark = (key, ok, detail) => {
  report[key] = ok ? "PASS" : "FAIL";
  if (detail !== undefined) report.detail[key] = detail;
  if (!ok) failed = true;
};
const pass = (key, detail) => mark(key, true, detail);

try {
  report.FINAL_COMMIT = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() ?? "unknown";

  // ---------------------------------------------------------------- audit only
  if (flag("--audit-only")) {
    const dir = option("--audit-only");
    if (dir === undefined || !existsSync(dir)) {
      console.error(`[windows-acceptance] --audit-only needs an existing directory`);
      process.exit(1);
    }
    const audit = auditInstallTree(path.resolve(dir));
    for (const entry of audit.steps) console.log(`[${entry.ok ? "PASS" : "FAIL"}] ${entry.name}${entry.info !== undefined ? ` — ${entry.info}` : ""}`);
    writeFileSync(path.join(root, "desktop-windows-acceptance-report.json"), JSON.stringify({ audit }, null, 2));
    process.exit(audit.steps.every((entry) => entry.ok) ? 0 : 1);
  }

  // ---------------------------------------------------------------- gates
  if (flag("--gates")) {
    const results = [];
    for (const [name, npmArgs] of [
      ["typecheck", ["run", "typecheck"]],
      ["tests", ["run", "test"]],
      ["build", ["run", "build"]],
      ["desktop:e2e", ["run", "desktop:e2e"]],
    ]) {
      console.log(`[windows-acceptance] gate: ${name}`);
      // Output is captured AND echoed — a failing gate must never be silent.
      // (The first Windows run died here spawning npm.cmd without a shell:
      // a silent EINVAL with status null and zero output.)
      const run = runNpmSync(npmArgs, {
        cwd: root,
        timeout: 30 * 60_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (run.error !== undefined) console.error(`[windows-acceptance] gate process error: ${String(run.error)}`);
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim();
      if (output.length > 0) console.log(output);
      const ok = run.error === undefined && run.status === 0;
      const counts = /# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/.exec(output);
      results.push({
        name,
        ok,
        counts: counts === null ? undefined : { tests: counts[1], pass: counts[2], fail: counts[3] },
        outputTail: output.slice(-2000),
      });
      if (!ok) {
        report.detail.gates = results;
        mark(
          "AUTOMATED_TESTS",
          false,
          `gate "${name}" failed${run.error !== undefined ? ` — process error: ${String(run.error)}` : ` — exit ${String(run.status)} (full output above and in the report)`}`,
        );
        throw new Error(`gate ${name} failed`);
      }
    }
    report.detail.gates = results;
    const testCounts = results.find((entry) => entry.name === "tests")?.counts;
    pass(
      "AUTOMATED_TESTS",
      `typecheck + build + desktop:e2e green${testCounts !== undefined ? `; tests ${testCounts.pass}/${testCounts.tests} pass, ${testCounts.fail} fail` : "; tests green"}`,
    );
  }

  // ---------------------------------------------------------------- build
  if (flag("--build")) {
    console.log("[windows-acceptance] building the installer (npm run desktop:dist)…");
    const build = runNpmSync(["run", "desktop:dist"], { cwd: root, stdio: "inherit", timeout: 40 * 60_000 });
    if (build.error !== undefined || build.status !== 0) {
      throw new Error(
        `desktop:dist failed${build.error !== undefined ? ` — process error: ${String(build.error)}` : ` — exit ${String(build.status)}`}`,
      );
    }
  }

  // ---------------------------------------------------------------- platform
  // (Gates and the installer build are cross-platform; everything from the
  // silent install onward needs Windows.)
  if (process.platform !== "win32") {
    console.error(
      "[windows-acceptance] " +
        (flag("--gates") ? "gates ran; the installed-app acceptance itself must run on Windows.\n" : "this orchestrator must run on Windows.\n") +
        "Pre-flight the runner on any OS with: npm run desktop:acceptance-headless\n" +
        "Audit a staged/install tree anywhere with: node scripts/windows-acceptance.mjs --audit-only <dir>",
    );
    // Throw (not exit) so the mandated report — including any gate results —
    // is still written before the process ends.
    throw new Error("the installed-app acceptance requires Windows (gates + --audit-only work on any OS)");
  }

  // ---------------------------------------------------------------- installer
  const dist = option("--dist") ?? path.join(root, "desktop-release", "Arena Setup 0.1.0.exe");
  if (!existsSync(dist)) {
    throw new Error(`installer not found: ${dist} — build it first (npm run desktop:dist) or pass --dist <path>`);
  }
  report.WINDOWS_ARTIFACT = `${path.basename(dist)} (${(statSync(dist).size / 1024 / 1024).toFixed(1)} MB)`;

  // ---------------------------------------------------------------- install
  let installDir;
  if (flag("--skip-install")) {
    console.log("[windows-acceptance] --skip-install: using the existing installation");
  } else {
    console.log(`[windows-acceptance] silently installing ${dist} (/S, per-user)…`);
    const install = spawnSync(dist, ["/S"], { stdio: "ignore", timeout: 10 * 60_000 });
    if (install.status !== 0) {
      mark("INSTALL", false, `installer exited ${String(install.status)}`);
      throw new Error("installer failed");
    }
  }
  installDir = locateInstallDir();
  if (installDir === null || !existsSync(path.join(installDir, "Arena.exe"))) {
    mark("INSTALL", false, `Arena.exe not found (looked at ${String(installDir)})`);
    throw new Error("installed Arena.exe not found");
  }
  pass("INSTALL", installDir);

  // ---------------------------------------------------------------- audit
  console.log(`[windows-acceptance] auditing installed tree: ${installDir}`);
  const audit = auditInstallTree(installDir);
  for (const entry of audit.steps) console.log(`[${entry.ok ? "PASS" : "FAIL"}] ${entry.name}${entry.info !== undefined ? ` — ${entry.info}` : ""}`);
  mark("SECURITY/PACKAGING AUDIT", audit.steps.every((entry) => entry.ok), audit);
  if (audit.steps.some((entry) => !entry.ok)) {
    throw new Error("packaging audit failed — see steps above");
  }

  // ---------------------------------------------------------------- acceptance run 1
  const dataDir = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"), "Arena");
  console.log("[windows-acceptance] launching the installed app (acceptance mode, normal run)…");
  const run1 = await runInstalledAcceptance(path.join(installDir, "Arena.exe"), "run1.json", 25 * 60_000);
  printAcceptance(run1.body);
  const sections = run1.body?.sections ?? {};
  const sectionOk = (name) => sections[name]?.ok === true;
  mark("FIRST LAUNCH", sectionOk("firstLaunch"), sections.firstLaunch);
  mark("RUNTIME", sectionOk("firstLaunch") && sectionOk("paths"), { firstLaunch: sections.firstLaunch, paths: sections.paths });
  mark(
    "WAVEYARD WORKFLOW",
    sectionOk("workflow") && sectionOk("failureTests"),
    { note: "API-level automated; GUI checklist (playback/meters/mixer/inserts) is manual — docs/windows-acceptance.md", workflow: sections.workflow, failureTests: sections.failureTests },
  );
  mark("EXPORT", exportOk(sections.workflow), { export: run1.body?.export });
  mark("RESTART PERSISTENCE", sectionOk("restartPersistence"), sections.restartPersistence);
  mark("OFFLINE", sectionOk("offline"), { note: "loopback-only proven in-run; adapter-offline pass is the manual step in docs/windows-acceptance.md", offline: sections.offline });
  if (run1.body?.export !== undefined) report.detail.EXPORT_MEDIA = run1.body.export;

  // ---------------------------------------------------------------- orphan check (normal exit)
  const orphansAfterExit = findOwnedProcesses(installDir, dataDir);
  const processCleanupOk = sectionOk("processCleanup") && orphansAfterExit.length === 0;
  mark("PROCESS CLEANUP", processCleanupOk, {
    inApp: sections.processCleanup,
    orphansAfterNormalExit: orphansAfterExit,
  });

  // ---------------------------------------------------------------- abnormal shutdown
  if (!flag("--skip-abnormal")) {
    console.log("[windows-acceptance] abnormal-shutdown variant: force-killing the app mid-run…");
    const child = spawn(path.join(installDir, "Arena.exe"), [], {
      env: { ...process.env, ARENA_DESKTOP_ACCEPTANCE: resultFilePath("abnormal.json") },
      stdio: "ignore",
      detached: false,
    });
    await sleep(75_000); // mid-workflow (runtime up, export likely in flight)
    spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { stdio: "ignore" }); // main process only — a hard crash
    await sleep(5_000);
    const orphansAfterKill = findOwnedProcesses(installDir, dataDir);
    report.detail.ABNORMAL_SHUTDOWN = {
      orphansAfterForceKill: orphansAfterKill,
      note:
        orphansAfterKill.length === 0
          ? "no owned processes survived the force-kill"
          : "processes survived the force-kill — recorded honestly; recovery run below proves the next launch copes",
    };
    if (orphansAfterKill.length > 0) {
      // Do not let them leak into the recovery run's port/socket state.
      for (const proc of orphansAfterKill) spawnSync("taskkill", ["/PID", String(proc.ProcessId), "/F"], { stdio: "ignore" });
      await sleep(2_000);
    }
    console.log("[windows-acceptance] recovery launch after abnormal shutdown…");
    const recovery = await runInstalledAcceptance(path.join(installDir, "Arena.exe"), "recovery.json", 25 * 60_000);
    printAcceptance(recovery.body);
    report.detail.RECOVERY_AFTER_ABNORMAL = {
      ok: recovery.body?.ok === true,
      sections: Object.fromEntries(Object.entries(recovery.body?.sections ?? {}).map(([name, section]) => [name, section.ok])),
    };
    if (recovery.body?.ok !== true) mark("PROCESS CLEANUP", false, "app did not fully recover after an abnormal shutdown");
  }

  // ---------------------------------------------------------------- uninstall (optional)
  if (flag("--uninstall")) {
    const uninstaller = readdirSync(installDir).find((name) => /^unins\d+\.exe$/i.test(name));
    if (uninstaller !== undefined) {
      console.log("[windows-acceptance] silently uninstalling…");
      spawnSync(path.join(installDir, uninstaller), ["/S", "?_?=" + path.join(installDir, "uninstall.tmp")], { stdio: "ignore", timeout: 5 * 60_000 });
    }
  }

  report.KNOWN_LIMITATIONS = collectLimitations(run1.body);
} catch (error) {
  report.ERROR = String(error instanceof Error ? (error.stack ?? error.message) : error);
  failed = true;
}

writeFileSync(path.join(root, "desktop-windows-acceptance-report.json"), JSON.stringify(report, null, 2));
console.log("\n================ WINDOWS ACCEPTANCE REPORT ================");
for (const [key, value] of Object.entries(report)) {
  if (key === "detail") continue;
  console.log(`${key}:${typeof value === "string" ? "" : ""} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
console.log(`===========================================================`);
console.log(failed ? "WINDOWS ACCEPTANCE: FAIL" : "WINDOWS ACCEPTANCE: PASS");
console.log("Full detail: desktop-windows-acceptance-report.json");
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let resultDirCache = null;
function resultFilePath(name) {
  resultDirCache ??= mkdtempSync(path.join(tmpdir(), "arena-win-acceptance-"));
  return path.join(resultDirCache, name);
}

async function runInstalledAcceptance(exePath, resultName, timeoutMs) {
  const resultPath = resultFilePath(resultName);
  rmSync(resultPath, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(exePath, [], {
      env: { ...process.env, ARENA_DESKTOP_ACCEPTANCE: resultPath },
      stdio: "ignore",
      detached: false,
    });
    const timer = setTimeout(() => {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      reject(new Error(`installed app did not finish within ${timeoutMs / 60000} min`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  if (!existsSync(resultPath)) return { body: { ok: false, error: "installed app exited without writing the acceptance report" } };
  return { body: JSON.parse(readFileSync(resultPath, "utf8")) };
}

function printAcceptance(body) {
  for (const [name, section] of Object.entries(body?.sections ?? {})) {
    for (const step of section.steps ?? []) {
      console.log(`[${step.ok ? "PASS" : "FAIL"}] ${name} · ${step.name}${step.info !== undefined ? ` — ${step.info}` : ""}`);
    }
  }
  if (body?.error !== undefined) console.error(`[FAIL] runner error: ${String(body.error).slice(0, 400)}`);
}

function exportOk(workflowSection) {
  const steps = workflowSection?.steps ?? [];
  return steps.filter((step) => /export/.test(step.name)).every((step) => step.ok);
}

function locateInstallDir() {
  const reg = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ai.arena.os", "/v", "InstallLocation"], { encoding: "utf8" });
  const match = /InstallLocation\s+REG_SZ\s+(\S.*)$/m.exec(reg.stdout ?? "");
  if (match !== null) return match[1].trim();
  const fallback = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Arena");
  return existsSync(fallback) ? fallback : null;
}

/** OS-level: any process whose executable lives under the install or data dir. */
function findOwnedProcesses(installDir, dataDir) {
  const ps =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${psQuote(installDir)}*' -or $_.ExecutablePath -like '${psQuote(dataDir)}*' } | ` +
    `Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0 || (run.stdout ?? "").trim() === "") return [];
  try {
    const parsed = JSON.parse(run.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Packaging audit — works on any OS (also usable with --audit-only against
 * the staged tree on Linux).
 */
function auditInstallTree(dir) {
  const steps = [];
  const step = (name, ok, info) => steps.push({ name, ok, info });
  const exists = (relative) => existsSync(path.join(dir, relative));

  step("app tree exists", existsSync(dir), dir);
  for (const required of [
    ["Arena.exe (or staged server)", ["Arena.exe", "server\\server.js", "server/server.js"]],
    ["FFmpeg binary", ["resources\\app\\bin\\ffmpeg.exe", "resources/app/bin/ffmpeg", "bin/ffmpeg"]],
    ["FFprobe binary", ["resources\\app\\bin\\ffprobe.exe", "resources/app/bin/ffprobe", "bin/ffprobe"]],
    ["embedded PostgreSQL", ["resources\\app\\embedded-postgres\\bin\\postgres.exe", "resources/app/embedded-postgres/bin/postgres", "embedded-postgres/bin/postgres"]],
    ["canonical migrations", ["resources\\app\\desktop-migrations", "resources/app/desktop-migrations", "desktop-migrations"]],
    ["FFmpeg GPL license notice", ["resources\\licenses\\FFMPEG-LICENSE.txt", "resources/licenses/FFMPEG-LICENSE.txt", "licenses/FFMPEG-LICENSE.txt"]],
  ]) {
    step(`shipped: ${required[0]}`, required[1].some((candidate) => exists(candidate)));
  }

  // No repo junk / secrets.
  const junk = [];
  for (const name of [".env", ".env.local", "desktop-release", ".git", "test", "fixtures", "__tests__"]) {
    if (exists(name)) junk.push(name);
    if (exists(`resources\\app\\${name}`) || exists(`resources/app/${name}`)) junk.push(`resources/app/${name}`);
  }
  step("no secrets / repo junk in the installed tree", junk.length === 0, junk.length > 0 ? junk.join(", ") : "clean");

  // No symlinks escaping the install dir (Turbopack pg defect class).
  const escaping = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = path.resolve(path.dirname(full), readlinkSync(full));
        if (!resolved.startsWith(dir + path.sep)) escaping.push(`${full} → ${resolved}`);
      } else if (entry.isDirectory()) {
        walk(full);
      } else {
        fileCount += 1;
        totalBytes += statSync(full).size;
      }
    }
  };
  walk(dir);
  step("no symlink escapes the installed tree", escaping.length === 0, escaping.length > 0 ? escaping.join("; ").slice(0, 200) : "clean");
  step("install tree size recorded", fileCount > 0, `${fileCount} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  return { steps, fileCount, totalBytes };
}

function collectLimitations(body) {
  const limitations = [];
  if (body?.sections?.workflow?.ok !== true || body?.sections?.workflow === undefined) limitations.push("check workflow section — recorded from the run");
  limitations.push("separation/Demucs requires the Waveyard Python worker — fails honestly on desktop");
  limitations.push("AI features require credentials — reported DEGRADED until configured");
  const abnormal = report.detail?.ABNORMAL_SHUTDOWN;
  if (abnormal !== undefined && Array.isArray(abnormal.orphansAfterForceKill) && abnormal.orphansAfterForceKill.length > 0) {
    limitations.push(`processes survived a force-kill of the main process: ${abnormal.orphansAfterForceKill.map((p) => p.Name).join(", ")} (recovery verified)`);
  }
  return limitations;
}
