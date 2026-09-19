# Gate 7 — first real-evidence reasoning pass

> **Date:** 2026-09-19 · **Base commit:** `a3acf0e` · **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-real-evidence-driver.mjs` · **Verdict:** **PASS** (37/37)
>
> **The question** (Gate 7's own, finally not hypothetical): given real
> provenance-backed evidence, what is Arena actually permitted to conclude?

## Evidence provenance

The payload at `scripts/fixtures/real-evidence-upstream-capture.json` is the
actual JSON upstream's runtime emitted — `getPersonalisationContext()` at
`imlochie/SomeSafePortablesoftware@8e54a283c392c53f64099a903b293de220e565ce`,
seeded with the exact events of upstream's own regression test ("rebuilds
explainable recent, long-term, rewatch, scope, and explicit signals"), derived
as-of 2026-09-19T00:00:00.000Z. It is not a fixture Arena designed: Arena captured
it, validated it, and dropped it through the real seam (dev-replay HTTP server
→ read-only generated-operation client → generated-contract validation →
normalize → lattice → calculus → renderer).

## Checks

| # | Class | Check | Outcome |
|---|-------|-------|---------|
| 1 | INGRESS | real payload validates against the regenerated contract and normalizes verbatim | ✅ {"facts":8,"observedSignals":2,"temporalSignals":2,"collectionFacts":1,"interpretations":0,"uncertainties":0,"explicitPreferences":2} |
| 2 | INGRESS | real provenance arrives intact through the seam (current row: its own 2 window events, not the whole history) | ✅ observationIds=2 evidenceKeys=2 ingestionBatchIds=["manual-0013acd8-4bf8-4b4c-823b-accd0abbf824"] eventOccurredAt=2 observedAt=2 scope=plex:movies-v1 |
| 3 | INGRESS | previous row carries its own provenance chain (1 window event, same anchor, complete family) | ✅ observationIds=1 evidenceKeys=1 scope=plex:movies-v1 derivedAt=2026-09-19T14:32:17.103Z |
| 4 | INGRESS | the surface carries its own constraints and they cross verbatim | ✅ ["Signals are observations, not likes or preferences","No universal taste score","No recommendation decision is made here"] — _the producer tells the seam what is not licensed; preservation keeps that_ |
| 5 | DERIVE | restate real observed fact (totalPlays) | ✅ CERTIFIED status=observed statement="The archive records 4 for "totalPlays" in the all_ingested window." — _certificate carried_ |
| 6 | DERIVE | restate real long-term signal with full provenance behind it | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, totalWatches=4, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=4 for "behaviour-film" in the all_ingested window." — _certificate carried_ |
| 7 | DERIVE | restate real temporal signal inside a caller-declared evidence window | ✅ CERTIFIED status=derived statement="The archive records title=behaviour-film, watches=2, watchesLast30Days=1, watchesLast90Days=2, watchesPrevious90Days=1, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…} for "behaviour-film" in the rolling_90d window (2026-06-21T14:32:17.103Z to 2026-09-19T14:32:17.103Z)." — _certificate carried_ |
| 8 | DERIVE | restate real collection fact | ✅ CERTIFIED status=derived statement="The archive records never_matched=4 for "archive" in the all_ingested window." — _certificate carried_ |
| 9 | DERIVE | count the non-unknown facts as real arithmetic | ✅ CERTIFIED status=derived statement="7 facts recorded in the all_ingested window." — _certificate carried_ |
| 10 | DERIVE | sum real numeric facts | ✅ CERTIFIED status=derived statement="The archive records a total of 7 across 2 facts in the all_ingested window." — _certificate carried_ |
| 11 | DERIVE | enumerate real subjects over both observed signals | ✅ CERTIFIED status=derived statement="2 observed signals covering 1 distinct subject in the all_ingested window: "behaviour-film"." — _certificate carried_ |
| 12 | DERIVE | unknown ground stays unknown on the REAL surface (hoursWatched = null value) | ✅ CERTIFIED status=unknown statement=""hours watched: duration evidence insufficient for a single number" remains open — no positive evidence is available within scope archive in this evidence delivery." — _certificate carried_ |
| 13 | DERIVE | real evidence replays byte-identically (no clocks in the calculus) | ✅ byte-stable |
| 14 | PREFERENCE | canonical preference provenance crosses the seam verbatim (all 8 public fields; closed 4-key provenance attached) | ✅ preferenceId=1 source=operator_statement observedAt=2026-09-18T12:00:00.000Z scope=plex:movies-v1 statement="I am into Japanese cinema right now." — _preferenceId / operator_statement / observedAt / scopeIdentity / subjectType / subjectIdentity / statement — no relabelling, no behavioural handles_ |
| 15 | PREFERENCE | legacy preference crosses as legacy: status + null, never replaced with a synthetic object | ✅ provenanceStatus=legacy provenance=null statement="Legacy statement" observedAt=2020-01-01T00:00:00.000Z — _null provenance preserved verbatim through transport and normalization_ |
| 16 | PREFERENCE | preference provenance named only as preference provenance — no event/batch lineage attached, owner unexposed | ✅ provenance.keys=preferenceId,source,observedAt,scopeIdentity; owner-field present: false — _statement-level provenance is not converted into behavioural provenance_ |
| 17 | EXTRACT | two temporal rows: each extractor identifies its own window verbatim; adjacency prev.endsAt==curr.startsAt read, never reconstructed | ✅ prev extracted=[2026-03-23T14:32:17.103Z .. 2026-06-21T14:32:17.103Z] \| curr extracted=[2026-06-21T14:32:17.103Z .. 2026-09-19T14:32:17.103Z] — _identification only; nothing reconstructed from derivedAt or comparisonWindowDays_ |
| 18 | FINDING | GAP CLOSED by producer emission (unchanged calculus): the previous observation now has its own ref — the pair is reachable vocabul | ✅ temporalSignals=2; refs whose extracted window equals the declared previous window: 1 — _evidence unit moved from 1-row-2-windows to 2-rows-1-window-each; the addressing vocabulary was always sufficient_ |
| 19 | DERIVE | certified two-window trend over REAL producer evidence: prev vs curr by the parity key, exact arithmetic | ✅ perWindow=[prev@(2026-03-23T14:32:17.103Z -> 1), curr@(2026-06-21T14:32:17.103Z -> 2)] delta=1 relation=greater — _delta/relation are arithmetic over parity-key values; no adjective, no interpretation_ |
| 20 | DERIVE | trend replays byte-identically (claim JSON stable across recomputation) | ✅ claim-stable=true — _textual, not aliasing: comparison is its own claim identity_ |
| 21 | NEGATIVE | overlapping windows still refuse a comparison | ✅ VOID (void_claim) |
| 22 | NEGATIVE | identical windows across two rows refuse (identity overlap, never a trend out of a re-statement) | ✅ VOID (void_claim) |
| 23 | NEGATIVE | missing window on a real row: the contract must refuse | ✅ REFUSED at ingress: Archive Assistant response violates the PersonalisationContext contract at temporalSignals[0].value: missing required pr |
| 24 | NEGATIVE | missing previousWindow on a real row: the contract must accept (new producer shape) | ✅ ACCEPTED at ingress (schema-required = [window] only) |
| 25 | NEGATIVE | malformed bounds: contract types permit strings, calculus refuses formation downstream | ✅ VOID (lineage_incomplete) |
| 26 | NEGATIVE | mismatched scopes across members refuse the comparison | ✅ VOID (void_claim) |
| 27 | NEGATIVE | unknown load-bearing metric refuses (no interpolation ever) | ✅ VOID (void_claim) |
| 28 | NEGATIVE | missing lineage on a member refuses the conclusion | ✅ VOID (lineage_incomplete) |
| 29 | NEGATIVE | contradictory window declarations refuse (conflict propagates through comparison) | ✅ VOID (void_claim) |
| 30 | NEGATIVE | single-window temporal evidence refuses a comparison outright | ✅ VOID (lineage_incomplete) |
| 31 | VOID | including an unknown fact in a positive aggregate kills the whole claim | ✅ VOID (void_claim) |
| 32 | DERIVE | real producer-declared window licenses a bounded as-of claim (identification, not reconstruction) | ✅ window=[2026-06-21T14:32:17.103Z .. 2026-09-19T14:32:17.103Z] asOf=2026-09-19T14:32:17.103Z span=90d status=derived rule=temporal.asof.v1 — _the window arrived typed and declared upstream; the extractor copied the strings_ |
| 33 | VOID | identity overlap still refuses as a negative construct (twin of one ref, never a pair from one row) | ✅ VOID (void_claim) |
| 34 | VOID | real explicit preference statement is not handled enough to ground a conclusion | ✅ VOID (lineage_incomplete) |
| 35 | VOID | real interpretation channel is EMPTY: nothing to restate | ✅ VOID (bad_reference) |
| 36 | VOID | real uncertainty channel is EMPTY: the named-limit channel has no payload here | ✅ VOID (bad_reference) |
| 37 | CONTRADICTION | zero contradictions surfaced anywhere on real evidence (incl. the same-subject signal pair: identical lineage = one chain) | ✅ [["facts",0],["observedSignals",0],["temporalSignals",0],["collectionFacts",0],["interpretations",0],["uncertainties",0],["explicitPreferences",0]] — _identical-lineage derivation is the exemption that fired on REAL data_ |

## Certified sentences (all of them)

- **[DERIVE]** “The archive records 4 for "totalPlays" in the all_ingested window.”  
  ↳ `status observed · scope archive · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "facts[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, totalWatches=4, firstWatchedAt=2020-01-01T10:00:00.000Z, lastWatchedAt=2026-09-01T10:00:00.000Z, activeMonths=4 for "behaviour-film" in the all_ingested window.”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"all_ingested","startsAt":null,"endsAt":null} · rule restate.v1 · via "observedSignals[0]"`
