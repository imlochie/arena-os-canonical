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

## Continued delivery: Waveyard playback + fail-closed draft review

The scope remains the whole application. Waveyard and Arcade are the first checkpoints, not completion of the mandate. Waveyard's acceptance target is the relevant STEM.FM experience for user-provided music (import, independent stems, multi-track sessions, manipulation, durable work and exports), not just Demucs. The STEM.FM benchmark here comes from the owner's supplied documentation excerpts; those external pages were not independently fetched from this network-restricted sandbox.

### Execution path and repairs

`ProjectWorkspace → StudioCore → useStemTransport` and `TrackPlayer / SessionExperience.SessionDeck → useStemTransport` share the same HTML media/Web Audio primitive. The transport now:

- Uses synchronous playback position for seek/play and loop wraps rather than a stale render closure; loop wraps keep the clock running.
- Treats equal asset-ID lists as the same deck, preventing polling from tearing down a playing context. Real deck changes pause and disconnect old channels without poisoning the context.
- Reconnects actual remounted media elements, applies pre-play master insert state, and clears playing state when audio ends.
- StudioCore mixer/insert restoration effects now depend on stable transport callbacks, not the newly returned transport object on every position tick, avoiding unnecessary graph rebuilds while playing.
- Refuses empty/missing/invalid stem playback, stops the performance if a required stem disappears/fails, and invalidates late async starts on pause/stop.

`Deep Agent page → /api/deep-agent → runDeepAgent → generation/review → deep_agent_runs/deep_agent_steps` had two false-success mechanisms: missing review verdicts defaulted to PASS; the loop marked the run done despite failed reviews and fed rejected drafts downstream. Both are fixed. Missing/deterministic-fallback reviews fail closed, rejected work stops dependent steps, exceptions mark the durable run failed, and failed transcripts remain retrievable. Page request failures now surface errors instead of clearing prior results or silently removing local entries. This is still a research/draft agent: **model review is not independent execution evidence, and no new investigative tool executor has been integrated**.

### Runtime evidence

- Browser acceptance: `npm run test:acceptance:transport`, **10 passed** with Chromium 153.0.8010.0. Uses the actual React hook, real HTML audio elements, Web Audio graphs, analyser RMS and MediaRecorder/decodeAudioData. Two deterministic PCM tones are test inputs, not alleged inference outputs.
- Checks include actual gain/mute/solo signal changes, seek alignment, repeated looping, equal-list refresh, new-deck playback, missing stem failure, pre-play master effects, ended state, remounted sources, pending-start cancellation, failed-media recovery and a decodable/non-silent master recording.
- Controlled regression comparison: the first eight browser cases against the original HEAD transport passed **1 and failed 7**; the repaired transport passed all eight. Two further recovery/recording cases were added afterward and the final suite passed all ten. The source was restored immediately after comparison; no original user changes were discarded.
- Browser TAP output includes the exact transport source SHA-256, browser version, input identity and explicit limitations. CI now installs Chromium, runs this gate on pushes/PRs, and retains TAP evidence even on failure. The added CI job has not itself been observed running here.
- `123` tests passed in the combined Arcade + Waveyard library + Deep Agent regression command, including real embedded PostgreSQL library/session persistence and PGlite draft-review transcripts. The initial library run failed because `npm ci --ignore-scripts` left PG symlinks unhydrated and ffprobe non-executable; dependency-local setup was repaired and the complete command rerun successfully. No product dependency discovery was changed to mask those failures.
- Existing Wave 3/3b integration suites: **12 passed, none skipped**, against a temporary real PostgreSQL instance booted through the desktop runtime config/EmbeddedPostgres classes and canonical migrations, then stopped and removed.
- Typecheck and production build passed. Full lint: **0 errors, 46 warnings** (one added effect-synchronisation warning in the transport).
- No Electron UI, packaged Windows, real model generation or Demucs inference acceptance has been established. Browser audio measurements are not subjective listening evidence or sample-perfect sync guarantees.

### STEM.FM-oriented acceptance status (not a completion checklist)

| Area | Evidence in this delivery | Still required |
| --- | --- | --- |
| Import/preparation | Existing service suite reads real WAV metadata, checksum, private storage and persisted track/job rows | MP3/M4A/FLAC UI import + actual separation + existing-stem import acceptance |
| Independent playback | Real graph gain/mute/solo/seek/loop/failure recovery verified with PCM tone inputs | Separated music through full room UI and Electron; subjective listening and long-duration drift |
| Multi-track sessions | Existing real SQL tests cover ordered tracks, saved mix/transitions, swaps with provenance and Studio handoff references | Audible cross-track mixing/transitions + navigation/restart continuity in the actual UI |
| Manipulation | Shared transport looping + restored master gain insert verified as signal operations | Full timeline, speed/pitch/key/edit/effect acceptance against persisted arrangements |
| Durable work/export | SQL playback/session reopen and master recording primitive verified | Full room save/restart/reopen; WAV stem export and rendered combined mix import/reopen |
| Inference | No new inference evidence | Source → intended Demucs → validated/listenable stems → workspace/session → export |

### REA reference and application-wide continuation

Inspected `morluto/rea` at `7c458f04b9155707c8ba406f8b455b10016f1b99`: MIT metadata, `src/domain/evidence.ts`, `src/application/EvidenceInputResolver.ts` and its tests. Relevant actual contracts separate observed/derived/inferred confidence, authority, source digest, environment, limitations, links and exact retained-reference resolution; dangling or mismatched references fail rather than being guessed. No REA code or dependencies were imported. This delivery applies those principles to test provenance and fail-closed review; it does **not** claim REA-like runtime investigation, tracing or retained-evidence tools are now agent-executable.

Arena already has `repoMap.ts` (bounded static file/export map), `toolRuntime.ts` (grant-scoped read-only filesystem/git tools), Archive evidence references and Deep Agent persisted transcripts. These are different contracts, not an integrated investigation-to-implementation agent. Reuse them rather than introducing a competing registry. Native/IPC observation, reusable investigative evidence and actual agent-mediated implementation/verification remain open.

The room scope was rediscovered from `Nav.tsx`, `arenaRooms.ts`, `ArenaRoomsDirectory.tsx` and `src/app/**/page.tsx`, not restricted to Waveyard/Arcade. Existing room catalogues are not acceptance evidence. No other room is promoted to accepted by this delivery, including Deep Agent (only its review-state guarantees were repaired).

Next concrete work: use the browser acceptance environment to exercise the actual local-first Waveyard room from user source import through persisted session playback and exported audio, with isolated data; complete the corresponding Electron check on a capable host and real Demucs on a prepared host. Then continue room-level execution checks using the existing directory/route map. `StudioCore` restoration-effect dependencies were corrected in this patch; full room interaction acceptance of saved effects still remains outstanding, and hook acceptance must not be treated as room acceptance. Do not reset this investigation or claim parity from the table above.
