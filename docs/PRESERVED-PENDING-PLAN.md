# Preserved-pending work — dependency-aware implementation plan

Status: **plan, not implementation.** Nothing described here is present in the
convergence candidate. Each item below was examined against current `main`
(`33c876a`) during the 2026-11-07 reconciliation and deliberately left out of
PR #29 because it is a subsystem, not a port. This document exists so the work
is recoverable in the right order, without creating a second storage,
persistence, mission or runtime system.

Companion: `docs/BRANCH-PR-RECONCILIATION-LEDGER.md` §2.4 records *why* each was
deferred. This file records *how* to do it.

---

## A. Artifact content objects and two-grace reclamation

Source refs: `arena/331aa502-arena-os-canonical` (also on PR #25/#26 trees).
Old-layout files: `src/lib/artifact-objects.ts` (101 lines),
`artifact-storage-lock.ts` (4), `artifact-object-recovery.ts` (76),
`artifact-reclamation.ts` (190), `src/db/schema.ts` additions,
`src/app/api/artifacts/{storage,[id]/history}/route.ts`.

### What is actually missing on `main` (verified)

| Prerequisite | On `main`? |
|---|---|
| `artifacts.content_object` (jsonb) column | **no** |
| `artifact_revisions` table | **no** |
| `object_reclamations` table | **no** |
| `StorageProvider.putImmutableStream(key, stream, {bytes, sha256})` | **no** |
| `StorageIntegrityError` | **no** |
| Artifact revision/history routes | **no** |
| `MAX_ARTIFACT_OBJECT_BYTES` descriptor validation | **no** |
| `arcadeStore` artifact CRUD (insert/list/get/update/delete) | **yes** |
| `getStorage()` local provider, `safeLocalPath`, `privateObjectKey` | **yes** |

So `main` can create, list, read, update and delete artifacts with a `body`
string; it has **no** immutable content objects and **no** revision history.

### Why it cannot be a copy

`artifact-objects.ts` imports two storage primitives that do not exist, and its
correctness argument depends on them: `putImmutableStream` is what makes
"deduplicated, byte-and-sha bound, never partially written" true, and
`StorageIntegrityError` is what distinguishes "storage refused for integrity
reasons" (→ 422) from "storage unavailable" (→ 503). Porting the module without
them would compile only by stubbing, which is exactly the unverified capability
claim this work exists to avoid.

### Dependency-ordered plan

Do these as **separate PRs in this order**. Step 1 is independently valuable and
does not depend on 2–5.

1. **Storage: immutable stream publication** (`lib/arena/src/lib/waveyard/storage.ts`)
   - Add to `StorageProvider`: `putImmutableStream(key, source, {bytes, sha256})`
     and `getLocalPath` already exists.
   - Local implementation: stream to `key.partial`, count bytes and hash while
     writing, refuse (and unlink) on size/hash mismatch, `fsync`, then
     `replaceFile` → use the recovered `lib/arena/src/lib/fs-replace.ts` so
     Windows sharing violations do not surface as integrity failures. *This is
     the first genuine reuse of the recovered stack — worth doing here.*
   - Add `StorageIntegrityError` as a distinct class.
   - Tests: hash mismatch refused and no target file left; byte-count mismatch
     refused; existing identical object deduplicated (same key, no rewrite);
     concurrent identical publishes produce one file; Windows retry path covered
     by the existing `fs-replace` tests.
   - **No schema, no routes.** Ships alone.

2. **Schema: artifact revision + content descriptor** (migration + `lib/db`)
   - `artifacts`: add `content_object jsonb`, `revision integer not null default 1`,
     `current_revision_id uuid`, `deleted_at timestamptz`.
   - New `artifact_revisions` table (owner-scoped, immutable snapshots).
   - New `object_reclamations` table exactly as the old schema defines it
     (`state`, `marked_at`, `not_before`, `purge_after`, `identity jsonb`,
     `audit jsonb[]`).
   - Follow the existing migration convention: `lib/arena/desktop-migrations/`
     is the packaged, ordered path; add the matching `lib/arena/drizzle/` file.
     Next free numbers are 0025+ (desktop) and 0027+ (drizzle) — re-check before
     writing.
   - Tests: apply to a disposable PGlite database via
     `lib/arena/src/lib/waveyard/worker-local/pglite-migrations.test-helper.ts`
     (added by PR #29) and assert the columns/tables exist and default correctly.
   - **Additive only.** No behaviour changes yet.

3. **Artifact objects, ported against the real API**
   - Port `artifact-objects.ts` with `storageReadLock` (advisory lock) intact,
     descriptor validation, and the published/superseded receipt writes.
   - Port `artifact-object-recovery.ts` (retain unbound/partial objects; never
     collect on a guessed absence of metadata).
   - Tests: the old module's contract — foreign-owner path 404 not 403; wrong
     media type refused; binding mismatch refused; missing object →
     `410`, not a substituted excerpt.

4. **Routes: revision history + storage download**
   - `GET /artifacts/[id]?revision=<uuid>&download=1`, `GET /artifacts/storage`
     (reclamation status), wired through `requireApiAccess` + owner scoping as
     the existing artifact routes already do.
   - Extend the existing `artifacts/route.ts` rather than adding a parallel
     artifact API.

5. **Two-grace reclamation** (`artifact-reclamation.ts`)
   - Local-only, explicit, never on a startup/refresh path. Every decision
     re-reads the real graph; the receipt table is never authoritative for
     reachability.
   - Tests: marked → quarantine → purge with the real grace windows; a revived
     reference cancels purge; an interrupted run resumes without double-purge.

### Guard rails

- Do **not** add `@aws-sdk`. `main`'s storage is deliberately local-first; the
  module header says S3 was dropped on purpose.
- Do **not** create a second artifact store. Extend `arcadeStore` + the existing
  `imported/artifacts` routes.
- Until step 3 lands, nothing may claim "artifacts are recoverable".

---

## B. Arcade browser-runtime publication gate

Source ref: PR #19 `product/arcade-runtime-validation` @ `16a6e0b`.
Files: `src/lib/games/sandbox.ts` (29 lines), `games/runtime-validation.ts`,
`games/runtime-contract.test.ts` (48), plus changes to `games/forge-ai.ts`.

### What is missing on `main` (verified)

`main` has `games/validator.ts`-equivalent static checks inside
`games/index.ts` (`validateGameCode`) and `games/imported-html.ts` (imported-HTML
safety), but **not**:

- `sandbox.ts` (`ARCADE_HOST_CSP`, `GAME_CSP`, `sandboxGameDocument`);
- `runtime-validation.ts` (`validateGameRuntime`, `consumeFreshRuntimeCheck`);
- the `validateRuntime` / `onDraft` seams and `ForgeDraftError` on
  `forgeGameWithAI`.

`main`'s `forgeGameWithAI` does retain a failed draft (it attaches
`err.draft` with code/title/gameType/validation), so **draft retention already
exists**. What is genuinely missing is *browser* execution proof before
publication.

### Why it was not ported

It restructures `forgeGameWithAI`'s result contract (`runtimeValidation`,
`repairsUsed` semantics, an `onDraft` callback) and its end-to-end proof needs a
real Playwright browser. Porting it unverified would be its own unproven
capability claim.