- **[DERIVE]** “The archive records title=behaviour-film, watches=2, watchesLast30Days=1, watchesLast90Days=2, watchesPrevious90Days=1, lastWatchedAt=2026-09-01T10:00:00.000Z, comparisonWindowDays=90, window={…} for "behaviour-film" in the rolling_90d window (2026-06-21T14:32:17.103Z to 2026-09-19T14:32:17.103Z).”  
  ↳ `status derived · scope plex:movies-v1 · window {"label":"rolling_90d","startsAt":"2026-06-21T14:32:17.103Z","endsAt":"2026-09-19T14:32:17.103Z"} · rule restate.v1 · via "temporalSignals[0]"`
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
- **[DERIVE]** “"behaviour-film": watches was 1 in the window from 2026-03-23T14:32:17.103Z to 2026-06-21T14:32:17.103Z and 2 in the window from 2026-06-21T14:32:17.103Z to 2026-09-19T14:32:17.103Z; the later window is greater by 1.”  
  ↳ `temporal.compare.v1:watches`

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
- Trends (compareWindows) with fewer than two real temporal rows: singleton
- The explicit-preference statement: since 1a2200b it carries a closed
  canonical provenance (preferenceId / operator_statement / observedAt /
  scopeIdentity) — statement-level identity, NOT behavioural lineage
  handles — so the lattice wall (lineage_incomplete) still fires, by
  design, before any status question. The statement AND its provenance
  are carried verbatim by transport; neither yet grounds conclusions.
