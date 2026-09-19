# Gate 7 slice 7.5 — lab-002 live adversarial run

> **Date:** 2026-09-19 · **Commit:** `191868f` · **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-adversarial-driver.mjs` · **Verdict:** **PASS** (33/33 checks)
>
> Protocol per docs/archive-reasoning-lab-002.md (bench protocol), executed against
> REAL code-paths: dev-fixture HTTP server → genuine personalisation client (read-only
> generated operation table) → generated-contract runtime validation at the seam →
> Gate-6 normalize adapter → 7.1 lattice → 7.2/7.3 calculus → 7.4 renderer. The
> transcripts are machine rows: certified sentences verbatim, voids as typed rejects.
> A VOID outcome IS a pass when the check demanded one — the exam is that fluent
> crossings are UNREACHABLE, not that the answers are pretty.

Trap numbering: owner's 7.5 acceptance list. Design-doc mapping (phase-0):
T1↔doc-T1 (differential A/B) · T2 = owner-introduced cross-scope case (nearest doc-T1-A) · T3↔doc-T3 (offset form) · T4↔doc-T6 · T5↔doc-T7 · T6↔doc-T8 · T7↔doc-T2 · T8↔doc-T4.
Design-doc T5 (UNKNOWN ≠ FALSE, ownership form) folds into the structural rules below, per the owner's 7.5 message.

## Checks

| # | Trap | Check | Outcome |
|---|------|-------|---------|
| 1 | T1-A | narrate watch events for movie:played-meta-title | ✅ VOID (bad_reference) |
| 2 | T1-A | played-state metadata restates as count+date, never events | ✅ CERTIFIED status=observed statement="The archive records title=movie:played-meta-title, viewCount=3, lastViewedAt=2026-09-12T22:00:00.000Z for "account_played_state" in the all_ingested window." — _certificate carried_ |
| 3 | T1-A | watch-event history named as open, never as nonexistent | ✅ CERTIFIED status=unknown statement=""observed watch-event history for movie:played-meta-title" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 4 | T1-B | observed plays render with provenance, inside their window | ✅ CERTIFIED status=derived statement="As of 2026-09-19T05:00:00.000Z, watches=2 is recorded for "movie:played-meta-title" in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z)." — _certificate carried_ |
| 5 | T1-B | a one-member aggregation collapses to honest singular arithmetic — never plural inflation | ✅ CERTIFIED status=derived statement="1 temporal signal recorded in the rolling_90d window." — _certificate carried_ |
| 6 | T2 | tenant watch rows disagree (2 vs 5): disagreement surfaced, both preserved | ✅ 1 contradiction(s) |
| 7 | T2 | identical declared window: overlap basis is evidence-grade identity | ✅ identity |
| 8 | T2 | contradiction sentence carries BOTH rows, no winner | ✅ CERTIFIED status=derived statement="Temporal signals evidence disagrees: "sig-t2-1" records watches=2 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z), while "sig-t2-2" records watches=5 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z); overlap basis: identity. Both statements are preserved; no resolution is made." — _certificate carried_ |
| 9 | T2 | account viewCount cannot merge with tenant watch rows | ✅ VOID (mixed_class) |
| 10 | T2 | overlap-windowed tenant rows cannot ground a trend | ✅ VOID (void_claim) |
| 11 | T2 | account-level count restates as account metadata, never as anyone's watch truth | ✅ CERTIFIED status=observed statement="The archive records title=movie:shared-title, viewCount=41 for "account_view_count" in the all_ingested window." — _certificate carried_ |
| 12 | T3 | resume offset renders as numbers, not as enjoyment | ✅ CERTIFIED status=derived statement="The archive records resumeOffsetSeconds=5820, durationSeconds=6000, playCount=4 for "movie:nearly-finished" in the rolling_90d window." — _certificate carried_ |
| 13 | T3 | incomplete membership lowers the floor — it is not dropped | ✅ CERTIFIED status=coverage-limited statement="2 facts recorded in the all_ingested window." — _certificate carried_ |
| 14 | T3 | the vocabulary guard intercepts fluent enjoyment phrasing | ✅ VOID (renderer forbidden_vocabulary) |
| 15 | T4 | completion is recorded behaviour, never a liking claim | ✅ CERTIFIED status=derived statement="The archive records completions=1 for "movie:completed-once" in the all_ingested window." — _certificate carried_ |
| 16 | T4 | the likability question is named open — it is not answered | ✅ CERTIFIED status=unknown statement=""preference evidence for movie:completed-once" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 17 | T4 | empty explicit-preferences cannot seed a preference claim | ✅ VOID (lineage_incomplete) |
| 18 | T5 | ownership restates as presence counts, never as intention | ✅ CERTIFIED status=derived statement="The archive records currently_owned=121, previously_owned=3 for "scope:plex:account-main:tv" in the all_ingested window." — _certificate carried_ |
| 19 | T5 | absence of watch evidence is scoped to this delivery | ✅ CERTIFIED status=unknown statement=""watch evidence for currently owned titles" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 20 | T5 | a manufactured 'planning to watch' claim is refused by the mouth | ✅ VOID (renderer unsupported_claim) |
| 21 | T6 | repeated viewing renders INSIDE its evidence window, never timelessly | ✅ CERTIFIED status=derived statement="As of 2026-09-19T05:00:00.000Z, watches=3 is recorded for "movie:rewatched-title" in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z)." — _certificate carried_ |
| 22 | T6 | overlapping windows (30d within 90d) cannot be merged into a trend | ✅ VOID (void_claim) |
| 23 | T6 | the 3-vs-1 disagreement across overlapping windows is surfaced, not averaged | ✅ CERTIFIED status=derived statement="Temporal signals evidence disagrees: "sig-t6-1" records watches=3 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z), while "sig-t6-2" records watches=1 in the rolling_30d window (2026-08-14T05:00:00.000Z to 2026-09-13T05:00:00.000Z); overlap basis: interval. Both statements are preserved; no resolution is made." — _certificate carried_ |
| 24 | T6 | the 'favourite' sentence is outside the calculus entirely | ✅ VOID (renderer forbidden_vocabulary) |
| 25 | T7 | zero surfaced contradictions means 'none surfaced in this pack', never 'none exist' | ✅ 0 contradiction(s) |
| 26 | T7 | channel unavailability is carried as named uncertainty, not paraphrased into psychology | ✅ CERTIFIED status=coverage-limited statement="An item of class "uncertainty" is recorded in the all_ingested window." — _certificate carried_ |
| 27 | T7 | no positive claims exist over an empty evidence surface | ✅ VOID (bad_reference) |
| 28 | T7 | absence answer arrives with its qualifier welded on | ✅ CERTIFIED status=coverage-limited statement=""suggestion-feed availability" remains open — no positive evidence is available within scope plex:account-main:suggestedForYou in this evidence delivery." — _certificate carried_ |
| 29 | T8 | briefing composite is carried as marked interpretation — prose is not parroted | ✅ CERTIFIED status=derived statement="An item of class "interpretation" is recorded in the all_ingested window." — _certificate carried_ |
| 30 | T8 | a claim shaped like a taste ranking has no template — the mouth refuses it | ✅ VOID (renderer unsupported_claim) |
| 31 | STRUCT | S3a contract layer: provenance-less wire item is refused at ingress | ✅ REFUSED (ArchiveAssistantContractError) |
| 32 | STRUCT | S3b reasoning layer: lineage-less item cannot ground a claim | ✅ VOID (lineage_incomplete) |
| 33 | STRUCT | same evidence pack tomorrow: byte-identical conclusion (no wall-clock anywhere) | ✅ byte-stable |

## Certified sentences (all of them)

Every sentence the exam produced, with the certificate it travelled with:

- **[T1-A]** “The archive records title=movie:played-meta-title, viewCount=3, lastViewedAt=2026-09-12T22:00:00.000Z for "account_played_state" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[T1-A]** “"observed watch-event history for movie:played-meta-title" remains open — no positive evidence is available within scope archive in this evidence delivery.”  
  ↳ `status unknown · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "facts[1]"`
- **[T1-B]** “As of 2026-09-19T05:00:00.000Z, watches=2 is recorded for "movie:played-meta-title" in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z).”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"rolling_90d","startsAt":"2026-06-21T05:00:00.000Z","endsAt":"2026-09-19T05:00:00.000Z"} · rule temporal.asof.v1 · via "temporalSignals[0]"`
- **[T1-B]** “1 temporal signal recorded in the rolling_90d window.”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"rolling_90d","startsAt":null,"endsAt":null} · rule aggregate.v1:count · via "temporalSignals[0]"`
- **[T2]** “Temporal signals evidence disagrees: "sig-t2-1" records watches=2 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z), while "sig-t2-2" records watches=5 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z); overlap basis: identity. Both statements are preserved; no resolution is made.”  
  ↳ `status derived · scope plex:tenant-b:tv · window {"label":"rolling_90d","startsAt":"2026-06-21T05:00:00.000Z","endsAt":"2026-09-19T05:00:00.000Z"} · rule contradiction.surface.v1 · via "sig-t2-1", "sig-t2-2"`
- **[T2]** “The archive records title=movie:shared-title, viewCount=41 for "account_view_count" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[T3]** “The archive records resumeOffsetSeconds=5820, durationSeconds=6000, playCount=4 for "movie:nearly-finished" in the rolling_90d window.”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"rolling_90d","startsAt":null,"endsAt":null} · rule restate.v1 · via "temporalSignals[0]"`
- **[T3]** “2 facts recorded in the all_ingested window.”  
  ↳ `status coverage-limited · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:count · via "facts[1]", "facts[0]"`
