# Mandate6 — usable binary Mission handoff and CI fixture repair, 2026-10-19

Follows `09bc88925beb1d7d6b5cb09d45a629aae9dfd9d7`. That head passed static1360-source/build, Compose and browser checks, but its **new FX native step failed** in CI39201244592/39201240493. Do not call those runs all-green. The new fixture had inherited a local-only FFmpeg PATH adjustment. Reproduced without that adjustment:1FAIL23.32s (`/home/user/mandate6-fx-no-path-before.txt`). Fixed the fixture, not the results: resolve the actual installed FFmpeg/FFprobe with Arena's existing `requireTool`, expose them only to the worker child via a temporary private symlink bin, and immediately surface handler failure instead of waiting for a nonexistent checkpoint. All seven real queue windows then pass **without any shell FFmpeg PATH adjustment**,1PASS53.89s (`/home/user/mandate6-fx-no-path-after.txt`). CI now publishes FX test failure identities as well as A7 identities. Signed Azure Actions log/artifact downloads are inaccessible here; check annotations and locally reproduced environments are retained instead of inventing unseen log details. Exact newest-head CI must be checked independently.

## Another actual cross-workflow failure, implemented and proven

An actual Mission wrote and published270000-byte Unicode and240000-byte binary files, then honestly became incomplete after a rejected syntax-invalid action. Both useful partials remained downloadable after source-file overwrite and PostgreSQL restart. A later actual task could copy the text but the shared `reuse_mission_output` tool explicitly refused the binary, so its real Node verification command failed. Before proof: `/home/user/mandate6-large-mission-native.txt`; after: `/home/user/mandate6-large-mission-after.txt`.

- Extended the **existing guarded file writer**, not a new tool/registry, to accept exact byte buffers as well as text. Reuse resolves the owned pinned revision through the existing Mission manifest, verifies its complete private content, then writes those bytes without UTF8 conversion. The existing32MiB output bound is also enforced before writing; no inline/DB body limit was raised. Containment/symlink checks and syntax validation remain; binary bytes cannot masquerade as JavaScript source. Text write receipts now report actual UTF8 bytes instead of UTF16 character counts.
- Updated the Mission tool instructions to truthfully advertise supported text **and binary** file reuse.
- Added an actual **Prepare reuse** control beside verified Mission outputs. It puts stable source-space/mission/output IDs, the original Artifact/revision reference, expected SHA256 and an explicit destination into the **next task draft**. Existing draft text is preserved, repeated preparation is idempotent, and it does not execute tools or claim successful reuse. The normal task/provider path remains responsible for actual work.
- The real Chromium regression inspects the complete large text, downloads both partials, overwrites their workspace files, restarts PostgreSQL, and verifies both in a **fresh Node process**. It clicks Prepare reuse, preserves an existing goal, parses the actual drafted binary arguments into the later controlled protocol plan, invokes the real file-copy tools and runs a real Node checksum verification command. The later Mission is done and its verification.json and copied binary are downloadable through the actual panel. Invalid binary-to-code reuse is rejected without creating a file. This is runtime/tool/identity acceptance, not autonomous model reasoning.

## Latest verified boundary

- Integrated actual PostgreSQL/private files/HTTP/Chromium/Redis/BullMQ: **55PASS/0FAIL**, `/home/user/mandate6-final55-integrated.txt`. Includes the original54 plus the large/binary partial→later-task workflow. Subsequent strengthened fresh-Node/UI-draft focused test:1PASS, `/home/user/mandate6-large-mission-browser.txt`, not an additive56.
- Production Next buildPASS (`/home/user/mandate6-final55-build.txt`); root typecheckPASS; production worker typecheckPASS. Changed Mission/UI/test lint:0errors/1existing effect warning. Full lint last run0errors/48warnings. No inference/Electron/Windows acceptance claim.
- Unicode Mission file SHA256 `9618d3a6549f0f07fec2eef89d8e02677222cdc38879ff4ba138b095c2ee836a`; binary SHA256 `93c1f032ee90c7ae77edd4accd37e90ed58dd8cf70474f25478cc4b1d14d10e5`. Actual later command asserts these exact hashes after immutable retrieval, not merely row existence. Full provenance IDs and fresh-process/UI evidence are in the focused log.

## Continue independently

The broader programme remains open: independent Studio scale/main-thread, stale edits/cancellation/save-reopen and remaining-room useful-outcome checks; interrupted/orphan export/temp-file reconciliation without premature deletion; remote-provider/S3 and broader runtime acceptance where available. Inspect output-capture reads under concurrent workspace mutation before making unbounded-I/O claims. Preserve all published cross-room, Orchestrator, full Artifact and real FX recovery work. No Windows/model/checkpoint prerequisite, no auto-merge, no whole-app completion claim.

---

# Mandate6 — real FX lease loss, interruption and verified publication, 2026-10-19

Follows verified/published `7580caa83ad53830a4894867e1eac57446b24afe`; PR15 remains open/unmerged. Exact new-head results belong in the PR evidence comment rather than a self-referential commit hash here.

## Actual RED → shared fix → real runtime

The production isolated export handler was run in **actual BullMQ Worker child processes**, against native PostgreSQL and Redis7.2.6. Worker A was stopped at postrender/prevalidation until its lease expired. Worker B recovered the real stalled job and published a valid file. Resuming A reproduced: Redis job **completed**, SQL job **failed**, **one valid asset**. Before proof: `/home/user/mandate6-fx-lease-before.txt`. This was not a fake queue or two artificial duplicate queue IDs.

- Local and isolated export status writes now preserve an already-complete publication; stale attempts cannot mark it preparing/processing/finalizing/failed. Rendering/publication stages stop when another attempt has published. The existing database unique asset-per-job constraint remains authoritative. Losing attempts clean only their own unpublished file, never the winning file.
- Existing asset metadata no longer silently means complete. Both handlers verify exact stored size/SHA256 and job/project/version/format binding before acknowledging it. A completed marker with no asset is explicitly invalidated. Queue progress acknowledges complete on verified publication recovery.
- The authorized media handler verifies the complete stored file **before** serving bytes/ranges or signing a download. Missing/corrupt bytes return410/422 instead of a200 with altered sound, and invalidate a corrupt completed marker. Storage errors return503 rather than private paths/keys. No deletion of the damaged file is attempted.
- An explicitly restored private file can be recovered using the real existing Retry route, even when its BullMQ record is already completed: retry that terminal record in place, re-verify the retained file, restore truthful completion and download the original bytes without another asset. Retry now closes its real Redis connection on every HTTP exit. The real test initially passed its assertions but stayed alive reconnecting after Redis shutdown, exposing that actual resource leak; it now exits normally.
- Added truthful publishing and committing checkpoints. No model-side effects or exactly-once arbitrary execution are claimed. Private copies can be written by more than one attempt; the guarantee exercised is consistent, recoverable publication with one valid asset.

## Executed acceptance, non-additive

Integrated native PostgreSQL/HTTP/private-files/Chromium/BullMQ suite: **54 passed,0 failed**,112.88s, `/home/user/mandate6-final-integrated.txt`. The strengthened focused queue rerun adds live-workspace editing after claim and proves the spawned FFmpeg process is actually stopped via Linux `/proc` before killing its process group; `/home/user/mandate6-fx-lease-native.txt`. It is an overlapping test, **not**55 tests.

The same persisted V1 includes overlapping clips, phase inversion, saturation, delay, master gain and reverb. After claim, the live remix is changed to different polarity/gain/no inserts. V1's stored snapshot hash remains unchanged. Every recovered output is compared against the local deterministic V1 reference's **decoded PCM**, not just its successful file creation:

| Actual interruption window | Recovery observed |
| --- | --- |
| Claimed / resolving-remix, before render | Two attempts, complete SQL + completed queue, one valid asset |
| Rendering checkpoint before processing | Same |
| Actual FFmpeg launched, output graph parsed, verified stopped process | Same |
| Postrender / prevalidation | Same |
| Postvalidation / preupload | Same |
| Private object published / premetadata transaction | Same |
| Metadata+completion committed / before queue acknowledgement | **One** render attempt; verify/adopt existing file, one asset |

All seven outputs match the V1 reference at maximum decoded sample error **0** on this Linux runtime (test tolerance0.00015). Source: real encoded synthetic stereo3s440Hz PCM at44.1kHz, not a model output. Output includes308700 stereo frames (7s with FX tails),Exact file size is verified against actual asset metadata, without assuming fixed WAV headers across FFmpeg versions. Exact output SHA256 on this runtime: `bcd151dec249bf54cafdffc4a995a9fb9f838cf5fbc3e6556fb8b249c2292602`. Input SHA256: `8f7c5c108f01deec126acce948671f42454c8345112046fcd6ccf0c3090d3cf0`. The focused evidence prints the actual V1 ID/snapshot SHA and every recovered output checksum/status/attempt count. Local-vs-isolated real decoded FX/audio-control tests remain in the integrated54.

Root typecheck, **production worker** typecheck (`npx tsc --noEmit -p waveyard-worker/tsconfig.production.json`) and production Next build pass. Full lint:0errors/48warnings; changed root FX/API/test files lint clean. The production worker config deliberately excludes legacy unit tests importing absent old web paths/Vitest; it does **not** claim those unrelated legacy tests pass. Exact-head CI now installs isolated-worker dependencies, typechecks production sources, and runs this native/real-Redis lifecycle alongside A7 (isolated Redis DB15, no mock broker).

Additional exact Artifact test vectors in the integrated run:350021-byte Unicode SHA256 `a09f5949ec045ad45f64bdcff0cedf03f50c124e477a208d14403aeea53bc62d`;240000-byte binary SHA256 `93c1f032ee90c7ae77edd4accd37e90ed58dd8cf70474f25478cc4b1d14d10e5`. Actual download/restore/restart bytes are asserted against these vectors, not only against metadata.

## Scope / continue

This establishes **Linux local-private-storage WAV FX** recovery for these windows, including an actual fresh worker process after each kill. It is not S3, host power-loss, genuine neural inference, MIDI-analysis, Electron or Windows acceptance. SIGKILL can leave unpublished private/temp attempt files; they are not certified as assets and no speculative garbage collection removes them. Controlled text adapters/synthetic audio are only protocol/DSP fixtures.

The full Mandate is **not complete**. Continue Mission reusable-output acceptance for larger/binary/failed useful partials through later real tasks and owner/restart faults; independent Studio scale/main-thread/stale-edit/save-reopen and remaining-room workflows; broader private-object reconciliation and remote-provider/runtime checks where available. Do not return to Windows or repeat unavailable model/checkpoint downloads as a prerequisite. Preserve the published cross-room, Orchestrator and Artifact fixes. Do not merge automatically.

---

# Mandate6 — durable work and full private content, 2026-10-19

Second implementation boundary follows `367452fd585a26e8594c01ef212b8f5c19800679`, whose full source regression passed1360/0 and whose exact-head CI run39195600339 passed all four checks. PR15 remains open/unmerged.

## Actual failures fixed and exercised

- Legacy Orchestrator INSERT failure genuinely returned201 with a fabricated memory-only session. The before-fix native-handler log is `/home/user/mandate6-orchestrator-before.txt`. Removed the memory fallback and sticky database-health mode entirely. Migrations own the schema; unavailable reads answer503, not empty/cached sessions.
- Session/participant/initial-relay creation, human response + parent state, complete deliberation batches, and deletion now transact together under parent locks. Write-boundary faults roll back all affected records. Stable client creation/relay UUID keys acknowledge the same durable identities on concurrent retries and reject changed intent rather than overwriting it. Human answer retries are idempotent; conflicting answers receive409.
- Dispatch claims persist before execution. Concurrent Advance requests cannot dispatch the same pending work twice. A full real HTTP-adapter response is atomically retained in the existing private object provider before SQL completion. Both relay/parent publication failures recover in a **fresh application process** after PostgreSQL restart, without another adapter request. Uncertain effects are durable and never automatically replayed; the workbench supports explicit, warned cancellation and complete-response downloads. No exactly-once arbitrary-side-effect claim.
- Workbench failed reloads retain acknowledged work; rejected answers/drafts remain available. Outgoing source context now uses the shared owner/checksum verifier. A previous final envelope slice could discard the end of a valid relay request; it is replaced by an explicit bounded-byte refusal, and the real adapter test verifies the request suffix arrives.
- Large archives now use full private immutable content plus a descriptor inside the **existing Artifact/revision registry**, not a raised SQL body limit or new registry. Inline bodies stay at20,000 UTF-16 code units. Full objects are bounded at32MiB, streamed during publication and verified streaming before download/restore; owner-scoped checksums/size/media type are retained. Pointer manifests are bound by the independently stored body checksum, with canonical serialization surviving PostgreSQL JSONB key ordering.
- Archive + session closure commit together. A SQL failure after upload leaves one retained unbound object; a retry hashes identical work to the same object. Original archive revision identity survives repeated close requests and later Library edits. Archive filing time is revision.createdAt; embedded record.updatedAt is the last work update, not a changing retry timestamp.
- Artifact Library now exposes complete downloads, object size/hash, explicit inline-replacement guidance, history restore, and conservative owner-scoped unbound/incomplete-object inspection. Verified unbound bytes can be recovered idempotently as an Artifact explicitly marked recovered/unknown origin. There is **no automatic object deletion**: history/tombstones, unbound uploads and incomplete writes are retained, not guessed safe to collect. Inventory is bounded to500 files and is not a full-volume integrity audit. Physical keys/paths are not returned.
- New Mission outputs reuse the same content-object contract; historical mission-output storage remains readable. The actual Mission panel still downloads/reuses old revisions after workspace overwrite/restart. Binary/large manifests cannot masquerade as text tool input: text consumers refuse unsupported formats/sizes and direct callers to complete download or `reuse_mission_output`.

