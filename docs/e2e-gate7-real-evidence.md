# Gate 7 — first real-evidence reasoning pass

> **Date:** 2026-09-19 · **Base commit:** `4b11b51` · **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-real-evidence-driver.mjs` · **Verdict:** **PASS** (19/19)
>
> **The question** (Gate 7's own, finally not hypothetical): given real
> provenance-backed evidence, what is Arena actually permitted to conclude?

## Evidence provenance

The payload at `scripts/fixtures/real-evidence-upstream-capture.json` is the
actual JSON upstream's runtime emitted — `getPersonalisationContext()` at
`imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a`,
seeded with the exact events of upstream's own regression test ("rebuilds
explainable recent, long-term, rewatch, scope, and explicit signals"), derived
as-of 2026-09-19T00:00:00.000Z. It is not a fixture Arena designed: Arena captured
it, validated it, and dropped it through the real seam (dev-replay HTTP server
→ read-only generated-operation client → generated-contract validation →
normalize → lattice → calculus → renderer).

## Checks

| # | Class | Check | Outcome |
|---|-------|-------|---------|
| 1 | INGRESS | real payload validates against the regenerated contract and normalizes verbatim | ✅ {"facts":8,"observedSignals":2,"temporalSignals":1,"collectionFacts":1,"interpretations":0,"uncertainties":0,"explicitPreferences":1} |
| 2 | INGRESS | real provenance arrives intact through the seam | ✅ observationIds=3 evidenceKeys=3 ingestionBatchIds=["manual-0d6a3acb-ace2-47f6-91d1-2d263cfbf4f0"] eventOccurredAt=3 observedAt=3 scope=plex:movies-v1 |
| 3 | INGRESS | the surface carries its own constraints and they cross verbatim | ✅ ["Signals are observations, not likes or preferences","No universal taste score","No recommendation decision is made here"] — _the producer tells the seam what is not licensed; preservation keeps that_ |
| 4 | DERIVE | restate real observed fact (totalPlays) | ✅ CERTIFIED status=observed statement="The archive records 3 for "totalPlays" in the all_ingested window." — _certificate carried_ |
| 5 | DERIVE | restate real long-term signal with full provenance behind it | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, totalWatches=3, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=3 for "behaviour-film" in the all_ingested window." — _certificate carried_ |
| 6 | DERIVE | restate real temporal signal inside a caller-declared evidence window | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90 for "behaviour-film" in the rolling_90d window (2026-06-21T10:22:53.741Z to 2026-09-19T10:22:53.741Z)." — _certificate carried_ |
| 7 | DERIVE | restate real collection fact | ✅ CERTIFIED status=derived statement="The archive records never_matched=3 for "archive" in the all_ingested window." — _certificate carried_ |
| 8 | DERIVE | count the non-unknown facts as real arithmetic | ✅ CERTIFIED status=derived statement="7 facts recorded in the all_ingested window." — _certificate carried_ |
| 9 | DERIVE | sum real numeric facts | ✅ CERTIFIED status=derived statement="The archive records a total of 5 across 2 facts in the all_ingested window." — _certificate carried_ |
| 10 | DERIVE | enumerate real subjects over both observed signals | ✅ CERTIFIED status=derived statement="2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film"." — _certificate carried_ |
| 11 | DERIVE | unknown ground stays unknown on the REAL surface (hoursWatched = null value) | ✅ CERTIFIED status=unknown statement=""hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 12 | DERIVE | real evidence replays byte-identically (no clocks in the calculus) | ✅ byte-stable |
| 13 | VOID | including an unknown fact in a positive aggregate kills the whole claim | ✅ VOID (void_claim) |
| 14 | VOID | real surface's window vocabulary is not the 7.3 extractor's: as-of claims unformable | ✅ VOID (lineage_incomplete) |
| 15 | VOID | one real temporal signal cannot ground a trend | ✅ VOID (lineage_incomplete) |
| 16 | VOID | real explicit preference statement is not handled enough to ground a conclusion | ✅ VOID (lineage_incomplete) |
| 17 | VOID | real interpretation channel is EMPTY: nothing to restate | ✅ VOID (bad_reference) |
| 18 | VOID | real uncertainty channel is EMPTY: the named-limit channel has no payload here | ✅ VOID (bad_reference) |
| 19 | CONTRADICTION | zero contradictions surfaced anywhere on real evidence (incl. the same-subject signal pair: identical lineage = one chain) | ✅ [["facts",0],["observedSignals",0],["temporalSignals",0],["collectionFacts",0],["interpretations",0],["uncertainties",0],["explicitPreferences",0]] — _identical-lineage derivation is the exemption that fired on REAL data_ |

## Certified sentences (all of them)

- **[DERIVE]** “The archive records 3 for "totalPlays" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, totalWatches=3, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=3 for "behaviour-film" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "observedSignals[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90 for "behaviour-film" in the rolling_90d window (2026-06-21T10:22:53.741Z to 2026-09-19T10:22:53.741Z).”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"rolling_90d","startsAt":"2026-06-21T10:22:53.741Z","endsAt":"2026-09-19T10:22:53.741Z"} · rule restate.v1 · via "temporalSignals[0]"`
- **[DERIVE]** “The archive records never_matched=3 for "archive" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "collectionFacts[0]"`
- **[DERIVE]** “7 facts recorded in the all_ingested window.”  
  ↳ `status derived · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:count · via "facts[0]", "facts[1]", "facts[2]", "facts[3]", "facts[5]", "facts[6]", "facts[7]"`
- **[DERIVE]** “The archive records a total of 5 across 2 facts in the all_ingested window.”  
  ↳ `status derived · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:sum · via "facts[0]", "facts[2]"`
- **[DERIVE]** “2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film".”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:subjects · via "observedSignals[0]", "observedSignals[1]"`
- **[DERIVE]** “"hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery.”  
  ↳ `status unknown · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "facts[4]"`

