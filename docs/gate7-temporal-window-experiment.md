# Gate 7 — temporal-window downstream experiment

> **Date:** 2026-09-19 · **Prior base:** `05742a3` · **Upstream tip:** `3180bf9bc63c1cf755c0725c2fd1336b2c360460` (branch `arena/01a0b5e9-somesafeportablesoftware`)
> **Status:** downstream verification experiment, run exactly as ordered.
> No Arena machinery change was made. **The one-row delta did NOT occur
> under zero change; diagnosis below, stopped at smallest-fix report per
> the standing instruction. Implementation awaits owner decision.**

## Steps 1–4: the tree, verified

All four preconditions verified against the actual fetched tree, not reports:

1. **Commits reachable:** `git merge-base --is-ancestor` confirms `141c789`
   ("feat: expose temporal signal window bounds") and `3180bf9` ("fix: anchor
   temporal signal derivation") are ancestors of
   `origin/arena/01a0b5e9-somesafeportablesoftware`; `3180bf9` is the tip.
2. **OpenAPI exposes the window:** `lib/api-spec/openapi.yaml:1522-1534` —
   `TemporalSignalValue` REQUIRES `window: {$ref: TemporalWindow}`, and
   `TemporalWindow` is `{startsAt: string, endsAt: string}` required, with
   `additionalProperties: false`. Typed, closed, producer-authored. The
   meaning crossed the contract.
3. **Generated artifacts agree:** upstream `lib/api-zod` emits
   `interface TemporalWindow { startsAt: string; endsAt: string }` and
   `TemporalSignalValue.window: TemporalWindow`. Arena's own regenerated
   snapshot (`src/lib/personalisation/generated/`) carries the identical
   shape; `--check` is green.
4. **Runtime emits the bounds:** the 05742a3 capture harness re-run at
   `3180bf9` produced `recent_activity.value.window =
   {startsAt: "2026-06-21T11:16:29.301Z", endsAt: "2026-09-19T11:16:29.301Z"}`
   — an exact 90.0-day span — with the producer's single-anchor invariant
   holding live: **`derivedAt === value.window.endsAt`**, and
   `derivedAt`/`window.endsAt`/filter anchor now being one and the same
   instant (the producer passes its `now` into every write, upstream
   regression `archive-analytics.test.ts:157`). All metrics, counts,
   unknowns, and the constraint list are unchanged: 8 facts (one
   `hoursWatched: null`, `unknown`), 2 observed + 1 temporal + 1 collection
   signal, 0 interpretations, 0 uncertainties, 1 preference, 3 constraints.
   Only the temporal signal carries a window — the focused emission scope.

Arena-side revalidation per the new contract authority: pin retargeted
(`generate-personalisation-contract.mjs` defaults + authority comment),
generated `contract.ts`/`types.ts` regenerated from that exact tree,
Gate-6 wire fixtures given the now-REQUIRED `value.window` (as verbatim
data), pin-tracking assertions and Gate-7 test expectations that quote the
shared fixture's value blob updated to include it (restatement carried the
window — that *is* the verbatim covenant operating correctly). Suite:
**128/128** (+1 new contract-sanity Testament: TemporalWindow is closed,
required, producer-declared).

## Step 5–8: the experiment result

Ran the existing real-evidence battery **completely unmodified** (row
expectations exactly as at `05742a3`) against the new producer payload:

**19/19 PASS — with row 14 still `lineage_incomplete`.**

- Row 14 (temporal as-of claim): VOID, same kind as before.
- Rows 1–13, 15–19: semantically identical outcomes (row 6's restatement
  now contains `window={…}` *inside the verbatim metric text* — evidence
  of the field crossing the transport intact and being ignored at the
  calculus layer, not lost at the seam).
- Determinism pair: byte-identical within the run.
- Unknown stays floored at `unknown`; preference channel still
  `lineage_incomplete`; interpretation/uncertainty channels still empty
  (`bad_reference`); **trend still unavailable** (single temporal window —
  row 15, unchanged).