## Executed verification

- Integrated actual native-PostgreSQL/HTTP/browser workflow run: **53 passed,0 failed**, `/home/user/mandate6-durable-workflows-verified.txt`. This supersedes overlapping focused runs rather than summing them. Includes ten new Orchestrator cases, four full-content cases, real Library recovery/download/edit/restore controls, existing Mission recovery/output reuse, all four cross-room paths, and existing actual decoded Studio FX/local-vs-isolated-worker workflows.
- Full-content tests exercise large Unicode and binary bytes, exact SHA256/length, interrupted and corrupt streaming writes, SQL failure after upload, concurrent recovery, private ownership, swapped manifests, missing/corrupt objects, restart, history, tombstones and restore with no replacement revision on failure.
- Production build and typecheck pass. Full lint: zero errors,48 warnings. PGlite migration regression: five passed. A full-source attempt exposed missing statement separators in migration0019; that attempt was stopped, the delimiter fixed, and its failing suite rerun successfully. Corrected full source regression: **1360 passed,0 failed**,624.50s, `/home/user/mandate6-durable-source-pg-verified.txt`. Published boundary `7580caa83ad53830a4894867e1eac57446b24afe` has all four checks PASS in exact-head CI39199177329; PR15 comment6259731450 records the evidence.
- Browser evidence is Chromium153, not Electron. HTTP adapter output, synthetic PCM and controlled protocol workers establish contracts, not genuine inference, music-model quality or autonomous reasoning.

## Continue, do not conflate with whole-Mandate completion

Redis7.2.6 was downloaded from the allowed GitHub source and compiled outside Git (BSD license inspected) at `/home/user/arena-test-tools/redis-source/redis-7.2.6/src/redis-server`. The following boundary now executes actual PostgreSQL/Redis/BullMQ FX interruptions, stale-worker publication and completed-media integrity; this older direct-handler boundary did not prove that lifecycle. Then complete the broader Mission/Studio/other-room programme. Private storage here is the actual local provider, not S3/power-loss/exactly-once acceptance. Legacy already-truncated data cannot be reconstructed. No Windows, Electron renderer or genuine model/checkpoint acceptance is claimed, and none is required to continue Linux work.

---

# Mandate 6 — trusted cross-room execution, 2026-10-19

First implementation boundary, based on published `2ad8e33791fce9d6c3aec5440face7ce8c899afe`. PR15 and PR14 were inspected and remain unmerged. No resets or merges were performed; the restored checkout was reconciled against byte-identical published files before editing.

## Reproduced and fixed

- Real Collab POST + native PostgreSQL previously accepted an unpinned Artifact source and executed arbitrary replacement client text. The preserved before/after reproduction changes from HTTP200 to actionable400.
- Battle classic/stream, Collab and Council now share one authoritative resolver. A supplied source must be `artifact:<id>@<revisionId>`; owner, revision membership, required snapshot fields and independent stored body SHA256 are checked before generation or writes. Client preview text is never substituted for pinned content. Omitted/cleared sources explicitly use plain text.
- Results and SQL records retain the actual consumed revision, hash, byte length and owner. Owned tombstones preserve readable pinned history. Current edits, concurrent edits and database restarts do not reinterpret an old pin. Mutable project context is not silently appended to pinned inputs.
- Actual interfaces submit references, explain that preview edits are ignored while pinned, and provide an explicit clear-to-text control. Noncanonical outgoing room outputs now require the actual “Save & send” snapshot acknowledgement before navigation. A browser chain executes Collab → Council → Battle against those acknowledged revisions.
- Room read/mutation routes now enforce API access. Streamed Battle responses explicitly declare UTF-8 and show the authoritative consumed prompt, rather than claiming that an edited preview was executed. The streaming endpoint refuses ephemeral requests instead of silently persisting them; the classic endpoint supports ephemeral execution.

## Executed evidence for this boundary

- Native PostgreSQL and actual HTTP-handler/browser workflow suite: **38 passed, 0 failed**, `/home/user/mandate6-first-workflows-final.txt`. Includes the existing Mission/Artifact/Studio workflows, new four-path revision tests, no-write assertions, actual revision-storage outage, concurrent edits, restart/tombstones, invalid/foreign/unbound/checksum-corrupt references, and the real outgoing cross-room controls.
- Actual room interface focused run: **3 passed**, `/home/user/mandate6-cross-room-browser.txt`. Browser Chromium153 was provisioned through an npm package; this is not Electron/desktop acceptance.
- Typecheck and production build passed. Scoped lint: zero errors, three pre-existing effect warnings. Existing Arcade/Artifact-store migration regression: six passed.
- Full source regression is running against an isolated native PostgreSQL fixture. The first attempt without a live shared database exposed the existing PG-required Archive tests; that attempt was stopped, not counted as passing. The corrected run has its own database (`/home/user/mandate6-first-source-pg.txt`). The first workflow attempt lacked executable npm-packaged FFmpeg/FFprobe and the separate worker dependencies; those environment prerequisites were prepared and the complete38-test run above then passed, without skipping failures.
- Exact commit CI will be tracked in PR15. No auto-merge.

## Limits and next implementation boundary

Inline execution remains bounded at20,000UTF-16 code units/80,000UTF-8 bytes. Oversized pinned content fails explicitly; this is **not** large archive storage. Migration0018 backfills hashes of legacy bodies as they exist at migration time, not proof against historical corruption or a privileged editor changing both body and checksum. Deterministic Local Engine/controlled execution tests are not model-quality acceptance.

A further actual native-PG reproduction has exposed legacy Orchestrator write failures being misreported as request errors, with memory fallback still present in create/read/respond/delete paths. Continue removing those false durable outcomes and proving write-boundary rollback/recovery; then large private-storage archives, actual Redis/BullMQ FX interruption, reusable Mission outputs and remaining room workflows. None of those broader mandates is declared complete. Windows, Electron renderer and genuine music-model acceptance remain unproven; they do not block Linux implementation.

---

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

## Execution-reset continuation — listening session → usable Studio arrangement (2026-10-18)

### Repository reconciliation

Refreshed `main` (`f0e4180`) and PRs #14/#15. The snapshot initially showed the
already-published #15 files as dirty against the old base. Compared every one
of the 20 files byte-for-byte with remote `58121d7` before advancing the local
index/HEAD with a mixed reset; no worktree bytes were discarded or duplicated.
Both PRs were open, with all their reported checks successful (including #15's
browser-audio gate). Those statuses describe the **previous** heads, not this
new patch. No PR was merged or closed.

Read #14's 17-file diff and provisioning/dependency documentation. It is a
separate consent/managed-runtime prerequisite, not an inference result. This
patch does not duplicate it or integrate it on green CI alone. Its checkpoint
host (`dl.fbaipublicfiles.com`) and CPU-wheel index (`download.pytorch.org`) are
outside this sandbox's permitted outbound hosts. Current Python is 3.11.2;
`torch`, `torchaudio`, `demucs`, the managed environment and local models are
absent. No install, checkpoint download, consent, real Demucs invocation or
music-quality acceptance is claimed. Licensing assertions in that PR still
need review against actual upstream terms; do not treat them as verified here.

### Defect and implementation

`sendSessionToStudio` previously selected only the first real stem per song,
created no clips, and committed the new project/remix outside the track
transaction. The derived project owned no assets, so project GET returned no
stems and `ProjectWorkspace` could not mount Studio. Arrangement PUT and the
actual WAV renderer rejected the referenced library audio as out-of-project.
The old test checked IDs/count only, not a usable arrangement.

The handoff now:

- Keeps all separated lanes (or one explicitly selected unseparated bridge,
  never the bridge mixed on top of separated stems).
- Creates sequential, duration-bounded clips in listening order and preserves
  saved per-stem levels. Timed donor swaps become real source-range clips.
- Atomically creates project, remix, lanes and clips. Empty/oversized sessions
  are refused before writes; missing/short swap assets are refused by song.
- Enforces the existing shared 32-lane/256-clips-per-lane editor limits rather
  than creating arrangements the save/version parser cannot accept.
- Resolves project-native audio plus already-bound remix/clip/immutable-version
  references through `projectAudio`. Assets and source records must still
  belong to the destination project's owner. Arbitrary other-project clip IDs
  are not granted merely because the current user owns them. No audio files
  or source/stem rows are copied or reparented.
- Uses that resolution in workspace reads (including existing analysis and
  waveform metadata), remix reads/saves, creation, version restore and the
  desktop WAV renderer. Immutable versions retain reuse after live lanes
  have been removed/replaced.
- Shares the handoff result type with the client, fixing the old `refused`
  string-versus-array mismatch. A visible notice and persisted project
  description explain that **live transition triggers/crossfades and the
  playback cursor are not reconstructed**. This is a sequential derived edit,
  not a claim of performance-session fidelity.

### Repeatable evidence

```sh
# Normal npm install scripts hydrate the packaged PostgreSQL libraries.
# If dependencies were installed with --ignore-scripts, run the package's
# scripts/hydrate-symlinks.js from its own package directory and restore the
# ffmpeg/ffprobe platform executables' execution permission first.
WAVEYARD_ACCEPTANCE_ARTIFACT_DIR=.data/acceptance/waveyard-handoff \
  npm run test:acceptance:handoff
```

This uses the existing library service suite: a fresh embedded PostgreSQL
cluster, canonical desktop migrations, isolated storage, actual route handlers,
actual desktop local-job broker, actual FFmpeg rendering/FFprobe decoding and
actual streaming download responses. It does **not** launch Electron or a room
UI. The inputs are explicitly synthetic PCM-tone fixtures, not alleged Demucs
results. Test fixture engine metadata now says `synthetic-test-fixture`.

The suite checks all five lanes and six clips (including the timed swap),
project assets needed to mount the editor, individual stem download bytes and
non-silent decoding, save/reopen with changed master level, rejection of an
unbound same-owner asset without damaging the saved edit, version creation,
WAV export queue execution, download/decoding, restoration from immutable
versions after deleting live lanes, and survival after deleting the original
listening session. Additional cases cover the explicit source-only bridge,
empty/foreign-owner/lane-limit refusals, genuine PostgreSQL-trigger write
failure rollback, foreign-owner bound-reference exclusion, and malformed
legacy snapshots. These are route/service/render tests, not browser clicks.

Observed exported WAV: **5 seconds, 44,100 Hz, stereo PCM16**. Decoded magnitude
at 220 Hz before swap ≈ **0.05179**, at donor 880 Hz after swap ≈ **0.05179**,
next song at 880 Hz ≈ **0.03237**; unwanted donor before swap, original drums
after swap and muted vocals each **< 0.000001**. This checks real signal and
timeline content, not merely HTTP success, file existence or a nonzero RMS.

`handoff.json` retains observed time, exact implementation file SHA-256 values,
Git head **and dirty status** (so a pre-commit run cannot misattribute its
source), runtime/version, actual input digests, durable job/export provenance,
decoded signal measurements and limitations. The output WAV and individual
drum WAV are retained alongside it. CI's existing test step now retains these
artifacts **and full test output even on failure**. Generated outputs remain
outside Git. The new CI run must be observed separately after publication.

