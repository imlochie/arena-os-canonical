# Arena Windows acceptance test — Phase 2

Phase 1 (the desktop runtime) was accepted at commit `4684582` with the
headless proof green: embedded PostgreSQL, local worker broker (all 4
queues), bundled FFmpeg/FFprobe, JS analysis engines, real export,
restart persistence, offline operation, a self-contained staged tree, and
423/423 + 43/43 tests. **The only unverified boundary is the installed
Windows application itself.** This document maps the acceptance mandate to
exact commands, and splits automated from manual steps — nothing here
redesigns the runtime or adds product features.

The local-worker architecture is intentionally different from
browser/cloud mode (local broker instead of Redis) while preserving the
server's job semantics — that is the design, not debt.

## The one command (Windows 10/11 x64 machine)

From the repo root on the Windows machine (Node.js + npm + git required
there; the *installed app* requires none of them):

```bat
npm install
npm run windows:acceptance -- --build --gates
```

That runs, in order: the automated gates, the NSIS build
(`desktop-release/Arena Setup 0.1.0.exe`), a silent install, the
packaging audit, the installed-app acceptance run, the orphan-process
check, and the abnormal-shutdown/recovery variant. It prints the
mandated PASS/FAIL report and writes full detail to
`desktop-windows-acceptance-report.json`.

Useful variants:

| Command | What it does |
| --- | --- |
| `npm run windows:acceptance -- --build` | build + install + full acceptance |
| `npm run windows:acceptance` | installer already built; full acceptance |
| `npm run windows:acceptance -- --skip-install` | app already installed |
| `npm run windows:acceptance -- --skip-abnormal` | skip the force-kill/recovery variant |
| `npm run windows:acceptance -- --uninstall` | also uninstall at the end |
| `node scripts/windows-acceptance.mjs --audit-only <dir>` | packaging audit only (any OS) |

## What is automated (and where the code lives)

The installed app runs the **same acceptance runner** that is pre-flighted
headless on Linux — `desktop/acceptance.ts` (wired in `desktop/main.ts`,
gated on `ARENA_DESKTOP_ACCEPTANCE=<result.json>`; normal app behaviour is
untouched). It executes against the real install: real
`%LOCALAPPDATA%\Arena`, real first-run initdb, real bundled binaries, the
Electron binary as the Node runtime (`ELECTRON_RUN_AS_NODE`).

| Mandate section | Automated by |
| --- | --- |
| §1 build the installer | orchestrator `--build` (electron-builder; needs github.com access) |
| §2 clean-machine install | silent NSIS `/S` + install-location discovery + packaging audit |
| §3 first launch | `firstLaunch` section (supervisor→ready, initdb, health, window created) |
| §4 Windows path validation | `paths` section (all dirs under the data root, `%LOCALAPPDATA%\Arena` on win32, no escaping symlinks) |
| §5 Waveyard workflow (API level) | `workflow` section (project → import WAV → waveform/peaks → analysis BPM/key/beat grid → sections → passthrough stem → arrangement → version → export → bundled-ffprobe verification, recording codec/rate/channels/duration/size/peak) |
| §6 restart persistence | `restartPersistence` section (two full close/relaunch cycles; project, source, analysis, stem, version, export record + media) |
| §7 process lifecycle | `processCleanup` section + OS-level orphan check (PowerShell, executables under install/data dirs) + abnormal force-kill variant with a recovery launch |
| §8 failure tests | `failureTests` section (malformed audio → honest 422 or failed job with real ffmpeg error; missing project → 404; AI → honest DEGRADED) |
| §9 offline | every URL in the run is loopback (asserted in-report); see manual step below for the adapter-off pass |
| §10 packaging audit | `packagingAudit` section + the orchestrator's install-tree audit (layout, no repo junk, no secrets, no escaping symlinks, license notices) |
| §11 final verification | `--gates` runs typecheck, tests, web build, desktop:e2e; plus `npm run desktop:acceptance-headless` |

Headless pre-flight (any OS, no Windows needed):

```bash
npm run desktop:prepare-server
npm run desktop:acceptance-headless
```

This is the exact code the installed app runs — 62 steps across 8
sections at the time of writing.

## Manual steps (GUI-only, on the Windows machine)

After the automated run, with the app installed and launched normally:

1. **Playback + meters** — open the acceptance project, play the
   imported track, confirm audible playback and that the meters move
   (the automated run proved real peaks exist for them).
2. **Mixer / inserts / cleanup UI** — alter mixer state, add inserts,
   run cleanup; confirm the UI reflects real state (the API surfaces are
   covered automatically).
3. **Offline pass** — disable the network adapter, relaunch Arena,
   re-open the project, play, export. AI may show unavailable; local
   audio must keep working.
4. **Abnormal shutdown observations** — the orchestrator records whether
   any owned processes survive a force-kill of the main process. If any
   survive, that is a genuine Windows finding to file (expected area:
   no Job-object tie between Electron and its children); the recovery
   launch proves the next start copes either way.

## npm environment notes (findings from the real Windows machine)

