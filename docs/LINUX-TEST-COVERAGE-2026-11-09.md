# Linux test coverage map — measured 2026-11-09

Generated from a full run of every test file on this branch (`8a0ae14`,
PR #29) in a provisioned Linux sandbox, cross-referenced with what each
workflow in `.github/workflows/` actually executes. Numbers below are
measured, not estimated. Regenerate rather than edit by hand: the method is
reproducible from the commands in §1.

## 1. Method

* Files: every `*.test.ts`, `*.test.tsx`, `*.test.mjs` outside
  `node_modules` — **285 files** (all `node:test`; no vitest/jest;
  no root `test` script, only `desktop` has one).
* Invocation, matching the repo's workflows: `.ts` via
  `scripts/node_modules/.bin/tsx --test <absolute path>`; `.mjs` via
  `node --test <file>` from its directory. **cwd = the file's own package
  directory** (`lib/arena`, `artifacts/api-server`, `artifacts/arenaforge`,
  `scripts`, `desktop`). Running everything from `scripts/` (what
  `windows-recovered-stack.yml` does) breaks 4 files that read
  paths relative to `process.cwd()` (§4).
* Environment: Node 22, `pnpm install --frozen-lockfile` (full); PostgreSQL
  16.14 server binaries (`initdb`/`postgres`/`pg_ctl`) on PATH, ffmpeg/ffprobe
  on PATH, Python 3.11; `DATABASE_URL=postgres://unit@127.0.0.1:1/unit`
  (the import-time convention; suites that need a database start their own).
  No Chromium, no outbound network, no pinned model weights, no built
  `dist/` bundles. 2 files in parallel on 2 vCPU, 900 s cap per file.
* A second pass started a **live** PostgreSQL on 127.0.0.1:5432 as
  `postgres:postgres`, created `app_db`, applied the 25 desktop migrations
  through `desktop/database.mjs` (177 tables), set `DATABASE_URL` to it, and
  re-ran every file that probes for a live server.

## 2. Headline numbers

| | files | tests | pass | fail | skip | failing files |
|---|---|---|---|---|---|---|
| Provisioned Linux, package cwd | 285 | 2152 | 2078 | 51 | 23 | 22 |
| + live PostgreSQL on 5432 with migrations | 285 | 2152 | 2102 | 34 | 16 | 16 |

(`separation-real-ort.test.ts` hit the 900 s cap and produced no TAP summary,
so its tests are not in these totals.) The historical "76 environment-dependent
failures" (ledger §3, `tests=1446 pass=1353 fail=76 skip=17`, no PostgreSQL
binaries) is superseded by these figures.

## 3. What CI actually runs today

| workflow | runner | trigger | test files run |
|---|---|---|---|
| `windows-recovered-stack.yml` | windows-latest | push / PR | 24 |
| `waveyard-worker-local-db.yml` | ubuntu-22.04 | push / PR | 3 |
| `windows-package.yml` | windows-latest | push / PR | 26 |
| `linux-arcade-admission.yml` | ubuntu-22.04 (nix), workflow_dispatch only | manual | 3 |
| `waveyard-browser-timing.yml`, `windows-arcade.yml`, `windows-audio-isolation.yml` | — | — | 0 (acceptance scripts, no test files) |

* Covered by an automatic workflow on any OS: **53 / 285** files
  (24 Windows recovered-stack + 3 Linux DB + 26 desktop on Windows).
* Covered automatically **on Linux: 3** files.
* **Uncovered anywhere: 232 files**, of which **212 pass on provisioned Linux today**
  (1674 tests, 1658 passing, 16 skipped; 497 s of
  summed per-file wall time). 181 of those 212 files carry no
  service marker at all (no PostgreSQL, ffmpeg, Python, browser or ORT).

## 4. The 22 files that fail on provisioned Linux, attributed