### Still not accepted

This repairs a previously unusable handoff and exercises its save/render path;
it does **not** establish full Waveyard acceptance, STEM.FM/STEM DAW parity,
model inference, subjective audio quality, Electron/Windows operation, or
browser-room navigation/restart behavior. Some advanced source-analysis actions
(section placement, meeting-point application, alignment and project-derived
processing) still enforce project-native provenance independently; carry the
same authorized-reference semantics through those paths with their provenance
tests rather than loosening every `projectId` comparison. Live transitions need
a separately defined and persisted timing contract before claiming faithful
handoff. Real-provider Arcade playability, agent-dispatched investigation and
the whole-room acceptance inventory remain open; prior text-review fixes do
not satisfy those requirements.

### Verification of this patch

- Final handoff/library integration run: **26 passed, 0 failed, 0 skipped**.
  Temporarily substituting only the original `58121d7` handoff implementation
  into the same final suite produced **22 passed / 4 failed** (bridge clips,
  multi-stem/render workflow, lane-limit refusal, atomic rollback). Repaired
  source bytes were restored in `finally` and the final suite rerun green.
- Focused remix/versioning/render-helper/session-logic tests: **33 passed**.
- Local worker suite: **42 passed, 0 failed, 0 skipped**; the initial 180-second
  tool wait expired, but the same process finished at 182.4 seconds and its
  final summary was read afterward. It was not launched twice. Includes real
  ONNX Runtime with a hand-built identity model and controlled deep-engine
  cases; **neither is learned Demucs/music-separation acceptance**. Some tests
  overlap the focused invocation above; do not sum them as distinct cases.
- Final production build and typecheck: **passed**. Full lint: **0 errors,
  46 existing warnings**. `git diff --check`: passed.
- Logs retained outside Git under `/home/user/arena-handoff-*.txt`; generated
  manifest/mix/individual-stem files under `/home/user/arena-handoff-evidence/`.
- No browser-room, Electron, packaged Windows, provider-backed Arcade, or
  agent-dispatched investigation acceptance was executed in this patch.

## Continuous-execution continuation — referenced editing and staged runtime (2026-10-18)

### Reconciliation, not a restart

Refetched `main` and the session branch. Main is still `f0e4180`; PR #15 is
`f814e2f`, open, with all checks successful on that exact head (including run
39115409407). PR #14 remains open at `536c940`. Its 17-file diff was refreshed;
no provisioning implementation was duplicated and neither PR was merged.
The restored snapshot again presented published files as dirty against the
old base. All 30 files matched remote bytes before a mixed reset advanced the
index/HEAD. No differing user work was discarded.

### Actual repairs

1. **Referenced beat alignment and section editing.** Reproduced a 422 from the
   real alignment route against a valid handoff stem. Alignment now resolves
   the existing authorised `projectAudio` relationship, including a timed
   donor clip whose source differs from its lane's original stem. Source,
   analysis, checksum and original-project provenance still have to agree.
   Section placement/looping uses the same authorised membership, then checks
   the complete original-source/analysis/section chain. An unrelated same-owner
   stem is not a grant, and stale checksums cannot modify the edit. The pure
   section scope helper now names its argument `audioProjectId`: destination
   membership is established by the server, not by pretending all records
   were reparented into the derived project.
2. **A deliberate handoff choice, with current controls.** Clicking Send to
   Studio now presents a choice BEFORE creating anything, explaining that
   the sequential edit is not a recording of live triggers/crossfades/cursor.
   Cancel retains the listening session. The route requires explicit
   `mode: "sequential"`; old/no-mode calls receive a recoverable confirmation
   response, not a silently lossy arrangement. The accepted request carries
   the visible per-track edits. These are validated against session membership
   and saved atomically with the derived arrangement. A just-changed slider
   no longer depends on the 600ms autosave timer winning the race. Failed
   creation rolls back those edit writes as well. The existing desktop runner
   was updated to exercise both refusal and the explicit choice.
3. **Real queue waits, not cached completion.** A second render exposed that
   LocalJobBroker cached the first drain Promise forever. It could certify new
   work from an old success, or permanently reuse a timeout. Each wait now
   observes current work. Both cases reproduced as failing regressions before
   the fix and pass afterward.
4. **Trustworthy staged source identity.** The old package guard hashed only
   HEAD + porcelain status: changing an already-dirty file's bytes did not
   invalidate a staged package. Two tests reproduced this false match.
   Identity now includes tracked/unignored source bytes, executable bits,
   deletions and symlink targets; generated ignored artifacts remain excluded.
   Tests are included in the normal npm test command. After desktop staging,
   full lint also incorrectly traversed copied compiled/vendor code (62
   errors). Excluded generated desktop-package/release/dist trees, not desktop
   source or source rules. Source lint returns to 0 errors/46 warnings.

### Executed evidence and limits

- Existing handoff + new edit/render integration: **27 pass / 0 fail / 0 skip**
  with real isolated embedded PostgreSQL, canonical migrations, production
  handlers, queue and FFmpeg. Before the referenced-edit repair: **26 pass /
  1 fail**, returning the original 422. Existing handoff/render cases remain.
- The new edit is saved/versioned/rendered as a **6.872-second** PCM WAV.
  Decoding checks silence before the moved clip and in a gap, 220 Hz in the
  moved original, 880 Hz in the donor range, then 220 Hz in BOTH placed/looped
  sections. Actual magnitudes are about 0.25895 in audible windows and below
  0.000001 in the gaps. This is signal-content verification, not file counting.
- Focused section/transition/broker tests: **36 pass / 0 fail / 0 skip**.
  Broker comparison alone: old 5 pass/2 fail; fixed 7 pass/0 fail.
- Source-identity and music-runner CLI tests: **4 pass / 0 fail / 0 skip**.
  Identity comparison alone: old 0 pass/2 fail; fixed 2 pass/0 fail.
- Fresh standalone desktop staging and the existing real supervisor E2E
  executed **57 successful checks**, including upload, honest missing-engine
  failure, actual analysis/waveforms, explicit unseparated bridges, export,
  session handoff, referenced alignment, save, shutdown and restart. The new
  derived alignment and master level survived restart. **This is the actual
  desktop service kernel against the staged distribution, NOT Electron UI
  acceptance.** Inputs remain deterministic fixtures, not separation proof.
- Electron smoke compiled the shell but failed to launch: the Electron binary
  is absent after the dependency installation. Failure output was retained;
  no inaccessible download was retried. No Windows acceptance exists.
- Typecheck passed; lint 0 errors/46 warnings. Build is also exercised by
  desktop:prepare-server. Logs: `/home/user/arena-next-*`,
  `/home/user/arena-edit-{before,after}.txt`, `/home/user/arena-broker-*.txt`,
  `/home/user/arena-identity-*.txt`. Audio/manifest evidence:
  `/home/user/arena-next-evidence/`. These generated files are outside Git.

### Reproducible real-music boundary on a prepared host

Added `scripts/waveyard-real-music.mjs` (no alternate inference implementation):

```sh
npm run test:acceptance:music -- \
  --url http://127.0.0.1:PORT \
  --input /absolute/path/to/authorised-real-music.wav \
  --checkpoint /absolute/models/5c90dfd2-34c22ccb.th \
  --out /absolute/evidence/new-unique-run --real-music
```

Run against the already-running, prepared LOCAL Arena instance, after the
user's normal preparation/consent flow. This does not install anything or
accept terms. It verifies the production checkpoint prefix before contacting
Arena; creates an identifiable new project; uploads the caller's real music
with `deep_6s`; waits for the actual durable job; checks all six model/version
attributions and input checksum; downloads/checksums/decodes each stem; builds
and saves a remix from those exact stem IDs; versions, renders, downloads and
decodes the mix; verifies duration/signal; and exercises immutable restoration.
It retains the project and evidence on success AND failure and refuses to
replace an existing evidence directory. No synthetic or identity fallback is
provided. Its CLI/invalid-checkpoint/target/evidence-protection paths were
executed; **the genuine-inference path has NOT run here**. This is an API/audio
acceptance command, not proof of UI interaction, restart, subjective separation
quality or Electron. Demucs version is retained in output modelVersion; capture
the actual server torch/torchaudio versions separately on the capable host.

### Concrete unfinished work (not hidden by this delivery)

The checkpoint and CPU wheel hosts remain outside this sandbox's allowed
network; no trained checkpoint, torch, torchaudio or Demucs is installed.
PR #14's positive provisioning/inference path still requires a capable host;
green doubles are not that evidence. Do not mark Priority 1 complete.

The full transition history/timing/cursor contract is still missing. This
patch implements the required user-controlled lossy choice, not faithful live
performance reconstruction. Source inspection also found a separate hard-cut
bug: `beginTransition` calls `finishTransition` without creating fade state,
while `finishTransition` immediately returns on null fade state. Reproduce it
in the actual session UI/audio runtime and repair it with an interaction
regression next. Meeting-point/placement and project processing paths still
have independent project-native restrictions; alignment/section repairs do
not silently claim those are solved.

Arcade provider-backed generation/gameplay, agent-dispatched authorised repair,
and the remaining rooms were not executed or promoted to accepted this cycle.
`docs/capability-expansion-investigation.md` was read; its earlier capability
and test claims remain historical investigation, not this cycle's proof.
Next highest-value boundary: actual session transition interaction and real
music through the prepared engine/desktop UI, preserving the same model outputs
through editing/export; then real-provider Arcade and the connected agent
execution loop, rather than another parallel capability registry.

## 2026-10-18 continuation: actual session lifecycle repair

Reconciled PR15 `aad7db2`, PR14 `536c940`, and fetched main `f0e4180`; neither PR merged. At `aad7db2`, CI is **mixed**, not uniformly green: run 39119716173 passed all four jobs, duplicate push run 39119714913 failed A7 job 117652648246. Both `gh run view --log-failed` and the job-log API redirect failed with EOF to externally hosted logs. Added retained A7 TAP evidence for future runs; this is diagnostic instrumentation, **not** a diagnosis/fix of that older failure.

Reproduced against the actual `SessionExperience` and `useStemTransport` in Chromium 153.0.8010.0, before patching: **0/3 passed** (`/home/user/arena-session-before.txt`). Hard cut left Song A current; timed fade advanced the heading but lost incoming audio; missing incoming audio had no actionable failure status. This is a controlled HTTP session fixture with deterministic 220/440/880Hz PCM, **not** real database/inference/Electron acceptance. It invokes the real controls, HTML media, and Web Audio graph, sampling the actual master analyser (not a fabricated meter).

Implemented explicit checked hard-cut completion, stable physical keyed decks under a single parent (promotion no longer reloads/stops the incoming transport), immediate current/deck restore identity, boolean play outcome, synchronous master-gain intent, generation-scoped pending starts, cancellation and queue-replacement invalidation. Pause/stop cancel both decks; freeze still holds a live mix, but pause stops both and resume restores the current mix. Added real position/stop controls and the controlled-range seek fix discovered while executing recovery tests. Natural end reuses checked promotion without replaying the outgoing track. Persisted state contains no transient fade.

`test:acceptance:session`: **9 passed**, including consecutive cuts, timed fade with two audible masters then correct incoming frequency, reload, missing/rejected starts, pending-start cancellation/late asset arrival, replacement during fade, pause/seek/stop, freeze recovery, natural end. Shared transport suite: **11 passed**; combined run **20 passed** (not additive with the previous 10 transport checks). `/home/user/arena-session-transport-final.txt` retains browser/version/source hashes and evidence limits. No renderer exceptions. `npx tsc --noEmit` passed; full lint completed with no errors; current handoff suite **27 passed** (synthetic PostgreSQL/API/FFmpeg) at `/home/user/arena-session-handoff.txt`, artifacts `/home/user/arena-session-evidence`; session-logic/broker subset **30 passed** at `/home/user/arena-session-focused.txt`. Fresh staging/desktop/current-head CI still required after remaining implementation.

Browser preparation changed strategy, not a repeated blocked download: externally installed npm `@sparticuz/chromium@153.0.0` under `/home/user/arena-browser-tools`, extracted its packaged browser and AL2023 NSS libraries. Local command: `LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium npm run test:acceptance:session`. No product dependency on that external browser package. CI uses its existing Playwright browser installation and now runs the actual session suite and retains its TAP.