The hypothesis "the existing machinery accepts the new explicit window
with no Arena code change" is therefore **refuted by experiment** — the
driver's row-14 expectation (encoding the old verdict) still passes
because the old verdict still happens. The verifier stayed honest; reality
simply didn't move.

**Root diagnosis (the smallest true statement):** `extractWindow`
(`src/lib/archive-reasoning/windows.ts`) anchors exclusively on the
*Arena-internal* 7.3 evidence vocabulary — `coverage.label|window|startsAt|endsAt|windowDays`. Upstream placed its window at
`temporalSignals[].value.window`. The meaning IS now contract-declared
(typed, required, closed, runtime-emitted); the extractor's anchor set
simply predates the contract's declaration. This is a genuine
**extraction-vocabulary defect at the Gate-7 ingress edge** — not a
calculus defect (refusal without lineage still works exactly as designed),
and not an adapter defect (the adapter is a frozen verbatim projection —
tests #4/#5/#8 mandate it; teaching it to rename `value.window` into
coverage vocabulary would violate its foot-stamped testaments).

### Smallest required fix (report only — NOT implemented)

One guarded branch in `extractWindow`, evaluated as an additional
anchor alongside the existing coverage vocabulary: if the item carries a
producer-declared window object with string `startsAt`/`endsAt` that parse
to finite instants (and the producer's own field order), extract identity
`{startsAt, endsAt}` (+ `label` iff the producer ever declares one). Pure
identification of a contract-typed field — zero semantics manufacturing,
zero arithmetic beyond the existing DAY_MS convention (which this branch
does not need: the producer emits absolute bounds).

Predicted blast radius, marked before any keystroke:

- E2E battery row 14 flips to a certified `temporal_synthesis` claim whose
  window is the producer's own `[2026-06-21T11:16:29.301Z,
  2026-09-19T11:16:29.301Z]`, as-of the evidence's own `derivedAt`.
  Every other row: unchanged by design (row 15 trend-unavailable stays).
- One 7.3 Testament ("an item with no window material extracts nothing")
  must move its specimen from `coverage: {}` to a window-free value as
  well, since the canonical fixture legitimately carries the new field.
- Precedence question for the owner when both vocabularies coexist
  (Arena-internal fixtures have both today, and by construction they
  agree): coverage-declared material keeps priority (no existing
  Testament moves), producer-declared bounds fill the real-surface gap;
  a *disagreeing* pair is surfaced as conflict (never silently
  reconciled). This rule must be written down with the branch, whatever
  the owner chooses.
- No new conclusion kinds, no calculus semantics motion, no Gate-6
  adapter touch, no trend upgrades, no anything else.

If the owner rules the contrary — that the extractor's vocabulary is frozen
and the redress belongs upstream instead — this document stands as the
record that the current composition is the deliberate boundary. Either
verdict closes the question; the fog is gone.

## What was deliberately not done

No `windows.ts` edit. No `temporal.ts` edit. No adapter edit. No driver
expectation flip staged ahead of the machinery (the expectation change
belongs with the fix, or never). No recommendation, taste, ranking,
scoring, inference, or LLM surface touched at any point in this pass.

> *Meaning crossed the contract this time — typed, required, anchored by
> one clock. The extractor just hasn't been introduced to where it
> arrived.*

---

**Resolution (same day, owner verdict: extractor branch):** implemented
exactly as diagnosed — a strictly additive producer-window identification
branch in `extractWindow` with the dual-authority conflict rule
(coverage keeps priority on identical declarations; any disagreement is
a `void_claim` refusal, never reconciliation). Verified: row 14 flipped
to a certified bounded as-of claim over the producer's own window, every
other battery row unchanged, suite 131/131, adversarial 33/33, tsc/build
clean. Live ledger: `docs/e2e-gate7-real-evidence.md`.
