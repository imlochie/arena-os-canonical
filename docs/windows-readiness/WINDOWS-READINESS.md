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

On the same commit, the **desktop contract gate runs and records its own exit**
(168/168) and the **full source suite passes on Windows** (1649 tests, 1643
pass, 0 fail, 0 cancelled, 6 skipped — each skip named with its reason). This
was the phase's open question: the suite does not merely "run"; it finishes.

The limitations are enumerated in §7. The ones that matter: the binary is
unsigned and has no updater, no human has driven the GUI or heard audio on
Windows, GPU/deep-separation weights were not exercised, and one fixture cannot
be expressed on Windows at all (a 70,000-character ffmpeg argument).

## 2. Final revision identity

| Item | Value |
| --- | --- |
| Evidence commit | `7c54f07174e199afec3f2c7f2850f0b7c901465c` (`7c54f07`) — the commit the final six-job green run (39819390531) ran against |
| Full suite | 1649 tests · 1643 pass · **0 fail** · 0 cancelled · 6 skipped — same counts on the three most recent runs |
| Desktop gate | 168 tests · 168 pass · **0 fail** · 0 cancelled · 445 s de-elevated in the final run (379–445 s across runs), and the step records its own exit |
| Base commit | `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` |
| Windows runs (all six jobs `success`) | [39819390531](https://github.com/imlochie/arena-os-canonical/actions/runs/39819390531) (`7c54f07`), [39810859260](https://github.com/imlochie/arena-os-canonical/actions/runs/39810859260) (`31b93cb`), [39810849313](https://github.com/imlochie/arena-os-canonical/actions/runs/39810849313) (`1261b70`), [39797631449](https://github.com/imlochie/arena-os-canonical/actions/runs/39797631449) (`805e4c0`), [39797838680](https://github.com/imlochie/arena-os-canonical/actions/runs/39797838680) (`9dbcfc2`), [39792179515](https://github.com/imlochie/arena-os-canonical/actions/runs/39792179515) (`7be5a46`), [39792397329](https://github.com/imlochie/arena-os-canonical/actions/runs/39792397329) (`52eba9e`), [39775173391](https://github.com/imlochie/arena-os-canonical/actions/runs/39775173391) (`8a1adee`) — eight runs across eight commits |
| Run that failed, and why | [39802222893](https://github.com/imlochie/arena-os-canonical/actions/runs/39802222893) (`c087806`): one test, Arcade's 1.2 s cold-start navigation budget (§5.18), fixed in `1261b70` and green in every run since |
| Predecessor runs | `39724952496` (5 fail), `39736649568` (1 fail), `39739476880` (1 fail), `39770687200` (1 fail) — each failure named and fixed in §5, none retried blindly |
| Installer | `Arena Setup 0.1.0.exe`, 621.1 MB; SHA-256 in `installer-sha256.txt` inside the `windows-package-<sha>` artifact |

Eight commits produced the same six green jobs, with exactly one failure in
between (the Arcade cold-start bound, §5.18, fixed in `1261b70` and green in
every run since). The evidence commit for this candidate is the first entry of
that list (the most recent run), `7c54f07`; the earlier runs are kept, and the
one failure among them is named, because a ledger that deletes an inconvenient
result stops being a ledger. Every Windows job prints `commit`,
`tree` and `digest` in its first step, so an artifact can be tied to the source
that produced it.

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

A second pass, once the gate could actually gate, fixed the Windows behaviour
the suite then exposed. These are **product runtime changes**, not test or CI
adjustments:

| Change | Windows behaviour it corrects |
| --- | --- |
| `src/lib/spaces/command-process.ts`: `taskkill /pid <pid> /T /F` for the non-group path | Windows has no process groups; `child.kill()` ended only the direct child, descendants held the inherited pipes and a cancelled or timed-out host command never settled |
| `src/lib/toolEffectService.ts`: grant root canonicalised with `realpath` before scope validation | the stored scope is resolved (`C:\Users\runneradmin\…`) while a temp path can arrive in 8.3 form (`C:\Users\RUNNER~1\…`), so valid approvals and applies were refused with `TOOL_GRANT_INVALID` |
| New `src/lib/fs-replace.ts`, used by `provision-store.ts` and `provision-runtime.ts` | `rename` over a file another handle is reading fails with `EPERM` on Windows; the provisioning status file is polled every 20 ms, so a valid write was recorded as a failed preparation |
| `src/lib/creative/shorts.ts`: subtitle path escaped for ffmpeg's filtergraph | `subtitles='C:\…'` is parsed as an option list (`:` separates options, `\` escapes), so the captioned render exited 1; it is now `C\:/…` |
| `src/lib/waveyard/ffmpeg.ts`: failure text keeps the head of stderr | ffmpeg writes the error first and then rewrites the tail with `\r` progress, so callers were shown `… .101 / 58.` instead of the failure |
| `src/lib/games/runtime-validation.ts`: 15 s navigation inside a 30 s smoke budget | a cold Chromium on a 2-core runner exceeded the 1.2 s navigation budget on a locally-fulfilled page, failing a game that satisfied every isolation assertion |

Tests changed alongside them — `tests/helpers/platform-exit.ts` replaces POSIX
`SIGKILL` assertions with the platform's real exit shape, and the PostgreSQL
fixtures derive `windowsPathDirs` from `desktop/runtime/config.ts` instead of
hand-writing an empty list — but each pairing is named in §5 so a reviewer can
see which half was the product.

Product runtime code therefore changed in eight files, all listed above. The
rest is packaging, CI, tests or documentation.

## 4. Windows acceptance matrix

Evidence run: [`windows-acceptance` run 39819390531](https://github.com/imlochie/arena-os-canonical/actions/runs/39819390531)
(commit `7c54f07`) — **all six jobs green**, including the desktop gate and the
full source suite. The same six jobs were green at `31b93cb`, `1261b70`,
`9dbcfc2`, `805e4c0`, `7be5a46`, `52eba9e` and `8a1adee` as well, so the result
is repeatable rather than a single sample; one run in between (`c087806`, run
39802222893) failed a single Arcade test, and §5.18 records why. Job-level
results below are read from the jobs' own reports through the checks API; the
job-log host is unreachable from this environment, so every step publishes its
result as an annotation.

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
| `npm run test:desktop` (de-elevated, restricted token) | **PASS — 168 tests, 168 pass, 0 fail, 0 cancelled, 445 s in the final run (379–445 s across runs), and the step records its own exit** | **PASS** — 168/168, clean exit |
| `npm test` (full source suite, Windows) | **PASS — 1649 tests, 1643 pass, 0 fail, 0 cancelled, 6 skipped**, green on the three most recent runs (`1261b70`, `31b93cb`, `7c54f07`) | **PASS with 2 environment failures** — 1645 tests, 1643 pass; the two failing tests require Chromium, which this sandbox cannot download (§7.9) |
| Per-file lifecycle probe (diagnostics job) | **29/29 files exit cleanly** with the gate's per-test budget | 29/29 exit cleanly |
| Staging identity guard | **PASS** — correctly refused packages while the tree was genuinely dirty (§5) | PASS |

The elevated control that used to sit beside the desktop gate is gone with the
defect it documented: the wrapper, not the token, was the problem (§5.8).

A skipped, timed-out or environment-blocked gate is **not** a pass and is not
counted as one here. The six skips in the Windows suite are enumerated in §7.8.

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
8. **"The de-elevated test process does not exit" — our wrapper, not the
   product.** For three runs the desktop step reported the complete TAP summary
   (`# pass 168 · # fail 0 · # duration_ms 427262`) and then no completion
   sentinel, so the step was recorded as BLOCKED. The true cause was in
   `scripts/windows-deelevated-step.mjs`: it writes a `.bat` whose last lines
   record `%ERRORLEVEL%` into a sentinel file, and the command it launched was
   `npm.cmd`. **A `.bat` that invokes another `.bat`/`.cmd` without `call`
   transfers control instead of returning**, so those last lines never ran and
   the wrapper polled out its whole bound. The receipts prove it: the suite
   printed `durationMs=1132214 exit=1` and the step still waited a full hour.
   Two independent controls agree — the same desktop command launched as `node`
   always wrote its sentinel, and the elevated control (which never used this
   wrapper) always finished. The wrapper now emits `call <cmd>` for batch
   programs. Nothing in the product ever hung; the handle reporter and
   `--test-force-exit` were chasing this defect.

   The probe this detour produced is kept: it is how the real cost of the two
   deep-separation files became visible (227 s for `separation.test.ts`, not the
   100 s the first bound allowed).
9. **Six crash-recovery tests asserted a POSIX signal.** Windows has no
   signals: `process.kill(pid, "SIGKILL")` is `TerminateProcess`, so the parent
   observes `signal: null` plus a non-zero status and
   `assert.equal(child.signal, "SIGKILL")` failed for a reason unrelated to
   recovery. `tests/helpers/platform-exit.ts` keeps the intent — abrupt death,
   never one of the fixture's deliberate 0/73/74 exits — on both platforms.
   This was the whole content of suite failures 512/513/514 at `2eab64c`.
10. **Host-command cancellation and timeouts killed only the direct child.**
    `runCommandProcess` used `child.kill("SIGKILL")` on Windows without a
    process group, so a shell's descendants survived, held the inherited pipes
    open and `close` never fired: cancelling a command hung instead of
    resolving with 130/124. The Windows path now runs
    `taskkill /pid <pid> /T /F`. Suite failures "cancelling a running host
    command kills its process group…" and "a real timed-out command retains its
    committed effect…" disappeared from the next run (8 fail → 5 fail).
11. **Grant validation compared a resolved scope with an unresolved path.**
    `validateGrant` compared the stored `canonicalScope` (produced by
    `realpath`) against `grant.root` as supplied. On Windows a temp path
    arrives in 8.3 form (`C:\Users\RUNNER~1\…`) while `realpath` returns
    `C:\Users\runneradmin\…`, so every persisted approval and apply rejected
    a valid grant with `TOOL_GRANT_INVALID` — all three `toolEffectService`
    tests. The grant is now canonicalised exactly as the proposal was.
12. **Arcade publication tests had no browser.** They refuse to publish without
    real browser verification (`503 Browser verification unavailable`). Ubuntu
    CI installs Chromium; the Windows jobs did not, so the failure looked like
    a portability defect. They now `npx playwright install chromium`.
13. **Test PostgreSQL fixtures hand-wrote `windowsPathDirs: []`.** The product
    resolver puts the package's `bin`/`lib` on `PATH` so the DLLs load; the
    fixtures bypassed it and failed on Windows for a reason the product does not
    have. Both fixtures and the mission helper now derive the value from
    `desktop/runtime/config.ts`.
14. **Per-test bounds were set below the work they bounded.** 120 s cut
    `separation.test.ts` (16 tests, 227 s on Linux) and 180 s cut the ONNX
    inference tests on a 2-core runner. Both jobs now use 600 s, which still
    turns a hang into a named failure.
15. **A fixture's 15-second allowance was read as a product defect.** The
    `turn_recorded` recovery test failed with
    `platform=win32 signal=SIGTERM status=null` — the exact signature
    `spawnSync` produces when its own `timeout` expires (verified directly:
    `{ signal: "SIGTERM", status: null, error.code: "ETIMEDOUT" }`). The
    fixture, not the product, was killed. The allowance is now 60 s and
    `harnessTimedOut()` fails with "the fixture never reached its boundary —
    the HARNESS killed it", so this can never again be recorded as a product
    failure (or as a pass).
16. **ffmpeg spoke filter syntax, not Windows paths.** The captioned-short
    render produced `ffmpeg exited 1` on Windows: `subtitles='C:\…\x.srt'`
    is parsed as a broken option list because `:` separates options and `\`
    escapes inside a filtergraph. The path is now escaped as
    `C\:/…/x.srt`. The error text also showed progress instead of the failure
    (`… .101 / 58. 6.101`) because it took the last 1,200 characters of a
    stream ffmpeg rewrites with `\r`; it now keeps the first lines.

17. **A green job carried a failure annotation.** The gate-summary step grepped
    the logs for phrases like "not permitted" and published `::error` for any
    match, so a benign `npm EPERM` line printed while cleaning up after a
    *successful* `npm ci` appeared as a failure on a passing job. In this
    environment the checks API is the only readable evidence, so an annotation
    that contradicts the job is worse than none. The step now checks the step
    outcomes first and publishes a warning with the counts; run 39797631449
    shows the warning form on a green gate.

18. **The Arcade browser smoke raced a cold Chromium.** Run 39802222893
    failed exactly one test with `page.goto: Timeout 1200ms exceeded` on the
    locally-fulfilled verification page; the same test passed on the four
    preceding commits. Navigation now has 15 s and the whole smoke 30 s instead
    of 1.2 s / 10 s. Every isolation assertion is unchanged — blocked request
    count, the `about:srcdoc` frame URL, the page URL and the non-uniform
    canvas — so the step still fails when a game escapes its sandbox, not when
    a runner is slow to start a browser.

## 6. What the Windows run actually proves

- The application **installs, launches, operates, closes, reopens and
  uninstalls** from a real Windows installer built from this checkout
  (`Arena Setup 0.1.0.exe`, 621.1 MB), with all nine sections of the installed
  acceptance PASS: `INSTALL`, `FIRST_LAUNCH`, `RUNTIME`, `WAVEYARD_WORKFLOW`,
  `EXPORT`, `RESTART_PERSISTENCE`, `PROCESS_CLEANUP`, `OFFLINE`,
  `SECURITY/PACKAGING AUDIT`. Every run that attempted it has passed: 31 of
  31 (the 13 earliest runs predate the installed-acceptance job and skipped it,
  which is not a pass and is not counted as one).
- Writable data lives under `%LOCALAPPDATA%\Arena`, not the repository.
- The embedded database is created on first launch, survives restarts, and is
  reachable only over loopback.
- Media export works through the **bundled** FFmpeg/FFprobe on Windows.
- The application runs offline: no request left `127.0.0.1`.
- The desktop contract gate runs **and records its own exit**:
  `ℹ tests 168 · ℹ pass 168 · ℹ fail 0 · ℹ cancelled 0`, in 445 s, under a
  restricted token (run 39819390531, `7c54f07`). Before the wrapper fix the
  same suite also passed, but the step could only report "no completion
  sentinel" (§5.8).
- The full source suite **passes on Windows**: 1649 tests, 1643 pass, 0 fail,
  0 cancelled, 6 skipped (run 39819390531, `7c54f07`), with the same counts on
  the two preceding commits. It finishes; it does not merely start.

What it does **not** prove is listed next.

## 7. Limitations (explicit, each with its evidence)

1. **The suite is green, and two of its tests remain timing-sensitive by
   construction.** The suite passes on Windows at `1261b70`, `31b93cb` and
   `7c54f07` — 1649 tests, 1643 pass, 0 fail, 0 cancelled, 6 skipped. Two tests
   run real child processes and failed exactly once each before their bounds
   were corrected: `seed-http.test.ts` (three TypeScript children on a 2-core
   runner against a 20 s guard, run 39783929848) and the Arcade browser smoke
   (cold Chromium against a 1.2 s navigation budget, run 39802222893). Both are
   fixed — 120 s and 15 s/30 s respectively, each logging where it stalled — and
   both are green in every run since. Their pass rate still depends on runner
   speed, so this record does not call the suite deterministic.

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
8. **Six skips, each with its own reason.** One fixture cannot exist on
   Windows: "oversized embedded metadata" hands ffmpeg a 70,000-character
   argument and Windows caps a command line at 32,767 characters, so it is
   skipped with that exact reason — the 64,000-character bound it exercises is
   product code, verified on POSIX. The other five are pre-existing suites that
   declare `{ skip: !pgUp }`: they only run when `DATABASE_URL` points at a live
   server, and the reproducible suite deliberately owns its own embedded
   cluster instead. Skips are counted separately by the reporter
   (`# skipped 6`) and never as passes.
9. **Two tests need a browser.** The Arcade publication test and the Waveyard
   live-session test refuse to run without a real Chromium; the Windows jobs
   install it (`npx playwright install chromium`). In this Linux sandbox the
   browser cannot be downloaded, so the local run reports exactly those two as
   failing and nothing else (1643/1645 pass) — an environment limit, not a
   product result.
10. **Inherited product evidence is not Windows evidence.** Arcade, Spaces and
    Waveyard workflows were validated on Linux at `13638fe`; this branch does
    not re-claim them wholesale for Windows. What it does is run those source
    files on Windows and report each result individually — which is why there is
    no line here that says "inherited, therefore passing".

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

The Windows test gate is **closed**: typecheck, 168 desktop contract tests and
the 1649-test source suite are green on the runner at the commit this record
names. What follows cannot be closed by a hosted runner.

1. **Run the GUI checklist** on a real Windows desktop: audible playback, meters,
   mixer/inserts, adapter-off offline pass.
2. **Code-sign the installer** and document the certificate path.
3. **Exercise deep separation (Demucs) on Windows**, including an honest failure
   when the optional GPU package is unavailable, and verify the CPU path end to
   end with real weights.
4. **Add an updater story** if the product intends one; today it has none by
   design and that is documented rather than hidden.
5. **Re-run product workflows on Windows** at the UI level (Arcade source
   workshop, Spaces missions) — their source files run in the Windows suite, but
   no human has driven their interfaces on Windows.
6. **Verify the post-reconciliation tip.** This commit changes documentation
   only. Once its workflow run completes it becomes the newest entry in §2's run
   list, and its counts must match the ones recorded here; if they do not, this
   record is wrong and the run wins.