### Dependency-ordered plan

1. **`sandbox.ts` first, alone.** It is 29 lines, has no dependencies, and is
   independently testable without a browser: assert the policy precedes
   untrusted markup (index comparison), assert `frame-src 'none'` in the host
   CSP, assert `sandbox="allow-scripts"` and never `allow-same-origin` at the
   embedding site. Ships alone.
2. **Wire the sandbox into the player.** Use `sandboxGameDocument` at the point
   `main` currently renders untrusted game HTML, so the CSP is real in the app
   rather than only in the validator.
3. **`validateGameRuntime` behind an injectable seam.** Take the module's
   `Browser`/`Page` from a parameter with a default, so the orchestration tests
   run on fixtures and only the acceptance test needs a browser.
4. **Then** extend `forgeGameWithAI` with `validateRuntime`/`onDraft` and adopt
   `ForgeDraftError`, keeping the existing `err.draft` shape as the fallback so
   no current caller breaks.
5. **Acceptance**: a real-browser run. Does not need Playwright's CDN at test
   time if the browser is provisioned by the CI step — but this must be a real
   browser, headless, with `connect-src 'none'` enforced.

### Guard rails

- Never `eval`/`vm` in Node for untrusted game code.
- Never run untrusted HTML in an authenticated Spaces browser profile — the old
  header is explicit about this and it is the whole point of the boundary.