- **Install-script policy** (npm ≥ 11.16 / 12): dependency scripts run only
  when allowlisted. The repo commits the decision in `package.json`
  (`allowScripts`): embedded PostgreSQL platform packages (symlink
  hydration — required), @ffmpeg-installer/@ffprobe-installer platform
  packages (exec bits), esbuild (build), msgpackr-extract (worker prebuilds),
  unrs-resolver (eslint). `electron-winstaller` is explicitly DENIED — we
  build NSIS and never use its Squirrel tooling. `strict-allow-scripts=true`
  in `.npmrc` makes an uncovered script fail the install loudly.
- **Electron**: electron 44 ships NO npm install script — the runtime binary
  is hydrated lazily into `node_modules/electron/dist` (by
  `node node_modules/electron/install.js` or a first `npx electron --version`).
  `desktop:dist` validates the local dist (existence + version match) and
  passes it to electron-builder via `electronDist` — the build machine never
  contacts github.com for Electron.
- **Restricted networks**: skip the lazy Electron download with the SUPPORTED
  env var `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` (the old
  `electron_skip_binary_download` .npmrc key was never real npm config and
  only produced warnings — removed).
- **npm audit**: 0 production/runtime vulnerabilities (`npm audit --omit=dev`
  is clean). All 18 findings (6 high, 12 moderate) are dev/build-chain only:
  6 high in the ESLint glob chain (braces/micromatch/fast-glob — lint-time,
  trusted repo files), 12 moderate in the electron-builder and drizzle-kit
  chains (incl. the esbuild dev-server advisory). Nothing vulnerable is
  shipped in the installer; no dependency was mutated (pinned ecosystem).

## Recursive self-packaging — fixed, with a staging invariant

**Defect (found on the real Windows machine):** after the first successful
`desktop:dist`, the repo root contains `desktop-release/win-unpacked` (the
entire previous build). Turbopack's output file tracing **recursively
includes repo-root directories that exist at build time** (proven: any file,
any depth — a text probe, a `.bin`, a `.exe` all landed in
`.next/standalone`) unless they are listed in `outputFileTracingExcludes`.
The next build therefore staged the previous installer's full contents
inside `desktop-package/server/desktop-release/...` and electron-builder
signed the same binaries twice — once normally, once under
`resources/app/server/desktop-release/...` — before dying in icon-tool.

**Fix (both layers):**
1. `next.config.ts` excludes `./desktop-release/**` and
   `./desktop-package/**` from desktop output tracing (verified with a
   control group: excluded dir vanishes, unexcluded probe dir still swept).
2. `scripts/lib/staged-tree-guard.mjs` — staging REJECTS any tree
   containing packaging output (`desktop-release`, `desktop-package`,
   `win-unpacked`/`linux-unpacked`/`mac-unpacked`, or a nested
   `resources/app` layout) at any depth; `desktop-prepare-server` runs it
   on every staging, and also starts from a fresh `.next/standalone`.
   `desktop:e2e` asserts the same invariant on the staged tree, and the
   acceptance runner's packaging audit flags the same names.

## Offline tool seeding (NSIS) — for networks where github downloads hang up

electron-builder downloads its NSIS toolchain at BUILD time from
github.com (`nsis-3.0.4.1.7z`, `nsis-resources-3.4.1.7z`). If those
transfers die mid-flight (`socket hang up`) the installer cannot be built,
even though the Electron runtime and signing tools are already local.

The supported offline path: electron-builder checks a **predictable
archive cache before any network access**
(`<cache>\<releaseName>\<filename>`, verified against the checksums
app-builder-lib itself enforces, then unpacked by its own machinery —
nothing is bypassed). Seed it once:

```bat
:: 1. Download BOTH archives once — a BROWSER usually succeeds where
::    Node's fetch is cut off (any machine with access works, then copy):
::    https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z
::    https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z
::
:: 2. Verify + place them (SHA-256 checked against the installed
::    app-builder-lib; truncated downloads are rejected):
node scripts\desktop-seed-builder-tools.mjs "%USERPROFILE%\Downloads\nsis-3.0.4.1.7z" "%USERPROFILE%\Downloads\nsis-resources-3.4.1.7z"
::
:: 3. Re-run the build — no github.com access needed for tools anymore:
npm run desktop:dist
```

`node scripts\desktop-seed-builder-tools.mjs --status` shows the cache
root and which tools are seeded/extracted (`winCodeSign-2.6.0` is usually
already cached once signing has run once). Seeded archives survive across
builds; the seed script refuses to place anything whose checksum does not
match the installed app-builder-lib's expectations.

## Honest expectations

- The installer cannot be built inside the development sandbox
  (github.com TLS block) — hence `--build` runs on the Windows machine.
- `desktop:smoke` (window + IPC roundtrip) needs the Electron binary and
  a display; on headless Linux CI it is skipped with a clear message.
- If the abnormal-shutdown variant finds surviving processes, the report
  says so — it is never silently marked PASS. Fix policy (mandate §12):
  identify the exact Windows-specific root cause, fix the smallest
  correct layer, add a regression test where practical, rebuild, rerun.
