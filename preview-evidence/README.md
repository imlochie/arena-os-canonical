# Arena OS — Integrated Product Preview Receipt

**Date:** 2026-10-21
**Verdict:** **PASS WITH LIMITATIONS** (limitations enumerated in §7)
**Scope:** Arcade + Spaces + Waveyard operating together in one running application. No feature development was performed and no source file was modified.

---

## 1. Exact identity under test

| Item | Value |
| --- | --- |
| Branch inspected | `arena/integration-candidate-2026-10-21` @ `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` |
| HEAD at test time | `13638fe8a5c280e6b47ecf97fb6e6cf414163a12` |
| Tree | `5eddbf4117d0ea2192c568a19744ad9a147e767c` |
| Parent | `28b90cd` (descendant of integration base `04705ab` / PR #15) |
| Source digest (`sha256(git archive HEAD)`) | `5b9bd01ef92c3d25489823b090aca00f8396b2ba430fe9b682de1ec0dd4e9ad4` |
| Working tree during all runs | **clean** (`git status --porcelain` empty) |
| Checkout | detached worktree `/home/user/preview-13638fe` (existing checkout at `f0e4180` untouched) |
| Production build | Next.js 16.3.8, `npm run build` exit 0, `BUILD_ID=KSA2fPGUFZYkI3-uJ735x` |

PR #15, #22, #23, #24 and #25 were not modified, retargeted, merged or closed. The six hosted workflows that passed on `13638fe` are **inherited evidence only** and are not used as proof here; every result below was produced locally against the exact commit above.

### Live preview of this session

The runtime is up on `127.0.0.1:3000`. Arena's desktop guard answers **403** to any non-loopback Host ("Arena desktop only serves loopback hosts"), so the sandbox preview URL cannot hit it directly. `tools/preview-proxy.mjs` (a shim, **not** part of the app) forwards a public port to the loopback runtime and rewrites only the `Host` header, which makes the running build browsable at the sandbox preview URL. Trade-off, stated plainly: that URL then inherits the owner's local-trust view of this sandbox (acceptance data only, no credentials) and bypasses the LAN/DNS-rebinding protection the app implements on purpose. It is a demo convenience, not a deployment pattern, and **no acceptance evidence was collected through it** — every result below came from direct loopback requests.

## 2. Environment and startup

Node 22.22.3 / npm 10.9.8, PostgreSQL 16 (npm-hosted `@embedded-postgres/linux-x64`) on `127.0.0.1:5432`, Chromium **153.0.8010.0** (npm-hosted `@sparticuz/chromium`) driven by `playwright-core`. Sandbox has no Docker, no audio device, no apt/Playwright CDN access.

```bash
git worktree add --detach /home/user/preview-13638fe 13638fe8a5c280e6b47ecf97fb6e6cf414163a12
cd /home/user/preview-13638fe
node scripts/environment-restore.mjs        # npm ci (745 pkgs) + PG16 init + .env + drizzle push
npm run db:setup                            # creates app_db + schema
ARENA_ARCADE_CHROMIUM_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib \
CI=true ARENA_ARCADE_CI_NO_SANDBOX=1 npm test   # 1642/1642 pass
rm -rf .next && npm run build               # BUILD_ID KSA2fPGUFZYkI3-uJ735x
ARENA_DESKTOP_MODE=1 CI=true ARENA_ARCADE_CI_NO_SANDBOX=1 \
ARENA_ARCADE_CHROMIUM_PATH=/tmp/chromium LD_LIBRARY_PATH=/tmp/al2023/lib \
TURBOAGENT_URL=http://127.0.0.1:4317 NODE_EXTRA_CA_CERTS=…/tls/ca.pem \
npm start -- -H 0.0.0.0 -p 3000
```

Browser: real headless Chromium, `--no-sandbox --disable-dev-shm-usage` (sandbox relaxation is environmental, not an app change). Two environmental substitutions, both disclosed:

* `raw.githubusercontent.com` is unreachable from this sandbox, so acquisition served the **exact pinned upstream 2048 sources** (`478b6ec…`, all four SHA-256 pins matched) from a local TLS mirror (`tools/raw-mirror/`, `tools/raw-mirror/pins.txt`).
* `ARENA_DESKTOP_MODE=1` + loopback origin is the app's own documented local-trust path (`src/lib/security/api-access.ts`); no `ARENA_INTERNAL_API_KEY` was placed in a browser.

## 3. Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | **exit 0** | `logs/gates-before-chromium.log` |
| `npm test` (with Chromium) | **1642 / 1642 pass, 0 fail**, exit 0, 920 s | `logs/tests-1642-pass.log` |
| `npm run build` | **exit 0**, BUILD_ID `KSA2fPGUFZYkI3-uJ735x` | `logs/build.log` |
| App suite `tests/acceptance/arcade-rule-reopen.test.mjs` | **pass** (10.3 s), real UI save + immutable reopen | `runs/arcade/candidate-suite-receipt.json` |

Without a browser the first suite run had `not ok 113` and `not ok 801`; with Chromium present both pass. The earlier failures are therefore recorded as **environmental**, not app defects, and the full suite is green at this head.

## 4. Workflows exercised (real UI, real runtime)

### 4.1 Waveyard — `runs/waveyard/waveyard-live-results.json`
Session `00f5616f-1aed-4c73-ae8f-4d442840aa11`, 30/30 steps, `failure: null`, 0 page errors, 2 console entries (the two intentionally injected HTTP failures).

* Canonical 4-lane mix loads and is audible; 8 forward/reverse source switches across **both** songs in all four stem categories, each confirmed by FFT energy at analyser taps, not by UI labels (typical 107–324 ms; first switch 13.7 s includes preparation).
* Rapid repeated switching settles on the last selected source.
* Hold-to-isolate: vocals 0.127 while drums/bass/instruments read **0.000**; release restores the canonical mix.
* Save → `· stem selections saved`; reload re-opens the saved selection and plays it (14.1 s, includes audio re-acquire). 6 swaps persisted with timestamps (17.16–18.73 s, plus a post-reload switch).
* **Failed save** (injected `503` at the save boundary): status `· stem selections saved` → `· stem selections error` one second later, alert names the HTTP status and states audio remains selected in-page; DB unchanged; retry recovers with audible layout unchanged (`runs/waveyard/06-save-failure.png`).
* **Failed preparation** (donor asset `404`): "Donor audio could not be prepared (HTTP 404). The working mix was retained." — audible instruments 0 new, DB unchanged (`runs/waveyard/07-failed-preparation.png`).
* Earlier failing run preserved unaltered at `runs/waveyard-failed-run/` (`baseline audio did not reach expected lanes`) — a stale-fixture condition, fixed by re-seeding; it is not deleted or relabelled.

### 4.2 Arcade — `runs/arcade/arcade-results.json`
8/8 steps, `failure: null`, 0 page errors, 0 HTTP errors. 3 console entries are the duplicated-CSP warning analysed in §6.

* Acquisition from pinned sources → `guaranteed-four`, 4 initial tiles.
* **Observable gameplay difference** measured independently in the iframe: modified board starts `[4,4,4,4]` and draw 0.01 spawns **4**; upstream control starts `[2,2]` and draw 0.01 spawns **2**.
* Verify-and-save: server-side Chromium run `passed`; artifact `6959caa5-bdbe-4d1f-b273-64d1007ef37f`, revision `c202ea54-e59b-4e66-b0cd-2a6d758382ac`.
* Download 26 231 B, SHA-256 matches the stored object and the recomputed package; runtime observations bound to the saved source+patch.
* Reopened immutable revision reproduces the same spawn behaviour; derived from the saved revision only.
* Fail-closed API: tampered package → `422`, foreign revision → `404`, neither mutating saved revisions.

### 4.3 Spaces — scripted routing (explicitly labelled) — `runs/spaces-mission.json`
Fleet: Planner `turboagent-32b` (`Qwen/Qwen2.5-32B-Instruct`), Builder/Reviewer `turboagent-7b` (`Qwen/Qwen2.5-7B-Instruct`). Mission `9333615d…`: **done in 151 ms**, 3 steps / 3 agents / 3 artifacts, per-agent model IDs routed correctly, `persistence: postgres`.

* **The model endpoint was a scripted OpenAI-compatible server (`tools/scripted-model-server.mjs`), not a language model.** Its replies state that in the written artifact. This is evidence of *routing, execution, storage and provenance*, **not** of live-model intelligence or autonomy.
* Artifacts downloaded (180/179/180 B), SHA-256 matched, and survived a full server restart; mission history and status survived as well.
* Recovery: renaming `space_agents` to simulate a fleet-lookup outage → mission POST **500, fail-closed** (0 missions, 0 model calls); after restoring the table a new mission `d4a219a6…` completed. **The 500 body leaks the raw SQL statement** — see §6.
* Status detail honestly reports HOST-jail execution with no container runtime.
* **UI-driven mission** (not just API): goal typed into the workbench, `🚀 Run mission` clicked, mission `a3193ea8-40dc-417b-9ba0-8edb74a3ea1c` reached `done` with 3 download links, 3 new scripted model calls, 0 console/HTTP errors, provenance and the scripted-response label both visible (`runs/spaces-ui-mission/`).

### 4.4 Cross-application — `runs/cross-app/cross-app-results.json`
6 routes (`/`, `/rooms`, `/arcade`, `/spaces`, `/waveyard`, `/waveyard/session/<id>`) all **200** in 388–574 ms, **0 console errors, 0 page errors, 0 bad responses**. Shared artifact store: **14** entries at cross-app time (5 `arcade-source`, 9 `mission-output`), 17 after the extra UI-driven mission; all reachable from the library API.

* Arcade panel: saved-games list, **5 Reopen buttons**, truth labels ("Human review pending", "Board progress is not persisted", revision hashes).
* Spaces card: fleet models rendered, mission-history select with 3 labelled missions, 3 artifact download links. Workflow continuity verified: artifact saved in Arcade is reopening-visible after navigation; Waveyard session saved earlier loads with 4 lanes and its persisted 6-swap history.
* Navigation is client-side and preserves state; no stale-UI, missing-content, broken-media or silent-fallback regression was observed on these paths.

## 5. Persistence and recovery evidence

| What | Evidence |
| --- | --- |
| Waveyard selections | 6 swaps persisted (`currentSessionTrackId` unchanged), survive page reload **and a full server stop/start** (re-read from the API after restart) |
| Waveyard save failure | in-page error, DB untouched, retry succeeds (`dbUnchangedByFailedSave: true`) |
| Arcade revision | immutable object + revision IDs, byte/hash verified after download and after reopen |
| Spaces mission outputs | 3 artifacts hash-matched before and after server restart |
| DB outage | mission dispatch fails closed (0 missions, 0 model calls), then recovers after restore |

## 6. Findings, highest priority first

1. **Raw SQL leaked in a client-facing 500** — `POST /api/spaces/<id>/mission` returns `{"error":"Failed query: select … from \"space_agents\" …"}` when the fleet lookup fails. Fail-closed behaviour is correct; the disclosure is not. Fix: map persistence errors to a generic message and log the detail server-side.
2. **Duplicate CSP meta in the Arcade source preview** — `POST /api/arcade/source` already returns `sandboxGameDocument(preview2048Mod(bundle))`; `ArcadeSourceWorkshop.tsx` wraps it again (`srcDoc={sandboxGameDocument(result.preview)}`). The inner `<head>` lands inside `<body>`, so Chromium ignores that meta and logs "delivered via a `<meta>` element outside the document's `<head>`". **Root-caused and reproduced in isolation**: enforcement is *not* lost, because the outer meta is in `<head>` and blocks `connect-src 'none'`; the warning is a redundant-policy artifact. One-line fix: pass `result.preview` unwrapped (or stop wrapping in the route) so both callers agree. Evidence: `runs/arcade/arcade-results.json` (`consoleErrors`), §4.2.
3. **Spaces output panel renders raw JSON** — scripted `{thought, actions, handoff, done}` is shown as text rather than formatted steps (cosmetic, affects readability of mission output).
4. **No container isolation for mission commands** — app states HOST-jail execution explicitly; acceptable for preview, must be closed before any multi-tenant use.
5. **Waveyard has no beat/downbeat data in this fixture**, so bar snapping is correctly reported unavailable; it is untested, not broken.

## 7. Limitations (why this is not a clean PASS)

1. **Waveyard audio is a controlled fixture.** Stems are 90 s synthesised PCM sine tracks written by `tools/seed-waveyard-live.mjs` — this exercises transport, routing, isolation, persistence and failure handling, **not** separation quality, inference, or musical quality. Audibility is graph-level (analyser taps in the page's real `AudioContext`), not a human listening test.
2. **Bar snapping unexercised** — the fixture carries no trustworthy downbeat data, and the UI correspondingly states "bar snapping is unavailable" (captured in `runs/waveyard/waveyard-live-results.json`); it is untested here, not shown to be implemented.
3. **Spaces intelligence is scripted.** The OpenAI-compatible endpoint was a deterministic script; routing/provenance are real, model intelligence is not. Invalid-model abort was not exercised.
4. **Desktop/Electron shell not exercised** — the web runtime was validated in desktop-trust mode; packaging, auto-update and native audio devices were out of scope. The sandbox reports no audio output devices, which the UI states honestly.
5. **Acquisition used a local pinned mirror** because `raw.githubusercontent.com` is unreachable here; hashes matched the app's pins, but the network path itself was substituted.
6. **Chromium ran with `--no-sandbox`** in this container (environmental).
7. **The live preview goes through a Host-rewriting shim** (see §1); the app itself is unchanged, but that browsing path is not evidence and would be unacceptable outside a private sandbox.
8. Not proven: arbitrary prompt-to-game quality, general reverse engineering, a complete mod ecosystem, production readiness.

## 8. Un-run cases

* Waveyard separation/analysis/export workers (no Redis/Demucs in this environment).
* Spaces invalid-model abort, long missions, multi-space concurrency.
* Arcade in-progress board persistence (explicitly unsupported by the app) and Electron packaging.
* Any load/performance testing beyond per-route latency above.

## 9. Evidence index

```
logs/tests-1642-pass.log              full suite, 1642/1642
logs/build.log                        npm run build → KSA2fPGUFZYkI3-uJ735x
logs/gates-before-chromium.log        typecheck + first suite run (browser-less failures)
runs/waveyard/waveyard-live-results.json + 7 screenshots
runs/waveyard-failed-run/             preserved failing run (stale fixture)
runs/arcade/arcade-results.json       + 5 screenshots, saved-artifact.json
runs/arcade/candidate-suite-receipt.json + candidate-suite-reopened.png
runs/cross-app/cross-app-results.json + 8 screenshots
runs/spaces-mission.json              mission record (scripted model)
runs/spaces-ui-mission/               mission dispatched from the workbench UI + screenshot
runs/ui-*.png                         manual probe screenshots (Spaces fleet/history, Arcade, sessions)
tools/                                seeder, four acceptance drivers, scripted model server, pinned mirror, preview shim
```
