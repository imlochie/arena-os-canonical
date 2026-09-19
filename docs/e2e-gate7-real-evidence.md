# Gate 7 — first real-evidence reasoning pass

> **Date:** 2026-09-19 · **Base commit:** `67822dd` · **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-real-evidence-driver.mjs` · **Verdict:** **PASS** (32/32)
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
| 2 | INGRESS | real provenance arrives intact through the seam | ✅ observationIds=4 evidenceKeys=4 ingestionBatchIds=["manual-cd159f07-ee2b-4f63-9923-a3d2c020c88d"] eventOccurredAt=4 observedAt=4 scope=plex:movies-v1 |
| 3 | INGRESS | the surface carries its own constraints and they cross verbatim | ✅ ["Signals are observations, not likes or preferences","No universal taste score","No recommendation decision is made here"] — _the producer tells the seam what is not licensed; preservation keeps that_ |
| 4 | DERIVE | restate real observed fact (totalPlays) | ✅ CERTIFIED status=observed statement="The archive records 4 for "totalPlays" in the all_ingested window." — _certificate carried_ |
| 5 | DERIVE | restate real long-term signal with full provenance behind it | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, totalWatches=4, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=4 for "behaviour-film" in the all_ingested window." — _certificate carried_ |
| 6 | DERIVE | restate real temporal signal inside a caller-declared evidence window | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, watchesPrevious90Days=1, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…}, previousWindow={…} for "behaviour-film" in the rolling_90d window (2026-06-21T12:20:41.670Z to 2026-09-19T12:20:41.670Z)." — _certificate carried_ |
| 7 | DERIVE | restate real collection fact | ✅ CERTIFIED status=derived statement="The archive records never_matched=4 for "archive" in the all_ingested window." — _certificate carried_ |
| 8 | DERIVE | count the non-unknown facts as real arithmetic | ✅ CERTIFIED status=derived statement="7 facts recorded in the all_ingested window." — _certificate carried_ |
| 9 | DERIVE | sum real numeric facts | ✅ CERTIFIED status=derived statement="The archive records a total of 7 across 2 facts in the all_ingested window." — _certificate carried_ |
| 10 | DERIVE | enumerate real subjects over both observed signals | ✅ CERTIFIED status=derived statement="2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film"." — _certificate carried_ |
| 11 | DERIVE | unknown ground stays unknown on the REAL surface (hoursWatched = null value) | ✅ CERTIFIED status=unknown statement=""hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 12 | DERIVE | real evidence replays byte-identically (no clocks in the calculus) | ✅ byte-stable |
| 13 | EXTRACT | two-window row: extractor identifies the CURRENT window verbatim; previousWindow crosses as data, not an invented identity | ✅ extracted=[2026-06-21T12:20:41.670Z .. 2026-09-19T12:20:41.670Z], carried previousWindow=[2026-03-23T12:20:41.670Z .. 2026-06-21T12:20:41.670Z] — _identification only; nothing reconstructed from derivedAt or comparisonWindowDays_ |
| 14 | FINDING | SEMANTIC GAP: compareWindows members point at items, one window per item; no ref can address value.previousWindow inside the single real row | ✅ temporalSignals=1; refs whose extracted window equals the declared previousWindow: 0 — _producer meaning fully declared AND fully preserved — upstream models two windows inside one row; documented, not patched_ |
| 15 | VOID | previous-vs-current over the single existing ref is refused for identity overlap (no pair interpretation from one row) | ✅ VOID (void_claim) |
| 16 | NEGATIVE | overlapping windows still refuse a comparison | ✅ VOID (void_claim) |
| 17 | NEGATIVE | identical windows across two rows refuse (identity overlap, never a trend out of a re-statement) | ✅ VOID (void_claim) |
| 18 | NEGATIVE | missing previousWindow on a real row: the contract must refuse | ✅ REFUSED at ingress: Archive Assistant response violates the PersonalisationContext contract at temporalSignals[0].value: missing required pr |
| 19 | NEGATIVE | missing window on a real row: the contract must refuse | ✅ REFUSED at ingress: Archive Assistant response violates the PersonalisationContext contract at temporalSignals[0].value: missing required pr |
| 20 | NEGATIVE | malformed bounds: contract types permit strings, calculus refuses formation downstream | ✅ VOID (lineage_incomplete) |
| 21 | NEGATIVE | mismatched scopes across members refuse the comparison | ✅ VOID (void_claim) |
| 22 | NEGATIVE | unknown load-bearing metric refuses (no interpolation ever) | ✅ VOID (void_claim) |
| 23 | NEGATIVE | missing lineage on a member refuses the conclusion | ✅ VOID (lineage_incomplete) |
| 24 | NEGATIVE | contradictory window declarations refuse (conflict propagates through comparison) | ✅ VOID (void_claim) |
| 25 | NEGATIVE | single-window temporal evidence refuses a comparison outright | ✅ VOID (lineage_incomplete) |
| 26 | VOID | including an unknown fact in a positive aggregate kills the whole claim | ✅ VOID (void_claim) |
| 27 | DERIVE | real producer-declared window licenses a bounded as-of claim (identification, not reconstruction) | ✅ window=[2026-06-21T12:20:41.670Z .. 2026-09-19T12:20:41.670Z] asOf=2026-09-19T12:20:41.670Z span=90d status=derived rule=temporal.asof.v1 — _the window arrived typed and declared upstream; the extractor copied the strings_ |
| 28 | VOID | one real temporal signal cannot ground a trend | ✅ VOID (void_claim) |
| 29 | VOID | real explicit preference statement is not handled enough to ground a conclusion | ✅ VOID (lineage_incomplete) |
| 30 | VOID | real interpretation channel is EMPTY: nothing to restate | ✅ VOID (bad_reference) |
| 31 | VOID | real uncertainty channel is EMPTY: the named-limit channel has no payload here | ✅ VOID (bad_reference) |
| 32 | CONTRADICTION | zero contradictions surfaced anywhere on real evidence (incl. the same-subject signal pair: identical lineage = one chain) | ✅ [["facts",0],["observedSignals",0],["temporalSignals",0],["collectionFacts",0],["interpretations",0],["uncertainties",0],["explicitPreferences",0]] — _identical-lineage derivation is the exemption that fired on REAL data_ |

## Certified sentences (all of them)

- **[DERIVE]** “The archive records 4 for "totalPlays" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, totalWatches=4, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=4 for "behaviour-film" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "observedSignals[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, watchesLast30Days=1, watchesLast90Days=2, watchesPrevious90Days=1, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…}, previousWindow={…} for "behaviour-film" in the rolling_90d window (2026-06-21T12:20:41.670Z to 2026-09-19T12:20:41.670Z).”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"rolling_90d","startsAt":"2026-06-21T12:20:41.670Z","endsAt":"2026-09-19T12:20:41.670Z"} · rule restate.v1 · via "temporalSignals[0]"`
- **[DERIVE]** “The archive records never_matched=4 for "archive" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "collectionFacts[0]"`
- **[DERIVE]** “7 facts recorded in the all_ingested window.”  
  ↳ `status derived · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:count · via "facts[0]", "facts[1]", "facts[2]", "facts[3]", "facts[5]", "facts[6]", "facts[7]"`
- **[DERIVE]** “The archive records a total of 7 across 2 facts in the all_ingested window.”  
  ↳ `status derived · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:sum · via "facts[0]", "facts[2]"`
- **[DERIVE]** “2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film".”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule aggregate.v1:subjects · via "observedSignals[0]", "observedSignals[1]"`
- **[DERIVE]** “"hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery.”  
  ↳ `status unknown · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule qualify.v1 · via "facts[4]"`

