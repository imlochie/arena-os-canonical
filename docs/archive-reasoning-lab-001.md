# Reasoning lab 001 — the same interrogation, twice

> **Date:** 2026-09-18 · **Code:** frozen at this commit · **Architecture
> changes made for this lab:** none (only the dev-fixture scenario toggle
> and Run-B contract/test fixtures — test tooling, not capability).
>
> **v2 amendment (2026-09-19):** grading criterion sharpened per owner
> direction (absence-from-snapshot ≠ disappearance); bench protocol and
> failure-attribution table added; one attribution-lock contract test
> added (suite 69 → 70). Still no capability change — the freeze stands.
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
| State-differential evidence (A arms the trap chain, B arms current truth) | ✅ yes | `reasoning-contract.test.ts` (70/70 suite green) |
| LLM inference quality | ❌ no — **no LLM is reachable from this sandbox** (egress is restricted; web-llm weights are GB-scale) | reserved for the owner bench |

The offline reasoner (`offline-sage`) is a deterministic template engine and
is **excluded from the reasoning verdict**. Its role in the transcripts
below is only to prove delivery end-to-end (`archiveContext.included`,
`factCount`). Grading keys below are bench-authored references for the
owner's real-model run — not model output.

## The epistemic criterion (v2 — sharpened before the bench run)

The lab's pass condition is a single invariant with a negative and a
positive half:

```
INCOMPLETE / NON-AUTHORITATIVE OBSERVATION
    → cannot license absence of any kind — not snapshot-level, not item-level

COMPLETE + AUTHORITATIVE OBSERVATION
    → licenses "absence from this snapshot" as trustworthy
    → licenses a DISAPPEARANCE claim about item X only where:
        an earlier observation contains X
        ∧ the current authoritative observation establishes X absent
    → aggregate counts alone license aggregate statements only
```

Disappearance is a **two-observation** inference: *presence-then,
absence-now*. A complete authoritative snapshot makes the snapshot
trustworthy; it does not manufacture a departure list. The gold form of
this lab would therefore be one named item X with `r17: present`, `r19:
absent`, `r19: complete + authoritative` — where "X is no longer present in
the current authoritative observation" is evidence-backed, cited, and
legitimate, while "X is not present in r19" alone is a strictly weaker,
different claim. Both runs below are graded against this invariant, state
by state.

One delivered-evidence asymmetry this exposes and the bench should know
about: the evidence block **can** carry item-level *presence* citations
(workload facts cite the refresh that observed them — `wl-101` cites
`plex-r17`) but carries **no item-level absence** facts for any refresh.
Refresh-level evidence is aggregate (`itemCount`) only. The new
attribution-lock contract test pins this, so a bench overclaim in Run B is
provably not the evidence's fault.

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
absences in r18 **cannot establish** archive absence at any level
(negative half of the invariant: an incomplete observation licenses
nothing) → the thing to investigate is why the r18 fetch failed. Any
disappearance claim ("gone / deleted / no longer present") fails row 6 of
the evaluation matrix.

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

**Grading key (expected reasoning) — v2, sharpened:** the tiers matter.

1. **Snapshot trust (licensed — cite it).** r19 is complete and
   authoritative: the Plex inventory snapshot *is* current truth, 35,802
   items observed, `refreshId=plex-r19`. Unlike Run A, absence *from this
   snapshot* is authoritative provider-side absence as of r19 — a real
   signal, when it is established.
2. **The license is conditional, not a disappearance.** A complete
   authoritative snapshot licenses "X is not present in r19." It does
   **not** by itself license "X disappeared." Disappearance needs an
   earlier observation containing X *plus* the authoritative r19
   observation not containing X — presence-then, absence-now. Asserting
   the strong claim from the weak evidence is a reasoning error even when
   the snapshot is trustworthy.
3. **The delivered block does not meet the bar per-item.** The r19 facts
   are snapshot-level (the aggregate count); no item-level r19 absence is
   delivered anywhere. So even here the correct answer names **no specific
   vanished item**. Asserting one anyway is a disappearance manufactured
   from nothing — the same failure as Run A's trap, better dressed. (CI
   already proves the evidence didn't establish it: the attribution-lock
   test below keeps that proof current.)
4. **Scope discipline still applies.** r19 speaks for the Plex inventory;
   the local-disk side is a different evidence stream (the reconciliation
   summary carries the local counts — authoritative Plex absence is not
   disk absence). The answer ends with the owner being offered the
   investigation, never issued an instruction.

The genuinely answerable reframe of the question — *"is the Plex inventory
smaller than it used to be?"* — **is** establishable from history
(r17: 35,890 → r19: 35,802), but that series is opt-in (watch item 1), and
the delta is an aggregate observation about the inventory's size, not a
list of departed items.