| file | result | class | why |
|---|---|---|---|
| `artifacts/api-server/src/imported/arcade/runtime-verification.test.ts` | 3/20 | browser | 17 tests: Chromium unavailable (CHROMIUM_PATH) |
| `artifacts/api-server/src/imported/arcade/source-rule-validation.test.ts` | 0/2 | network | pinned upstream fetch via safeFetch: 'fetch failed' (no outbound access here) |
| `artifacts/api-server/src/imported/archive/routes.test.ts` | 1/6 | live-postgres | 'PG required'; 6/6 with a live server |
| `artifacts/api-server/src/imported/chat/route.test.ts` | 5/6 | live-postgres | 'PG required'; 6/6 with a live server |
| `artifacts/api-server/src/lib/spaces-browser.real.test.ts` | 0/1 | browser+network | real browser against example.com |
| `artifacts/api-server/src/lib/waveyard/local-sync.test.ts` | 1/3 | network | LOCAL_SYNC_NO_PRIVATE_NETWORK: needs a private LAN interface |
| `artifacts/arenaforge/src/lib/arcadeManifest.test.ts` | 5/6 | browser-globals | test 5: 'localStorage is not defined' |
| `desktop/database.test.mjs` | 4/5 | live-postgres | ECONNREFUSED on DATABASE_URL; 5/5 with a live server |
| `desktop/server-contract.test.mjs` | 0/1 | built-artifacts | needs artifacts/api-server/dist/index.mjs (packaging test; Windows job builds first) |
| `lib/arena/src/lib/arenaRooms.test.ts` | 4/5 | cwd | test 4 scans process.cwd()/src/app; passes 5/5 from artifacts/arenaforge |
| `lib/arena/src/lib/emailInbox.test.ts` | 4/7 | live-postgres | assert.fail('PG required') without a live server on DATABASE_URL; 7/7 with one |
| `lib/arena/src/lib/identitySurface.test.ts` | 0/2 | stale-test | scans src/app/api, which exists nowhere in the repo |
| `lib/arena/src/lib/mediaArchive/local.test.ts` | 0/1 | stale-test | imports lib/arena/src/app/api/library/route, which does not exist |
| `lib/arena/src/lib/mediaArchive/mediaArchive.test.ts` | 0/6 | live-postgres | 'PG required'; 6/6 with a live server |
| `lib/arena/src/lib/spaces/arcade-development.test.ts` | 2/3 | live-postgres | query against DATABASE_URL; 3/3 with a live server |
| `lib/arena/src/lib/spaces/spaces-tools.test.ts` | 19/20 | fixture-vs-esm | test 14 writes a CommonJS x.test.js under a "type":"module" tree: 'require is not defined' |
| `lib/arena/src/lib/waveyard/useStemTransport.test.ts` | 0/1 | vite-only | imports './live-stem-worklet.ts?worker&url' (Vite syntax); node:test cannot load it |
| `lib/arena/src/lib/waveyard/worker-local/broker.test.ts` | 7/8 | stale-expectation | test 8 expects 5 queues; the worker now also registers waveyard-drum/harmony/vocal-analysis (queue.ts) |
| `scripts/waveyard-audio-restore.integration.test.ts` | 0/1 | browser | Playwright-driven acceptance |
| `scripts/waveyard-automation-persistence.test.ts` | 0/1 | browser | Playwright-driven acceptance |
| `scripts/waveyard-clip-donor-preview.test.ts` | 0/1 | browser | Playwright-driven acceptance |
| `lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts` | ?/? (timeout) | built-artifacts+weights | test 8: 'isolated separation worker is not installed in this API build'; then hung to the 900 s cap; 4 tests skip without pinned weights |

Class totals: browser 4, network 2, live-postgres 6, browser+network 1, browser-globals 1, built-artifacts 1, cwd 1, stale-test 2, fixture-vs-esm 1, vite-only 1, stale-expectation 1, built-artifacts+weights 1.

cwd-sensitive files (pass from their package directory, fail from `scripts/`):
`lib/arena/src/lib/authorization.integration.test.ts`, `lib/arena/src/lib/deviceChannel.integration.test.ts`, `lib/arena/src/lib/wave3.test.ts`, `lib/arena/src/lib/arenaRooms.test.ts`.

Files that pass with skips (skips are environment opt-ins, reported but not proven):
* `lib/arena/src/lib/waveyard/library/service.test.ts` — 53/57, 4 skip
* `artifacts/api-server/src/imported/arcade/route.test.ts` — 0/3, 3 skip
* `artifacts/api-server/src/imported/arcade/source/route.test.ts` — 0/1, 1 skip
* `desktop/arcade-bepinex-distribution.test.mjs` — 1/3, 2 skip
* `desktop/arcade-bepinex-profiles.test.mjs` — 0/2, 2 skip
* `desktop/arcade-bepinex-runtime.test.mjs` — 3/6, 3 skip
* `lib/arena/src/lib/foundry.test.ts` — 4/5, 1 skip (0 skip with a live PostgreSQL)
* `lib/arena/src/lib/mindApps.test.ts` — 3/5, 2 skip (0 skip with a live PostgreSQL)
* `lib/arena/src/lib/modelHub/registry.test.ts` — 0/1, 1 skip (0 skip with a live PostgreSQL)
* `lib/arena/src/lib/wave3.test.ts` — 7/9, 2 skip (0 skip with a live PostgreSQL)
* `lib/arena/src/lib/wave3b.test.ts` — 2/3, 1 skip (0 skip with a live PostgreSQL)
* `lib/arena/src/lib/waveyard/separation/claim.test.ts` — 6/7, 1 skip

