# Waveyard P5 — Product Completion Plan

Written **before** implementation, after walking every surface and the full
user journey through code (HOME → import → play → stems → queue → session →
compatibility → transition → save → reload → Stem2 → Studio). Continues from
`8e7f501` on `arena/01a10c30-arena-os-canonical`.

P5 is the integration pass: no new engine, no new machinery, no speculative
features. The verified architecture (P1–P4) is consumed as-is.

---

## Findings

### A. Missing functionality

1. **Sessions are invisible from the front door.** `/waveyard` answers every
   STEP-4 question except "What sessions do I have?" — sessions are reachable
   only through the nav link. The LISTEN→PERFORM journey starts with hunting.
2. **No Player→Session bridge.** Playing a track and wanting to perform with
   it requires: leave player → Sessions → create → re-find the track in a
   select → add. The natural "take this track into a session" step does not
   exist. (Session→Player already works: session order items link nowhere
   outside the session, by design — the session is the performance surface.)

### B. UX problems

3. **Navigation is fragmented.** Nine hand-copied navs; three variants:
   the product nav (Music/Sessions/Discover/Studio·Create, brand
   "stem-aware music") on home/play/sessions/session, and the legacy studio
   nav (brand "open stem studio", links "Home"/"Discover"/"New project") on
   `/waveyard/create`, `/waveyard/projects/[id]`, `/waveyard/discover`,
   `/waveyard/moderation`. From the Studio you cannot reach Music or Sessions
   at all. This is the loudest "stack of demos" signal in the product.
4. **Session decks are unlabeled as decks.** "Current"/"On deck" describes
   roles but STEP 7 asks for the performance mental model: DECK A / DECK B
   with their roles.
5. **Session compatibility answers are prose-only.** The honest REAL /
   APPROXIMATE / UNAVAILABLE distinction exists in the reasons but is not
   *labeled*, so a user must parse sentences to learn what is proven vs
   estimated vs absent.

### C. Accessibility

6. Global `:focus-visible` outlines exist; player keyboard transport exists
   (Space/arrows, text-entry guarded); session surfaces operate fully through
   native controls (buttons/selects/sliders) via keyboard tab order; status
   regions use `role="status"`. **Gap:** session surfaces have no keyboard
   shortcuts — acceptable (two simultaneous decks make single-key transport
   ambiguous); documented here instead of guessed at in code.

### D. Visual/product cohesion

7. The legacy brand subtitle ("open stem studio") and missing links (above)
   read "studio with a music library attached" — the inverse of the product
   hierarchy. Fix is the shared nav (finding 3), not a redesign.
8. First-run empty state is one thin line ("Your library is empty — add
   music to begin."). It does not explain what Waveyard is, what a stemmed
   track is, what happens to source-only tracks, what sessions are, or what
   Stem2 does (STEP 10). Same for the sessions list empty state.

### E. Reliability/failure handling

9. Audited against the STEP-11 list; existing behavior: library empty ✓,
   import errors surfaced ✓, invalid audio rejected with reason ✓ (422 +
   message), source-only honesty ✓ (player + home badges), deleted queue
   items ✓ (failSummary "(removed track)" in sessions; queue removes by id),
   unavailable asset → transport play failure surfaces as an error line ✓,
   failed session restore → falls back to first track + saved position only
   when the saved track still exists ✓, failed transition/swaps/handoff →
   honest status messages + 409 reasons ✓, Stem2 disconnect/reconnect/routing
   failure → mandated states ✓, restart persistence ✓ (e2e-proven).
   **No change needed** — the failure pass found no silent paths; this is
   recorded so the claim is auditable.

### F. Hardware acceptance

10. The Stem2 plan has a 7-step checklist; STEP 16 of the mandate asks for
    the full 18-step Windows acceptance procedure with per-test
    classification (VERIFIED / PARTIALLY VERIFIED / UNAVAILABLE / FAILED).
    Documentation update only — hardware behavior is never classified from
    documentation alone.

### Engine-safety audit (STEP 15, no changes required)

- One audio engine (`useStemTransport`); session composes two instances ✓
- Decks are role-keyed and stable; navigation unmount pauses + closes
  contexts (transport cleanup effect) ✓
- rAF loops cancel on unmount/pause (P2 pattern, reused in session meters) ✓
- Meters poll only while playing ✓; one routing controller (singleton) ✓
- Crossfade cancel/finish are deterministic and advance exactly once ✓
- Stem2 routing operations serialized (no routing race) ✓

---

## Implementation (scoped)

| # | Change | Files |
|---|---|---|
| 1 | **`WaveyardNav`** — one shared nav (Music · Sessions · Discover · Studio), consistent brand; used by all nine Waveyard pages. Studio pages keep their content untouched. | new `src/components/waveyard/WaveyardNav.tsx`; 9 page files (nav block swaps only) |
| 2 | **Home Sessions section** — list, create, open, delete (existing sessions API; last-updated ordering). Placed between Queue side and Library? No: as a panel beside Playlists — the front door now answers "What sessions do I have?". | `MusicHome.tsx` |
| 3 | **Truthful first-run empty states** — empty library explains Waveyard, stems, source-only, sessions, Stem2 (no catalogue/artwork/device/analysis fakes). Sessions list empty state explains what a session is. | `MusicHome.tsx`, `sessions/page.tsx` |
| 4 | **Player → Session bridge** — "Play as session" creates a session named after the track, adds THIS track, and opens the session (two API calls that already exist; no new server code). | `TrackPlayer.tsx` |
| 5 | **`compatibilityEvidence`** (pure, tested) — deterministic REAL / APPROXIMATE / UNAVAILABLE labels for tempo, key, and alignment from analysis facts; rendered as tags next to the existing reasons. Deck headers gain DECK A / DECK B labels. | `session-logic.ts` (+tests), `SessionExperience.tsx` |
| 6 | **Windows Stem2 acceptance procedure** — the 18-step procedure + classification table appended to the Stem2 plan; nothing marked VERIFIED until physically tested. | `docs/waveyard-stem2-plan.md` |

Out of scope (recorded, not silently expanded): visual redesign of Studio,
new session features, new Stem2 capabilities, meeting-point cueing (P5 of
the original plan is covered by P3's honest stored-mode), playlist/queue
changes, keyboard shortcuts for sessions.

## Verification plan

`npm test` (expect 568 + new evidence tests) · `npm run typecheck` ·
eslint on every P5-changed file (repo pre-existing debt reported, not
touched) · `npm run desktop:compile` · `npm run desktop:prepare-server` ·
`npm run desktop:e2e` (49 steps must stay green) · manual Windows
acceptance + physical Stem2 procedure documented for the user.