Real-music prerequisites rechecked: Python 3.11.2; no torch or demucs module, no checkpoint or authorized real music supplied/found in the workspace. No provider credentials are configured in this process; the app's browser-held BYOK values are not available to this agent. Do not substitute these PCM fixtures for music, infer successful codegen, or download/accept model assets to bypass those blocks.

### Arena-owned execution contracts (continuation after session fix)

Investigated existing repoMap/read-only toolRuntime, approved tool effects, Deep Agent (explicitly research-and-draft only), and the existing Spaces mission dispatcher/real workspace tools/governance. Did not bolt on another agent or grant arbitrary repository execution. Five new contract regressions first failed **0/5** (`/home/user/arena-agent-before.txt`): nonzero command exit marked successful; failing/absent tests marked successful; `done:true` overriding test failure; exhausted turns claiming completion; memory retrieval returning a raw DB-row journal instead of the public summary shape.

Repaired shared command/test failure propagation on host and container adapters; completion now requires explicit protocol completion with no unresolved failures owned by that role, including across approval checkpoints. A failed action is cleared only by a successful retry of that exact action signature. A disconnected publish or a denied required external call now remains incomplete, not done; updated the older tests that asserted those false successes. Approval gates and single-claim rules remain intact. Each completed tool observation is saved before the next effect, and memory retrieval uses the same summary conversion as SQL. Existing mission API/store path remains authoritative; added an alternate real SQL connection dependency consistent with Deep Agent's testing seam, with no silent memory downgrade for that explicit connection.

**55 Spaces tests passed** (`/home/user/arena-agent-all.txt`), including the five new contracts (not 55+5). The repair-loop contract actually searches/reads a buggy source module, runs an unchanged invariant test (real failure), edits the source via `edit_file`, reruns the same test (real success), saves intermediate observations in SQL before the next reply, closes/reopens the file-backed PGlite database, and retrieves the two-turn transcript. Controlled replies drive this test; this is **not genuine model reasoning or Arena repairing its own repository autonomously**. Evidence `/home/user/arena-agent-evidence/*.json` includes limitations, source hash, unchanged invariant hash, repaired source, and the retrieved transcript. Typecheck passed and touched-file lint had no errors. PGlite durability is not embedded desktop PostgreSQL/Electron acceptance.

Arcade's two substantially distinct descriptions (word-grid tactics; gravity-switching pinball rescue) were sent through the actual forge with `localOnly:true`. Both honestly returned `noModel:true`, not template/codegen success; `/home/user/arena-arcade-current-blocker.txt`. No genuine configured provider was available in this process. This establishes failure behavior only: **no new gameplay/progression/iteration/save/reopen acceptance**. Browser-held user keys were neither requested nor accessed.

Remaining-route source inventory: **62 actual page routes** under `src/app`, including dynamic room/session/project/watch routes. This is an inventory, **not 62 accepted rooms**. Shared high-impact work this cycle addressed Waveyard session execution and Spaces command/test outcome + transcript persistence. Other room outcomes, native processing authorizations, faithful live-performance Studio reconstruction, genuine real music and own-agent/provider workflows remain open. Before broadening repository-write authority, audit the existing approved-effect integrity/path contracts; no new authority was added here.

### Full staged UI uncovered a second runtime blocker

At clean staged `b1808b3`, executed the complete session page against the real standalone Next server and embedded PostgreSQL (no mocked HTTP). It crashed before showing its decks: `Cannot read properties of undefined (reading 'id')`. Browser stack led to library options: the production `/api/library/tracks` returns flat `TrackSummary[]`, while the controller incorrectly read `option.track.id`. The earlier isolated fixture's empty library hid this defect. Failure report `/home/user/arena-runtime-ui-desktop.json` and screenshot retained (initial failed attempt; will be replaced by an explicitly identified later run).

Changed the isolated fixture to the real nonempty flat library shape: the existing hard-cut test went red (`/home/user/arena-session-library-before.txt`). Corrected option handling and used a type-only `Pick<TrackSummary,...>` rather than another duplicate shape. All **9 session tests** then passed at `/home/user/arena-session-library-after.txt`; typecheck/touched-file lint passed. Added opt-in `npm run desktop:e2e -- /path/report.json --browser` to run actual staged UI controls, two real master analyser signals, hard cut, timed crossfade, queue recovery, real saved-state reload and playback, with screenshot. Browser is required when requested; failure is not skipped or turned into a headless substitute. Full UI re-execution on the corrected staged tree is pending at this paragraph's revision.

At `b1808b3`, both current-head CI runs **39122285572 / 39122282289 passed all four jobs**, including A7, browser session+transport and Compose. This does not erase the earlier `aad7db2` A7 failure, whose externally hosted logs remained unavailable. Fresh b180 staging and headless supervisor E2E **57 passed**, `/home/user/arena-runtime-desktop.json`; this is not yet the corrected library-UI revision. A bare local `npm test` completed after the tool's 180-second wait expired (not rerun): 1266 pass / 23 fail / 10 skip, 558.8 seconds. This run lacked the shared test PostgreSQL prerequisites, unlike CI; inspect `/home/user/arena-runtime-all-tests.txt` rather than report a local full-suite pass. New implementation-focused checks and properly provisioned CI are reported separately, not added together.

### Full staged UI execution result / delivery evidence

At clean committed **d7af43d484e26fe90ef335190ec17e06e394cf08**, freshly rebuilt/staged installer tree, executed:
`LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium npm run desktop:e2e -- /home/user/arena-runtime-ui-final.json --browser`.
**58/58 checks passed** (the earlier 57 plus one compound browser workflow; do not add these counts). This is the real staged Next application, real production HTTP handlers, real embedded PostgreSQL, real HTML media/Web Audio, real FFmpeg, and actual supervisor shutdown/restart. **Not Electron**. Browser actions: play source A (440/1320Hz); actual hard-cut control advances to source B (660/1760Hz); stop/jump back/play; actual one-second crossfade hears both graphs then promotes B (observed 1210ms including control/assertion overhead); real persisted session reload starts paused and plays B correctly. Zero renderer exceptions. Actual master RMS approximately 0.031; observed dominant bins 1313.5Hz for A and 1765.7Hz for B. Screenshot `/home/user/arena-runtime-ui-final.json.session.png` was visually inspected. It correctly labels playback as full source/not separated. Report includes the source-identity guard, browser version, observations and evidence limits. It then completes the existing authorized sequential handoff, referenced edits/alignment and supervisor restart checks. This is synthetic passthrough-source evidence, **not real music, learned six-stem inference, faithful live-performance reconstruction, or subjective quality**.

The 23 bare-local full-suite failures were individually inspected: all reported missing shared PostgreSQL prerequisites (Archive native context/lineage/chat, email accounts/scanning, local-media library, sync/reconciliation/native bridge). Do not count them as passes or erase them: `/home/user/arena-runtime-all-tests.txt` retains the complete failing run. Both provisioned CI runs at b1808b3 passed their static/full-test/build gate; d7af43d new-head CI was still running at this note's write. Final PR evidence must report the actual latest checks, not reuse the older green SHA.

Electron smoke was re-executed and failed because the Electron binary is absent (`/home/user/arena-runtime-electron.txt`); no repeated binary download was attempted. There is no Windows installed-app run here. The real-music CLI was inspected (`--help` only); no prepared genuine model/checkpoint/authorized music input is available, so the positive command was not run. Arcade provider/gameplay/iteration and genuine own-agent repository repair remain unaccepted for the same missing provider/model environment. Remaining room-level useful outcomes and native processing authorization work are still open. Highest next targets: prepared-host real music through UI/Studio/export with retained source/output identity; genuine Arcade/provider gameplay and own-agent repair; approved-effect integrity audit before additional execution authority.

This last evidence-only note changes source identity too. Restage and rerun the guarded browser/supervisor command after committing it; the resulting report's identity step names the exact delivered commit. Keep that result in the PR evidence rather than repeatedly changing source notes merely to insert their own commit hash.

### Final adjacent fade defect: implicit unity and source-only audio

A stricter mid-fade check found that newly created sessions save `stemMix: {}` (implicit unity), but the fade iterated only explicit keys. Incoming audio faded in while outgoing audio stayed at unity until its final stop. Source-only audio without a passthrough bridge also had no stem row to address for gain. Two targeted regressions failed at the mid-fade attenuation assertion on the prior implementation (`/home/user/arena-empty-mix-before.txt`, **0/2**; thresholds use measured browser RMS and exclude initial graph startup). Fixed by expanding the outgoing envelope over every audible playback asset/type with default unity, and applying gain to actual playback assets including source-only IDs. **22/22 combined browser checks passed** (`/home/user/arena-default-mix-after.txt`: 11 session + 11 shared transport, not additive with prior 20). Typecheck and touched-file lint passed. Strengthened the full staged UI probe to require measured outgoing attenuation as well as incoming signal before promotion; final commit must be restaged and rerun with that stronger assertion.

Also re-executed the five PG-dependent suites responsible for the bare-local run's 23 failures, this time with a freshly initialized actual embedded PostgreSQL and canonical Drizzle schema: **33/33 passed**, `/home/user/arena-delivery-pg-recheck.txt`. This demonstrates the missing-DB prerequisite cause for those cases; it does not turn the original failing full run into a passing one or establish room-level acceptance for Archive/email/media.

At 9fc95f4, push CI 39123198657 passed all four jobs. Duplicate PR CI 39123201561 failed during **Clean dependency install**, before A7/schema/tests; its browser and Compose jobs passed. Raw job logs redirected to a blocked external Azure host; annotations give only exit 1 and missing A7 TAP (the test never ran). Do not call this a diagnosed application failure or silently label it a flake. Job rerun was unavailable while that run was active. Final PR evidence must use the new head after this fade repair, preserving that failure history.

### Actual handoff navigation (not merely a successful endpoint)

Continued through the real supported session UI's explicit sequential-handoff dialog at clean staged 6b67659. Creation succeeded, but clicking **Open it in the Studio** landed on `/waveyard/create?project=…`, whose new-upload page ignores that query. No editable arrangement appeared. Real-server failure `/home/user/arena-handoff-ui-before.{json,txt}`; this was not a mocked link test. Corrected the destination to the existing `/waveyard/projects/[id]` workspace, preserving the explicit loss decision. Added the focused controller navigation regression and strengthened the full staged browser workflow to click the real handoff dialog/link and require the actual Studio **Save now** control and remix timeline, plus a Studio screenshot. Combined browser suite **23 passed** (12 session + 11 transport), `/home/user/arena-handoff-navigation-after.txt`; typecheck/touched-file lint passed. Final fresh-stage execution below remains the authoritative full UI result; do not infer it merely from the controller test. Full Studio edit/version/export UI and genuine music still require their own acceptance beyond opening the referenced arrangement.

### Continued Studio edit → version → render exposed a real stereo export failure

The first corrected-route UI assertion omitted the workspace's supported **Studio** presentation tab (default is Play). Kept its failure report; then used the actual tab and verified the editable arrangement at `/home/user/arena-studio-tab-verified.{json,txt}`. This was a probe correction, not another product crash.

Continued real controls: changed Master to 0.4, clicked Save now, reloaded workspace, selected Studio again, verified restored 0.4, and created a named immutable version through its real prompt/control. Requested its export through the production API (not an invented export button). That job **failed**: bundled FFmpeg 4.1 could not negotiate `Parsed_amerge_14` channel formats for the two delayed stereo inputs. `/home/user/arena-studio-edit-export.{json,txt}` retains the actual failed job/error. Existing mono render fixtures did not reveal it.

Added a real bundled-FFmpeg regression with two stereo WAVs, the production filter helpers, delayed clips, and a 0.4 master. It failed on the old helper with the same amerge error (`/home/user/arena-stereo-render-before.txt`, 0/1). Reasserted stereo layout after pan/delay/padding at the merge boundary without changing source files, timing, IDs or gain. **11 render-helper tests passed** (`/home/user/arena-stereo-render-after.txt`), including decoding the full 2-second export and measuring 220/440Hz amplitudes 0.07071±0.001 at their expected positions. Current PostgreSQL/API/referenced-render suite remains **27 passed**, `/home/user/arena-stereo-handoff.txt`; typecheck/touched-file lint passed.

Expanded the opt-in staged browser workflow to include Studio-tab selection, real master edit/save/reload/version, production API render/download, FFprobe, PCM non-silence/duration, downloaded SHA256 and bound source IDs, and a retained WAV. This is still **synthetic passthrough-source** acceptance; no claim of real learned stems, subjective quality, faithful performance reconstruction, or an export-button interaction. Fresh final staging/runtime execution and exact-head CI are authoritative after this commit.

