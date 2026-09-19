# Gate 7 — two-window capability dress rehearsal

> **Date:** 2026-09-19 · **Pose:** SYNTHETIC lab persona `g7cap` emitting
> exactly the shape proposed in docs/gate7-two-window-seam-proposal.md.
> **Not real evidence; proves Arena-side capability only.**
> **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-capability-probe.mjs`
> **Verdict:** **PASS** (13/13 checks)

If upstream lands the proposal, THIS is the conclusion the real-evidence
battery will re-verify with producer-authored bounds (windows here are
persona constants, deliberately indie-but-honest half-open spans):

| # | Check | Outcome |
|---|-------|---------|
| INGRESS | proposed two-row shape crosses the seam validated + verbatim (2 temporal items, classes/signalTypes preserved) | ✅ temporalSignals=2 types=[recent_activity, recent_activity_previous] |
| RETAIN | both windows — verbatim identification, no reconstruction (sorted prev-first) | ✅ perWindow=[2026-03-23T05:00:00.000Z..2026-06-21T05:00:00.000Z | 2026-06-21T05:00:00.000Z..2026-09-19T05:00:00.000Z] |
| RETAIN | both evidence references (distinct rows; members + loadBearing) | ✅ members=[{"collection":"temporalSignals","index":0},{"collection":"temporalSignals","index":1}] |
| RETAIN | the compared metric is the parity key, per-window values intact | ✅ values=[1, 2] |
| RETAIN | explicit comparison direction — delta arithmetic, never an adjective | ✅ delta=+1 relation=greater |
| RETAIN | epistemic ceiling = derived (the calculus computes the ceiling, never the caller) | ✅ status=derived |
| RETAIN | scope identity explicit | ✅ scope=plex:account-main:tv |
| RETAIN | deterministic derivation rule + byte-identical re-computation (no clocks) | ✅ rule=temporal.compare.v1:watches; claim byte-stable=true |
| RETAIN | inspectable lineage: conclusion frozen, load-bearing refs frozen, envelope span honest | ✅ envelope=[2026-03-23T05:00:00.000Z..2026-09-19T05:00:00.000Z] label=comparison_span |
| IDENTIFICATION | prev window retained while NOT equal to derivedAt: it was consumed as declared, never derivedAt−90d | ✅ prev.endsAt=2026-06-21T05:00:00.000Z vs derivedAt=2026-09-19T05:00:00.000Z (distinct — declaration consumed verbatim) |
| ADJACENT | the previous row alone supports its own bounded as-of claim (same calculus path as row 14) | ✅ as-of window=[2026-03-23T05:00:00.000Z..2026-06-21T05:00:00.000Z] |
| ADJACENT | contradiction lane stays silent (same lineage + non-overlapping windows: both stand, no fabricated dispute) | ✅ surfaced=0 |
| RENDER | renderer speaks only the earned arithmetic (vocabulary scan with evidence strings masked) | ✅ clean |

## The deterministic trend conclusion (verbatim claim)

```json
{
  "subject": "movie:behaviour-film",
  "metricKey": "watches",
  "perWindow": [
    {
      "member": {
        "collection": "temporalSignals",
        "index": 1
      },
      "window": {
        "startsAt": "2026-03-23T05:00:00.000Z",
        "endsAt": "2026-06-21T05:00:00.000Z"
      },
      "windowKey": "{\"label\":null,\"startsAt\":\"2026-03-23T05:00:00.000Z\",\"endsAt\":\"2026-06-21T05:00:00.000Z\"}",
      "value": 1
    },
    {
      "member": {
        "collection": "temporalSignals",
        "index": 0
      },
      "window": {
        "startsAt": "2026-06-21T05:00:00.000Z",
        "endsAt": "2026-09-19T05:00:00.000Z"
      },
      "windowKey": "{\"label\":null,\"startsAt\":\"2026-06-21T05:00:00.000Z\",\"endsAt\":\"2026-09-19T05:00:00.000Z\"}",
      "value": 2
    }
  ],
  "comparisons": [
    {
      "aWindowKey": "{\"label\":null,\"startsAt\":\"2026-03-23T05:00:00.000Z\",\"endsAt\":\"2026-06-21T05:00:00.000Z\"}",
      "bWindowKey": "{\"label\":null,\"startsAt\":\"2026-06-21T05:00:00.000Z\",\"endsAt\":\"2026-09-19T05:00:00.000Z\"}",
      "delta": 1,
      "relation": "greater"
    }
  ],
  "members": [
    {
      "collection": "temporalSignals",
      "index": 0
    },
    {
      "collection": "temporalSignals",
      "index": 1
    }
  ]
}
```

- rendered statement: ""movie:behaviour-film": watches was 1 in the window from 2026-03-23T05:00:00.000Z to 2026-06-21T05:00:00.000Z and 2 in the window from 2026-06-21T05:00:00.000Z to 2026-09-19T05:00:00.000Z; the later window is greater by 1."
- epistemic: derived · scope: plex:account-main:tv · rule: temporal.compare.v1:watches
- load-bearing: [{"collection":"temporalSignals","index":0},{"collection":"temporalSignals","index":1}]

**What this establishes:** once the evidence arrives *as rows*,
`compareWindows("watches")` over the pair yields the bounded comparison
with every retention item intact — the calculus needed no contact with
the problem beyond identifying two declared windows. The remaining
question is purely upstream emission (proposal, owner-gated).
