# Declared gameplay validation

Continues the integrated PR19 gate on owner `a6f38552`; does not re-merge
or rewrite PR19/20. Legacy games without a contract retain their explicitly
labelled smoke-only result. New server-side AI generations must include the
bounded `arena-gameplay` JSON contract described in `gameplay-contract.ts`.
The same opaque iframe, CSP, clean browser, denied network and publication
identity gate remain in use. No model-authored test JavaScript is evaluated.

Four fresh-document scenarios exercise controls, numeric progress, a terminal
state and a non-vacuous restart. Actions are real keys/clicks; observations
must come from unique visible HUD elements. Controls must also change canvas
content. The report stores before/after observations and failures; the existing
single repair sees those failures, and unsuccessful drafts remain private.
Client/serialized reports still cannot forge the one-use publication proof.

## What this establishes—and does not

These are **declared mechanic observations**. The model authors both game and
scenario data: a dishonest HUD or weak scenario can still misrepresent deeper
semantics. A pass does not prove arbitrary user-intent fidelity, exhaustive
physics/collisions, fun, live-model quality, Windows or Electron operation.
Non-canvas games remain outside the existing publication contract.

The repeatable controlled corpus has genuinely different maze, projectile
shooter and switch-puzzle rules. Negative controls include inert input despite
animation, broken restart, unreachable terminal state, and bounded repair.
These hand-authored games/scripted providers test production orchestration and
browser mechanics—not live creative performance.

Run:

```
node --import ./scripts/register-src-loader.mjs --test src/lib/games/gameplay-contract.test.ts
node --import ./scripts/register-src-loader.mjs --test tests/acceptance/arcade-gameplay.test.mjs
```

The optional live path uses **existing** `TURBOAGENT_URL` runtime configuration
and an explicit `ARENA_ARCADE_EVAL_MODEL`. It never prints endpoint/credential
values. Run `node --import ./scripts/register-src-loader.mjs
scripts/arcade-live-eval.mjs`. Missing configuration produces a `blocked`
receipt and exit 2, not a skipped/passed live evaluation. Receipts and failed
drafts stay under `.data/arcade-live-eval/`; inspect actual game fidelity by
playing the saved output. This does not provision or assume a model.
