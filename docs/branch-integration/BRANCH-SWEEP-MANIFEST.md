# Branch Integration Sweep — Provenance Manifest

**Sweep date:** October 2026
**Target:** `main` (this repository) — branch `arena/01a10c30-arena-os-canonical`
**Mandate:** Safely migrate and integrate ALL untranslated work from the other
branches as canon, additive-only, battery green before every commit. Nothing
strandable left behind; every landed body recorded here; every skip has a
reason. This manifest is the durable ledger — if a question ever arises about
where a piece of this tree came from, the answer is in the table below.

---

## The commit ledger

Six bodies, six commits, in landing order. Every commit was verified with the
full battery + typecheck + build before committing (see per-commit numbers).

| # | Commit | Body | Origin branch | Origin commits |
|---|--------|------|---------------|----------------|
| 1 | `027ffcf` | LUMA device app (Expo) | `arena/01a0bdc9-arena-os-canonical` | 11 commits, Sep 2026 |
| 2 | `ba5c9c5` | lab-004: archive-reasoning epistemics, personalisation, internal chat | `arena/01a0b544-arena-os-canonical` | 52 commits |
| 3 | `2312a9b` | Lochie Life College runtime (layers 5–9) + Campus client | `arena/01a0bb55-arena-os-canonical` | 24 commits |
| 4 | `2116c47` | Security/identity architecture (owner/device identity, WebAuthn, node protocol, execution policy) | `arena/01a09640-arena-os-canonical` | 17 commits |
| 5 | `2d88032` | E2E suite, Waveyard phase docs, compose CI gate, community files | `arena/01a0bebf-arena-os-canonical` | 102 commits |
| 6 | `dc15a54` | Preferences API, archive-assistant surface, turboagent health, room docs, wangp bridge | `arena/01a0a9b7-arena-os-canonical` | (extras beyond the already-integrated core) |

All branches had **disjoint histories** from main (no merge-base; every branch
rooted at the Sep-13 "Initial canonical Arena OS build"). Integration was
therefore always a **content port** (git checkout of paths + adaptation), never
a git merge. Nothing was rebased over main's history.

---

## Body 1 — LUMA device app (`luma/`)

- **Landed:** the complete Expo/React Native client at `luma/` — Skia
  processing engine + shaders + adaptive native, expo-router tab app (camera,
  editor, create, settings), mobile UI kit, async-storage repositories,
  theme tokens, EAS/device-build config. Self-contained workspace: its own
  package.json, tsconfig, jest (jest-expo), eslint, lockfile.
- **Relationship to main:** the web engine of the same project already lives
  in `src/lib/luma/` (85–100% rename-similar engine modules); this is its
  device sibling. Zero coupling to the Next.js app.
- **Verification:** `npm ci` + `jest --ci` inside `luma/` → **115/115** (14
  suites), `tsc --noEmit` clean. Root tsconfig excludes `luma/` (own
  toolchain — same pattern as `waveyard-worker/`).

## Body 2 — lab-004 / gate-7 epistemics

- **Landed:** `src/lib/archive-reasoning/` (lattice, evidence, temporal,
  windows, synthesizers, render), `src/lib/personalisation/` (client, context,
  fixtures, generated contract, validation), `src/lib/chatRunner.ts`,
  `src/lib/internal-auth.ts`, `POST /api/internal/chat`, the 21 gate-7/lab
  docs, lab driver scripts + fixtures, OpenAPI contract generator.
- **The one merge (not a replacement):** `/api/chat` now delegates to
  `runChat` while **preserving main's browser response envelope exactly**
  (`requestedModelId` + the structured `runtime` object — existing UI
  consumers see a strict superset). Added: opt-in `archiveContext` evidence
  folding (fail-soft; Local Mode zero-egress always wins), the internal
  credential leg, and 401 only for wrong-bearer callers. No-header browser
  calls are never blocked (verified by the ported compatibility tests).
- **Verification:** 76 tests of this body, all green in the main battery.

## Body 3 — College runtime

- **Landed:** `src/lib/college/` (41 modules — layers 5–9), 32 routes under
  `/api/college/*`, 11 pages under `/college/*`, 4 components,
  `src/db/college.ts` (60 `college_*` tables, zero collisions with main's
  schema — verified), `mobile/` Campus client (own package.json/tsconfig,
  excluded from the root project), layer 5–9 verification scripts, Dockerfile,
  3 docs.
- **Migration systems:** canonical
  `desktop-migrations/0004_college_runtime.sql` generated from the schema
  (journal-ordered), mirrored as `drizzle/0017_college_runtime.sql` for dev
  history. Main's college foundation (`classOccurrences`/`eduMemory` +
  `lib/college.ts`) was already identical on the branch — untouched.
- **Skipped:** the branch's `drizzle/0000_college_baseline.sql` — it was a
  whole-app schema snapshot that would re-create tables main already has.
  Schema-driven generation is the canon.

## Body 4 — Security/identity architecture

- **Landed:** identity core (identityService, webauthn + verification,
  authenticationCeremony, authorization, sessionLifecycle/Events,
  requestIdentity), device channel (deviceArtifacts, encryptedBlobStore,
  nodeProtocol/Keys/Responses, rateLimits), execution machinery
  (executionPolicy/Session, retryPolicy, toolEffects + toolEffectService,
  workerExecutor/Suitability, workforceResolver, councilSynthesis,
  completeCouncilSession, apiErrors), routes
  `/api/identity/authentication/{options,verify}`, `/api/device-artifacts`,
  `/api/execution-sessions/[id]`, 7 architecture docs.