## 5. Live PostgreSQL experiment (what one service unlocks)

* `lib/arena/src/lib/emailInbox.test.ts`: 4/7 (0 skip) → **7/7** (0 skip)
* `lib/arena/src/lib/mediaArchive/mediaArchive.test.ts`: 0/6 (0 skip) → **6/6** (0 skip)
* `artifacts/api-server/src/imported/archive/routes.test.ts`: 1/6 (0 skip) → **6/6** (0 skip)
* `artifacts/api-server/src/imported/chat/route.test.ts`: 5/6 (0 skip) → **6/6** (0 skip)
* `lib/arena/src/lib/foundry.test.ts`: 4/5 (1 skip) → **5/5** (0 skip)
* `lib/arena/src/lib/mindApps.test.ts`: 3/5 (2 skip) → **5/5** (0 skip)
* `lib/arena/src/lib/modelHub/registry.test.ts`: 0/1 (1 skip) → **1/1** (0 skip)
* `lib/arena/src/lib/wave3.test.ts`: 7/9 (2 skip) → **9/9** (0 skip)
* `lib/arena/src/lib/wave3b.test.ts`: 2/3 (1 skip) → **3/3** (0 skip)
* `desktop/database.test.mjs`: 4/5 (0 skip) → **5/5** (0 skip)
* `desktop/server-contract.test.mjs`: 0/1 (0 skip) → **0/1** (0 skip) — still fails: needs artifacts/api-server/dist/index.mjs (packaging test; Windows job builds first)
* `lib/arena/src/lib/spaces/arcade-development.test.ts`: 2/3 (0 skip) → **3/3** (0 skip)

Net: 6 files turn green, 24 more tests pass, 7 skips disappear.

## 6. Chosen next improvement (one credit, measurable)

**A Linux sweep job for the uncovered `node:test` files.** Scope rule:
every test file under `lib/`, `artifacts/` and `scripts/`, minus the 3 files
`waveyard-worker-local-db.yml` already runs, minus an explicit, reasoned
exclusion list (§4 classes browser, network, built-artifacts, stale-test,
vite-only, browser-globals, stale-expectation, fixture-vs-esm). `desktop/`
stays owned by `windows-package.yml` and `linux-arcade-admission.yml`.

Measured today: in scope 255 files; **235 pass** (1854 tests,
1838 passing, 16 skipped, 520 s summed per-file wall time measured 2-wide on 2 vCPU) and 20 would be
excluded with the reasons above. Design to reuse: the DB job's per-file
loop, evidence artifact, skip warnings and failure annotations; the package-cwd
rule from §1; PATH with the runner's PostgreSQL binaries (claim.test.ts and
library/service.test.ts start their own cluster), ffmpeg and python3 already on
the image; `DATABASE_URL` unit convention. Success metric: 235 files / 1838
tests green on `ubuntu-22.04`, zero unexplained skips.

Not chosen, with numbers: adding a live PostgreSQL service unlocks 24 tests
(§5) and can be a follow-up inside the same job; Playwright browsers unlock
21 tests across 5 files but need the heavier browser-timing setup; the 4
cwd-sensitive tests, the stale `broker` expectation and the two dead-path tests
are small code fixes that belong in their own focused change.

## Appendix — per-file results (provisioned Linux, package cwd)

