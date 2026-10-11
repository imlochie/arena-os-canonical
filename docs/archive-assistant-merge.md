# The Archive Assistant merge — native at last

> **What changed.** Archive Assistant used to be a separate app
> (SomeSafePortablesoftware) that Arena OS talked to over a read-only HTTP
> bridge (`ARCHIVE_ASSISTANT_API_URL`, bearer/local modes, six GETs). That
> separation is gone: the assistant's core loop — provider sync,
> reconciliation, the review workload, and the six read operations — now runs
> inside Arena OS against its own database. One app, no bridge.

## What was kept

The **seam design** survived the merge because it was good:

- The generated contract types (`src/lib/archive-assistant/generated/`) stay
  the vocabulary. The native six-op service must still **validate against
  the same generated schemas** — a native bug now fails closed exactly like
  an upstream contract violation used to.
- `context.ts` (facts with evidence handles), `prompt.ts` (reasoning rules),
  and the epistemic lattice (`src/lib/archive-reasoning/`) are unchanged —
  they reason over the same shapes, whatever produces them.
- The house posture: **read-only toward providers**, honest uncertainty,
  evidence citations on every fact.

## What was absorbed

| Was (external app) | Now (native, in Arena OS) |
| --- | --- |
| Provider config (plex token) | `media_providers` table (plex + jellyfin, token sealed AES-256-GCM via `secretBox`) |
| Plex sync | `src/lib/mediaArchive/plex.ts` — real `/library/sections` + `/library/sections/{id}/all` fetches, watch state captured |
| (jellyfin was planned upstream) | `src/lib/mediaArchive/jellyfin.ts` — real `/Users/{id}/Views` + `/Users/{id}/Items` fetches, ticks→ms, watch state |
| Refresh history | `media_refreshes` — every sync attempt with status (`syncing`/`synced`/`sync_error`), completeness (`complete`/`partial`/`unknown`), reason; authority = last complete snapshot |
| Provider inventory | `media_library_items` — normalized items, deduped by (provider, ratingKey), first/last-seen refresh lineage |
| Reconciliation report | `src/lib/mediaArchive/reconcile.ts` — local `archive_items` ↔ provider libraries: matched / local_only / plex_only / duplicate / quality_conflict / uncertain, summary persisted in `reconciliation_runs` |
| Review items + decisions | `archive_review_items` (+ `archive_observations` for lineage: current + superseded prior per finding) — approve / reject / reopen recorded, never auto-executed |
| `/assistant/overview`, `/assistant/workload`, … | `src/lib/mediaArchive/contextClient.ts` — the six operations served natively from these tables, validated against the generated contract |
| Bridge status probe | `bridge-status.ts` — native: providers connected, last refresh, honest states (no more "unconfigured external URL") |

## The six read operations, natively

`ArchiveContextClient` still exists as the interface — now with one
implementation that reads the local database:

- `getOverview()` — health/attention from open review items, priority counts,
  honest `activeWork` (acquisition jobs: always 0 — that subsystem is not
  merged), media experience from captured watch state, discovery honestly
  `not_available` until provider "newest" endpoints are merged.
- `getWorkload()` — review items with states (`needs_you`, `completed`,
  `dismissed`, `superseded`, `uncertain`), observation lineage, counts.
- `getReconciliationSummary()` — the latest persisted `reconciliation_runs`
  summary (or an honest zero-run summary).
- `getFindingLineage(reviewItemId)` — current observation + at most one
  superseded prior + provider refresh linkage.
- `getProviderRefreshState/History(provider)` — from `media_refreshes`,
  including the "attempted diverged from authority" trap semantics the
  reasoning layer tests.

## What is honestly NOT merged yet

- **Acquisition/download jobs** (yt-dlp, media-tool bundling) — a write-heavy
  subsystem with its own safety story; deferred deliberately.
- **Archive operations** (rename/move with preflight/rollback) — the review
  decision is recorded, but Arena does not touch files yet.
- **Naming proposals, identity audit, media inspect** — same class.
- **Personalisation (Gate-6 seam)** — the client lib is intact; its evidence
  (watch-state signals) is now derivable from `media_library_items` when a
  provider with watch state is synced. Wiring it into chat is follow-up work.

## Where things live

- `desktop-migrations/0014_media_archive.sql` + `src/db/schema.ts` (tables above)
- `src/lib/mediaArchive/` — `types.ts`, `plex.ts`, `jellyfin.ts`, `sync.ts`,
  `reconcile.ts`, `contextClient.ts`, `review.ts`
- API: `/api/archive/providers` (list/save/delete/test/sync/reconcile),
  `/api/archive/review` (decisions), `/api/archive/context` and
  `/api/archive/findings/[id]/lineage` (now native)
- UI: the Archive Assistant room (`/rooms/archive-assistant`) is a native
  control panel — providers, sync, workload with approve/reject
- Tests: `src/lib/mediaArchive/providers.test.ts` (real HTTP fixture
  servers for the plex/jellyfin clients), `src/lib/mediaArchive/mediaArchive.test.ts`
  (PG-gated: sync lifecycle incl. partial/failed refreshes and authority
  pinning, reconciliation + observation lineage + healing, review decisions,
  the native six-op client against the generated contract, bridge status),
  plus the rewritten native route tests (`src/app/api/archive/routes.test.ts`,
  `src/app/api/chat/route.test.ts`)

## Post-merge: the local library (Wave 6 groundwork)

The provider model now has a third, server-less kind: **local**. A folder on
disk becomes a first-class provider — scanned by the real ffprobe through the
same sync machinery, reconciled like any provider, streamed with HTTP Range
by Arena itself, with Arena's own watch state and Toolbox-powered
transcode-on-demand. That's the Plex-independence groundwork; the full story
lives in `docs/local-library.md`. The gaps above (acquisition, executable
file operations, discovery) remain open and unchanged.