### CI evidence must not mask failed acceptance through tee

Final workflow review caught an evidence-gate problem: an unspecified GitHub bash shell uses `-e` without guaranteed `pipefail`, so the A7 and browser TAP `| tee` steps could report a successful job after failed tests. Added workflow-wide explicit `shell: bash` (GitHub runs it with `-e -o pipefail`) for all four Linux jobs. Executed the failing-pipeline comparison: old template exit 0, explicit-bash contract exit 1 (`/home/user/arena-ci-pipefail-proof.txt`). Static full-test step already set pipefail. Treat older A7/browser job-success statuses as statuses, not proof of their TAP contents; the new exact-head runs with enforced failure propagation are the delivery gate. No intentionally failed acceptance was changed to pass.

Before this workflow-only correction, clean staged **42a33a0e69f8c7661cdd26cdb809b2753efa96f3** completed all **58** guarded checks with the full expanded UI workflow: explicit handoff → correct project route → Studio tab → master 0.4 edit/save/reload → named UI version → actual API render/download/decode. `/home/user/arena-verified-desktop.json` and screenshots/WAV retain the result. Export is **24.000s, 44100Hz stereo PCM s16le, RMS 0.0088367**, SHA256 `e9fb68579ba8555f24215888177b37ca1dea799290f73f41354b05ee0a1fc57a`, with the two original bound asset IDs in the report. Zero renderer errors. Final source must be freshly restaged even for this workflow/evidence-only commit; final PR result names that new source stamp without another self-referential notes commit. Spaces **55 passed** again at `/home/user/arena-agent-final.txt`; full lint 0 errors/46 warnings; typecheck passed. Genuine music/provider/own-agent/Electron/Windows and remaining room acceptance limits above are unchanged.

## Mandate 3 — prepared-host boundary and approved file effects (2026-10-19)

Baseline reconciled against live PR15 `0488a70ba2316d9021e5d647c56fd7dce3e5ae42`: all remote tracked files byte-identical before index/history reconciliation; no file overwrite. PR15 and PR14 remain open/unmerged. Prior CI results apply only to that baseline, not this patch.

### Actual environment and execution
- Python 3.11.2; neither torch nor demucs installed. No authorised music/checkpoint positively identified in the targeted local search; no prepared `.data`. `npm run test:acceptance:music -- --help` executed; genuine music acceptance NOT executed. No weights/substantial model installs attempted.
- Normal `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund` failed on ONNX Runtime download from api.nuget.org (ECONNRESET). Changed strategy: `npm ci --ignore-scripts --no-audit --no-fund` succeeded (745 packages); native runtime preparation is NOT thereby verified. Logs outside Git: `/home/user/mandate3-install{,-safe}.txt`.
- Installed Electron package 44.7.0 has no npm lifecycle install script. Its lazy `index.js` and explicit `install.js` do not honour the previously documented skip-binary variable. Corrected `.npmrc` advice. New doctor and launcher inspect the package/path without importing that downloader. Explicit `npm run desktop:prepare-electron` is the opt-in official checksum-validating installer; it was NOT run here. `npm run desktop:doctor` fails accurately for absent binary and absent Linux display. `npm run desktop:smoke` compiles desktop but fails before GUI launch. Logs: `/home/user/mandate3-electron-{doctor,smoke}.txt`. No Electron or Windows acceptance claimed.

### Integrated implementation and evidence
- Added no-download Electron preflight, opt-in preparation, and a direct verified-binary launcher; smoke uses the same launcher. Removed inherited ELECTRON_RUN_AS_NODE before GUI spawn. Preflight explicitly is not UI acceptance.
- Approved local-file effects now recompute the digest of the actual operation before writing; resolve/check the canonical parent even for missing target files; preserve legitimate create/edit and stale-preimage handling. Claimed effects that reject during apply now finalize with a durable failed row/event rather than remaining applying.
- Reproduction: `node --import ./scripts/register-src-loader.mjs --test src/lib/toolEffects-safety.test.ts` initially **1 pass / 3 fail** (changed content, changed path, escaping symlink parent). Retained `/home/user/mandate3-effect-before.txt`.
- Final: `node --import ./scripts/register-src-loader.mjs --test src/lib/toolEffects-safety.test.ts src/lib/toolEffectService.integration.test.ts` **7 pass / 0 fail**, including database-backed persisted tamper rejection, unchanged file bytes, durable failed event, and retry refusal. `/home/user/mandate3-effect-final.txt`. This is local filesystem/PGlite evidence, NOT autonomous real-model acceptance.
- `node --test scripts/lib/electron-host.test.mjs`: **3 pass**, controlled host probes only (`/home/user/mandate3-host-tests.txt`). These counts are separate, not an end-to-end total.
- `npx tsc --noEmit` PASS; targeted ESLint of changed desktop scripts/host tests/effect modules/tests PASS. No full build/full-suite rerun or new CI result at documentation time.

### Explicit remaining scope / next execution
Faithful live-session transition reconstruction, real provider Arcade generation/iteration, real-model own-agent investigation, and further room workflows remain open. No provider run was established this cycle. The file-effect change is defense in depth, not an OS sandbox: hostile concurrent directory/symlink mutation, process crashes between filesystem rename and DB finalization, and general execution isolation remain outside this regression proof. Do not label the entire approval/runtime boundary secure or the mandate complete. Next useful capability: inspect and implement faithful transition persistence/reconstruction, while awaiting a prepared host with authorised music/checkpoint and a usable Electron display. Preserve genuine stem identity once inputs exist; do not substitute synthetic evidence.

## Linux-first continuation — completed session transitions (2026-10-19)

Baseline `f0411cbc8166474bfdcf076e02e46e845d0ec7db`: live PR15 open; both CI runs `39170919341` and `39170916140` now all four jobs SUCCESS. Those results do not cover the changes below.

Implemented a backward-compatible optional completed cue in the EXISTING session transition JSON: outgoing/incoming source-clock positions, next session-track identity and physical deck identity. Successful full crossfades and hard cuts capture/save it through the existing track PATCH route; failed starts/cancelled or forced-shortened fades do not masquerade as completed full envelopes. Editing transition controls clears the old cue. Handoff now offers completed-transition reconstruction (default prominent choice) and a separately explicit sequential edit. Missing, reordered or impossible cues refuse rather than silently guessing or dropping tracks. Old sequential API clients remain supported.

Reconstruction uses EXISTING remix clips and track volume automation: consecutive overlaps/hard cuts, incoming source offsets, held outgoing stems, saved stem levels and timed donor changes. Lane-wide envelopes continue across donor clip boundaries. No schema migration/second arrangement format. Source and stem ownership checks remain. Original session identity/configuration and saved cursor retained in derived project provenance; cursor is a bookmark, never autoplay. Pauses, seeks, cancelled/forced-shortened fades and live mix gestures are not a complete performance recording; only completed supported cues are reconstructed.

Executed evidence so far (working tree on f0411cb; final exact-head execution follows separately):
- Initial real integration attempt blocked by ignored lifecycle preparation: PostgreSQL `libpq.so.5` links absent, then FFprobe not executable. Ran only shipped PostgreSQL hydration script and chmod on installed FFprobe; no binary/model download. This exposed a restore-script defect: hydration is skipped when tsc already exists. Repair next.
- Regression after those preparations: `node --import ./scripts/register-src-loader.mjs --test src/lib/waveyard/library/service.test.ts`: 27 pass / 1 fail, new transitions request rejected 400. `/home/user/transition-before.txt`.
- Implementation integration: same suite 28 pass, including real PostgreSQL migrations, cue persistence, mixed crossfade/hard-cut, source offsets, donor change during fade, save/reopen, immutable version/restore, actual local queue FFmpeg export/download/decode. `/home/user/transition-after.txt`; synthetic WAV and measured frequency/gain evidence `/home/user/transition-evidence/` (outside Git). Test being expanded with no-side-effect missing-cue refusal and actual PATCH validation; rerun required.
- `session-logic.test.ts` + `session-arrangement.test.ts`: 26 pass (includes existing tests, not additive with full suite). Consecutive crossfades/held stems/ranges/invalid cue/deck checks.
- Actual Chromium153 UI/WebAudio on controlled HTTP fixture: 13 pass, including new completed mixed-transition capture/reload/handoff test. `/home/user/transition-browser.txt`. Explicitly not PostgreSQL or Electron acceptance. External npm browser tooling under `/home/user/arena-browser-tools`, not a product dependency.
- Typecheck, targeted lint and `npm run build` passed before the latest test/harness expansion. Installed ONNX native binding now explicitly loads successfully; no model or inference verified.
- Staged browser/API/PostgreSQL execution is next; harness now chooses completed-transition handoff and verifies source offsets, unchanged automation and cue-derived rendered duration rather than the old fixed sequential duration. Do not claim this staged path passed until executed.

Genuine music/checkpoint inference, real-provider gameplay/autonomous reasoning, Electron GUI and Windows remain separate open layers. None prevents further current-host engineering.

### Executed transition checkpoint: 644373a11ed5a9cd277a2beac7f2674024d146af

`npm run desktop:compile && npm run desktop:prepare-server` PASS. Then `LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium npm run desktop:e2e -- /home/user/transition-staged.json --browser` PASS, 58 recorded staged checks (not an additive unit-test total). Guard verified exact commit/source digest and self-contained staged tree. Actual browser/session hard cut and fade cues persisted through production API/PostgreSQL, reconstructed Studio clip offsets/automation, real Studio master edit/save/reload/version, actual FFmpeg WAV export/download/decode, ordered supervisor shutdown/restart and persisted arrangement restoration. Evidence `/home/user/transition-staged.{json,txt}` and companion screenshot/WAV paths within JSON. Browser is Chromium153, not Electron. No subjective listening/inference claim. Staged diagnostics actually reported no configured provider credentials; native ONNX binding can load but has no model.

### Next integrated fixes: current-host preparation, Spaces timeouts, Arcade/Artifact recovery

- **Observed Linux preparation defect:** an existing `tsc` caused `environment-restore.mjs` to skip native hydration after ignore-scripts install. Extracted a small offline-only helper that always prepares already-shipped platform PostgreSQL links and FFmpeg/FFprobe permissions. No general lifecycle hooks, downloads or Electron/model imports. Two repeatability/missing-package unit tests pass; invoked helper against actual installed packages, successfully hydrated links and executable modes. Does not claim the entire environment restore/daemon bootstrap ran.
- **Reproduced Spaces defect:** child ignoring SIGTERM outlived a 150ms command timeout until test rescue killed it at 1.5s (`/home/user/command-timeout-before.txt`). Shared command subprocess helper now enforces SIGKILL, marks deadline as exit124/failure and bounds output while streaming. POSIX process-group termination also stops descendants retaining pipes or writing late results. Both host tools and isolation command adapter use it. Targeted timeout/mission/isolation tests **17 pass** (`/home/user/command-timeout-after.txt`); real host children, controlled model orchestration, not autonomous reasoning. Windows descendant termination and processes inside a container after killing its exec client remain unaccepted; this helper is NOT an OS sandbox or mission cancellation implementation.
- **Arcade reproduced:** repair response with deterministic Local Engine backend but fallback=false was accepted as AI codegen; invalid draft code was discarded. New two regressions RED (8 pass/2 fail), then GREEN (10 pass). Typed failure retains unvalidated draft + actual attempted runtime + validation issues, API returns422 without persisting or presenting a game, UI offers inert inspection/text download and keeps the previous game running. Repair exception/fallback cannot masquerade as success. Success notice now includes actual runtime modelId. No live provider execution claimed (`/home/user/arcade-{before,after}.txt`).
- **Beyond Waveyard/Arcade:** inspected `src/lib/arenaRooms.ts` and current page tree: Assistant, Orchestrator, Council, Congress, Spaces, Archive Assistant, Classroom, College, Studio, Creative Suite, Foundry, Deep Agent, Mind, Subscriptions, Cut Lab, Waveyard, LUMA, Market, Device Security; additional routes include Arcade and Artifact Library. Chose Artifact Library because its persisted outputs are shared/reused by Council/Collab/Arena, not a room-render inventory exercise. Reproduced two actual browser recovery failures: rejected deletion removed the card and failed load looked like an empty library. Fixed client to retain cards on rejected/network delete, show loading/error/retry, remove only after accepted deletion, and keep existing work on load failure. General/project artifact reads now return actionable503 rather than fabricated empty200. A real PostgreSQL table-unavailability/recovery regression preserves a saved artifact; API suite **6 pass** (`/home/user/arcade-artifact-pg.txt`). Broader room tasks remain unaccepted.
- **Real browser recovery:** `LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium node --test tests/acceptance/recovery-runtime.test.mjs`: **3 pass**, actual Arcade/Artifact components; controlled HTTP/provider failures. Old game's iframe remains interactive after forge failure; failed draft is not launched, downloadable text bytes equal draft; rejected artifact deletion retains card; accepted retry removes; loading retry retrieves work. `/home/user/recovery-browser-after.txt`; artifact RED `/home/user/artifact-browser-before.txt`. This does NOT prove real-provider gameplay or database interaction in the browser fixture.
- Expanded real Waveyard regression to TWO decoded render cases within the SAME integration test: mixed fade/hard-cut, and consecutive fades with held outgoing drums, each with donor change during first fade. Both save/reopen/version/restore/export paths pass in the 28-test real PostgreSQL suite. Retained separate synthetic WAVs and spectral measurements in `/home/user/transition-evidence/result{,-held}.json`; no overlapping count inflation.
- CI now retains new transition WAV/JSON evidence in the existing handoff artifact and runs/retains the new recovery browser tests with existing explicit bash/pipefail. Final exact-source validation/CI follows this commit; do not inherit the earlier head's checks.