- **Schema:** `src/db/identitySchema.ts` — the branch's 19 tables. The
  branch's REDESIGNED mode-neutral `cognitive_sessions` landed as
  `execution_sessions` (own family; child tables + fileArtifacts FK to it) so
  main's council-flavored `cognitive_sessions` remains canon. Canonical
  `desktop-migrations/0005_identity_security.sql` (identity tables only) +
  `0006_core_session_columns.sql` (the branch's ADDITIVE columns on core
  tables: models workforce fields; council_runs structuredSynthesis +
  sessionId; battles/collabs sessionId). Mirrored as `drizzle/0018`/`0019`.
- **Shared-lib additions (additive only):** `GenerateOpts.strictRoute`
  (offline models still route to the local engine — zero network),
  `declaredModelCapabilities` + `STRUCTURED_OUTPUT_MODELS` in models.ts.
- **Deps added:** `@simplewebauthn/server`, `@electric-sql/pglite` (dev —
  integration tests run PGlite against the canonical migration file).
- **Adaptations (wiring, never assertions):** integration tests retargeted
  from the branch's `drizzle/0024–0026` to the canonical `0005`; renamed
  table references including inline fixture DDL; TS parameter properties
  converted to explicit fields (node strip-only mode); generate stubs typed
  to main's richer `GenerateResult`.
- **Skipped:** the branch's `api/handoffs` + `lib/handoffs.test.ts` — main's
  handoff ledger is the canon evolution of that file. The branch's ~64 M-files
  (its own evolution of main's routes/schema) were not replaced — only their
  additive pieces were extracted.

## Body 5 — E2E / CI / phase docs

- **Landed:** Playwright config + `tests/e2e/` (global-setup +
  `real-separation.spec.ts`, 2338 lines; imports adapted from `@waveyard/*`
  to this tree's modules; fault-injection scenarios self-skip without
  `WAVEYARD_TEST_FAULT_TOKEN` by design), `@playwright/test` devDep (browser
  download stays opt-in), `.github/workflows/ci.yml` (static gate + compose
  build smoke — green-by-construction on this tree), 20 Waveyard program
  docs, deterministic fixture-creator scripts, `prove-demucs.ts`,
  CONTRIBUTING/LICENSE/SECURITY.
- **Skipped (monorepo-structure artifacts; the restructure was rejected):**
  `docker/{e2e,worker}.Dockerfile` (COPY monorepo paths), `scripts/migrate.ts`
  (a third migration tracker — `desktop-migrations/` is canon),
  `scripts/test-compose.ts` (drives the branch's test-profile compose
  topology), `tests/unit/arena-rooms-handoffs.test.ts` (exercises the
  branch's parallel rooms registry; this tree's rooms system has its own
  battery coverage).

## Body 6 — 01a0a9b7 extras

- **Landed:** `/api/preferences` + `/api/preferences/[id]` (main already had
  the `owner_preferences` table and an identical `lib/preferences.ts` — only
  the HTTP surface was missing), the interactive archive-assistant surface
  (`/api/archive/{chat,items,scan}`, `/archive` page, `ArchiveAssistant`
  component + lib — coexists with main's reasoning-integration archive
  client under disjoint paths; both systems preserved),
  `/api/turboagent/health`, `bridges/wangp_bridge.py` + README, and the nine
  room briefs at repo root (AGENTS, ARCHIVE, CLASSROOM, CONGRESS, CUT,
  ORCHESTRATOR, REFERENCES, SPACES, STUDIO).
- **Skipped:** the branch's `drizzle/0009_studio_jobs` + `0010_cut_projects`
  (main's schema already carries both tables; dev-history duplicates under a
  colliding numbering) and `drizzle.config.json` (deliberately absent from
  this tree).

---

## Branches with nothing left to port

- **`arena-rooms-handoffs`** — superseded: main carries the rooms/handoffs
  evolution; nothing stranded.
- **`arena/01a0bdc9`** — fully landed (body 1; its web engine was already in
  main as `src/lib/luma/`).
- **`arena/01a0b544`, `arena/01a09640`, `arena/01a0bb55`, `arena/01a0bebf`,
  `arena/01a0a9b7`** — fully swept (bodies 2–6).

Every branch's A-file inventory was diffed against main; every file either
landed, landed-adapted, or is listed above with its reason. The skipped files
remain recoverable at their origin refs (e.g.
`origin/arena/01a0bebf-arena-os-canonical`).

## Standing contracts reaffirmed during the sweep

- Two migration systems: every schema change updated `desktop-migrations/`
  (canonical, journal-ordered, generated from schema) AND `drizzle/` (dev
  mirror) AND `src/db/*Schema.ts`.
- Never weakened, skipped, or rewrote a foreign test's assertions — only its
  wiring (import paths, fixture DDL names, stub types) to match this tree.
- The desktop battery, typecheck, lint, and Next build were green before
  every one of the six commits; the final state is 873/873 tests.
- Monorepo restructures rejected; all work landed on this tree's topology.
