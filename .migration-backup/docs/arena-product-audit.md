# Arena Product — Complete Audit: Expectation Holes, Incomplete & Inaccessible Content

**Scope:** the full Arena OS product (every page, every API route, every feature promise),
inspected for: holes between what the product promises and what it delivers, incomplete
implementations, and inaccessible/unreachable content. Method: page↔nav↔route structural
cross-scans (template-literal aware), component/route/Table/env usage analysis, docs-vs-
reality comparison, and live probes against a running server with a fresh database.
Battery after the one fix this turn produced: **1125/1125**; desktop-mode build clean.

---

## 0. Fixed during this audit (P0 — core loop break)

**Server-side ffmpeg/ffprobe discovery was dead inside the bundled Next server.**
Evidence chain (live):
- Diagnostics reported `ffmpeg/ffprobe: UNAVAILABLE — no installer package` in the dev
  server while the same packages resolved fine from plain node.
- Instrumented resolution exposed the root cause: Turbopack rewrites `createRequire` and
  rejects dynamic module names — *"Cannot find module as expression is too dynamic"* —
  killing the documented tier-2 (installer package) discovery in dev **and** standalone.
- Consequence on any machine without system ffmpeg (desktop unaffected — it passes env
  paths): `POST /api/library/tracks` (the MusicHome **“+ ADD MUSIC”** button) failed with
  a hard `FfmpegMissingError` — **the core “drop → process → play” promise broke in
  dev/web deployments**.
- A second, compounding bug: the uploads route’s honest browser-probe fallback matched
  the error with `/ENOENT|not found|spawn/i` — which **never matches** the actual
  `FfmpegMissingError` message ("ffprobe is not available to Arena…"), so the fallback
  was dead code even when the browser had decoded the file.

**Fixes (all verified live):** a bundler-proof filesystem discovery tier in
`src/lib/waveyard/ffmpeg.ts` (correct npm layout `node_modules/@ffprobe-installer/
<platform>/<binary>` — the platform package is a *sibling* of the wrapper, first attempt
had this wrong and was caught by re-probing), the fallback regex now matches the named
error, the installer packages are traced into the standalone build, and
`serverExternalPackages` covers them. Post-fix: diagnostics **READY**, library add
creates a real track (`duration: 1s` from real ffprobe, separation queued), uploads
probe server-side again. Desktop build compiles with the installer trees traced.

---

## 1. Inaccessible content (exists, but no door)

> **CORRECTION (post-fix verification):** the original scan missed `src/lib/arenaRooms.ts`
> (a `.ts` file, outside the `.tsx` corpus). The `/rooms` directory did already link
> `/studio` and `/device-security`. Truly orphaned were **`/archive`** (the rooms entry
> links the bridge detail page, not the live assistant surface) and **`/market`** (in
> nothing at all). All four are now in the Cmd/Ctrl+K launcher — the primary discovery
> surface the home page promotes — plus Market added to the rooms list and `/archive`
> added as the archive room's secondary door.

Four full pages lacked a door in the primary navigation (all return 200 when visited
directly):

| Page | What it is | Hole |
|---|---|---|
| `/studio` | The visual AI studio (StudioLab — backends, jobs, gallery, ~1,000 lines) | The nav advertises `/image` ("Generate images") and `/luma`, but the full studio with job history and backend switching is invisible. |
| `/market` | Model marketplace/comparison (181 lines) | No entry point anywhere. |
| `/archive` | Archive Assistant surface | No entry point (and its API family is half-dormant, see §2). |
| `/device-security` | "What Arena can honestly observe about this environment" (303 lines) | A trust-building page nobody can find. |

(For contrast: Waveyard moderation had the same problem and was fixed last turn; the
college sub-pages are all linked from their hub; `/waveyard/create`, `/waveyard/sessions`
are linked in-product.)

**Recommended:** add these four to the nav launcher groups (Create / System) or to the
`/rooms` directory — the launcher already exists, these are one-line additions.

## 2. Dormant capabilities (built, never driven by the UI)

Corrected orphan-route scan over the Arena side (congress advance is in fact used —
scanner false-negative from a `!` assertion in the template). Remaining **11 dormant
route families**:

- **`/api/exports/*`** (list/detail/media/retry) — a *parallel* export API. The visual
  studio UI drives `/api/studio/jobs/*` instead. Two export systems, one used: pick one.