- Interpretations and uncertainties: channels exist in the contract but are
  EMPTY upstream today — nothing to restate or qualify against.
## Evidence classes still insufficient (the honest remainder)

1. **Preference-channel behavioural grounding** — upstream explicitly does
   NOT attach watch-event lineage handles to preferences (verified at
   1a2200b: no evidenceKey / observationId / eventId / ingestionBatchId on
   the preference record); under the existing lattice, therefore, no
   conclusion forms. Under current rules this is the correct void: a
   statement's identity is not evidence of behaviour.
2. **Interpretation & uncertainty payload** — upstream emits none today; the
   classes that carry "licensed inference" and "named limits" remain unfed.

*(Temporal window identity WAS class #1 here; it is resolved — see above.)*
## Two-window evidence (upstream 8e54a28): verification verdict

**VERIFIED.** The seam proposal (docs/gate7-two-window-seam-proposal.md)
landed upstream at `8e54a283c392c53f64099a903b293de220e565ce` ("Emit
separate previous temporal evidence row"): the previous observation is now
its own row (`recent_activity_previous`) with its own window, the parity
key `watches` on both rows, one producer anchor (`derivedAt` = current
window `endsAt`), rows emitted only for non-empty windows, per-row event
evidence. Historical record of the pre-landing verdict (SEMANTIC GAP at
4dcb2a0): docs/gate7-two-window-verification.md. On this capture, the
DERIVE rows show the full loop closing with zero Arena change: each window
identified verbatim from its own row (adjacent: `prev.endsAt === curr.startsAt`,
read, never reconstructed), the unchanged `compareWindows("watches")` pair
certifies `delta=+1 / relation="greater"` (prev 1 → curr 2) with both rows
load-bearing, scope intact, envelope spanning prev→curr, byte-identical
replay, and the renderer speaking exactly the earned arithmetic. The
refusal class: retired as within-one-row (two real rows now); preserved
as the twin-construct negative, which still fails closed. No Arena
machinery, extractor, calculus, renderer, or conclusion-kind moved in this
slice — producer emission alone resolved the evidence unit.

