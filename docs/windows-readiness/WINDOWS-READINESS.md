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
| Evidence commit | `7096fa8e21d9b06e91031884783fc7c0fc314d0c` (`7096fa8`) — the last commit that changes what the jobs verify (product code, a test, or a command), and the commit the six-job green run 39928621349 ran against |
| Branch head | this commit — documentation only since `7096fa8`. Its own run is listed in PR #26 and not here: a file cannot record the result of the run that reads it |
| Why they differ | A documentation commit still gets a full run, and that run proves the tree it checked builds and passes — but it does not change what was verified. The evidence commit names the content the jobs verified; the head is always at least one documentation commit ahead of the newest run this file can cite, so it is never the place to look for the branch's current state |
| Full suite | 1649 tests · 1643 pass · **0 fail** · 0 cancelled · 6 skipped — the same counts on every green run since `1261b70` (all listed below) |
| Desktop gate | 168 tests · 168 pass · **0 fail** · 0 cancelled · 340 s de-elevated in the final run (258–445 s across runs), and the step records its own exit |
| Base commit | `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` |
| Windows runs (all six jobs `success`) | [39938802088](https://github.com/imlochie/arena-os-canonical/actions/runs/39938802088) (`86ede5f`), [39932071413](https://github.com/imlochie/arena-os-canonical/actions/runs/39932071413) (`464c947`), [39928621349](https://github.com/imlochie/arena-os-canonical/actions/runs/39928621349) (`7096fa8`), [39911183957](https://github.com/imlochie/arena-os-canonical/actions/runs/39911183957) (`95f4ce9`), [39908416966](https://github.com/imlochie/arena-os-canonical/actions/runs/39908416966) (`15e4666`), [39903639972](https://github.com/imlochie/arena-os-canonical/actions/runs/39903639972) (`db06e29`), [39899148687](https://github.com/imlochie/arena-os-canonical/actions/runs/39899148687) (`1b0cfdb`), [39892723344](https://github.com/imlochie/arena-os-canonical/actions/runs/39892723344) (`e0da39d`), [39890546669](https://github.com/imlochie/arena-os-canonical/actions/runs/39890546669) (`71cdee7`), [39819390531](https://github.com/imlochie/arena-os-canonical/actions/runs/39819390531) (`7c54f07`), [39810859260](https://github.com/imlochie/arena-os-canonical/actions/runs/39810859260) (`31b93cb`), [39810849313](https://github.com/imlochie/arena-os-canonical/actions/runs/39810849313) (`1261b70`), [39797838680](https://github.com/imlochie/arena-os-canonical/actions/runs/39797838680) (`9dbcfc2`), [39797631449](https://github.com/imlochie/arena-os-canonical/actions/runs/39797631449) (`805e4c0`), [39792397329](https://github.com/imlochie/arena-os-canonical/actions/runs/39792397329) (`52eba9e`), [39792179515](https://github.com/imlochie/arena-os-canonical/actions/runs/39792179515) (`7be5a46`), [39779059146](https://github.com/imlochie/arena-os-canonical/actions/runs/39779059146) (`23e7486`), [39775173391](https://github.com/imlochie/arena-os-canonical/actions/runs/39775173391) (`8a1adee`) — eighteen runs across eighteen commits |
| Runs that failed, and why | [39783929848](https://github.com/imlochie/arena-os-canonical/actions/runs/39783929848) (`6485fe8`): seed-http's SIGKILL restart test at its 20 s guard (§7.1) — the same test later hit the 120 s cap that replaced the guard in run 39896001156, so the cap, not the test, was the problem (§5.22); both are gone. [39886922288](https://github.com/imlochie/arena-os-canonical/actions/runs/39886922288) (`5c54f76`, documentation only — the diff from `7c54f07` is empty outside `docs/`): the conversion provenance test exceeded its own 60 s budget, which the same code had cleared 35 minutes earlier; fixed at the cause in `71cdee7` (§5.19). [39802222893](https://github.com/imlochie/arena-os-canonical/actions/runs/39802222893) (`c087806`): one test, Arcade's 1.2 s cold-start navigation budget (§5.18), fixed in `1261b70`. [39896001156](https://github.com/imlochie/arena-os-canonical/actions/runs/39896001156) (`f43b86e`, documentation only): seed-http's SIGKILL restart test hit the 120 s cap it had been given after the first such failure, in a run whose suite took 37 minutes against 16.5 in the preceding one; the cap was measuring the runner, and both local caps are gone in favour of the suite's single declared bound (§5.20). [39901358509](https://github.com/imlochie/arena-os-canonical/actions/runs/39901358509) (`ff1f1b3`, documentation only): the desktop gate's export-publication test hit its own 30 s cap and the aborted transaction failed the rest of its file; the source suite ran the same file in the same run and passed (§5.21). [39905312322](https://github.com/imlochie/arena-os-canonical/actions/runs/39905312322) (`699747c`, documentation only): a crash fixture's own 60 s allowance expired, and the harness named itself as the killer; the allowance now derives from the suite's declared bound (§5.22). Five failures are kept here, and no failing commit was re-run until it turned green |
| Predecessor runs | `39724952496` (5 fail), `39736649568` (1 fail), `39739476880` (1 fail), `39770687200` (1 fail) — each failure named and fixed in §5, none retried blindly |
| Installer | `Arena Setup 0.1.0.exe`, 621.1 MB; SHA-256 in `installer-sha256.txt` inside the `windows-package-<sha>` artifact |

Eighteen commits produced the same six green jobs. Six of the twenty-four runs
behind them failed, and all six are named above: the Arcade cold-start
bound (§5.18) and local caps that measured the runner (§5.19–§5.22). Each was
fixed at its cause and the fixed commit was run again; no failing commit was
re-run until it turned green. A ledger that deletes
an inconvenient result stops being a ledger, and one that keeps it without a
cause is noise.

The evidence commit in the table is `7096fa8` — the last commit that changes
what the jobs verify, in this case the Linux CI test-cleanup fix in §7.11 — and
39928621349 is its run. The commits after it, including the one you are reading,
change documentation only. They still produce full runs, and those runs are
linked from PR #26 rather than from this file, because a file cannot record the
result of the run that reads it. The gap is the convention, not a stale number:
the head is always at least one documentation commit ahead of the newest run
this document can cite. Every Windows job prints `commit`, `tree` and `digest`
in its first step, so an artifact can be tied to the source that produced it.

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

Evidence run: [`windows-acceptance` run 39890546669](https://github.com/imlochie/arena-os-canonical/actions/runs/39890546669)
(commit `71cdee7`) — **all six jobs green**, including the desktop gate and the
full source suite. The same six jobs were green at `7c54f07`, `31b93cb`,
`1261b70`, `805e4c0`, `9dbcfc2`, `7be5a46`, `52eba9e` and `8a1adee` as well, so
the result is repeatable rather than a single sample; two runs in between
failed one test each (`c087806`, run 39802222893; `5c54f76`, run 39886922288),
and §5.18 and §5.19 record why. Job-level
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
| `npm run test:desktop` (de-elevated, restricted token) | **PASS — 168 tests, 168 pass, 0 fail, 0 cancelled, 340 s in the final run (258–445 s across runs), and the step records its own exit** | **PASS** — 168/168, clean exit |
| `npm test` (full source suite, Windows) | **PASS — 1649 tests, 1643 pass, 0 fail, 0 cancelled, 6 skipped**, green on every run in §2 (which lists them all, green and failed, so the count cannot drift from the list) | **PASS with 2 environment failures** — 1649 tests, 1647 pass, 2 fail, 0 cancelled, 0 skipped at `e0da39d`; the two failing tests require Chromium, which this sandbox cannot download (§7.9) |
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

    Two more contradictions of the same class survived that fix, both in
    places where the *step* is deliberately allowed to fail. The elevation
    Probe's Variant A is a control that must fail — a `cmd` builtin cannot
    write the completion sentinel, and the point of the variant is that the
    wrapper reports that instead of waiting out its bound — yet it published
    `::error` on a green job. The staged-tree packaging audit runs an
    installed-layout auditor against a staged tree on purpose, so it reports
    the media binaries as missing, and it too published `::error` on a green
    job. Both wrappers now read `ARENA_STEP_TOLERATED_FAILURE`: the exit status
    is untouched, so the workflow still decides whether to tolerate the step,
    but the annotation becomes a `::warning` carrying the reason the step is
    tolerated. A green job now carries only warnings and verified counts, and
    run 39892723344 (`e0da39d`) is the first where that holds for all six jobs:
    not one `failure` annotation, only warnings and the counts each wrapper
    reports.

18. **The Arcade browser smoke raced a cold Chromium.** Run 39802222893
    failed exactly one test with `page.goto: Timeout 1200ms exceeded` on the
    locally-fulfilled verification page; the same test passed on the four
    preceding commits. Navigation now has 15 s and the whole smoke 30 s instead
    of 1.2 s / 10 s. Every isolation assertion is unchanged — blocked request
    count, the `about:srcdoc` frame URL, the page URL and the non-uniform
    canvas — so the step still fails when a game escapes its sandbox, not when
    a runner is slow to start a browser.

19. **The conversion test's 60 s bound sat below its own cost on the runner.**
    Run 39886922288 (`5c54f76`, documentation only) failed one test: "native
    conversion and reconversion preserve original acquisition rights and
    checksum lineage" timed out at its 60 s budget, which also failed the two
    subtests it had not finished. The diff from `7c54f07` is empty outside
    `docs/`, and that commit's run was green 35 minutes earlier, so this was a
    budget, not a product regression. The test's work is small but not free: it
    starts a PostgreSQL cluster of its own (`initdb` writes 968 files / 39 MB)
    and then drives native FFmpeg probe, encode and full-decode verification
    for every conversion, six of them inside the corrupt-metadata repair loop.
    Measured on this checkout: 3.1 s for the test, 3.9 s for the file — and
    >60 s once on a 2-core runner sharing its disk with the electron-builder
    job. The bound is a hang detector, not a performance target, so it moved to
    120 s (the bound the suite already gives `separation-real-ort`, `claim`,
    `seed-http` and `service`, and far below the 600 s the product's own
    `execTool` allows one conversion), and the test now emits a `t.diagnostic`
    line per phase, so the next overrun names where the time went instead of
    only that it ran out. No assertion, isolation check or verification step
    was relaxed; the fix is `71cdee7`. The 120 s cap was itself removed when the
    same class of failure hit another test (§5.20) — the diagnostics and this
    record of the failure remain.

20. **Two local per-test caps were measuring the runner, not the product.**
    Runs 39886922288 and 39896001156 each stopped a different test at a cap the
    test had declared for itself — 60 s for the conversion provenance test, then
    120 s for seed-http's SIGKILL restart test — and neither test asserts
    anything about duration. The second failure is the clearer signal: the whole
    suite took 37 minutes in that run against 16.5 minutes in the one before it,
    with the same code (`f43b86e` changes documentation only), so the machine
    was slow, not the code. The suite already declares exactly one per-test hang
    detector, `--test-timeout`, 10 minutes in CI; that declaration now applies
    to a developer run as well (`scripts/test-source.mjs` supplies it instead of
    leaving the local run unbounded), and the two local caps are gone. The phase
    log lines stay, and the de-elevated wrapper now carries the `[phase]` and
    `timed out after` lines into its annotation, so a timeout says where it
    stopped instead of only that it stopped. No assertion, isolation check or
    verification step is relaxed, and the failures above remain in this record.
    Run 39899148687 (`1b0cfdb`) is the first with the arrangement in force: six
    jobs green, 1649 tests / 1643 pass / 0 fail, 168/168 on the desktop gate.

21. **A 30 s cap in the desktop gate took the rest of its file down with it.**
    Run 39901358509 failed the gates job: "export publication and cleanup use
    authoritative row locks and exact references" — a parent test that builds
    its own PostgreSQL cluster — stopped at its 30 s cap, and the seven tests
    after it failed in 34–260 ms on the state the aborted transaction left
    behind (a row lock still held), until the file itself hit its 600 s bound.
    The source suite ran the same file in the same run and passed, because
    there the declared bound is 10 minutes: the code was fine, the cap was not,
    and aborting mid-transaction turns one slow test into a broken file.
    Removing it is the same fix as §5.20, applied with it to every test that
    builds a cluster or a browser and had declared a cap below the declared
    bound — `export-publication` (30 s), `export-bundle` (60 s),
    `publication-integrity` (60 s), `session-live` (60 s) — so no test in that
    class can poison its own file. Tests whose cap is part of what they assert
    (the Mission deadline tests) keep theirs. Run 39903639972 (`db06e29`) was
    the first with all four removed: six jobs green, 1649 tests / 1643 pass /
    0 fail, 168/168 on the desktop gate.

22. **A crash fixture's 60 s allowance, and an annotation that blamed the wrong
    file.** Run 39905312322 (`699747c`, documentation only) failed one test —
    "real PostgreSQL restart after before_completed preserves identity/results
    and executes command once". The harness did what §5.15 built it to do: it
    named itself as the killer ("the HARNESS killed it after its own timeout
    (platform=win32 signal=SIGTERM status=null)") instead of reporting a product
    failure. But the gate still went red for a number nobody asserted. That
    fixture spawns a whole TypeScript child that talks to PostgreSQL, so a
    constant bound measures the machine: `tests/helpers/hang-bound.ts` now
    derives such bounds from the suite's declared per-test bound when CI sets it
    (`ARENA_TEST_TIMEOUT_MS`), and the crash fixtures in `mission-recovery` and
    the child scripts in `service.test.ts` use it. A developer run keeps its
    local 60 s / 30 s guard.

    The same run exposed a defect in the annotation added by §5.20: it carried
    the last `[phase]` lines in the whole log, so this failure was annotated
    with seed-http's download phases from a different file. It now takes only
    the phases printed inside the failing test's own block. An annotation that
    attributes work to the wrong test is worse than none, which is the premise
    of §5.17. Run 39908416966 (`15e4666`) is the first green run with both
    changes in force: six jobs, 1649 tests / 1643 pass / 0 fail, 168/168 on the
    desktop gate, and no `failure` annotation on any job.

## 6. What the Windows run actually proves

- The application **installs, launches, operates, closes, reopens and
  uninstalls** from a real Windows installer built from this checkout
  (`Arena Setup 0.1.0.exe`, 621.1 MB), with all nine sections of the installed
  acceptance PASS: `INSTALL`, `FIRST_LAUNCH`, `RUNTIME`, `WAVEYARD_WORKFLOW`,
  `EXPORT`, `RESTART_PERSISTENCE`, `PROCESS_CLEANUP`, `OFFLINE`,
  `SECURITY/PACKAGING AUDIT`. No run that attempted it has failed (the 13
  earliest runs predate the installed-acceptance job and skipped it, which is
  not a pass and is not counted as one). The total grows with every green run;
  the assertion is the absence of a failure, not a particular count.
- Writable data lives under `%LOCALAPPDATA%\Arena`, not the repository.
- The embedded database is created on first launch, survives restarts, and is
  reachable only over loopback.
- Media export works through the **bundled** FFmpeg/FFprobe on Windows.
- The application runs offline: no request left `127.0.0.1`.
- The desktop contract gate runs **and records its own exit**:
  `ℹ tests 168 · ℹ pass 168 · ℹ fail 0 · ℹ cancelled 0`, in 340 s, under a
  restricted token (run 39928621349, `7096fa8`). Before the wrapper fix the
  same suite also passed, but the step could only report "no completion
  sentinel" (§5.8).
- The full source suite **passes on Windows**: 1649 tests, 1643 pass, 0 fail,
  0 cancelled, 6 skipped (run 39928621349, `7096fa8`), with the same counts on
  every green run since `1261b70`. It finishes; it does not merely start.

What it does **not** prove is listed next.

## 7. Limitations (explicit, each with its evidence)

1. **The suite is green, and three of its tests remain timing-sensitive by
   construction.** The suite passes on Windows at `1261b70`, `31b93cb`,
   `7c54f07`, `71cdee7`, `e0da39d`, `15e4666` and `7096fa8` — 1649 tests, 1643 pass, 0 fail,
   0 cancelled, 6 skipped. Four tests run real child processes, and three of
   them stopped at caps they had set for themselves before that was corrected:
   `seed-http.test.ts` (three TypeScript children) at a 20 s guard (run
   39783929848) and again at the 120 s cap that replaced it (run 39896001156);
   the conversion provenance test (a PostgreSQL cluster plus native FFmpeg) at
   60 s (run 39886922288); and the export-publication test (a PostgreSQL cluster)
   at 30 s (run 39901358509), where the aborted transaction then failed the rest
   of its file. None of those caps asserted anything about duration, so all are
   gone: one bound, declared by the suite, now applies to every test and to a
   developer run (§5.20, §5.21). The fourth, the Arcade smoke, failed once
   against a real assertion of its own — 1.2 s to navigate a locally-fulfilled
   page (run 39802222893) — and keeps its 15 s navigation inside a 30 s smoke. All three log where they stalled, and each is green in
   every run since its fix. Their pass rate still depends on runner speed, so
   this record does not call the suite deterministic.

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
   failing and nothing else (1647/1649 pass, measured at `e0da39d`) — an
   environment limit, not a product result.
10. **Inherited product evidence is not Windows evidence.** Arcade, Spaces and
    Waveyard workflows were validated on Linux at `13638fe`; this branch does
    not re-claim them wholesale for Windows. What it does is run those source
    files on Windows and report each result individually — which is why there is
    no line here that says "inherited, therefore passing".

11. **This record is the Windows gate, not the repository's whole CI.** The
    branch also runs the repository's Linux CI (`ci.yml`: typecheck, lint, the
    source suite, build, the A7 runtime acceptance, browser audio and the
    compose images). That workflow failed on the committed tip `95f4ce9` at one
    test — "two concurrent starts cannot corrupt each other — the second is
    refused" in `src/lib/waveyard/separation/provision-store.test.ts`. The job
    log host is unreachable from here, but the check annotation carries the TAP
    block and names the failure exactly: `ENOTEMPTY: directory not empty,
    rmdir '/tmp/wy-store-…/env'`, thrown by the test's own `finally`. The
    preparation manager persists `ready` *before* its last status write and the
    lock release, so a test that removed its temp tree as soon as
    `getStatus()` said `ready` was deleting a directory still being written to;
    the throwing `finally` then replaced whatever the body had produced, which
    is why a green test was reported as a failure with no assertion in it. The
    test now joins the lifecycle's settlement — a `start()` on a ready machine
    resolves only after cleanup, the contract its sibling test already asserts —
    and removes the tree with retries, and a cleanup that still fails is logged
    rather than allowed to replace the result. That is a defect in the test, not
    in the product. It is fixed in `7096fa8`, whose Linux CI run
    ([39928621325](https://github.com/imlochie/arena-os-canonical/actions/runs/39928621325))
    is green in all four jobs with no failure annotation — including the test
    that had failed. The next commit's CI run (39932071273 on `464c947`) was
    cancelled before it executed a single test: `actions/setup-node` spent the
    job's whole 10-minute budget in a failing cache restore and logged "Failed
    to restore: Egress is over the account limit", so every acceptance step was
    skipped while the workflow's other three jobs passed. The next attempt
    (39935007547 on `285064d`) never reached a verdict either: the browser job
    spent 5 m 48 s of its 10-minute budget downloading the browser, ran its
    three test steps successfully, and was killed by its own wall clock; the
    test/build job was killed at its 30-minute budget 14.5 minutes into its Test
    step. On a healthy runner those jobs take 8 m 50 s and 14–22 minutes, so
    both wall clocks sit above their measured cost — the runs that hit them
    did so while the account was throttled, which is also what the Egress
    message above says.

    The conclusion recorded here is deliberately narrow. **Linux CI is green at
    `7096fa8`, all four jobs** — that is the run that verifies the fix for the
    one real failure, and it is the Linux evidence for this candidate. The two
    later tips were cancelled by an account condition, not by a test, and they
    are neither counted as a pass nor reported as a product failure. This
    record claims the Windows gate plus that one green Linux CI run; it does
    not claim that every check on every later commit is green, and a reviewer
    should re-run CI once the account's egress limit clears rather than read
    "cancelled" as either.

    That re-run happened on `86ede5f` and settled the question
    ([39938802094](https://github.com/imlochie/arena-os-canonical/actions/runs/39938802094)):
    **all four jobs green, no failure annotation**, with the same budgets the
    two cancelled runs hit — the browser job finished in 8 m 39 s of its 10
    minutes and the test/build job in 14 m 57 s of its 30. So the budgets are
    correct as written and the earlier cancellations were the throttled
    account, not a tight bound. Raising them would have papered over exactly
    the condition a reviewer needs to know about, and this record does not
    claim otherwise.

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
6. **Verify the newest commit's run.** Runs are recorded here for every commit
   that changes what the jobs verify — product code, tests, or a command; that
   commit and its run are the evidence row in §2. A commit that changes only
   documentation, or only the annotation level of a tolerated control, is
   verified by its own workflow run, linked from the pull request — a file
   cannot record the result of the run that reads it. If that run is not six
   green jobs with the counts above, this record is wrong and the run wins.