- **`/api/studio/models/{type}`** — single-model detail; only the list endpoint is used.
- **`/api/identity/authentication/options` + `/verify`** — the full WebAuthn ceremony
  (challenge, session cookie, rate limits). **There is no login UI anywhere** — hosted
  multi-user mode is unreachable; the local-first build never triggers it. Either build
  the login surface or mark the family explicitly dormant in docs.
- **`/api/internal/chat` + `/api/turboagent/health`** — ops/CI endpoints.
- **`/api/archive/findings/{id}/lineage`** — on-demand lineage lookup; findings surface
  exists but the lineage view was never wired.
- **`/api/device-artifacts/{id}`** — detail route (list is used from device-security
  flows); no drill-down in the UI.
- **`/api/execution-sessions/{id}`** — execution detail; orchestrator UI never links to one.

## 3. First-run emptiness (fresh database, live-verified)

- `/api/battles` → 0; the home feed relies on `ensureSeeded()` which only seeds the
  **models table** — no starter battles. A brand-new user sees an empty arena history
  (the UI does render "No battles match"). First-session value depends entirely on the
  user initiating a battle.
- `/api/public/projects` → 0 — Discover correctly says "No public projects match this
  catalogue search", but never explains **how** a project becomes public (publish flow
  lives two surfaces away in the studio's PublicationPanel).
- Diagnostics: `ai: DEGRADED — No AI provider has credentials` (honest, with per-
  provider reasons surfaced in the AI studio — good).

## 4. Expectation gaps (promise vs delivery)

