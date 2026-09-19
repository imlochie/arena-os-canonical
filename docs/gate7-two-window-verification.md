# Gate 7 — two-window temporal evidence verification

> **Date:** 2026-09-19 · **Directive:** verification-only downstream
> experiment (no Gate-7 redesign before an answer). Battery trace:
> `docs/e2e-gate7-real-evidence.md` (32/32).

## 1. Authoritative upstream ref

- **commit:** `4dcb2a0183bb5d5a9f59a3b8c8f24e71037d62c7`
  ("Evolve archive temporal evidence to two windows"), verified reachable
  from the authoritative branch (`git merge-base --is-ancestor` — tree
  verified, not a report).
- **branch:** `arena/01a0b5e9-somesafeportablesoftware` (tip).
- **contract source:** `lib/api-spec/openapi.yaml` at that tree —
  `TemporalSignalValue` now **requires** `[window, previousWindow]`, both
  `TemporalWindow {startsAt, endsAt}` (closed). Upstream zod/TS agree;
  Arena's regenerated snapshot carries the same; `--check` green. No
  manual contract edits: the diff is exactly the upstream delta.

## 2. Evidence captured (real producer runtime, verbatim)

Same capture discipline as `05742a3`: upstream's own pipeline, seed
synced to upstream's own regression test (which now includes its
previous-window event `behaviour-previous @ 2026-05-01T10:00:00.000Z`),
capturing `getPersonalisationContext()` at `4dcb2a0`. Pinned at
`scripts/fixtures/real-evidence-upstream-capture.json`.

```
previous:
  startsAt: 2026-03-23T12:20:41.670Z
  endsAt:   2026-06-21T12:20:41.670Z   (== current.startsAt — half-open, touching)
current:
  startsAt: 2026-06-21T12:20:41.670Z
  endsAt:   2026-09-19T12:20:41.670Z   (== derivedAt — single anchor holds live)
previous count: watchesPrevious90Days = 1
current count:  watchesLast90Days = 2   (watchesLast30Days = 1; comparisonWindowDays = 90)
derivedAt:      2026-09-19T12:20:41.670Z
scope:          plex:movies-v1
```

Span check: both exactly 90.0 days; `previousWindow.endsAt ===
window.startsAt` ⇒ genuinely **non-overlapping** under the machinery's
interval test. Provenance arrays now 4-deep (the synced seed's fourth
event), intact end-to-end.

## 3. Seam result

| Layer | Survived? |
|---|---|
| transport (dev-replay HTTP → read-only client) | ✅ |
| contract validation (REQUIRED two-window enforced — rows 18/19 prove the *refusal* direction too) | ✅ |
| Gate-6 normalization (verbatim, frozen) | ✅ |
| window extraction — CURRENT window identified verbatim (EXTRACT row 13); `previousWindow` crosses as carried data | ✅ |
| calculus — everything legal with existing refs (as-of claim row 27; no new kind anywhere) | ✅ |
| renderer — statements carry both counts/window material verbatim | ✅ |

Nothing was bypassed; no special adapter; no handcrafted trend call.

## 4. Gate 7 verdict: **SEMANTIC GAP**

(C), documented — not patched, per directive.

**What exists:** two fully producer-declared windows with per-window
counts, sharing one anchor, verifiably non-overlapping — precisely the
material a trend needs.

**What Gate 7 requires (existing rule, unchanged):** `compareWindows`
members are **evidence ITEM refs**, one extractable window per item,
same subject, pairwise non-overlapping.

**What existing machinery lacks:** a way to *address* the second
declared window inside one row. The FINDING row measured it: the real
pack has `temporalSignals=1`; refs whose extracted window equals the
declared `previousWindow`: **0**. So not Outcome B — this is not a
mis-shaped vocabulary the extractor missed (it recognizes
`value.window` perfectly and identifies it verbatim). It is an
**evidence-unit mismatch**: upstream models *two windows inside one
row*; the calculus addresses windows *per row*. No faithful-extraction
patch can bridge that without changing the evidence-addressing model
(the calculus is otherwise provably capable — the adversarial battery
exercises the two-item comparison pattern green).

**Why reconstruction is refused:** anything like "previous := current −
90d" from `derivedAt`/`comparisonWindowDays`/`firstWatchedAt` is Arena
manufacturing window identity — §9 ("identify, never upgrade") and the
directive's explicit blacklist. `extractWindow` was instead given
nothing new: the previous window stays *carried evidence data* (row 13),
never an invented identity.

**Negative battery (10/10 refusing — no wall moved by the two-window
surface):** overlapping → `void_claim`; identical windows → `void_claim`
(identity overlap); missing `previousWindow`/`window` → **REFUSED at the
contract** (REQUIRED fields); malformed bounds → string-typing passes,
calculus semantic guard refuses (`lineage_incomplete`); mismatched
scopes → `void_claim`; unknown metric → `void_claim` (no interpolation
ever); missing lineage → `lineage_incomplete` (C4 reached with the twin
on its own honest window); contradictory coverage-vs-producer
declarations → `void_claim` (conflict propagates, never reconciled);
single window → `lineage_incomplete`.

## 5. Smallest missing seam (ranked — NOT implemented)

1. **Producer-side (smallest, zero Arena delta):** emit the previous
   observation as its **own row** — Gate 7 then consumes it today,
   verbatim. Producer-side prerequisites, honestly noted: the
   `behavioral_signal` uniqueness key is (owner, scope, profile,
   signal_type, subject_type, subject_identity), so a second recent row
   needs a distinguishing dimension (e.g. `signal_type:
   "recent_activity_previous"`); and each row should carry the same
   numeric metric key (e.g. `watches`) describing *its own* window so
   the existing `compareWindows(metricKey)` arithmetic runs unchanged.
2. **Arena-side (rejected for now):** extend evidence addressing with an
   explicit declared-window channel (`EvidenceRef` window selector
   threading resolve/lineage/extract) — genuine machinery surgery for no
   newly *licensed* meaning; wrong order of redress while the producer
   owns the modelling choice.

## 7. Regression results

| Check | Result |
|---|---|
| Arena test suite | **131/131** |
| Typecheck | clean |
| Build | clean |
| Contract `--check` @ `4dcb2a0` | green |
| Gate-7 adversarial suite | **33/33** |
| Real-evidence battery | **32/32** (+13 new rows: 2 EXTRACT/FINDING, 11 two-window/negative) |

**Source files modified:** shape-tracking only — contract pin + generated
snapshot (regenerated, not hand-edited), Gate-6/7 wire fixtures given the
now-REQUIRED `previousWindow`, mock-lab persona helper emitting
producer-faithful adjacent bounds, adapter contract-sanity Testament
required-list, driver battery (+13 rows) and ledger. **Zero changes to
`src/lib/archive-reasoning/` machinery, the adapter, the client, or the
validator** — windows.ts, temporal.ts, lattice, render all byte-touched:
nothing. The SET of licensed conclusions did not grow.

> Archive Assistant knows. Arena preserves. The calculus decides what may
> be concluded. The renderer only speaks what was already earned.
>
> The evidence finally supplied is sufficient for *restatement and
> bounded as-of claims*. Whether the machinery may *compare* those two
> windows is now a producer modelling question with a zero-Arena-delta
> answer — not an Arena construction problem.
