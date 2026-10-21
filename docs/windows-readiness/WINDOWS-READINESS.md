# Arena OS — Windows readiness and integration record

**Branch:** `arena/windows-ready-integration-2026-10-22`
**Base:** `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` (PR #25, re-verified unchanged)
**Windows host:** GitHub-hosted `windows-latest` (Windows Server 2022, x64, Node 22)
**Workflow:** `.github/workflows/windows-acceptance.yml`
**Ledger / manifest:** [`INTEGRATION-LEDGER.md`](./INTEGRATION-LEDGER.md) · [`convergence-manifest.json`](./convergence-manifest.json)

Evidence is kept in four separate categories, because they are not
interchangeable:

| Category | Meaning |
| --- | --- |
| **Windows** | Executed on `windows-latest` against this branch. Run IDs are cited. |
| **Linux** | Executed in this checkout (Node 22, embedded PG16). Regression floor only. |
| **Inherited** | Product workflows executed in an earlier session on `13638fe`. Re-listed, never re-claimed. |
| **Not run** | Needs hardware or a human this environment cannot provide. Never scored as a pass. |

---

## 1. Outcome

**WINDOWS READY WITH LIMITATIONS.**

A clean Windows checkout of this branch installs dependencies, typechecks,
stages the packaged runtime, builds a real NSIS installer, silently installs it
per-user, launches the installed application, runs the product workflow
(Waveyard project → import → analysis → stem → arrangement → export verified by
the bundled FFprobe), survives two full close/relaunch cycles, leaves no orphan
processes, reports every URL loopback-only (offline), passes the packaging
audit, and uninstalls. Those nine mandated sections are `PASS` on Windows.

The limitations are enumerated in §7. The three that matter: the Windows
*test* jobs are not green yet (a de-elevated hang, investigated in §5), the
binary is unsigned, and the Windows run exercises the API-level application
rather than a human at a desktop with audio hardware.

## 2. Final revision identity

| Item | Value |
| --- | --- |
| Evidence commit | `a5d2d582` — the commit the Windows jobs below ran against |
| Tree | `1e64ebdb9260e695a6721dc4819e98ed614c2798` |
| Source digest | `sha256(git archive a5d2d58)` = `4918f69f5e0cd64691ab43e48788d967a308702854b4d5e501fdbda4e668dabd` |
| Base commit | `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` |
| Windows run | [39650513338](https://github.com/imlochie/arena-os-canonical/actions/runs/39650513338) (repeat of [39648109209](https://github.com/imlochie/arena-os-canonical/actions/runs/39648109209) with identical section results) |
| Installer | `Arena Setup 0.1.0.exe`, 621.1 MB; SHA-256 in `installer-sha256.txt` inside the `windows-package-<sha>` artifact |

Every Windows job prints `commit`, `tree` and `digest` in its first step, so an
artifact can be tied to the source that produced it. Commits after `a5d2d58`
change documentation and workflow text only; no application, packaging or test
code differs from the evidence commit.

## 3. What this branch changes

Full reasoning in the ledger (§3 of `INTEGRATION-LEDGER.md`). Summary:

| Change | Defect it removes |
| --- | --- |
| Platform binaries moved to `optionalDependencies` | `npm ci` aborted with `EBADPLATFORM` on Windows (two hard `os=linux` devDependencies) — dependencies could not be installed at all |
| `@ffmpeg-installer/win32-x64` declared (+ darwin/linux-arm64) | `desktop:prepare-server` aborted "Could not find ffmpeg binary"; no Windows installer could contain FFmpeg |
| `desktop/runtime/config.ts`: shared resolver, `.exe` suffix and PATH dirs in the **dev** layout | `npm run desktop` on Windows spawned a non-existent `initdb`/`pg_ctl`/`postgres` and could not load PostgreSQL's DLLs |
| `.gitattributes`: ONNX notice pinned to LF | The regenerated notice became a phantom tracked modification on a Windows checkout, so the staged-tree identity check refused the package |
| `scripts/desktop-dist.mjs`: `--publish never` | electron-builder demanded `GH_TOKEN` for a local build that must never publish |
| `.gitignore`: `windows-evidence/` | CI evidence written inside the checkout changed the staged source identity |
| New: Windows workflow, platform preflight, de-elevation runner, annotation wrapper | No Windows host had ever executed the repository's own acceptance contract |

The application's *runtime* code changed in exactly one place: the dev-layout
PostgreSQL paths. Everything else is packaging, CI or documentation.

## 4. Windows acceptance matrix

Evidence run: [`windows-acceptance` run 39648109209](https://github.com/imlochie/arena-os-canonical/actions/runs/39648109209)
(commit `e889f4a`). Job-level results transcribed below; each line was read
from the job's own report through the checks API.

### 4.1 Installed application — the mandated Gate D / D1–D10 contract

The repository's own orchestrator (`scripts/windows-acceptance.mjs`) installs
the built NSIS package, launches the *installed* `Arena.exe` with
`ARENA_DESKTOP_ACCEPTANCE`, and writes `desktop-windows-acceptance-report.json`.

| Report section | Result |
| --- | --- |
| `WINDOWS_ARTIFACT` | **Arena Setup 0.1.0.exe (621.1 MB)** |
| `INSTALL` | **PASS** — silent per-user NSIS install to `C:\Users\runneradmin\AppData\Local\Programs\Arena` |
| `FIRST_LAUNCH` | **PASS** — supervisor → embedded PostgreSQL initdb → health → window |
| `RUNTIME` | **PASS** |
| `WAVEYARD_WORKFLOW` | **PASS** — project, import, waveform/peaks, analysis (BPM/key/beat grid), sections, stem, arrangement, version |
| `EXPORT` | **PASS** — export verified by the **bundled** `ffprobe.exe` (codec/rate/channels/duration) |
| `RESTART_PERSISTENCE` | **PASS** — two full close/relaunch cycles; project, source, analysis, stem, version and export survive |
| `PROCESS_CLEANUP` | **PASS** — no owned processes survive; all workflow URLs loopback-only |
| `OFFLINE` | **PASS** — every request in the run targeted `127.0.0.1`; no network-dependent subsystem falsely reported READY |
| `SECURITY/PACKAGING AUDIT` | **PASS** — installed-tree layout, no repo junk, no secrets, no escaping symlinks, licence notices present |

The abnormal-shutdown variant (force-kill mid-run, orphan check, recovery
launch) runs by default in the same orchestrator and completed inside this job
(no `--skip-abnormal` was passed). Uninstall was exercised afterwards with the
per-user NSIS uninstaller.

### 4.2 Packaging job

| Step | Result |
| --- | --- |
| `npm ci` (clean install, Windows) | **PASS** |
| Windows platform packages present (`windows-platform-check.mjs`) | **PASS** |
| `desktop:compile` | **PASS** |
| `desktop:prepare-server` (standalone server, binaries, migrations, ONNX pruning) | **PASS** — staged tree 8 986 files / 849.8 MB |
| Staged-runtime acceptance (embedded PostgreSQL, worker, real export, restart) | **PASS** (de-elevated) |
| `desktop:dist` → NSIS installer | **PASS** |
| Installer SHA-256 recorded | **PASS** |

### 4.3 Gates

| Gate | Windows | Linux (this checkout) |
| --- | --- | --- |
| `npm ci` | **PASS** | PASS |
| `npm run typecheck` | **PASS** | **PASS** (exit 0) |
| `npm run test:desktop` | **168/168 tests PASS, gate BLOCKED**: the de-elevated run prints `# tests 168 · # pass 168 · # fail 0` in 429.9 s and then **never exits**, so no clean status can be recorded | **PASS** — 168/168 (clean exit) |
| `npm run test:desktop`, elevated control | 158/162 pass, **3 fail**, 1 cancelled, 473 s — the three real-cluster tests cannot start PostgreSQL under an administrator token (expected, environmental) | n/a |
| `npm test` (full source suite) | **NOT RUN** — the suite job had not completed at the time of writing; it is retained as its own job with a 200-minute budget | **PASS** — 1642/1642 at `13638fe` (previous session) |
| Staging identity guard | **PASS** — correctly refused packages while the tree was genuinely dirty (§5) | PASS |

A skipped, timed-out or environment-blocked gate is **not** a pass and is not
counted as one here.

## 5. Failure ledger (what broke on Windows, and why)

Everything below was a real failure observed on the runner, in order. None was
worked around by weakening a check.

1. **`npm ci` failed: `EBADPLATFORM`.** `@embedded-postgres/linux-x64` and
   `@ffmpeg-installer/linux-x64` were hard devDependencies with `os: ["linux"]`.
   Fixed by making every platform binary optional.
2. **`desktop:prepare-server` failed: "Could not find ffmpeg binary".** No
   `@ffmpeg-installer/win32-x64` in package.json or the lockfile. Fixed by
   declaring it (evidence: the package job now stages `bin/ffmpeg.exe`).
3. **Embedded PostgreSQL refused to start:** `"root" execution of the
   PostgreSQL server is not permitted.` The hosted runner executes every step
   with an administrator token. This is an *environment* property: a normal
   per-user install is unelevated. Reproduced the user's condition instead of
   weakening the acceptance —
   `scripts/windows-deelevated-step.mjs` launches the step through
   `runas /trustlevel:0x20000` and propagates the child's real exit status.
   After that, the staged-runtime acceptance and the installed acceptance both
   pass, which proves the database lifecycle really works on Windows.
4. **`runas` wrapper defects of its own** (all fixed, all recorded because they
   produced misleading results first): `spawnSync` wedged the job when a prompt
   appeared; hand-rolled nested quotes made `cmd.exe` mis-parse the argument;
   `%ERRORLEVEL%` is unset in a fresh `cmd.exe`, so the sentinel read
   `ECHO is off.`; a restricted token does not inherit the job's PATH additions,
   so bare `node`/`npm` resolved to nothing.
5. **Staged-tree guard rejected the package** with "tracked files changed since
   staging". Two distinct causes, both found and fixed:
   `.gitattributes` pinned only the FFmpeg notice to LF — the ONNX notice was
   regenerated to LF on a CRLF checkout and appeared modified (reproduced by
   converting the file here); and the informational packaging audit wrote an
   untracked report into the repo root *between* staging and verification,
   while the guard hashes untracked files. The guard was right both times.
6. **`desktop:dist` failed: "GitHub Personal Access Token is not set".**
   electron-builder resolved the GitHub remote for a build that must never
   publish. Fixed with `--publish never`.
7. **`desktop:dist` failed: local Electron distribution missing.** electron 44
   hydrates lazily (documented in `docs/windows-acceptance.md`); the workflow
   now runs `node node_modules/electron/install.js` first.
8. **The de-elevated test process does not exit** (open, narrowed). A bounded
   diagnostic run (`desktop-diagnostics` job, run 39659983653) produced:
   `# tests 168 · # pass 168 · # fail 0 · # cancelled 0 · # duration_ms 429905`
   and then no completion sentinel — the TAP summary is complete, so every test
   passed, but the process (and therefore `npm`) never returned. The elevated
   control in the same job finished in 473 s with the three real-cluster tests
   failing and one cancelled, as expected under an administrator token.

   So the Windows test *content* is green when the token is right; what breaks
   is process teardown. The three real-cluster tests boot an embedded
   PostgreSQL cluster, so the most likely lingering handle is the postmaster (or
   a worker child) that survives `pg_ctl stop` under a restricted token. Not yet
   proven: the job log is served from a host this environment cannot reach, and
   the run only carries annotations. Next step is to capture the surviving
   child PIDs at the end of the run and kill/verify them explicitly
   (`desktop/runtime/embedded-postgres.ts` `stop()` path, and the
   `processCleanup` assertions already used by the installed acceptance, which
   does pass).

## 6. What the Windows run actually proves

- The application **installs, launches, operates, closes, reopens and
  uninstalls** from a real Windows installer built from this checkout.
- Writable data lives under `%LOCALAPPDATA%\Arena`, not the repository.
- The embedded database is created on first launch, survives restarts, and is
  reachable only over loopback.
- Media export works through the **bundled** FFmpeg/FFprobe on Windows.
- The application runs offline: no request left `127.0.0.1`.

What it does **not** prove is listed next.

## 7. Limitations (explicit, each with its evidence)

1. **The Windows test gate cannot record a clean exit.** All 168 desktop tests
   pass de-elevated, but the process never returns (§5.8), so the gate is
   BLOCKED, not PASS. The full source suite did not finish within this session.
   Neither is reported as passing.
2. **The installed acceptance is API-level.** It drives the real server, real
   database, real worker and real export, but no human saw the window, played
   audio through a device, or moved a mixer. The GUI checklist in
   `docs/windows-acceptance.md` remains a manual step on a real desktop.
3. **No audio hardware.** The runner reports no output devices; Waveyard's UI
   states that honestly. Audible-mix verification (the inherited FFT-based
   checks) ran on Linux, not on Windows.
4. **The installer is unsigned** and `CSC_IDENTITY_AUTO_DISCOVERY=false`; no
   certificate exists in this environment. Windows SmartScreen will warn.
5. **No updater.** `electron-builder.yml` deliberately ships no auto-update
   path; update/replacement behaviour is therefore unverified by design.
6. **GPU and deep-separation model provisioning were not exercised.** The CPU
   path used only the passthrough/analysis pipeline; no Demucs weights were
   downloaded on Windows.
7. **The hosted runner is not a user's PC.** Windows Server 2022 with an
   administrator account, a restricted-token workaround and no desktop session
   is close to, but not the same as, a Windows 11 laptop.
8. **Inherited product evidence is not Windows evidence.** Arcade, Spaces and
   Waveyard workflows were validated on Linux at `13638fe`; this branch does not
   re-claim them for Windows. The Windows run covers the Waveyard workflow at
   API level only.

## 8. Installing the Windows build

For a reviewer with the artifact:

1. Download `Arena Setup 0.1.0.exe` from the `arena-windows-installer-<sha>`
   artifact of the Windows run.
2. Verify its SHA-256 against `installer-sha256.txt` from the same run.
3. Run the installer (per-user, no elevation required, install directory may be
   changed). It is unsigned: expect a SmartScreen prompt.
4. Launch **Arena** from the Start menu. First launch initialises the database
   under `%LOCALAPPDATA%\Arena` and takes noticeably longer than later launches.
5. Optional, to reproduce the automated acceptance on your own machine:
   ```bat
   node scripts\windows-acceptance.mjs
   ```
   It prints the mandated PASS/FAIL report and writes
   `desktop-windows-acceptance-report.json`.

To rebuild from source on Windows:

```bat
npm ci
node node_modules\electron\install.js
npm run desktop:dist
node scripts\windows-acceptance.mjs
```

## 9. Outstanding work, in priority order

1. **Diagnose the de-elevated desktop-test hang** (§5.8) and get `test:desktop`
   and `npm test` green on Windows. Until then the Windows *test* gate is open.
2. **Run the GUI checklist** on a real Windows desktop: audible playback, meters,
   mixer/inserts, adapter-off offline pass.
3. **Code-sign the installer** and document the certificate path.
4. **Exercise deep separation (Demucs) on Windows**, including an honest failure
   when the optional GPU package is unavailable, and verify the CPU path end to
   end with real weights.
5. **Add an updater story** if the product intends one; today it has none by
   design and that is documented rather than hidden.
6. **Re-run product workflows on Windows** (Arcade source workshop, Spaces
   missions) — they are Linux-verified only.