1. **“Generate images” without keys → the Demo backend** — silently the default
   (`backend` state starts `"demo"`). It *is* labeled (backend selector, fallback
   notices), but the nav promise ("Generate pictures") doesn't say the out-of-box
   result is procedural SVG previews, not real image models. A first-run honesty banner
   (like Waveyard's processor notice) would close the gap.
2. **Chat/LLM features without keys** → Local Engine fallback, clearly badged in-output
   ("⚠️ Fallback: Local Engine — deterministic offline output, not model output"). Good
   honesty; the gap is discoverability — KeysBar exists on chat/benchmark/collab/council/
   image but there is no single "set up providers" onboarding step.
3. **“Paste authorized source links”** (BuildProject options) — every link fails unless
   `AUTHORIZED_SOURCE_RESOLVER_URL` is configured (unset in every default deployment).
   The UI copy does disclose this; the expectation hole is that the option reads as a
   feature when it is an integration point.
4. **Streaming libraries** — Spotify live sync requires the user to create a developer
   app and paste a client ID (explained in-UI, 5-minute setup); Apple/YouTube are
   import-only pending credentials; full-track streaming into the separator is
   industry-impossible (Spotify previews deprecated; ToS bans). Library metadata is the
   real surface — delivered.
5. **Windows desktop** — build/packaging verified here; the acceptance protocol remains
   owner-side (never claimed). Real Kim_Vocal_2.onnx weights remain owner-side
   (huggingface.co is connection-blocked from this sandbox in every form).

## 5. Documentation & configuration gaps

- **`.env.example` documents ~10 vars; the code reads ~35.** Undocumented (functionally
  invisible configuration): `AUTHORIZED_SOURCE_RESOLVER_URL`, `WANGP_BRIDGE_URL`,
  `COMFYUI_URL`, `TURBOAGENT_URL`, `ARCHIVE_ASSISTANT_*` (4), `COLLEGE_AUTH_MODE`,
  `COLLEGE_MODEL_ID`, `MAX_UPLOAD_BYTES`, `MAX_WAVEFORM_PCM_BYTES`, `WAVEYARD_STORAGE_DIR`,
  `WAVEYARD_MODELS_DIR`, `SEPARATION_MODEL`, `STEM_DEVICE`, `SEAL_SECRET`,
  `ARENA_INTERNAL_API_KEY`, `ARENA_APP_URL`, `OPENAI/ANTHROPIC_BASE_URL/MODEL`, …
- **The Guide page (212 lines) never mentions Waveyard** — the flagship product is
  absent from the product’s own guide.
- **The Command hub** links only 5 destinations (home/artifacts/collab/council/projects)
  — it bills itself as “Not sure where to start?” but ignores music, images, arcade.
- **PWA manifest** brands the app "ArenaForge Personal" while the product is "Arena OS"
  (and Waveyard is unmentioned in the description).
- No `sitemap.ts`/`robots.txt` (fine for local-first; worth deciding deliberately for
  hosted mode).

## 6. Test-coverage holes

- **E2E: exactly one spec** (`real-separation.spec.ts`) — and on inspection it is
  **legacy**: it registers accounts and logs in via `/api/auth/login|register` and
  exercises multi-user isolation (intruder/viewer/reporter/moderator), all of which the
  local-first port removed. It cannot run against a plain dev server; it is retained
  (now with an explicit header) as the compose-profile acceptance for when that
  multi-user-capable profile is rebuilt.
- **NEW: `tests/e2e/arena-smoke.spec.ts`** — the current-UI smoke (6 tests: home
  promise, launcher reaches every audited page, Demo-backend honesty banner, orphan
  pages render, Waveyard promise copy, core APIs + diagnostics floor). Verified to load
  and compile (`playwright test --list`); its first full run requires a machine with
  Playwright browsers — this sandbox's network blocks cdn.playwright.dev, so the run is
  honestly marked CI/owner-side, not claimed.
- The Arena side still has no deep browser e2e (battles/collab/council flows) — the
  smoke covers navigation and honesty surfaces only.
- The desktop acceptance harness exists and is unit-tested, but the protocol itself has
  never been run on real Windows (owner-side, honestly documented).

## 7. Minor / polish

- Discover’s empty state could teach the publish path (“Publish from a project’s
  Publication panel to list it here”).
- `/rooms` (directory) vs `/spaces` (workbench) naming overlap can confuse.
- Two nav systems already park content gracefully (Waveyard parked row, Arena rooms
  launcher) — the four orphan pages in §1 just need a door.
- BattleArena history empty-state says "No battles match" even when the cause is "you
  haven't created any" (filter-vs-empty conflation).

## 8. Prioritized backlog

| P | Item | Status |
|---|---|---|
| **P0** | Bundled-server ffmpeg/ffprobe discovery + probe-fallback regex — core loop in dev/web | ✅ done (live-proven) |
| P1 | Link the four orphan pages into the launcher/rooms | ✅ done (launcher ×4 + rooms list Market + archive secondary door) |
| P1 | First-run honesty banner for the visual studio's Demo default | ✅ done (SSR-verified banner when Demo is the active backend) |
| P1 | Document all env vars in `.env.example` (grouped) | ✅ done (~30 vars, grouped: providers, studio backends, bridges, ops, audio tuning) |
| P2 | Decide the export-API duplication (`/api/exports/*` vs `/api/studio/jobs/*`) | ✅ documented dormant in DEPLOYMENT.md (retained for compatibility) |
| P2 | WebAuthn login surface for hosted mode, or mark dormant | ✅ documented dormant in DEPLOYMENT.md |
| P2 | Refresh the Guide + Command hub to include Waveyard and the studio surfaces | ✅ done (TL;DR card + CTA links; MAKE MUSIC / GENERATE intents) |
| P2 | Arena-side e2e smoke | ✅ spec written + compile-verified; full run needs browsers (CI/owner-side) |
| P3 | Discover empty-state publish teaching; battle empty-vs-filtered; PWA branding | ✅ done (all three) |
| P3 | Archive lineage view | ✅ done — on-demand lookup card on the connected bridge page (read-only, explicit, matches the route's never-eager design) |
| P3 | Device-artifact drill-down + execution-session links | ✅ resolved by verification: both are hosted-mode-only surfaces (session-cookie gated / no local creator) — documented dormant in DEPLOYMENT.md |
| P3 | WanGP model-detail route (`/api/studio/models/{type}`) | ✅ done — "Model details" expander in the visual studio, honestly labeled live-bridge vs offline defaults |
| P3 | Rooms/spaces naming overlap | ✅ clarified on the rooms directory (Spaces = one room, the agent workbench) |

## 9. Final state

- Battery **1125/1125** (≈581 s), tsc clean, eslint clean, `ARENA_DESKTOP_BUILD=1`
  build clean with installer binaries traced into the standalone tree.
- Live evidence captured for every claim above (fresh-DB probes, diagnostics before/
  after, failed-then-passing intake calls, page status codes).
- Committed locally on `arena/01a10c30-arena-os-canonical` (not pushed, per the
  standing rule). 15th platform re-clone repaired in place at audit start (soft-reset
  restore onto pushed `968e286`, tree verified identical).