Remaining next boundaries: broader Waveyard production controls (effects/tempo/key/loop/alignment through UI), Arcade runtime exception reporting and durable provider provenance, mission checkpoint/action recovery and cancellation, remaining room workflows. Real inference/provider/Electron/Windows remain precisely scoped open acceptance, not a condition for continuing Linux development.

### Exact-source verification: 81d3ec574174737f062eae878f8821e223564e32

Clean-tree execution after integrating the three follow-up commits (0fc9181 preparation, 22fd138 command bounds, 81d3ec5 Arcade/Artifact recovery):

1. `ARENA_TRANSITION_EVIDENCE_DIR=/home/user/transition-evidence-final node --import ./scripts/register-src-loader.mjs --test --test-concurrency=2 src/lib/waveyard/library/service.test.ts src/lib/waveyard/library/session-logic.test.ts src/lib/waveyard/library/session-arrangement.test.ts src/lib/spaces/*.test.ts src/lib/games/*.test.ts src/app/api/arcade/route.test.ts` — **135 pass / 0 fail / 0 skip**. Single combined selection; earlier 28/26/17/10/6 counts are contained within it, not additional. `/home/user/continuation-final-tests.txt`.
2. `LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium node --test tests/acceptance/session-runtime.test.mjs tests/acceptance/recovery-runtime.test.mjs` — **16 pass / 0 fail**. Actual components/WebAudio, controlled HTTP/model-failure responses. `/home/user/continuation-final-browser.txt`.
3. `node --test scripts/lib/installed-tool-preparation.test.mjs scripts/lib/electron-host.test.mjs` — **5 pass** controlled host probes. `/home/user/continuation-final-host.txt`.
4. Typecheck PASS. Targeted lint 0 errors / 2 hook-effect warnings (existing Arcade effect and Artifact initial loader); not claimed warning-free. Desktop compile + fresh standalone staging PASS. `/home/user/continuation-final-stage-build.txt`.
5. `LD_LIBRARY_PATH=/tmp/al2023/lib CHROMIUM_EXECUTABLE_PATH=/tmp/chromium npm run desktop:e2e -- /home/user/continuation-final-staged.json --browser` — **58 staged checks PASS**, exact81d3ec5 source identity/digest verified, real embedded PostgreSQL/production API/browser/WebAudio/FFmpeg, export and shutdown/restart. Separate acceptance layer, not a 58-unit-test increment.
6. Clean-tree synthetic render evidence records full81d3ec5 and empty working-diff SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Mixed-case 220Hz magnitude before transition .103580, fading outgoing .087931, faded-in 880Hz .009906, post-donor old220Hz .000079, new880Hz .077298; after hard cut220Hz .051790, wrong880Hz .00000010. Held-drum/consecutive-fade case outgoing .103559 (no outgoing ramp), donor .145705; final overlap contains both expected sources. WAV and SHA256 + persisted state in `/home/user/transition-evidence-final/result{,-held}.json`. These are identifiable synthetic signals, not learned separation or a listening assessment.

Final harness expansion (no product-code change after81d3ec5) adds two actual staged browser flows: Artifact Library create/read/reuse-link/confirmed delete/reload with the production database; Arcade **offline template only** persisted/opened/started/paused, naturally reached GAME OVER, restarted and reopened with identical code/provenance. `/home/user/continuation-shared-staged.{json,txt}` passed on81d3ec5 + harness working digest; exact final-head staged run is performed after committing this evidence/harness update. The single staged browser check now includes these observations, so the58-check count is unchanged. No claim that visiting a downstream Collab link ran a model.

CI at81d3ec5: push/PR runs `39172774784` / `39172771801` exist; A7 and browser jobs successful, Compose successful in the first run, main full-suite jobs still in progress at last query. Final delivery head gets its own checks; these are not inherited as final-head green. `f0411cb` baseline's previously missing CI was independently established all8 SUCCESS; no workflow was missing.

Next highest-value uncompleted implementation: mission durable mid-turn/checkpoint recovery (currently resume can revisit agent turns), then Waveyard effects/tempo/key/looping through real Studio controls and Arcade runtime exception reporting. Full product/other rooms, genuine inference, real-provider generation/reasoning, Electron GUI and Windows are NOT accepted. Work continues on Linux; none requires returning to Windows.

### Full-suite and CI follow-up (80cdeeb71598eaaa2238b1f91f4969c6411a48ef)

Final-head staged run `/home/user/delivery-staged.{json,txt}` PASS,58 checks including the expanded real Artifact Library/Arcade-template flows; source-digest guard matched80cdeeb exactly. Fresh real PostgreSQL16.14 cluster/schema established solely for a complete source-suite execution (not reusing test doubles):
`DATABASE_URL=postgres://postgres@127.0.0.1:38979/arena_full_suite node --import ./scripts/register-src-loader.mjs --test --test-concurrency=2 "src/**/*.test.ts" "desktop/**/*.test.ts" "scripts/lib/*.test.mjs"`
**1319 pass / 0 fail / 0 skipped**,39 suites,338.389s; `/home/user/delivery-full-tests.txt`. This full total CONTAINS the135 selected tests and host probes above; never add them. MDX's CPU-intensive identity-inference regressions took time; they remain controlled DSP tests, NOT genuine model acceptance. Temporary PostgreSQL is stopped afterward; no user database/data touched.

Exact80cdeeb CI: `39173089562` all4 jobs SUCCESS. Duplicate `39173085163`: main quality, browser and Compose SUCCESS; A7 acceptance step FAILED (install/schema succeeded, retained TAP artifact12153401835 exists). Actual assertion/cause unknown: signed Actions log host and Azure artifact host both return EOF under this host's outbound restrictions. GitHub check annotations expose only exit1, not the failing test. `gh run rerun 39173085163 --failed` refused (workflow cannot be rerun); direct known job117810106708 rerun returned403 `Resource not accessible by integration`. This is NOT silently labelled flaky/resolved, nor mistaken for an install failure. Failed-job metadata and access errors retained outside Git under `/home/user/delivery-{failed-job,a7-failed-log,a7-download-error}.*`.

Concrete diagnostic improvement: failed test identities now publish bounded, escaped GitHub check annotations directly from retained TAP in both static and A7 jobs, so this restricted host can identify failures through api.github.com even if signed log/artifact downloads fail. No raw tool/assertion output or secrets included; job failure remains authoritative. Three controlled parsing/escaping tests PASS; no test selection weakened or failure ignored. A new head gets a fresh CI run; preserve the original failed run as unresolved historical evidence until its assertion is retrieved or reproduced. No claim that a rerun fixes its unknown cause.

## Mandate 4 — durable mission recovery (2026-10-19, implementation checkpoint)

Baseline reconciliation: PR #15 remained OPEN/unmerged at
`ccda769b3072820f7248076cd4ee56c59ad81a25`; both reported four-job CI runs
were green (eight successful checks, `/home/user/mandate4-baseline-ci.json`).
No prior work was reset. This supersedes the earlier pending-CI observation.

**Reproduced before repair:** actual embedded PostgreSQL, actual mission
`node increment.cjs` side effect, native child termination at the next agent.
The original runtime left a running row but restarted under a **different ID**,
repeating committed work. The red test is retained at
`/home/user/mandate4-recovery-before.txt` (0 pass / 1 fail).
Controlled model replies are protocol fixtures, not autonomous reasoning.

The existing mission JSON journal now holds model requests/replies, stable
turn/request IDs, a cursor, requested-action lifecycle, saved execution policy,
results and recovery provenance. A transaction locks the real space during
creation/claim; an owner lease and conditional writes exclude another process
and fence late results. Results commit before the next dispatch. A received
model plan is not regenerated just to continue an unfinished action list.
PostgreSQL unavailability **fails closed**, including after process restart;
there is no implicit in-memory mission fork. Ephemeral unit fixtures must opt
in explicitly and are labelled memory-only. Idle PostgreSQL disconnects no
longer kill the server through an unhandled pool error.

Recovery is deliberately not an exactly-once claim for arbitrary tools:
* committed results are reused;
* interrupted read-only file inspection can retry;
* an interrupted `write_file` can recover from matching actual file bytes,
  with a SHA-256 receipt and explicit notice that the original tool return
  was not committed; drifted files stop rather than being overwritten;
* uncertain commands/external effects stop for review, never blindly replay;
* persisted approval results can restore their actual success/failure;
  interrupted approval claims cannot be silently reused;
* owner review records evidence and distinguishes human attestation from
  machine verification. Saving review dispatches nothing; resume is explicit.
  Explicit retry warns about duplicate effects. Cancellation fences late
  replies/results; host commands receive process-group cancellation through
  the lease heartbeat. Cancellation is not rollback of external effects.

The actual Spaces panel now polls durable progress, exposes full requested
arguments/results and review history, reports storage errors, saves inspected
outcomes, resumes the saved mission, and can cancel a particular mission.
Malformed/oversized model action lists are retained and rejected rather than
silently truncating a plan and claiming completion. Model calls and host
commands are bounded; uncertain timeout results require inspection.

Executed source checkpoint evidence (not additive suite totals):
* `/home/user/mandate4-contracts-final.txt`: 69 pass, zero fail, including
  24 actual PostgreSQL/process interruption tests plus existing controlled
  tool/governance tests. Afterwards, `/home/user/mandate4-durability-final.txt`
  executed the expanded native PostgreSQL suite: **26 pass / zero fail**,
  including actual 20-second command timeout with a committed partial effect
  and a hung model bounded by the actual 30-second remaining mission deadline.
  The timeout result is retained, subsequent work blocks, and a late model
  reply dispatches no command. These suites overlap; do not sum them.
* `/home/user/mandate4-browser-mission.txt`: 3 pass, zero fail. **Actual HTTP
  handlers + actual PostgreSQL + actual Chromium component + actual files**:
  killed command → owner review → persisted audit → explicit resume writes
  retained report, count stays one; active lease gives HTTP409 then owner
  cancellation; actual SQL stop/restart shows error then retrieves the mission.
* Typecheck passed; targeted lint zero errors, one pre-existing workbench
  effect warning. Evidence files stay outside Git.

Remaining boundaries: no configured-provider reasoning acceptance has been
performed in this cycle; browser acceptance is not Electron or Windows.
Cancellation of an already-committed remote side effect cannot undo it.
Legacy partially executed turns without requested-action checkpoints stop for
inspection rather than pretending to reconstruct an unknown model plan.
Next unblocked product target: Studio FX/output execution. Inspection found
that immutable FX state exists but export snapshot parsing/rendering omits
track/master insert chains; arrangement audition also ignores them. These
are findings, **not repaired or accepted yet**. Continue with actual UI →
persisted/versioned chain → rendered/decoded signal, not more registry tests.

Provider configuration inspection (names/booleans only, no secret output):
Groq/OpenRouter/Google/Gemini/OpenAI/TurboAgent keys and Ollama/llama.cpp
endpoint overrides were absent. No download or fake real-provider run was
attempted. Existing GitHub sandbox authentication is unrelated to model
readiness. Publication fixtures reject empty file lists locally and never
send sandbox GitHub credentials to a remote test repository.

