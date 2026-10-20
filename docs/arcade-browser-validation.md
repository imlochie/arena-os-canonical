# Arcade: browser-checked publication

Follow-on source base: `ba5cfa731712b8f4759416830ed66b9cb50b9d84`.
Agent A's recovery/integration branches and PR18 are not edited or merged.
P5 remains frozen. This is the first Arcade reliability increment, not closure
of the broader game/mod/Spaces/Waveyard product mandate.

## Evidence-based gap map

| Area | Observed implementation | Verification state / next gap |
| --- | --- | --- |
| Arcade | Eight offline cores, generated/iterated code, static checks, retained attempt Artifacts and cancellation fencing | Existing persistence contracts do not establish execution. This increment gates arbitrary new publication on browser smoke and tests a custom game's actual inputs/states. Live-model creative fidelity remains unverified. |
| Waveyard | Production transport/mixer/session/Studio paths; real local-file acceptance | PR18 isolated evidence is preserved; owner integration and Gate D remain Agent A's work. Continuous bank switching and genuine inference quality are not established by converter acceptance. |
| Spaces | Missions, governed tools, workspace isolation, journals/resumption, immutable outputs and UI controls | Reuse these; do not create another runtime. Actual objective-to-verified-deliverable/recovery browser acceptance and scheduler documentation reconciliation are the next separate Spaces increment. |
| Projects / Artifacts | Project context and owner-bound immutable private objects/revisions | Implemented infrastructure with existing source tests; not proof of every product workflow. Arcade reuses existing attempt Artifacts. |
| Model runtime | Shared `ai.generate`, backend identity, explicit fallbacks and execution policy | Preserve real routing; scripted HTTP replies prove orchestration, not genuine model reasoning or arbitrary game quality. |
| Real source/mod tooling | Workspace/repository/execution foundations | No cohesive verified sourcing→inspection→acquisition slice established here; implement one supported official provider separately, not a fabricated catalogue. |

## Changed production path

`forge` now supplies actual browser validation to the existing generation loop.
A statically valid but crashing/inert/egressing draft triggers the same one total
repair allowance, with observed complaints and draft evidence checkpointed first.
Missing/busy Chromium preserves the draft without wasting a repair call.

`finishAttempt` checks execution before publication, including legacy retry-save.
An exact, hash-bound, one-use in-process browser result can avoid a duplicate
browser launch; a client or serialized Artifact cannot forge that proof.
Existing revision/cancellation fencing and atomic game/Artifact completion remain.
The custom client/on-device save path also cannot bypass this gate by claiming
to be a verified core. Byte-identical built-in templates retain their trusted
offline path, including on machines without a browser binary.

The actual player uses the same CSP-wrapped opaque `allow-scripts` iframe as
validation. The `/arcade` parent forbids frame navigation; the inner policy
denies network, workers, embedded documents, forms and external resources.
Browser checks use fresh non-authenticated profiles, no Spaces cookies, no model
keys/DB credentials in the browser process environment, bounded concurrency and
a ten-second verification budget. Production enables Chromium's OS sandbox.
Only explicit CI configuration permits the runner's no-sandbox mode.

## Honest scope and configuration

Install Chromium once (`npx playwright install chromium`) or point
`ARENA_ARCADE_CHROMIUM_PATH` to an installed Chromium executable.
The browser runs locally; it does not download a model or call a provider.
Unavailable verification is not a passing game and never removes the prior game.

This gate checks bounded 2D-canvas rendering, changing output, exercised input,
runtime errors and denied requests. **Dispatching an input is not proof of its
intended mechanic.** A generic smoke pass does not prove arbitrary prompt
fidelity, causal input effects, pause/win/loss correctness, quality or fun.
The actual-page acceptance separately asserts those states for a labelled,
scripted custom photography game, plus representative template execution.
WebGL-only/unsupported games do not receive a fabricated pass.
Downloaded raw game source remains untrusted outside Arena's player sandbox.

## Verification

Focused source contracts:
`node --import ./scripts/register-src-loader.mjs --test src/lib/games/*.test.ts`.
Browser/actual-page acceptance (requires a built application and Chromium):
`node --import ./scripts/register-src-loader.mjs --test --test-concurrency=1 tests/acceptance/arcade-playability.test.mjs`.
The actual Next page uses existing desktop loopback trust in this isolated test,
not a claim that Electron or remote authenticated deployment was exercised.
Scripted replies travel through the real local-provider HTTP/model-routing path;
the explicit fixture-model pin is identified in the test, not hidden in production.

Dedicated CI installs once, then runs typecheck, focused lint, durable attempt
regressions, real application build, actual-page/browser acceptance and the full
unaltered source-suite runner. Receipts/traces and failures retain exact source
identity. A pending/failed CI run is not completion or release evidence.