## What the calculus legitimately derives from real evidence

- **Restatements** carry real metrics inside real envelopes (watchesLast90Days=2,
  totalWatches=4, never_matched=4, totalPlays=4) with status, scope lineage,
  and an inspectable derivation — never upgraded, never paraphrased.
- **Aggregation arithmetic** over real facts: counts and sums over non-unknown
  membership (7 facts recorded; total of 7 across 2 facts; one distinct subject).
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
## Two-window evidence (upstream 4dcb2a0): verification verdict

**SEMANTIC GAP (documented, not patched).** The producer's two windows are
fully declared — typed, REQUIRED, single-anchored, half-open non-overlapping
(see the EXTRACT row: bounds verbatim, `previousWindow.endsAt ===
window.startsAt`) — and they crossed the entire seam intact. Gate 7's
comparison rule is ≥2 evidence ITEMS with one extractable window each;
upstream models the pair inside ONE row. The FINDING row shows no evidence
ref in the real pack can address `value.previousWindow` — no extractor fix
of the 2cc6f6c class can bridge that, because `extractWindow` recognizes the
declared shape fine; it is the evidence-unit mismatch (row-vs-window) that
blocks membership, upstream's modelling choice. The calculus itself is
provably capable when comparisons arrive as two items (the adversarial
battery exercises exactly that pattern). Smallest seams, ranked:
1. **producer-side**: emit the previous observation as its own row (a
   distinguishing row-identity dimension is required — the signal-row
   uniqueness key is (owner, scope, profile, type, subject) — plus a shared
   per-row numeric metric key for the existing compareWindows arithmetic);
2. **Arena-side** (rejected for now): extend evidence addressing with an
   explicit declared-window channel — real machinery surgery across
   EvidenceRef/resolve/lineage for zero new licensed meaning.
No fix implemented; verification-only slice per directive. The 10-case
negative battery confirms no wall moved: overlap/identity/missing/
malformed/scope/unknown/lineage/conflict/singleton all still refuse.