- Do not weaken `TWO_RUNTIME_FAILURES` semantics: two runtime failures must
  still surface the real defect, not silently return a passing result.

---

## C. Waveyard arrangement / export capabilities

Source refs: PR #15 lineage (`arena/331aa502` and descendants). Old-layout files
with no counterpart under `lib/arena/src/lib/`: `waveyard/arrangement-pcm.ts`,
`waveyard/arrangement-preparation.ts`, `waveyard/export-bundle.ts`,
`waveyard/project-audio.ts`, `waveyard/library/session-save-queue.ts`,
`conversion/{archive,playlist,provenance,tunepat}.ts`, `http/{download,range}.ts`,
`waveyard/worker-local/export-inserts.ts`.

### Why this is a review item, not a port

`main` has a *different, newer* implementation of the same ground:
`waveyard/arrangement.ts`, `arrangement-preview-*.ts`, `automation/`, `fades.ts`,
`output-peak-limiter.ts`, `conversion/{engine,jobs,idempotency}.ts`,
`publication.ts`, `session-audio-asset-pool.ts`, and partial-content handling
inside `imported/exports/[id]/media/route.ts`.

Porting the old modules wholesale would create a **second** arrangement PCM path
and a second export/persistence route — precisely what the convergence mission
forbids. Each needs a capability-level comparison first.

### Order to review them, highest value first

1. `export-bundle.ts` — is there a real gap, or is it superseded by
   `publication.ts` + the exports routes? Compare what a bundle guarantees
   (byte-complete, ordered, checksummed) against what `main` produces today.
2. `http/{range,download}.ts` — `main` already serves ranges in
   `imported/exports/[id]/media/route.ts` and `imported/stream/[id]/route.ts`.
   Decide whether a shared primitive is worth extracting; do not add a second
   range implementation.
3. `library/session-save-queue.ts` — `main` has no save queue. This may be a
   genuine gap (ordering/coalescing for concurrent per-tab session writes).
   Compare against `session-service.ts` + `session-key-matching.ts` behaviour
   first, and against the existing test "concurrent per-stem patches from
   separate tabs preserve both edits".
4. `arrangement-pcm*` / `arrangement-preparation.ts` — largest and riskiest.
   `main` already renders preview PCM and offline renders. Only proceed if a
   measured behaviour is actually missing.
5. `conversion/{archive,playlist,tunepat,provenance}` / `project-audio.ts` —
   smallest gaps, safest to add incrementally with their own tests.

### Guard rails

- One PCM path, one export path, one persistence path. If a port would add a
  second, it must instead be a migration of the existing one.
- Every recovered behaviour needs a test that fails without it.

---

## D. Durable cancellation / recovery design

Source ref: PR #26 `arena/windows-ready-integration-2026-10-22`.

PR #26's durable `cancelling` status, `separation/recovery.ts` and the
`onSpawn` pid record conflict with `main`'s broker-based cancel
(`lib/arena/src/lib/waveyard/separation/cancel.ts`, `worker-local/broker.ts`,
`retry.ts`). This is a **design decision**, not a merge, and it should not be
started before C is resolved, because both touch the same job lifecycle.

The decision to make: does cancellation need a durable `cancelling` state (so a
crash mid-cancel is recoverable), or is broker-held cancel sufficient? Answer it
with a failure case — kill the process during a cancel and see what the row
says. Write that test first; it will choose the design.
