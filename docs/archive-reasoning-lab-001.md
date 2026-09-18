# Reasoning lab 001 — the same interrogation, twice

> **Date:** 2026-09-18 · **Code:** frozen at this commit · **Architecture
> changes made for this lab:** none (only the dev-fixture scenario toggle
> and Run-B contract/test fixtures — test tooling, not capability).
>
> **Question under test:** does the reasoning contract arm materially
> different — and correct — evidence for two states that *feel* identical to
> a casual reader ("Plex shows fewer items than before")?

```
Run A (trap):     r17 synced/complete/authoritative (35,890)
                  r18 sync_error/partial/non-authoritative   ← authority STAYS r17
Run B (ordinary): r17 synced/complete/authoritative (35,890)
                  r18 sync_error/partial/non-authoritative
                  r19 synced/complete/authoritative (35,802) ← authority MOVED to r19
```

Same question for both: **"Why did some things disappear from my Plex archive?"**

## What this lab could and could not certify

| Layer | Certifiable here? | Instrument |
|---|---|---|
| Fact delivery (client → contract validation → normalizer → prompt) | ✅ yes | live mock upstream, real client, real routes, smoke digest |
| State-differential evidence (A arms the trap chain, B arms current truth) | ✅ yes | `reasoning-contract.test.ts` (69/69 suite green) |
| LLM inference quality | ❌ no — **no LLM is reachable from this sandbox** (egress is restricted; web-llm weights are GB-scale) | reserved for the owner bench |

The offline reasoner (`offline-sage`) is a deterministic template engine and
is **excluded from the reasoning verdict**. Its role in the transcripts
below is only to prove delivery end-to-end (`archiveContext.included`,
`factCount`). Grading keys below are bench-authored references for the
owner's real-model run — not model output.

## Run A — trap state

**State served** (`AA_SCENARIO=trap` … mock log: `scenario=trap: plex
authority r17 (35,890 items) with failed partial attempt r18`).

**Evidence block delivered to the reasoner** (verbatim, captured live
through client → mock → normalizer → `buildArchiveContextSystemPrompt`):

```
- provider_refresh:plex (incomplete) The latest plex refresh attempt ended with a
  partial snapshot; the plex view is incomplete, not empty. Authority remains
  refresh plex-r17 (35,890 items observed). [refreshId=plex-r17 observedAt=2026-09-18T09:00:40.000Z]
- provider_refresh:plex:plex-r18 (incomplete) Plex refresh attempt plex-r18 has status
  sync_error with partial snapshot completeness and is not authoritative.
  [refreshId=plex-r18 observedAt=2026-09-18T09:00:40.000Z]
(+ 5 further facts: workload wl-101/wl-102, reconciliation summary, jellyfin pair)
```

**Grading key (expected reasoning):** r18 is incomplete → r18 is not
authoritative → r17 (35,890 items observed) remains authority → apparent
absences in r18 **cannot establish** archive absence → the thing to
investigate is why the r18 fetch failed. Any disappearance claim ("gone /
deleted / no longer present") fails row 6 of the evaluation matrix.

**Deterministic verdict:** contract-test suite locks this — prompt contains
the full chain, both citations, and matches zero disappearance patterns.
Mechanism transcript: `/api/chat` → `archiveContext: {included: true,
factCount: 7}`, `via: offline` (template engine; excluded from quality
verdict).

## Run B — ordinary state

**State served** (`AA_SCENARIO=ordinary` … mock log: `scenario=ordinary:
plex authority r19 (complete, 35,802 items) after r17 (35,890)`).

**Evidence block delivered to the reasoner** (verbatim, live):

```
- provider_refresh:plex (complete) Plex refresh plex-r19 is authoritative and
  complete (35,802 items observed). [refreshId=plex-r19 observedAt=2026-09-18T11:05:00.000Z]
(+ 5 further facts: workload wl-101/wl-102, reconciliation summary, jellyfin pair)
```

Note what is **absent**: no `sync_error`, no `partial`, no `incomplete`, no
`not authoritative` anywhere in the evidence lines (the differential
contract test asserts this against the fact lines — the safety rules retain
those words by design). `factCount: 6` — the divergence fact that existed in
Run A correctly does not exist here.

**Grading key (expected reasoning):** the current authoritative observation
is r19, complete, 35,802 items. An item missing there **is** authoritative
provider-side absence as of r19 — a real signal, citable to
`refreshId=plex-r19`. Report it as such, note what it does and does not
cover (it speaks for the Plex inventory snapshot; the local disk side is a
different evidence stream — the reconciliation summary shows the local
counts), and offer the owner the investigation, never the instruction.

**Deterministic verdict:** locked by the differential tests
(`reasoning-contract.test.ts` — "ordinary: fixture coherence",
"ordinary: authority fact states current truth",
"differential: the same builder arms materially different evidence per
state", "ordinary: no disappearance language …"). Mechanism transcript:
`archiveContext: {included: true, factCount: 6}`, `via: offline`.

## Differential result (the point of running twice)

| Dimension | Run A (trap) | Run B (ordinary) |
|---|---|---|
| plex fact classification | `incomplete` | `complete` |
| authority statement | "Authority remains refresh plex-r17 (35,890 items observed)" | "Plex refresh plex-r19 is authoritative and complete (35,802 items observed)" |
| failure/attempt language in evidence | present, cited `plex-r18` | none |
| divergence fact | present | correctly absent |
| factCount | 7 | 6 |
| disappearance claims in evidence | 0 (asserted) | 0 (asserted) |
| correct disappearance answer | **cannot be established** | **authoritative as of r19, cited** |

The same builder, the same rules, the same question — and the evidence arms
opposite conclusions because the *states* differ. That contrast is the
epistemic capability the architecture was built to preserve.

## Watch items for the owner's real-model run

Parked here, **not built** (evaluation matrix expansion rule applies):

1. **Cross-authority count delta.** The bridge does not currently compute
   "35,890 → 35,802 across authorities." It is visible only via opt-in
   history (`?history=1`): `plex-r19(synced/complete,auth) ·
   plex-r18(sync_error/partial) · plex-r17(synced/complete,auth)`. If the
   real run shows Arena needs that delta stated as a first-class fact, the
   narrowest seam is the normalizer (state carries only refs; history
   carries the series) — decide then.
2. **Historical-vs-current citation.** In Run B, workload fact `wl-101`
   still cites `refreshId=plex-r17` (the refresh that observed its evidence)
   while current authority is r19. Watch whether the model keeps "the
   finding's evidence came from r17" distinct from "current truth is r19."
3. **Local vs provider truth.** Run B's correct answer distinguishes
   authoritative *Plex inventory* absence from *local disk* absence (the
   reconciliation summary carries the local counts). If conflated, that's a
   prompt-rule lesson → encode it as a test.

## Reproduce

```bash
# Run A
AA_SCENARIO=trap node --import ./scripts/register-src-loader.mjs scripts/mock-archive-assistant.mjs 4017 &
ARCHIVE_ASSISTANT_API_URL=http://127.0.0.1:4017/api npm run smoke:archive -- --token lab --history

# Run B
AA_SCENARIO=ordinary node --import ./scripts/register-src-loader.mjs scripts/mock-archive-assistant.mjs 4017 &
# (same smoke command)

# Reasoning run (owner bench, real model + real Archive Assistant):
#   docs/archive-reasoning-evaluation.md §3 — same question, both states,
#   grade against the keys above.
```

**Decision record:** this lab changes nothing about capability. Arena's
verb set remains: reason, investigate, explain, propose. Decide stays with
the owner through Archive Assistant.