## Mandate 4 — Studio output and approval recovery (2026-10-19)

The next Studio defect above is now reproduced and repaired in the local
export path: actual Studio UI → PostgreSQL state → immutable version → broker
→ canonical track/master DSP → FFmpeg → browser WAV download. Before repair,
saved/reopened −6 dB track plus −6 dB master exported with decoded gain ratio
**1**; repaired output measures **0.25118863902498606**. Track clips are summed
before nonlinear inserts, master inserts execute once, polarity is retained,
and reverb tails survive export. Legacy dry exports retain their previous path.
Malformed/unsupported chains fail rather than silently producing dry success;
the isolated remote worker refuses FX/polarity it cannot execute.

Studio now persists the master fader, serializes saves, ignores stale save
responses and flushes current edits before immutable version creation. Version
history queues the real WAV export, follows its durable status, exposes retry
and errors, and downloads the actual completed file. Arrangement audition is
still dry; the UI says so. Reverb-tail support is **not** delay-tail support:
delay currently truncates its tail. FX exports are bounded to five minutes plus
a bounded tail allowance. These are synthetic-audio contract checks, not Demucs,
real-music inference, Electron or Windows acceptance.

Local evidence, kept outside Git:
* `mandate4-studio-fx-before.txt`: browser/SQL/render RED, decoded ratio 1.
* `mandate4-studio-fx-final.txt`: 3 actual-browser tests PASS (11.72 s), including
  master undo/redo, immediate version save, reopen, native download, nonlinear
  overlapping-clip processing and nonzero reverb-tail energy.
* `mandate4-studio-fx-evidence/{dry.wav,processed.wav,result.json}`: downloaded
  synthetic PCM and decoded gain measurements.
* `mandate4-studio-persistence.txt`: 50 focused persistence/render/FX tests PASS
  (8.21 s); includes the 22-test render/version/insert subset, not additive.
* `mandate4-browser-final.txt`: combined mission and Studio acceptance 7 PASS
  (20.39 s). After stricter outage reporting, `mandate4-ledger-browser.txt`:
  4 mission/approval tests PASS (9.32 s), including real SQL stop/restart,
  retained approval identity, actual approvals POST and resumed validation.
* `mandate4-ledger-regression.txt`: 20 governance/browser/external tests PASS.
* `mandate4-final-types.txt`: root typecheck PASS. Production build PASS in
  `mandate4-production-build.txt`. Targeted lint had no errors; Studio retains
  two existing warnings. Isolated worker production modules typecheck PASS
  (`mandate4-worker-runtime-types.txt`); full worker typecheck FAILS on legacy
  tests importing missing vitest/web modules (`mandate4-worker-types.txt`).

Default approval reads/decisions reconnect to SQL after outages instead of
remaining trapped behind a process-local health flag. Unknown SQL-ledger reads
fail explicitly when storage is unavailable, not as an empty approval list.
Known ephemeral fixtures keep their memory IDs. This is not a new persistence
framework and does not assert exactly-once remote effects.

A7 check annotations at published mission revision 6b3c81d named test C; full
signed CI logs were inaccessible. Independently reproduced a real Redis/PG
synchronization race by delaying processor entry 75 ms after claim (RED 0 !== 1).
The test now waits for actual processor entry without weakening execution/count
assertions. `mandate4-a7-final.txt`: all 9 real PostgreSQL/Redis tests PASS,
27.21 s, zero skips. This is **not proof** of the historical CI assertion cause.

The earlier 1,348-test source run changed source mid-run: useful regression
information, **not exact-revision acceptance**. Fresh published-revision CI and
clean-source native regression remain to verify. Both browser suites and retained
TAP/decoded audio evidence are now wired into the existing browser CI job.
PR15 remains open/unmerged. Next capability targets remain generated-code
iteration/retrieval and shared Artifact ownership/version/interruption contracts;
no whole-product completion or genuine provider-reasoning acceptance is claimed.

### Published validation and next Artifact defect

Published **55c20e0**: all four checks in run
`39178842081` PASS (A7, Compose, typecheck/lint/test/build, browser acceptance).
An unchanged, clean-source native regression at **55c20e0** completed with
**1,354 PASS / 0 FAIL / 0 SKIP**, 399.06 s
(`/home/user/mandate4-published-full-source.txt`). This supersedes the earlier
mid-edit 1,348-test run, not an additive test count. At that same published
revision the combined actual-browser/SQL suite passed 7/7 in 27.35 s, and the
real PG/Redis A7 suite passed 9/9 in 29.18 s. The four mission tests include one
SQL/API outage case; not all seven are rendered-UI tests.

Continued Artifact inspection found a separate actual data-loss defect:
POST and PUT silently sliced content to 20,000 UTF-16 code units while reporting
success. Native PostgreSQL + actual POST reproduced **201 with retained length
20,000** after a longer body was submitted (`mandate4-artifact-before.txt`).
Both handlers now return explicit **413**, before writing any part of an
oversized body/metadata update. The existing limit is unchanged; loss is no
longer hidden behind success. Owners can explicitly split and retry rather
than unknowingly retrieving an incomplete generated output.

`tests/acceptance/artifact-retention.test.mjs` exercises actual handlers +
native SQL: oversized create leaves no row; exact-limit Unicode round-trips;
oversized edit preserves both content and title; explicit shorter retry saves
and is retrievable. **2 PASS / 0 FAIL / 0 SKIP**, 2.67 s
(`/home/user/mandate4-artifact-after.txt`), root typecheck and targeted lint PASS.
This suite is wired into the existing durable browser/service CI job. The
1,354-test result belongs to parent 55c20e0, **not** a claim that this subsequent
Artifact delta was in that run. Immutable Artifact revision history and trusted
mission-reference validation still require follow-through; refusing truncation
is not versioning or whole-room acceptance. Existing displayed-library recovery
acceptance uses controlled HTTP, not real persistence; the new retention checks
supply real SQL evidence for this narrower write/retrieval boundary.

## Mandate 5 — shared audition/export DSP and bounded delay tails

Reconciled starting revision `508c3182d56e0a918ad9125446f1918787ff76fb`:
PR15 open, clean tree, all four latest PR checks green. No previous fix reset.

Actual browser destination tap reproduced dry audition: measured peak
0.1999877989 versus expected 0.0355234386 after saved track/master -6 dB and
polarity. Evidence `/home/user/mandate5-audition-before.txt`. Audition now
prepares clip PCM, sums each track before nonlinear inserts, applies polarity,
track level/pan/automation, then sums tracks and applies master level/inserts.
It uses the same canonical DSP kernels as local/remote bounces. Playback is a
single processed buffer; seeks prepare from zero to retain processor history.
Edits fence old asynchronous loads and replace the graph at the cursor; pause,
stop/unmount disconnect the source and invalidate pending starts. Transport
stop and seek now address arrangement playback as well as stem playback.

Scope: prepared playback, not zero-latency live FX modulation. Browser decoding
and resampling differ from FFmpeg, automation uses sample vs FFmpeg-frame
updates, and export requantizes/dithers. PCM comparisons use tolerances rather
than an algorithm-wide sample-identical claim. Five-minute arrangement limit.
Tempo/key-synced browser audition still requires follow-through: it now refuses
explicitly rather than silently playing untransformed audio. Ordinary clip FX
are audible; this remaining transform gap means the complete Priority-1 gate
is not claimed for all arrangements.

Late-delay RED used an impulse at 2.9s in a 3s source: the downloadable WAV
lacked the expected 3.15s echo (`mandate5-delay-before.txt`). Delay now allocates
its actual feedback tail, retaining echoes down to a feedback multiplier of
-80 dB. Zero feedback retains one delayed copy. Wet-zero/bypass leaves the dry
length unchanged. Individual delay tails and the combined track/master tail
allowance are bounded to 60s; excess settings fail before publication. Dry
exports keep their old path. UI describes these bounds, not arbitrary padding.

To ship identical kernels inside the isolated worker Docker context, canonical
DSP/fade/render helpers now live in `waveyard-worker/packages/dsp`, with original
app imports preserved as re-exports. This is one implementation, not copied FX
algorithms. The remote WAV renderer uses the same float-bus bounce, clip fades,
padding, polarity and master chain. MIDI processing is unchanged. Docker and
worker lockfile include the shared package/dependencies.

Evidence on this implementation tree before publication:
* `mandate5-studio-final.txt`: 6 PASS/0 FAIL, 17.86s; actual Studio/HTTP/native
  PostgreSQL/local broker/FFmpeg/native download, actual browser destination tap,
  audition/export polarity comparison, known late impulse echoes, real isolated
  worker child process. Remote and local processed WAVs have equal length and
  max PCM error 0 for the tested nonlinear/polarity/delay/reverb version.
* Remote missing-source failure creates no export asset; restoring the source
  and rerunning the real worker completes the same job with attempts=2.
  This proves worker-handler retry, not Redis queue/process-kill recovery.
* `mandate5-preview-unit.txt`: 4 PASS, summed nonlinear bus, independent tails,
  bypass duration, excessive feedback refusal, unknown/unsupported refusal.
* `mandate5-dsp.txt`: 126 PASS, canonical mixer + insert-bounce regressions.
  Counts overlap earlier suites; do not add them to historical totals.
* Root typecheck and production build PASS (`mandate5-types.txt`,
  `mandate5-studio-build.txt`). Worker production-module typecheck PASS
  (`mandate5-worker-types.txt`); legacy worker test-tree limitations remain.
* Target lint zero errors, one graph-update effect warning. Browser tests are
  synthetic signal contracts, not real inference, human listening, Electron,
  Windows or genuine model reasoning.

Next: immutable Artifact history and mission-output retrieval, while preserving
known remaining synced-audition/large-arrangement and staged worker lifecycle
gaps. No claim that Artifact history or durable mission deliverable manifests
have been implemented by this DSP change.

### Mandate 5 — Artifact history and pinned reuse milestone

Reproduced an overwritten earlier body through actual handlers/PostgreSQL:
`mandate5-artifact-before.txt` returned "changed work" when the original work
was requested. New migration `0017_artifact_revisions.sql` backfills a baseline
for existing rows. Creates and edits commit immutable snapshots and current
head atomically. Public edits require `expectedRevision` (428 if omitted,
409 if stale); row locks serialize races. Unchanged saves retain the revision.
Restoration always appends a revision and records its source revision ID.
Deletion is a versioned tombstone, not erasure; owned history and restoration
remain available. History pages are bounded to 50 revisions with an older-page
cursor; individual revision retrieval/download uses immutable UUIDs and owner
checks. Source attribution stays attached to snapshots. No history mutation
endpoint exists; database administrators are still trusted.

The Library UI now supports edit, history inspection, immutable text download,
restore and recovery of deleted artifacts. Conflict/error handling keeps the
user's draft. Cross-room links carry revision IDs; legacy rows must first bind
a baseline through history before reuse. New `read_artifact` tool dispatch
requires both artifact and revision IDs, checks the actual owner and journals
the immutable input. A later mission can reuse the recorded real result after
the current Artifact has changed; unbound implicit-latest references fail.
This is contract execution with controlled plans, not model reasoning.

SQL outage acceptance exposed two additional shared database defects: pg could
emit an unhandled checked-out-client error, and a failed Drizzle BEGIN could
leak its checked-out client, hanging shutdown. Permanent client error handling
and an outer owned checkout/release around transactions now preserve query
failure while preventing the process crash/leak. Before/after evidence is in
`mandate5-history.txt` and the test development record; the new real outage
case finishes with pool closure rather than hanging.

Local implementation evidence:
* `mandate5-history.txt`: 4 PASS, 3.31s, actual PostgreSQL/API creation, edits,
  unchanged save, racing updates, old downloads, restore, DB restart, oversize
  rejection, injected SQL failure after history insertion (full rollback),
  deletion/recovery, foreign history refusal, pinned revision tool reuse.
* `mandate5-history-browser.txt`: actual Library UI + native SQL, edit,
  download/restore/delete/recover/reload, 1 PASS, 4.98s (includes startup).
* `mandate5-artifact-regression.txt`: 8 PASS before the later history/reuse
  additions; overlaps the retention suite, not additive acceptance.
* Root typecheck, targeted lint and production build PASS in
  `mandate5-history-{types,lint,build}.txt`; lint retains one Library effect
  warning. Broad source regression and exact published CI remain to verify.