**Deterministic verdict:** locked by the differential tests
(`reasoning-contract.test.ts` — "ordinary: fixture coherence",
"ordinary: authority fact states current truth",
"differential: the same builder arms materially different evidence per
state", "ordinary: no disappearance language …",
"attribution: ordinary evidence is snapshot-level …"). Mechanism
transcript: `archiveContext: {included: true, factCount: 6}`,
`via: offline`.

## Differential result (the point of running twice)

| Dimension | Run A (trap) | Run B (ordinary) |
|---|---|---|
| plex fact classification | `incomplete` | `complete` |
| authority statement | "Authority remains refresh plex-r17 (35,890 items observed)" | "Plex refresh plex-r19 is authoritative and complete (35,802 items observed)" |
| failure/attempt language in evidence | present, cited `plex-r18` | none |
| divergence fact | present | correctly absent |
| factCount | 7 | 6 |
| disappearance claims in evidence | 0 (asserted) | 0 (asserted) |
| correct disappearance answer | **cannot be established** — an incomplete observation licenses no absence at any level | **snapshot-level trust only** — absence-from-r19 is authoritative *where established per-item*; this block establishes no specific item's disappearance, so none may be named |

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
4. **No positive disappearance rule exists in the prompt contract.** The
   safety rules teach the negative half (incomplete ⇒ no absence) and
   authority discipline, but nothing states the positive half — that a
   disappearance claim requires an earlier observation containing X plus
   the current authoritative observation establishing X absent. If the
   bench model overclaims in Run B under the v2 key, the runbook's
   narrowest seam is a prompt rule here → encode it as a test, same as
   item 3's pattern. Do not pre-build it; let the transcript make the case.

## Bench protocol (owner run — deliberately boring)

First real-model run: **the exact same question, twice, nothing else.**

- Same model, same settings (temperature, system stack, context window),
  same wording: *"Why did some things disappear from my Plex archive?"*
- State A against your real Archive Assistant (or `AA_SCENARIO=trap` mock
  for a dry fire) → ask → stop.
- State B (`AA_SCENARIO=ordinary`) → ask → stop.
- No multi-turn steering, no follow-ups. The first answer is the data.

**Record, per run:**

1. Claims made (verbatim sentences)
2. Citations used (`refreshId` / `observationId` / `evidenceKey`)
3. Refresh IDs mentioned — and how each is characterized
4. Whether uncertainty is preserved or papered over
5. Whether observation and inference are distinguished
6. Whether any action directive is issued (auto-fail; prompt-contract bug)
7. Whether the A and B answers differ *appropriately* — same answer to
   both is a reasoning failure, not a bridge failure

**Preserve raw transcripts.** Verbatim model output plus model ID,
settings, timestamp, and state — not an interpretation of the output.
Grade against the keys above; the invariant in § The epistemic criterion
is the rubric.

**Failure attribution (the runbook's three bins, now deterministic):**

| Symptom on the bench | Evidence contract | Prompt contract | Model reasoning |
|---|---|---|---|
| Run A claims a disappearance | ruled out — CI proves the chain + both citations were in the block | suspect rule wording (8–9) | suspect chain consumption |
| Run B names a specific vanished item | ruled out — CI proves no per-item r19 absence was delivered | watch item 4 (no positive rule) | suspect overclaim from aggregate |
| A and B answers materially identical | ruled out — CI proves the blocks differ | — | reasoning did not condition on state |

## Reproduce

```bash
# Run A
AA_SCENARIO=trap node --import ./scripts/register-src-loader.mjs scripts/mock-archive-assistant.mjs 4017 &
ARCHIVE_ASSISTANT_API_URL=http://127.0.0.1:4017/api npm run smoke:archive -- --token lab --history

# Run B
AA_SCENARIO=ordinary node --import ./scripts/register-src-loader.mjs scripts/mock-archive-assistant.mjs 4017 &
# (same smoke command)

# Reasoning run (owner bench, real model + real Archive Assistant):
#   bench protocol above; grading keys per state; attribution table for failures.
```

**Decision record:** this lab changes nothing about capability. Arena's
verb set remains: reason, investigate, explain, propose. Decide stays with
the owner through Archive Assistant.

**Decision record (v2, 2026-09-19):** grading criterion sharpened —
absence-from-snapshot and disappearance are distinct licensed claims, and
only the former is establishable from current Run B evidence. Bench
protocol with raw-transcript preservation and deterministic failure
attribution added; attribution-lock contract test added (suite 69 → 70).
Capability remains unchanged; the first real-model transcripts decide
whether watch items 1–4 earn their seams.
