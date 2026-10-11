# Gate 7 — two-window seam: producer-side proposal (landing-ready, NOT implemented)

> **Status:** proposal only. Nothing here is implemented — not upstream,
> not in Arena. Owner decides whether to land the upstream change
> (co-authorship as with `141c789`/`3180bf9`/`4dcb2a0`); the downstream
> verification then re-runs against its real capture. Anchors below were
> verified against the `4dcb2a0` tree, not remembered.

## The gap this closes (one sentence)

`ebe5012` measured it: `compareWindows` addresses evidence *items*, one
window each; the real pack has `temporalSignals=1`, and **0** refs can
reach `value.previousWindow`. The fix with **zero Arena delta** is to
emit the previous observation as its own row. This document is that
delta, spelled exactly.

## The upstream delta (three files + tests + docs)

**1. Separate observation row — `artifacts/api-server/src/services/behavioral-intelligence.ts`**

Additional `insertSignal` alongside the current `recent_activity` row:

```text
signalType: "recent_activity_previous"
value: {
  title,                                  // same subject row convention
  watches: <count of events with viewed_at in [now-180d, now-90d)>,
  window:         { startsAt: now-180d, endsAt: now-90d },
  previousWindow: { startsAt: now-270d, endsAt: now-180d },
}
```

Rationales, all tree-verified:

- `signalType` is the honest distinguishing dimension: the
  `behavioral_signal` uniqueness key is
  `(owner, scope, profile, signal_type, subject_type, subject_identity)`
  (`insertSignal` ON CONFLICT) — a same-typed second row would overwrite
  the first. `profile` must NOT be the dimension (`recent` semantics); the
  subject must NOT differ (comparisons require one subject).
- `previousWindow` on the previous row is bounds-only (no count below
  180d): the schema REQUIRES the field, so it carries the adjacent
  bounds; the count for it is *unknown ground — present-but-unmeasured*,
  never interpolated. If depth-2 chains ever matter, the field is exactly
  where recursion would land.
- `watches` = "events counted within `value.window`" — metric anchored
  to the row's own window, no relative naming. This is the parity key.
- Provenance: same per-subject convention as today (the derivation basis
  is the same event set; C4 handles remain intact).
- Anchor: same injected `now` (all rows derived from one instant — the
  `3180bf9` invariant simply extends).

**2. Code deltas, smallest form (same service file)**

- `BehavioralSignalType` union gains `"recent_activity_previous"`.
- `readBehavioralSignals` evidenceClass map: `"recent_activity" |
  "recent_activity_previous"` → `temporal_signal`.
- `getPersonalisationContext` temporalSignals filter: include both types.
- Additive metric on the CURRENT row: `watches: recent90.length`
  (self-describing parity key; additive — required-fields unchanged).

**3. Schema shape — OpenAPI**

No structural delta is *required*: `value` is `additionalProperties: true`
(`watches` passes), and `signalType` is plain string. Recommended doc-level
only: one sentence in the `PersonalisationTemporalSignal` summary noting
that a subject's recent activity is emitted as a **pair** of rows
(current + previous). Generated artifacts regenerate unchanged except
provenance stamps.

**4. Tests + docs (producer-side)**

- Extend the existing regression ("rebuilds explainable…"): assert the
  second temporal row — `recent_activity_previous`, `watches: 1`,
  `window` half-open-adjacent to the current row's window, `derivedAt`
  shared anchor, `previousWindow` [now−270d, now−180d) bounds without a
  count, and the current row's parity `watches: 2`.
- `docs/arena-personalisation-input-adapter-contract.md` §10 language:
  note the pair-as-rows emission (the doc's "recent window boundaries and
  counts" line becomes literally true per-window-per-row).

## Arena delta: provably zero

- Contract: the snapshot ALREADY types both windows
  (`TemporalSignalValue [window, previousWindow]` required, closed) — the
  previous row validates as another `PersonalisationTemporalSignal` with
  no regeneration and no new field names.
- Extractor: `value.window` per item — already identified verbatim.
- Calculus: `compareWindows(metricKey: "watches")` over the two members —
  existing arithmetic (per-window values, pairwise non-overlap by
  interval, adjacent-delta relation, sorted by window start, envelope
  span `[previous.start, current.end]`).
- Contradictions lane: same subject, non-overlapping windows → "both
  stand" skip — no movement (pattern already green on personas).
- The new conclusion fully satisfies the owner's retention list: both
  windows (perWindow), both evidence references, metric key, explicit
  relation (`greater`/`less`/`equal` + delta — no adjectives), ceiling
  `derived`, caller-declared scope, deterministic rule
  `temporal.compare.v1:watches`, lineage loadBearing both refs.
- Predicted driver movement, pre-registered for the next verification
  run: INGRESS counts `temporalSignals: 1→2`; the FINDING row flips
  (`refs→previousWindow: 0→1`) and is re-aimed to assert the pair is
  reachable; a NEW certified row `compareWindows([previous, current],
  "watches")` with `perWindow` windows verbatim from refs and `delta=+1,
  relation=greater` under the real capture; row 15's within-one-row
  refusal is retired (two real rows exist — replaced by the positive
  path); row 28 singleton still `lineage_incomplete`; every other row
  byte-identical, determinism pair included.

## Seam-level capability proof (synthetic dress rehearsal, already landed)

The "Arena delta: none" claim above is demonstrated at seam level, not
inferred, in `docs/gate7-two-window-capability-probe.md` — 13/13 checks,
`scripts/e2e-gate7-capability-probe.mjs` against lab persona `g7cap`
(SYNTHETIC; NOT real evidence) emitting exactly this emission shape
through the genuine seam: lab → read-only client → generated-contract
validation → Gate-6 normalize → lattice → `compareWindows` → renderer.
All owner retention items survived: both declared windows verbatim, both
refs load-bearing, parity-key values, arithmetic delta/relation, derived
status, explicit scope, deterministic rule, byte-stable lineage, renderer
vocabulary-clean. Regressions held at the same commit (suite 131/131,
real-evidence 32/32, adversarial 33/33). Post-landing, that same
demonstration is re-run against producer-authored evidence per the
pre-registered movement above.

## Owner decision points

1. **Bounds-only deeper window:** carry `previousWindow` [now−270d,
   now−180d) **without** a count (recommended; schema requires the
   field, unknown stays unknown) — versus emitting a third counted
   window now (rejected: no consumer need, scope creep).
2. **Parity key naming:** `watches` (recommended — window-anchored,
   self-describing, vocabulary already used in persona/adversarial
   shaped evidence) — versus any other single shared numeric key. Both
   rows must use the same one.
3. **Row-identity dimension:** `recent_activity_previous` signalType
   (recommended, tree-checked) — alternatives (profile/subject) are
   semantically wrong and would break the comparison's one-subject rule.

## Explicitly unchanged / out of scope

No Arena machinery, calculus, adapter, extractor, renderer, provenance,
testament, or conclusion-kind change. No upstream edits until the owner
lands them. No recommendation, taste, ranking, scoring, inference,
embeddings, model calls, feedback. The renderer still only speaks what
was already earned; after landing, it speaks exactly one more earned
thing: a two-window comparison over producer-declared windows.