Published DSP revision `204d112` CI correctly caught two packaging problems:
a root TS fixture imported isolated worker-only aliases before its dependencies
were installed, and the web Docker context excluded the newly shared kernels.
The fixture is now worker-scoped, and the web context includes only shared DSP
and types, not the worker app/dependencies. A7 and browser jobs had passed at
204d112, but static/Compose failed: **do not report that revision as green**.
The fixes ship with this Artifact milestone and need fresh published checks.
Mission deliverable snapshot/manifest retrieval remains the next major target.

### Mandate 5 — durable mission deliverables and recovery milestone

`mandate5-output-before.txt` reproduced actual panel retrieval failure: real
executed reports existed, but no usable download link appeared (only paths).
Mission saves now capture authoritative file-tool outputs and command/test logs
before advancing their recorded results. The existing object provider stores
atomic content-addressed private snapshots (32 MiB/item bound); equal content
reuses one object. Existing Artifact history supplies immutable revision IDs,
source mission attribution and ownership. Existing mission `artifacts` JSON now
holds the output manifest: stable ID, display path, byte length, checksum, type,
request/tool origin, owner, Artifact/revision IDs and completion/error state.
No independent database artifact registry or arbitrary filesystem-download API
was introduced. Large/binary files use metadata in the Artifact body, not a
truncated copy; full bytes remain downloadable from the checked snapshot.

The actual panel offers View/Download, checksummed saved snapshots and mission
history selection. Older missions remain retrievable after newer work changes
the workspace. Historical resume requests cannot accidentally resume a different
active mission. Legacy path-only records are explicitly unverified and have no
invented immutable download. Files not created by file tools require explicit
`publish_output`; command/test return logs are retained separately. Failed
writes and capture failures are marked unavailable and do not produce successful
downloads or false mission completion. A complete log snapshot does not imply a
successful command or an untruncated underlying process stream.

`reuse_mission_output` copies an owned immutable text snapshot into an authorised
workspace file through the existing write/syntax-check path. Source space,
mission and output IDs remain in its journal; the source manifest pins its
Artifact revision. Restoration/later edits never reinterpret the referenced
revision. Guessed/out-of-space IDs, foreign ownership, checksum corruption,
symlinks, hard-linked/nonregular files and oversized captures are refused.
Retrieval derives storage keys from authorised checksums, never from untrusted
manifest paths. File tools now reject symlink traversal too. This does not
sandbox host-mode commands or claim protection against a malicious local OS
actor racing parent-directory replacements. Binary reuse needs follow-through;
text reuse and binary download are separate capabilities.

Real persistence/execution evidence:
* `mandate5-output-final.txt`: 6 PASS/0 FAIL, 14.08s, actual panel + actual
  PostgreSQL + actual dispatcher/files, including SQL restart, native download
  SHA-256 verification, original output after later overwrite, reuse into later
  task, useful partial outputs with incomplete mission, foreign/scope refusal,
  corrupted snapshot rejection and symlink refusal.
* SIGKILL at `output_captured`, before result/manifest advancement: recovery
  binds one existing original Artifact revision without rewriting the file or
  duplicating the Artifact. An owner edit to the current Artifact between
  interruption and recovery does not change the pinned original download.
* `mandate5-all-final.txt`: combined 17 PASS/0 FAIL/0 SKIP, 33.14s, overlapping
  mission/Studio/Artifact acceptance (not additive with the focused six).
* Subsequent focused `mandate5-live-edit.txt`: actual nonlinear overlapping-clip
  audition, immediate master edit/version/export, pause/seek/stop, maximum one
  active source. Kernel-reference error 0.000003472, export error 0.000068441.
  Adds a browser case; do not count its repeat as independent tests.
* `mandate5-output-regression.txt`: 29 PASS for tools/execution/storage.
* `mandate5-dsp-final.txt`: 142 PASS covering shared kernels, preview, bounce,
  helpers, unsafe persisted FX refusal and 32-insert safety bound. Explicit UI
  `makeInsert` clamping is retained; untrusted persisted chains no longer
  silently clamp parameters. Unknown direct processors throw rather than dry
  success. Wet-zero inserts do not generate padded silent tails.
* Root typecheck and production build PASS (`mandate5-final-{types,build}.txt`),
  targeted output lint zero errors / one existing workbench effect warning.

Published `618858c` CI was not green: A7/Compose passed, static and durable
browser checks failed. Static annotations exposed migration 0017 missing
statement-breakpoint delimiters: native PostgreSQL accepted the multi-command
string while PGlite's prepared-query adapter refused it. Local reproduction
`mandate5-ci-reproduce.txt` showed 11 failures; inserting delimiters (no SQL
semantic change for already migrated databases) yields **17/17 PASS** in
`mandate5-ci-repaired.txt`. The prior signed aggregate logs remain inaccessible;
durable browser failure-identity annotations are now wired in as well. Fresh
published CI must verify the integrated revision; do not hide earlier failures.

Open: synced tempo/key audition, long-arrangement scalability/main-thread
preparation, real Redis worker kill/restart FX acceptance (handler retry is
proven, not that lifecycle), large/binary reuse, retention/garbage collection
policy for immutable objects, and acceptance beyond these rooms. No provider,
real inference, Electron or Windows claim. Provider/model availability has not
blocked this work and no unavailable downloads were retried.

## Mandate 5 continuation — preserve project work and consume pinned references

Published mission-output milestone `4c0ad8d71ef077520b5f6631444399f9bbcaf3d1`
was verified: all four checks in run `39185444333` PASS (static 8m03s,
browser 1m50s, A7 1m24s, Compose 2m22s); native root **1359 PASS**, 394.02s;
actual workflows **18 PASS**, 51.62s. PR15 remains open, unmerged.

Independent actual-handler/browser reproductions found further failures:
* Project Artifact POST returned 201 but discarded the suffix after 20,000
  characters (`mandate5-project-artifact-before.txt`). Once the server refused
  it, the actual Project UI still cleared the rejected draft (browser RED
  `mandate5-project-ui-before.txt`).
* Project DELETE returned 500 on the immutable-history FK **after deleting
  project memory** (`mandate5-project-delete-before.txt`).
* Orchestrator dispatched a supposedly pinned reference with its evidence
  entirely missing (`mandate5-orchestrator-before.txt`).

The shared store now supplies body-size validation and owner/tombstone scope
for project/context/Command/assistant reads. Project creation is atomic with
its project timestamp; rejected drafts stay editable in the actual workspace.
Project removal atomically unlinks work instead of deleting Artifacts, records
new metadata revisions for active and tombstoned Artifacts, and rolls everything
back on a write failure or foreign-owner conflict. Restoring an old revision
whose project was removed retains the original reference in history but restores
the content unscoped; it does not recreate deleted containers. The project UI
uses the existing real history/edit/download/restore controls and emits bound
references; legacy handoffs require loading history first.

Archive Assistant saves through the same immutable store and can retrieve an
owned pinned revision. Orchestrator takes canonical `artifact:id@revisionId`
references, validates them before creation and dispatch, resolves the original
snapshot rather than mutable latest, fails visibly on unavailable/foreign or
legacy unbound inputs, and labels bounded excerpts. Its actual UI accepts and
shows those references. Local-only external dispatch permits loopback adapters
only. Existing orchestrator handlers, project handlers and Command use the
shared API-access guard, not just browser middleware.

Verified frozen runtime/test tree (file hashes recorded outside Git):
* `mandate5-project-workflows.txt`: **24 PASS, 0 FAIL, 0 SKIP**, 84.66s,
  actual native PostgreSQL, browser controls, immutable downloads and isolated
  rendering. Includes rejected-draft retry, project history edit/download/
  restore/reopen, actual Orchestrator queue/HTTP dispatch/reopen, SQL restart,
  failed-write rollback, foreign/unbound refusal and original-input provenance.
* `mandate5-project-source.txt`: **1360 PASS, 0 FAIL, 0 SKIP**, 417.93s.
  Header identifies the prior Git HEAD because verification preceded this
  commit; the tested source hashes were checked unchanged before committing.
* `mandate5-project-types.txt`, `mandate5-project-build.txt`: typecheck and
  production build PASS. Targeted lint: zero errors, one existing Project
  effect warning. Focused native/browser repetitions overlap these totals.

Next independently reproduced failure: Orchestrator Close reports 200/closed
when Artifact insertion fails, with **zero archived Artifacts**
(`mandate5-orchestrator-close-before.txt`). Its record builder also clips text.
This is not repaired by the pinned-input work above. Follow through archival
failure, complete retained record download and retry without losing sessions.
Broader Battle/Collab/Council URL provenance is still not server-resolved;
pinning a link alone is not full cross-room consumption acceptance. Existing
model/Electron/Windows/real Redis FX lifecycle limitations remain unchanged.

## Mandate 5 follow-through — truthful archival and autosave/version race

`4997249951a861e45f27eb76307a9a68f3aaa628` is published with all four checks
PASS in run `39187902340`: static 5m07s, browser 2m09s, A7 1m28s, Compose
2m19s. No merge or unrelated branch changes.

The next reproduced Close failure is now repaired. Session closure and its
owned Artifact/history insert commit together, rather than closing first and
swallowing an archive error. The archive contains the complete **retained API
record**, including context, full retained requests/responses and pinned inputs,
not display excerpts. A stable Artifact identity and original immutable revision
make concurrent filing/retry idempotent; retry does not overwrite later Library
edits. The archive survives deletion of the original session. SQL failure at
Artifact insertion **or** session update rolls both back. Pending relays must be
resolved before final archival. Queue writes now acknowledge SQL completion,
share the parent-row lock with closure, and allocate sequence numbers under that
lock; failed writes cannot pretend to be memory-only successful relays.

The actual workbench provides Download retained session and Retry filing record.
The JSON download is the current retained session, not an immutable snapshot.
Records exceeding the shared 20,000-character Artifact limit are refused with
413 without closing or discarding the session; the entire retained record still
has a real download. This is an explicit limit, not full large-record immutable
archival support. Existing provider response/tool-report bounds are not undone
by the archive: “complete retained record” does not mean original unbounded
provider output or process stdout.

The first integrated archive run exposed another genuine Studio save race:
`mandate5-archive-workflows.txt` had **24 PASS / 1 FAIL**, timing out while
waiting for the version POST. This was not waived or fixed by increasing its
wait. A deterministic real-browser interception held an already-executed
PostgreSQL autosave response, then clicked Save version. The previous code
mistook the queued autosave's new response object for a new user edit and
aborted version creation: expected one immutable version, got zero
(`mandate5-save-race-before.txt`). Studio now retains edit identity through
acknowledgements with weakly held origin references. An actual newer edit still
wins and cannot be overwritten. The deterministic browser case proves both
no-intervening-edit (saved master 0.42) and newer-edit (saved master 0.31).

Frozen final source verification before this commit:
* `mandate5-archive-final-workflows.txt`: **26 PASS, 0 FAIL, 0 SKIP**, 50.67s.
  Includes the original audio/render/mission workflows, Project operations,
  pinned Orchestrator inputs, real session download/close/retry, SQL fault
  injection, concurrent queue/close, retained original archive after Library
  edit and source-session deletion, and both deterministic save-race cases.
* `mandate5-archive-native.txt`: 9 PASS, 4.01s (overlaps the 26 above).
* `mandate5-archive-types.txt`, `mandate5-archive-final-build.txt`: typecheck and
  production build PASS; `mandate5-archive-lint.txt`: zero errors/warnings for
  the changed archive/Studio files; `git diff --check` PASS.
* `mandate5-archive-source.txt`: 1360 PASS, 434.32s for the archive backend tree.
  The final client-only race fix occurred during that run; do not mislabel it
  an exact-final-tree source run. A fresh exact-published-HEAD run and final CI
  result will be attached to PR15 after publication. Frozen source hashes are
  retained in `mandate5-archive-final-source.sha256` outside the repository.

Next evidence-based targets: server-side revision resolution in Battle/Collab/
Council handoffs (their URLs still pass mutable prompt excerpts); remaining
legacy Orchestrator create/respond/dispatch/delete memory-fallback and failure
semantics; and large-record immutable archival through existing private storage.
The queue/close fixes do not establish durable provider execution receipts or
exactly-once external calls. The genuine-model/Electron/Windows and real Redis
FX restart gaps remain; no unavailable asset downloads were retried.