| file | result | tests | markers | covered by |
|---|---|---|---|---|
| `lib/arena/src/lib/waveyard/library/service.test.ts` | pass (4 skip) | 53/57 | pg_server ffmpeg win32_only | — |
| `artifacts/api-server/src/imported/arcade/game-catalog.test.ts` | pass | 4/4 | - | — |
| `artifacts/api-server/src/imported/arcade/mod-repository.test.ts` | pass | 1/1 | - | — |
| `artifacts/api-server/src/imported/arcade/postgres-fixture.test.ts` | pass | 1/1 | pg_server ffmpeg | — |
| `artifacts/api-server/src/imported/arcade/repository-assessment.test.ts` | pass | 8/8 | - | — |
| `artifacts/api-server/src/imported/arcade/repository-provider.test.ts` | pass | 5/5 | - | — |
| `artifacts/api-server/src/imported/arcade/repository-source.test.ts` | pass | 8/8 | - | — |
| `artifacts/api-server/src/imported/arcade/route.test.ts` | pass (3 skip) | 0/3 | pg_server ffmpeg | — |
| `artifacts/api-server/src/imported/arcade/runtime-verification.test.ts` | FAIL | 3/20 | - | — |
| `artifacts/api-server/src/imported/arcade/source-rule-validation.test.ts` | FAIL | 0/2 | - | — |
| `artifacts/api-server/src/imported/arcade/source/route.test.ts` | pass (1 skip) | 0/1 | pg_server ffmpeg | — |
| `artifacts/api-server/src/imported/archive/routes.test.ts` | FAIL | 1/6 | - | — |
| `artifacts/api-server/src/imported/chat/route.test.ts` | FAIL | 5/6 | - | — |
| `artifacts/api-server/src/imported/internal/chat/route.test.ts` | pass | 7/7 | - | — |
| `artifacts/api-server/src/imported/library/audio-capture/recoveries/preview-route.test.ts` | pass | 1/1 | - | — |
| `artifacts/api-server/src/imported/library/tracks/route.test.ts` | pass | 1/1 | pg_server win32_only | — |
| `artifacts/api-server/src/imported/toolbox/routes.test.ts` | pass | 9/9 | ffmpeg | — |
| `artifacts/api-server/src/imported/turboagent/health/route.test.ts` | pass | 3/3 | - | — |
| `artifacts/api-server/src/imported/waveyard/projects/[id]/mashup/route.test.ts` | pass | 0/0 | pg_server win32_only | — |
| `artifacts/api-server/src/lib/blind-battle.test.ts` | pass | 3/3 | - | — |
| `artifacts/api-server/src/lib/spaces-browser.real.test.ts` | FAIL | 0/1 | browser | — |
| `artifacts/api-server/src/lib/waveyard-startup-recovery.test.ts` | pass | 8/8 | - | — |
| `artifacts/api-server/src/lib/waveyard/audio-capture-manager.test.ts` | pass | 10/10 | - | — |
| `artifacts/api-server/src/lib/waveyard/audio-capture-throughput.test.ts` | pass | 1/1 | - | — |
| `artifacts/api-server/src/lib/waveyard/local-sync.test.ts` | FAIL | 1/3 | - | — |
| `artifacts/arenaforge/src/components/waveyard/library/audio-capture-options.test.ts` | pass | 6/6 | - | windows-recovered-stack |
| `artifacts/arenaforge/src/components/waveyard/library/local-session-crypto.test.ts` | pass | 3/3 | - | — |
| `artifacts/arenaforge/src/lib/arcadeGameControls.test.ts` | pass | 3/3 | - | — |
| `artifacts/arenaforge/src/lib/arcadeGameProgressBackup.test.ts` | pass | 10/10 | - | — |
| `artifacts/arenaforge/src/lib/arcadeManifest.test.ts` | FAIL | 5/6 | - | — |
| `artifacts/arenaforge/src/lib/arcadeNativeManifest.test.ts` | pass | 1/1 | - | — |
| `artifacts/arenaforge/src/lib/chip8ProgressBackup.test.ts` | pass | 6/6 | - | — |
| `artifacts/arenaforge/src/lib/chip8Runtime.test.ts` | pass | 12/12 | - | — |
| `artifacts/arenaforge/src/lib/developmentBuild.test.ts` | pass | 1/1 | - | — |
| `artifacts/arenaforge/src/lib/developmentPackage.test.ts` | pass | 1/1 | - | — |
| `artifacts/arenaforge/src/lib/importedGameRevision.test.ts` | pass | 10/10 | - | — |
| `artifacts/arenaforge/src/lib/importedGameSourceBackup.test.ts` | pass | 6/6 | - | — |
| `artifacts/arenaforge/src/lib/importedGameSourceComparison.test.ts` | pass | 9/9 | - | — |
| `artifacts/arenaforge/src/lib/importedGameStorage.test.ts` | pass | 4/4 | - | — |
| `artifacts/arenaforge/src/lib/importedRepositoryAttribution.test.ts` | pass | 4/4 | - | — |
| `artifacts/arenaforge/src/lib/offlineGameNavigation.test.ts` | pass | 3/3 | - | — |
| `artifacts/arenaforge/src/lib/offlineGameStyles.test.ts` | pass | 1/1 | - | — |
| `desktop/arcade-bepinex-distribution.test.mjs` | pass (2 skip) | 1/3 | win32_only | windows-package |
| `desktop/arcade-bepinex-profiles.test.mjs` | pass (2 skip) | 0/2 | - | windows-package |
| `desktop/arcade-bepinex-runtime.test.mjs` | pass (3 skip) | 3/6 | - | windows-package |
| `desktop/arcade-bepinex.test.mjs` | pass | 8/8 | - | windows-package |
| `desktop/arcade-classic.test.mjs` | pass | 3/3 | - | windows-package |
| `desktop/arcade-compatibility.test.mjs` | pass | 7/7 | - | windows-package, linux-arcade-admission |
| `desktop/arcade-control.test.mjs` | pass | 5/5 | - | windows-package |
| `desktop/arcade-linux-cleanup.test.mjs` | pass | 4/4 | - | windows-package, linux-arcade-admission |
| `desktop/arcade-linux-gate.test.mjs` | pass | 1/1 | - | windows-package, linux-arcade-admission |
| `desktop/arcade-packages.test.mjs` | pass | 6/6 | - | windows-package |
| `desktop/arcade-workshop.test.ts` | pass | 1/1 | - | — |
| `desktop/arena-backup.test.mjs` | pass | 13/13 | - | windows-package |
| `desktop/atomic-file.test.mjs` | pass | 4/4 | win32_only | windows-package |
| `desktop/build-output-cleanup.test.mjs` | pass | 3/3 | browser ffmpeg | windows-package |
| `desktop/build-space-preflight.test.mjs` | pass | 33/33 | browser | windows-package |
| `desktop/capture-tone-measurement.test.mjs` | pass | 2/2 | - | windows-package |
| `desktop/data-paths.test.mjs` | pass | 1/1 | - | windows-package |
| `desktop/database.test.mjs` | FAIL | 4/5 | pg_server | windows-package |
| `desktop/ffmpeg-bundle.test.mjs` | pass | 4/4 | ffmpeg | windows-package |
| `desktop/fs-cleanup.test.mjs` | pass | 5/5 | - | windows-package |
| `desktop/native-runtime-packaging.test.mjs` | pass | 2/2 | onnx_ort | windows-package |
| `desktop/process-tree.test.mjs` | pass | 4/4 | - | windows-package |
| `desktop/repository-builds.test.mjs` | pass | 7/7 | win32_only | windows-package |
| `desktop/server-contract.test.mjs` | FAIL | 0/1 | - | windows-package |
| `desktop/shutdown.test.mjs` | pass | 5/5 | - | windows-package |
| `desktop/waveyard-audio.test.mjs` | pass | 3/3 | - | windows-package |
| `desktop/waveyard-progress.test.mjs` | pass | 3/3 | - | windows-package |
| `lib/arena/src/lib/apiErrors.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/archive-assistant/context.test.ts` | pass | 14/14 | - | — |
| `lib/arena/src/lib/archive-assistant/prompt.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/archive-assistant/reasoning-contract.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/archive-reasoning/lattice.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/archive-reasoning/render.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/archive-reasoning/synthesizers.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/archive-reasoning/temporal.test.ts` | pass | 15/15 | - | — |
| `lib/arena/src/lib/arenaRooms.test.ts` | FAIL | 4/5 | - | — |
| `lib/arena/src/lib/authorization.integration.test.ts` | pass | 4/4 | pglite | — |
| `lib/arena/src/lib/capabilities/capabilities.test.ts` | pass | 8/8 | ffmpeg python | — |
| `lib/arena/src/lib/completeCouncilSession.integration.test.ts` | pass | 6/6 | pglite | — |
| `lib/arena/src/lib/connectedBrain.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/councilSynthesis.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/creative/creative.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/creative/research.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/deviceChannel.integration.test.ts` | pass | 5/5 | pglite | — |
| `lib/arena/src/lib/emailInbox.test.ts` | FAIL | 4/7 | - | — |
| `lib/arena/src/lib/executionPolicy.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/executionSession.integration.test.ts` | pass | 8/8 | pglite | — |
| `lib/arena/src/lib/foundry.test.ts` | pass (1 skip) | 4/5 | - | — |
| `lib/arena/src/lib/fs-replace.test.ts` | pass | 4/4 | - | windows-recovered-stack |
| `lib/arena/src/lib/games/forge-ai.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/games/forge.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/games/gameplay-contract.test.ts` | pass | 4/4 | - | windows-recovered-stack |
| `lib/arena/src/lib/games/mod-workshop.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/games/pong.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/games/source-2048.test.ts` | pass | 3/3 | - | windows-recovered-stack |
| `lib/arena/src/lib/games/validator.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/identityConfig.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/identitySurface.test.ts` | FAIL | 0/2 | - | — |
| `lib/arena/src/lib/luma/cameras/__tests__/catalog.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/luma/engine/__tests__/adaptive.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/luma/engine/__tests__/adjustments.test.ts` | pass | 15/15 | - | — |
| `lib/arena/src/lib/luma/engine/__tests__/colorPipeline.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/luma/engine/__tests__/history.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/luma/engine/__tests__/layers.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/luma/presets/__tests__/serialization.test.ts` | pass | 14/14 | - | — |
| `lib/arena/src/lib/luma/state/__tests__/editorStore.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/luma/storage/__tests__/projectRepository.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/markdown.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/mediaArchive/local.test.ts` | FAIL | 0/1 | ffmpeg | — |
| `lib/arena/src/lib/mediaArchive/mediaArchive.test.ts` | FAIL | 0/6 | - | — |
| `lib/arena/src/lib/mediaArchive/providers.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/mindApps.test.ts` | pass (2 skip) | 3/5 | ffmpeg | — |
| `lib/arena/src/lib/modelHub/agentBridge.test.ts` | pass | 4/4 | pglite | — |
| `lib/arena/src/lib/modelHub/aiHub.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/modelHub/registry.test.ts` | pass (1 skip) | 0/1 | - | — |
| `lib/arena/src/lib/modelHub/runtimes.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/personalisation/personalisation-adapter.test.ts` | pass | 13/13 | - | — |
| `lib/arena/src/lib/retryPolicy.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/runtime.test.ts` | pass | 22/22 | - | — |
| `lib/arena/src/lib/security/api-access.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/security/local-request-gate.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/security/outbound-url.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/security/request-limits.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/spaces/arcade-development.test.ts` | FAIL | 2/3 | - | — |
| `lib/arena/src/lib/spaces/browser.test.ts` | pass | 10/10 | browser | — |
| `lib/arena/src/lib/spaces/command-process.test.ts` | pass | 5/5 | - | windows-recovered-stack |
| `lib/arena/src/lib/spaces/external.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/spaces/governance.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/spaces/mission-evidence.test.ts` | pass | 4/4 | - | windows-recovered-stack |
| `lib/arena/src/lib/spaces/mission-fleet.test.ts` | pass | 4/4 | - | windows-recovered-stack |
| `lib/arena/src/lib/spaces/mission-memory.test.ts` | pass | 2/2 | - | windows-recovered-stack |
| `lib/arena/src/lib/spaces/mission-plan.test.ts` | pass | 3/3 | - | windows-recovered-stack |
| `lib/arena/src/lib/spaces/runtime-paths.test.ts` | pass | 2/2 | browser | — |
| `lib/arena/src/lib/spaces/spaces-tools.test.ts` | FAIL | 19/20 | python | — |
| `lib/arena/src/lib/spaces/workspace-isolation.test.ts` | pass | 10/10 | - | — |
| `lib/arena/src/lib/toolEffectService.integration.test.ts` | pass | 2/2 | pglite | — |
| `lib/arena/src/lib/toolRuntime.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/toolbox/toolbox.test.ts` | pass | 13/13 | ffmpeg | — |
| `lib/arena/src/lib/wave3.test.ts` | pass (2 skip) | 7/9 | ffmpeg | — |
| `lib/arena/src/lib/wave3b.test.ts` | pass (1 skip) | 2/3 | - | — |
| `lib/arena/src/lib/waveyard/ai/ai.test.ts` | pass | 10/10 | - | — |
| `lib/arena/src/lib/waveyard/ai/providers.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/waveyard/arrangement-preview-graph.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/arrangement-preview-memory.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/waveyard/arrangement-preview-selection.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/arrangement/composer.test.ts` | pass | 10/10 | - | — |
| `lib/arena/src/lib/waveyard/arrangement/layers-api.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/arrangement/prompt.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/audio-context-resume.test.ts` | pass | 5/5 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/audio-filenames.test.ts` | pass | 2/2 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/automatic-build-finalization.test.ts` | pass | 7/7 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/capture/pcm-signal.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/capture/rf64.test.ts` | pass | 5/5 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/capture/segments.test.ts` | pass | 6/6 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/conversion/engine.test.ts` | pass | 3/3 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/conversion/idempotency.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/design/sounddesign.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/waveyard/drum-analysis.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/separation.test.ts` | pass | 54/54 | pg_server pglite ffmpeg python onnx_ort win32_only | waveyard-worker-local-db |
| `lib/arena/src/lib/waveyard/export-automation.test.ts` | pass | 4/4 | ffmpeg | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/elastic.test.ts` | pass | 13/13 | - | — |
| `lib/arena/src/lib/waveyard/fades.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/waveyard/harmony-analysis.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/library/audio-backup.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/library/audio-restore.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/library/camelot-wheel.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/library/collections.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/waveyard/library/model.test.ts` | pass | 26/26 | - | — |
| `lib/arena/src/lib/waveyard/library/player-logic.test.ts` | pass | 13/13 | - | — |
| `lib/arena/src/lib/waveyard/library/pg-readiness.test.ts` | pass | 6/6 | pg_server | — |
| `lib/arena/src/lib/waveyard/library/session-key-matching.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/library/session-logic-key.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/library/session-logic.test.ts` | pass | 45/45 | - | — |
| `lib/arena/src/lib/waveyard/library/session-save-queue.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/waveyard/live-key-shift.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/live-stem-layers.test.ts` | pass | 122/122 | - | — |
| `lib/arena/src/lib/waveyard/local-context.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/measure/cleanup-workflow.test.ts` | pass | 11/11 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/measure/cleanup.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/waveyard/measure/master.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/measure/strip-silence.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/waveyard/midi-analysis-readiness.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/midi-file.test.ts` | pass | 15/15 | - | — |
| `lib/arena/src/lib/waveyard/live-stem-wsola.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/waveyard/midi-unit.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/mixer/dither.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/waveyard/mixer/dynamics.test.ts` | pass | 9/9 | - | — |
| `lib/arena/src/lib/waveyard/mixer/eq7.test.ts` | pass | 10/10 | - | — |
| `lib/arena/src/lib/waveyard/mixer/lofi.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/waveyard/mixer/inserts.test.ts` | pass | 20/20 | - | — |
| `lib/arena/src/lib/waveyard/mixer/mixer.test.ts` | pass | 23/23 | - | — |
| `lib/arena/src/lib/waveyard/mixer/measure.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/waveyard/mixer/modulation.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/waveyard/mixer/synth.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/waveyard/output-peak-limiter.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/player-state.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/mixer/reverb.test.ts` | pass | 13/13 | - | — |
| `lib/arena/src/lib/waveyard/separation/client.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/separation/deep.test.ts` | pass | 18/18 | python | — |
| `lib/arena/src/lib/waveyard/separation/device-status.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/separation/fft.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/separation/claim.test.ts` | pass (1 skip) | 6/7 | pg_server pglite win32_only | — |
| `lib/arena/src/lib/waveyard/separation/provision-runtime.test.ts` | pass | 23/23 | ffmpeg python | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/provision-store.test.ts` | pass | 11/11 | ffmpeg python | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/provision.test.ts` | pass | 13/13 | ffmpeg python | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/python-guardian.test.ts` | pass | 2/2 | python | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/quality.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/separation/retry.test.ts` | pass | 11/11 | pglite | — |
| `lib/arena/src/lib/waveyard/separation/seed-http.test.ts` | pass | 15/15 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/seed.test.ts` | pass | 9/9 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/selection.test.ts` | pass | 6/6 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/separation/session.test.ts` | pass | 7/7 | onnx_ort | — |
| `lib/arena/src/lib/waveyard/separation/stem-display.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/separation/stft.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/waveyard/session-dj-controls.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/session-output.test.ts` | pass | 1/1 | - | — |
| `lib/arena/src/lib/waveyard/source-acquisition-intake.test.ts` | pass | 4/4 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/source-analysis-retry.test.ts` | pass | 3/3 | pglite | — |
| `lib/arena/src/lib/waveyard/stem2/capability.test.ts` | pass | 17/17 | - | — |
| `lib/arena/src/lib/waveyard/stem2/media-session.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/stem2/routing.test.ts` | pass | 17/17 | - | — |
| `lib/arena/src/lib/waveyard/storage-immutable.test.ts` | pass | 10/10 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/storage.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/streaming/adapters.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/waveyard/streaming/library-sync.test.ts` | pass | 20/20 | - | — |
| `lib/arena/src/lib/waveyard/studio/ab-compare.test.ts` | pass | 11/11 | - | — |
| `lib/arena/src/lib/waveyard/studio/history.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/studio/layer-edit.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/studio/mashup-bed.test.ts` | pass | 9/9 | - | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/studio/mashup-regression.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/studio/mashup.test.ts` | pass | 14/14 | - | — |
| `lib/arena/src/lib/waveyard/studio/palette.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/studio/piano-roll.test.ts` | pass | 14/14 | - | — |
| `lib/arena/src/lib/waveyard/studio/soul-chef.test.ts` | pass | 10/10 | - | — |
| `lib/arena/src/lib/waveyard/studio/visualizer.test.ts` | pass | 31/31 | - | — |
| `lib/arena/src/lib/waveyard/studio/viz-fx.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/studio/viz-settings.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/studio/vocal-chops.test.ts` | pass | 15/15 | - | — |
| `lib/arena/src/lib/waveyard/timing.test.ts` | pass | 32/32 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/arrangement-automation.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/arrangement-extensions.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/automatic-remix.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/clip-editing.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/cross-source-alignment.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/separation/mdx.test.ts` | pass | 12/12 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/multi-source-placement.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/multi-clip-operations.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/musical-meeting-points.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/musical-events.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/visual-state.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/types/__tests__/section-arrangement.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/types/analysis-provenance.test.ts` | pass | 3/3 | - | — |
| `lib/arena/src/lib/waveyard/types/analysis-confidence.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/types/midi.test.ts` | pass | 7/7 | - | — |
| `lib/arena/src/lib/waveyard/useStemTransport.test.ts` | FAIL | 0/1 | - | — |
| `lib/arena/src/lib/waveyard/types/source-sections.test.ts` | pass | 8/8 | - | — |
| `lib/arena/src/lib/waveyard/vocal-analysis.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/waveyard/version-roundtrip.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/voicestudio/voicestudio.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/waveform-remix.test.ts` | pass | 26/26 | ffmpeg | windows-recovered-stack |
| `lib/arena/src/lib/waveyard/worker-local/analysis-engine.test.ts` | pass | 16/16 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/worker-local/broker.test.ts` | FAIL | 7/8 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/render-helpers.test.ts` | pass | 10/10 | ffmpeg | — |
| `lib/arena/src/lib/waveyard/worker-local/restore-upload-cleanup.test.ts` | pass | 2/2 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/runtime-policy.test.ts` | pass | 6/6 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/section-rhythm.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/analysis-recovery.test.ts` | pass | 2/2 | pglite | waveyard-worker-local-db |
| `lib/arena/src/lib/waveyard/worker-local/startup-cleanup.test.ts` | pass | 5/5 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/stem-analysis.test.ts` | pass | 1/1 | pglite | waveyard-worker-local-db |
| `lib/arena/src/lib/workerExecutor.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/workerSuitability.test.ts` | pass | 4/4 | - | — |
| `lib/arena/src/lib/workforceResolver.test.ts` | pass | 5/5 | - | — |
| `scripts/waveyard-audio-restore.integration.test.ts` | FAIL | 0/1 | pg_server browser ffmpeg win32_only | — |
| `scripts/waveyard-automation-persistence.test.ts` | FAIL | 0/1 | pg_server browser win32_only | — |
| `scripts/waveyard-benchmark-summary.test.mjs` | pass | 9/9 | - | — |
| `scripts/waveyard-blind-listening.test.mjs` | pass | 1/1 | - | — |
| `scripts/waveyard-clip-donor-preview.test.ts` | FAIL | 0/1 | browser | — |
| `scripts/waveyard-device-benchmark-comparison.test.ts` | pass | 2/2 | - | — |
| `scripts/waveyard-mashup-listening.test.mjs` | pass | 3/3 | - | — |
| `scripts/waveyard-quality-comparison.test.mjs` | pass | 5/5 | - | — |
| `scripts/waveyard-remix-response.test.ts` | pass | 2/2 | - | — |
| `scripts/waveyard-studio-recovery-accessibility.test.ts` | pass | 1/1 | - | — |
| `lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts` | TIMEOUT | -/- | pglite ffmpeg onnx_ort | — |