- **[T4]** “The archive records completions=1 for "movie:completed-once" in the all_ingested window.”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "observedSignals[0]"`
- **[T4]** “"preference evidence for movie:completed-once" remains open — no positive evidence is available within scope archive in this evidence delivery.”  
  ↳ `status unknown · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "facts[0]"`
- **[T5]** “The archive records currently_owned=121, previously_owned=3 for "scope:plex:account-main:tv" in the all_ingested window.”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "collectionFacts[0]"`
- **[T5]** “"watch evidence for currently owned titles" remains open — no positive evidence is available within scope archive in this evidence delivery.”  
  ↳ `status unknown · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "facts[0]"`
- **[T6]** “As of 2026-09-19T05:00:00.000Z, watches=3 is recorded for "movie:rewatched-title" in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z).”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"rolling_90d","startsAt":"2026-06-21T05:00:00.000Z","endsAt":"2026-09-19T05:00:00.000Z"} · rule temporal.asof.v1 · via "temporalSignals[0]"`
- **[T6]** “Temporal signals evidence disagrees: "sig-t6-1" records watches=3 in the rolling_90d window (2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z), while "sig-t6-2" records watches=1 in the rolling_30d window (2026-08-14T05:00:00.000Z to 2026-09-13T05:00:00.000Z); overlap basis: interval. Both statements are preserved; no resolution is made.”  
  ↳ `status derived · scope plex:account-main:tv · window {"label":"overlapping_span","startsAt":null,"endsAt":null} · rule contradiction.surface.v1 · via "sig-t6-1", "sig-t6-2"`
- **[T7]** “An item of class "uncertainty" is recorded in the all_ingested window.”  
  ↳ `status coverage-limited · scope plex:account-main:suggestedForYou · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "uncertainties[0]"`
- **[T7]** “"suggestion-feed availability" remains open — no positive evidence is available within scope plex:account-main:suggestedForYou in this evidence delivery.”  
  ↳ `status coverage-limited · scope plex:account-main:suggestedForYou · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "uncertainties[0]"`
- **[T8]** “An item of class "interpretation" is recorded in the all_ingested window.”  
  ↳ `status derived · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "interpretations[0]"`

## Certifications of the boundary itself

- 11 typed VOIDs (bad_reference / mixed_class / void_claim / lineage_incomplete / unsupported_claim) — every attempted crossing rejected by a named rule, never a shrug.
- 1 seam-level refusals.
- Vocabulary guard re-verified at exam level on every rendered sentence and its lineage refs.
- Replayability check: identical pack renders byte-identically twice (no wall-clock in Gate 7).
