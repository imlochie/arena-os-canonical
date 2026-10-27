# Feature-Utilisation Audit — Every Capability Reachable in the UI

**Scope:** verify that every implemented feature of the Waveyard product is actually
usable from the UI — no orphan routes, no invisible capabilities, no dead buttons.
Method: structural route↔UI cross-scan (template-literal aware, server-embedded URLs
included), then feature-level inspection of every panel, then live probes. Fixes
applied where gaps were found; battery re-run after.

**Environment note (14th platform re-clone, mid-audit):** HEAD reset to base with the
working tree intact but local commits `d3f2b69`/`728b67c` lost; restored via
`git reset --soft` onto pushed `968e286` (tree verified identical — status showed
exactly the mandate-wave + sweep files), re-committed as `165e89b`, then the audit
continued on top. `node_modules`/embedded-PG rebuilt (`npm ci --ignore-scripts` +
exec bits + soname symlinks — the nuget-hosted postinstall fallback is blocked here;
binaries ship in the tarballs, so nothing was missing).

---

## 1. Audit method

1. **Route → UI scan:** every `route.ts` under the Waveyard product surface
   (`/api/waveyard/*, /api/library/*, /api/streaming/*, /api/uploads, /api/assets/*,
   /api/desktop/*, /api/sources/*, /api/stems/*, /api/source-analyses/*,
   /api/source-section-analyses/*, /api/waveform-jobs/*, /api/jobs/*, /api/remixes/*,
   /api/remix-versions/*`) matched against every `/api/…` string in non-test UI code
   and in the Electron shell, with `${…}` holes as wildcards. Server-embedded URLs
   (e.g. `audioUrl` fields built by API routes) count as consumed — they are played
   by real `<audio>` elements.
2. **UI → route scan (reverse):** every `/api/…` the UI calls must resolve to a real
   route (no dead buttons). All hits resolved; the "dead" candidates were query-string
   truncation artifacts and external API bases (`/v1` in the AI adapter,
   `/arena/projects` in the handoff draft).
3. **Feature-level pass:** panel-by-panel inspection of StudioCore (Play/Studio/Visual
   presentations + Edit/Analyze/Showcase tabs), the deck, LivingPlayer, TrackPlayer,
   SessionExperience, MusicHome, BuildProject, ProjectWorkspace, PublicationPanel,
   ConnectedLibraries, moderation, public project page.

## 2. Gaps found and fixed

1. **Synchronous MIDI download was UI-orphaned** (`GET /api/waveyard/projects/{id}/midi/{audioId}`).
   The analysis panels only offered the queued remix-version export. Now
   `requestMidiExport` downloads the Standard MIDI File instantly when the analysis
   exists (blob download, real `.mid` bytes from the same route) and falls back to the
   queued export with an honest message otherwise. The harmony call now passes its stem
   id so the direct route can resolve the source. *Live probe: honest 404
   "Stem not found." for a bogus id — reachable and correctly guarded.*
2. **Publication audit trail was UI-orphaned** (`GET …/publication/audit`).
   PublicationPanel now loads the event history with the settings, renders it
   ("Publication history" — timestamp, event, reason), and refreshes it after every
   save. *Live probe: route reachable, events array returned.*
3. **Export-job lifecycle was invisible.** Queued MIDI/WAV exports said "queued" and
   then… nothing, anywhere. The publication GET now also returns active export jobs
   (status/stage/format/midiKind/error, editors only) and the panel renders them —
   in-flight exports say `queued · queued`, failures say why. Completed exports keep
   appearing in the publication picker, as before.
4. **Moderation was URL-only.** `/waveyard/moderation` (report review + actions) had
   no link anywhere, yet the local owner *is* the moderator. Added to the parked nav
   row beside Discover. *Live probe: page 200; both parked links present in the nav.*
5. **The stem deck (hero surface) had no download affordance.** Downloads existed only
   in ClipInspector/VocalChops. Each deck lane now carries a ⇩ chip
   (`/api/assets/{id}?download=1` — the existing sanitized-download capability), so
   "get your stems" is one click from the lane view, stem.fm-parity complete.

## 3. Verified utilised (no change needed)

- **Studio presentations:** Play (LivingPlayer: constellation stem controls, transport,
  sections strip, mini-player, Open Studio), Visual (CinematicVisual + presets),
  Studio (tabs: Edit — arrangement, waveform, transport, mixer, clip inspector, sound
  design, master, cleanup; Analyze — sections, meeting points, vocal/drum/harmony
  analyses, AI studio, generated layers, vocal chops, mashup; Showcase — deck,
  visualizer, A/B compare). Palette (source pool + connected libraries) always mounted.
- **Recursive separation** (deck ⋁ chip → stem layers), **engine seeding**
  (BuildProject "Prepare stem engine"), **models list** (BuildProject),
  **processing-status** (workspace banner), **arena handoff** (WaveyardHandoffPanel),
  **jobs/waveform jobs with retry** (workspace job cards), **source-intake/builds**
  (BuildProject), **automatic remixes** (prompt + banner in Play), **remix versioning**
  (save/restore via studio controls), **track library** (add/search/play/queue/
  playlists/smart collections/ratings), **sessions** (create, tracks, transitions, stem
  swaps, restore state, studio handoff), **streaming bridge** (connect, PKCE sync,
  JSON+CSV import, snapshots, diff, export, disconnect, sync-on-open), **public project
  page** (release player, download when allowed, reporting).
- **Three "orphan" candidates were false positives:** the per-asset audio routes
  (`cleanup/{audioId}`, `master/{audioId}`, `sound-design/{assetId}`) are consumed via
  server-embedded `audioUrl` fields played by `<audio>` elements in their studios.

## 4. Documented Arena-app findings (outside the product mandate)

The same scan over the pre-existing Arena OS surfaces found 12 route families with no
UI caller — recorded honestly, not fixed here (separate product surface, predates the
mandate): `/api/exports/*` (a parallel export API family; the visual studio UI uses
`/api/studio/jobs/*` instead), `/api/studio/models/{type}` (single-model detail; the
list endpoint is used), `/api/identity/authentication/*` (WebAuthn ceremony — dormant
in the local-first build by design), `/api/internal/chat` + `/api/turboagent/health`
(ops/CI), and detail endpoints `/archive/findings/{id}/lineage`,
`/congress/{id}/advance`, `/device-artifacts/{id}`, `/execution-sessions/{id}`.

## 5. Final state

- **Waveyard product orphans: 0** (re-scan after fixes).
- Battery **1125/1125** (≈616 s), `tsc --noEmit` clean, eslint clean on all touched
  files.
- Live probes: parked nav links present, publication `exportJobs` field served, audit
  route serving, MIDI route honest-404, moderation page 200, proof rows cleaned.
- Committed locally on `arena/01a10c30-arena-os-canonical` (not pushed, per the
  standing rule).
