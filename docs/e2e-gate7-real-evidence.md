# Gate 7 — first real-evidence reasoning pass

> **Date:** 2026-09-19 · **Base commit:** `3d7f104` · **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-real-evidence-driver.mjs` · **Verdict:** **PASS** (19/19)
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
| 2 | INGRESS | real provenance arrives intact through the seam | ✅ observationIds=3 evidenceKeys=3 ingestionBatchIds=["manual-d0c074c2-9b13-4474-9935-50e54af7d516"] eventOccurredAt=3 observedAt=3 scope=plex:movies-v1 |
| 3 | INGRESS | the surface carries its own constraints and they cross verbatim | ✅ ["Signals are observations, not likes or preferences","No universal taste score","No recommendation decision is made here"] — _the producer tells the seam what is not licensed; preservation keeps that_ |
| 4 | DERIVE | restate real observed fact (totalPlays) | ✅ CERTIFIED status=observed statement="The archive records 3 for "totalPlays" in the all_ingested window." — _certificate carried_ |
| 5 | DERIVE | restate real long-term signal with full provenance behind it | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, totalWatches=3, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=3 for "behaviour-film" in the all_ingested window." — _certificate carried_ |
| 6 | DERIVE | restate real temporal signal inside a caller-declared evidence window | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…} for "behaviour-film" in the rolling_90d window (2026-06-21T11:16:29.301Z to 2026-09-19T11:16:29.301Z)." — _certificate carried_ |
| 7 | DERIVE | restate real collection fact | ✅ CERTIFIED status=derived statement="The archive records never_matched=3 for "archive" in the all_ingested window." — _certificate carried_ |
| 8 | DERIVE | count the non-unknown facts as real arithmetic | ✅ CERTIFIED status=derived statement="7 facts recorded in the all_ingested window." — _certificate carried_ |
| 9 | DERIVE | sum real numeric facts | ✅ CERTIFIED status=derived statement="The archive records a total of 5 across 2 facts in the all_ingested window." — _certificate carried_ |
| 10 | DERIVE | enumerate real subjects over both observed signals | ✅ CERTIFIED status=derived statement="2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film"." — _certificate carried_ |
| 11 | DERIVE | unknown ground stays unknown on the REAL surface (hoursWatched = null value) | ✅ CERTIFIED status=unknown statement=""hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 12 | DERIVE | real evidence replays byte-identically (no clocks in the calculus) | ✅ byte-stable |
| 13 | VOID | including an unknown fact in a positive aggregate kills the whole claim | ✅ VOID (void_claim) |
| 14 | DERIVE | real producer-declared window licenses a bounded as-of claim (identification, not reconstruction) | ✅ window=[2026-06-21T11:16:29.301Z .. 2026-09-19T11:16:29.301Z] asOf=2026-09-19T11:16:29.301Z span=90d status=derived rule=temporal.asof.v1 — _the window arrived typed and declared upstream; the extractor copied the strings_ |
| 15 | VOID | one real temporal signal cannot ground a trend | ✅ VOID (void_claim) |
| 16 | VOID | real explicit preference statement is not handled enough to ground a conclusion | ✅ VOID (lineage_incomplete) |
| 17 | VOID | real interpretation channel is EMPTY: nothing to restate | ✅ VOID (bad_reference) |
| 18 | VOID | real uncertainty channel is EMPTY: the named-limit channel has no payload here | ✅ VOID (bad_reference) |
| 19 | CONTRADICTION | zero contradictions surfaced anywhere on real evidence (incl. the same-subject signal pair: identical lineage = one chain) | ✅ [["facts",0],["observedSignals",0],["temporalSignals",0],["collectionFacts",0],["interpretations",0],["uncertainties",0],["explicitPreferences",0]] — _identical-lineage derivation is the exemption that fired on REAL data_ |

## Certified sentences (all of them)

- **[DERIVE]** “The archive records 3 for "totalPlays" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, totalWatches=3, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=3 for "behaviour-film" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "observedSignals[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…} for "behaviour-film" in the rolling_90d window (2026-06-21T11:16:29.301Z to 2026-09-19T11:16:29.301Z).”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"rolling_90d","startsAt":"2026-06-21T11:16:29.301Z","endsAt":"2026-09-19T11:16:29.301Z"} · rule restate.v1 · via "temporalSignals[0]"`
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
## The frontier that resolved in this slice

The first real-evidence pass (05742a3) found the temporal-window frontier:
the real surface expressed windows as coverage-era fields plus an untyped
comparisonWindowDays — nothing the 7.3 extractor could anchor on. The seam
investigation (docs/gate7-temporal-window-seam.md) ruled the meaning existed
producer-side but wasn't crossing the contract; the downstream experiment
(docs/gate7-temporal-window-experiment.md) then proved the meaning arrived
(contract-typed, required, single-anchored) while the extractor still could
not see it. The verdict: extractor branch, strictly additive. Row "real
producer-declared window licenses a bounded as-of claim" is the flip:
identification of value.window, bounds verbatim, span = the producer's own
90d, asOf = the evidence's own derivedAt (= window.endsAt, single anchor).
## What remains void even with provenance-complete evidence

- Any positive claim whose membership includes the unknown fact (void_claim).
- Trends (compareWindows): one real temporal signal cannot ground a comparison.
- The explicit-preference statement: its real provenance is
  `{source:"operator statement"}` — no lineage handles of any kind, so the
  lattice wall (lineage_incomplete) fires before any status question. The
  statement IS carried verbatim by transport; it cannot yet ground conclusions.
- Interpretations and uncertainties: channels exist in the contract but are
  EMPTY upstream today — nothing to restate or qualify against.
## Evidence classes still insufficient (the honest remainder)

1. **Preference-channel provenance** — explicit preference statements need
   handles (observationId / evidenceKey / observedAt family) before the lattice
   can ground anything on them; currently transport-only, correctly so.
2. **Interpretation & uncertainty payload** — upstream emits none today; the
   classes that carry "licensed inference" and "named limits" remain unfed.

*(Temporal window identity WAS class #1 here; it is resolved — see above.)*
