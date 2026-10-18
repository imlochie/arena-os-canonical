# Product coherence continuation — 2026-10-18

Bounded delivery: Arcade request routing, generation/iteration truthfulness, and result retention. This is not whole-product or desktop acceptance.

## Fixed paths

- Auto + unknown mechanics → genuine model code generation (online when permitted, otherwise on-device), never implicit Neon Arena. Instant + unknown mechanics → actionable error. Explicit template selection remains available.
- Removed broad `space`, `ghost`, `blocks` keyword routes which misclassified unrelated mechanics.
- Model unavailable / invalid output → error, previous playable game retained. Iteration retains its instruction on failure and passes the full current HTML to code generation instead of regenerating a template.
- Repair receives the failed draft. Deterministic repair fallback fails; accepted repair provenance reflects its executor.
- Template bytes are checked before persisting verified/remix labels. Server codegen honors Ephemeral and exposes persistence failure. Unsaved generated HTML remains downloadable.
- Failed copy/delete/open no longer displays false completion or silently removes local state. Server-generated games no longer display a verified-core badge. Offline/online descriptions now match routing. Stop is shown only during cancellable on-device token streaming, not for an uncancellable server request.

## Evidence

- Typecheck: passed.
- Production build: passed.
- Full lint: 0 errors, 45 warnings.
- Arcade/game suite: 21 passed, including real embedded PostgreSQL create/reopen/provenance and real route rejection paths. Controlled model tests exercise generation/iteration/repair contracts, NOT real model quality or generated gameplay.
- Combined Arcade/game + Waveyard deep/retry run before the last added repair test: 42 passed.
- `test:desktop`: output ended with 137 passed / 0 failed. The tool wait timed out at 180 seconds; final summary was subsequently read from its log and no test process remained. These are automated desktop/service tests, NOT an Electron UI acceptance run.
- `desktop:smoke`: shell compiled, Electron binary acquisition failed (`fetch failed`); no renderer/IPC acceptance result exists.
- Dependency installation used `--ignore-scripts`; embedded PG initially lacked hydrated library symlinks. Running its packaged `scripts/hydrate-symlinks.js` from its own package directory enabled the real PostgreSQL route tests. No product code change was needed for that test-environment issue.

## Remaining acceptance / continuation

1. On a desktop-capable host, run Electron with isolated data, create genuinely different novel games with a reachable model, play each in the existing sandbox iframe, request gameplay changes, reopen revisions, and verify save/download/recovery. No real model execution, semantic fulfillment, browser interaction, or generated gameplay acceptance was demonstrated here.
2. Generated HTML validation remains structural, not a proof of JavaScript execution or gameplay correctness. Safe iframe remains `sandbox=allow-scripts`; stronger runtime validation remains outstanding.
3. Arcade history-fetch errors still degrade to an empty/stale list; generation persistence retries and server generation cancellation/progress are not implemented. On-device model loading cannot be cancelled by the stream Stop control. Do not advertise those as supported.
4. Waveyard provisioning PR #14 was inspected (files + evidence), not merged or duplicated. It explicitly records that genuine Demucs inference was not executed due to checkpoint/PyTorch download restrictions. This checkout's worker routes deep jobs through `runDeepSeparation`; passing injected-engine tests is not six-stem inference evidence. Owner-machine source → inference → valid/listenable stems → restart/retry/cancel acceptance remains open.
5. No claim is made about all controls, agent orchestration, other rooms, Windows installed-app acceptance, or whole-application coherence. Continue from actual execution paths, not this note as proof.
