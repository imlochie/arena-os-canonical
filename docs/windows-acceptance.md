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

## Honest expectations

- The installer cannot be built inside the development sandbox
  (github.com TLS block) — hence `--build` runs on the Windows machine.
- `desktop:smoke` (window + IPC roundtrip) needs the Electron binary and
  a display; on headless Linux CI it is skipped with a clear message.
- If the abnormal-shutdown variant finds surviving processes, the report
  says so — it is never silently marked PASS. Fix policy (mandate §12):
  identify the exact Windows-specific root cause, fix the smallest
  correct layer, add a regression test where practical, rebuild, rerun.