## What the calculus legitimately derives from real evidence

- **Restatements** carry real metrics inside real envelopes (watchesLast90Days=2,
  totalWatches=3, never_matched=3, totalPlays=3) with status, scope lineage,
  and an inspectable derivation — never upgraded, never paraphrased.
- **Aggregation arithmetic** over real facts: counts and sums over non-unknown
  membership (7 facts recorded; total of 5 across 2 facts; one distinct subject).
- **Unknown ground** on the real surface (hoursWatched = null value) yields an
  absence-qualified conclusion floored at `unknown` — open, scoped, never
  smoothed upward.
## What remains void even with provenance-complete evidence

- Any positive claim whose membership includes the unknown fact (void_claim).
- As-of/windowed temporal claims: the real surface expresses windows as
  `coverage.{collectingSince,historicalCoverageStart}` plus
  `value.comparisonWindowDays`, which the 7.3 extractor does not anchor on —
  **lineage_incomplete by design** (boundaries found before patches; the
  extractor is unchanged in this slice).
- Trends (compareWindows): one real temporal signal cannot ground a comparison.
- The explicit-preference statement: its real provenance is
  `{source:"operator statement"}` — no lineage handles of any kind, so the
  lattice wall (lineage_incomplete) fires before any status question. The
  statement IS carried verbatim by transport; it cannot yet ground conclusions.
- Interpretations and uncertainties: channels exist in the contract but are
  EMPTY upstream today — nothing to restate or qualify against.
## Evidence classes still insufficient (the honest remainder)

1. **Temporal window identity on the real surface** — provenance-complete events,
   but window EXPRESSION differs from the extractor's anchor vocabulary;
   windowed claims wait on either surface-side window declaration or an owner-
   decided extractor mapping. Provenance established lineage, not windows.
2. **Preference-channel provenance** — explicit preference statements need
   handles (observationId / evidenceKey / observedAt family) before the lattice
   can ground anything on them; currently transport-only, correctly so.
3. **Interpretation & uncertainty payload** — upstream emits none today; the
   classes that carry "licensed inference" and "named limits" remain unfed.
