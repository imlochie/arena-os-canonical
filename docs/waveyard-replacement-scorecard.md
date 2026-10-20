# Waveyard → STEM.FM replacement gate

Updated 2026-10-20. Historical starting revision: `ff09a715fe88185acec01a7dd2dc6c44468b5493`, branch `arena/331aa502-arena-os-canonical`, PR15. PR14 is a separate, unmerged provisioning proposal. Neither PR is authorized to merge.

## Decision: cancellation gate CLOSED

**Do not cancel on the strength of this delivery.** The connected learned-separation/music/catalogue acceptance has not passed. Essential failures are not averaged against working conversion, transport or Studio features. This mandate supersedes the older vision document's exclusion of catalogue replacement; that exclusion cannot make this gate pass.

Status vocabulary: **Verified** = executed, within the stated evidence boundary; **Partial** = some real usable paths, essential remainder unaccepted; **Broken** = reproduced incorrect behavior; **Missing** = required implementation/access absent in inspected paths; **Blocked** = identified prerequisite prevents this particular execution. A controlled PCM fixture is actual audio, but is never learned separation, real-song quality or provider/catalogue acceptance.

## 2026-10-20 execution update — real source audio, reviewed public intake, exact model import

**Gate remains CLOSED.** This update does not turn source-only music into learned stems, a controlled provider into live catalogue access, or browser/staging into Electron acceptance. Baseline `ee13987` has mixed authoritative CI: run39285233076 SUCCESS; run39285227898 FAILURE in the P0 bank browser gate (job118169153534). The failed job completed in ~320s, so a 10-minute *job* timeout is not its demonstrated cause. Assertion/log body cannot be retrieved from the restricted signed-storage host; root cause remains unknown. Other runs/passes do not erase it.

Implemented in the existing paths, without runtime dependencies or another player/library/queue:

- `ArchiveAudioDiscovery` in `/waveyard/discover` → owner-guarded `/api/library/catalogue` search/inspect/import → `archive-audio.ts` → existing native `addTrackFromAudioFile`/`ingestSourceFile`/private storage. Search hits are references. Review reveals actual file names, sizes, licence/source/terms links and a browser preview; import needs explicit recording/composition rights review. The server re-fetches metadata and accepts only unambiguous CC0/CC-BY 2.0/2.5/3.0/4.0, not NC/ND/SA or arbitrary “public domain” strings. Private/restricted, oversized, traversal and non-audio files are excluded. Conflicting file-level declarations cannot inherit a permissive item grant. Public DNS/redirect policy, metadata/transfer bounds, provider SHA-1 when supplied, native probe and stored SHA-256 protect intake. No protected-stream downloader, credentials or resolver service is introduced.
- Source acquisition keeps provider/id/file/grant/credits/review timestamp; `getTrack` and the existing `TrackPlayer` reopen the attribution and offer a downloadable notice. Duplicate bytes with different acquisition provenance are refused instead of changing the original rights record. Imported audio is explicitly **original/unseparated** with no separation requested. A checksum is not legal clearance. Rights remain uploader/publisher claims, not independent warranties. Export still requires preserving notices/indicating changes; automatically bundling notices into every Studio export is NOT implemented.
- `ModelAssetImport` in the existing build/project views displays pinned URL, SHA, licensing status and installed-file state. Explicitly reviewed owner-file POST `/api/waveyard/separation/models/[id]/import` accepts one registered asset, verifies its exact SHA even if a valid install already exists, and uses the existing locked seeder/checksum/atomic publisher, with no network fetch or alternate mirror. Acquisition sidecars distinguish registry vs owner-supplied bytes and permission unknown vs owner-asserted, never verified legal clearance. Changing acquisition mode does not resume unrelated partials. All recipe prerequisites must still pass the existing target preparation before failed jobs retry; import alone does not claim a requeue or inference.
- Cancellation now reaches the existing seed operation from both preparation UIs, import has a cancel control, and shared `safeFetch` preserves caller abort signals instead of replacing them. Previously verified models/compatible partials remain available; a cancelled joiner does not cancel another caller's transfer. No distributed/power-loss guarantee is added.

**Executed evidence so far (broader exact-commit verification follows below when completed):** focused source/security/seeding/native-PG36/36; controlled full browser review→preview→import→actual player signal/clock→reload attribution→notice download and UI model bad/good byte import1/1 (8389ms command). Initial renamed-result test assertion failed (35/36); fixed its stale field reference without weakening the assertion; final36/36. Typecheck, build, desktop compile/staging and lint0errors/48existingwarnings pass on the working implementation; these are not yet final-commit receipts. Electron preflight:44.7.0 npm package, no binary, no display. Native Node ORT loads; Python3.11.2 has no torch/torchaudio/demucs/Python ORT; compatible weights still absent. Test model payloads are explicitly synthetic, not executable model acceptance.

**Real music acquired and executed, source-only:** Deezer/Spleeter explicitly publishes its `audio_example.mp3` as an excerpt of **Slow Motion Dream**, Steven M Bryant ©2011, featuring CSoul, Alex Beroza and Robert Siekawitch, **CC BY3.0** (media-specific README note, not code licence). Source revision `c8854001ac8acad34a9bc2bd15f28475541828b1`; Git blob `cc91788843d20ae7af169d6e0f72c2c5658fdb39`;262867bytes; SHA-256 `4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507`. Acquired through GitHub's blob API, verified Git identity, native-probed MP3/44100Hz/stereo/10.919184s. Original composition/authorship is not independently warranted beyond that published grant. `.data/acceptance/authorized-music/spleeter-demo/` retains original MP3, provenance, before-restart session JSON, actual source-only export/rights notice and `arena-source-only-acceptance.json`. Production native intake→exact source serving→explicit `passthrough-unseparated`/model`none` bridge→saved exact session asset→PostgreSQL stop/start→Studio/version→local queued export all executed. Actual WAV:1919532bytes/10.880544s/RMS0.1765131300530129/SHA `7b8069a1d28588e71eee1c241ed35b9846c7a9679234a54c79b9bb4ef81d09e5`, finite/non-silent, within0.1s of source intake duration. One full-source lane, NOT four/six stems. Isolated test database was closed/removed after verification; retained music/exports/receipts are reusable, but no installation into the owner's running library is claimed.

**Catalogue assessment:** public Internet Archive protocol inspected at pinned `jjjake/internetarchive`4bb79621813fc5aaff5ad6d154a340dfd157d980 (`session.py`, `search.py`, `files.py`); only HTTP contracts reused, no AGPL package/code imported. Search/metadata and ordinary download are distinct. This path is anonymous public audio, not commercial catalogue rights or geographical availability. `archive.org` is outside this sandbox's outbound allowlist, so live search/play/download, current service terms, availability/limits, uploader authority and regional conditions have NOT been independently executed/verified here. Terms and media grant links are exposed for deliberate owner review; no cost/availability/rights warranty. API fixtures were controlled HTTP only. Jamendo was inspected but not integrated: client credentials and track-specific download/remix/monetization terms need separate verification. Live catalogue gate remains unaccepted; the real GitHub media acquisition is not a substitute for that gate.

### Bank failure reproduced and shared fix (2026-10-20)

The first new serial full browser run at implementation commit `e1d11cfe3930ef81827cdf4ce7ff92644d2e4265` was **52PASS/1FAIL/0SKIP**,314157ms. Failure was the unchanged P0 bank gate, line753: explicit legacy repair after database restart returned the **same four UUIDs in reverse order**, not evidence of a different generation or a timeout. Its earlier exact donor/playback/decoded-export assertions had passed. `getTrack` built bank snapshots from an unordered joined query; PostgreSQL is free to change that row order.

Fixed the **shared production query**, not the acceptance assertion: order published rows by stem type, then UUID. Already-saved explicit `assetIds` retain their stored order; no snapshot, donor, stem mix or cues are silently rewritten. Added a real PostgreSQL regression with deliberately non-sorted inserts, a reversed physical `CLUSTER`/`ANALYZE`, a simulated pre-upgrade reversed explicit snapshot and an ambiguous legacy item. It first reproduced unordered-bank instability, then passes with the query fix; legacy mix0.37 remains unchanged. The unchanged complete browser suites repeat **53PASS/0FAIL/0SKIP**,317720ms; bank215767ms,176400 stereo frames, max export sample error0.00009349733591079712; exact donor persists across restart. Logs `/home/user/music-browsers-e1d11cf.txt` and `music-browsers-bank-fixed.txt`. Initial regression setup failed on intentionally enforced unique storage keys; fixtures corrected to distinct actual private objects, not a relaxed constraint. Earlier CI assertion bodies remain unavailable, so this is a diagnosed/fixed **local** failure and plausible explanation for historical CI, not proof of those unseen assertions.

Acquisition review is now required for **registry download as well as owner-file import**. Owner must inspect manifests and attest source/licensing in the existing views; client refuses without it; owner-guarded seed route rejects missing attestation before fetching bytes. Cancellation still uses the existing resumable seeder. New client/route contracts and adverse physical-order test bring focused tests to40PASS. One fixture initially lacked the real HTTP `Host` header and correctly received401 before the expected400 review check; corrected the fixture header without weakening access control.

Canonical full source at `e1d11cf` before the bank fix:1403PASS/39suites/0FAIL/0CANCEL/0SKIP,727205ms command; equal start/end SHA and sourceDigest `cd7910fc22d3b2bdce33b3e28106306cb8dd652a57b99e4775455a62db418eaa`; receipt `.data/acceptance/source-suite/2026-10-19T17-41-24.854Z-3976.{json,tap}`. This is not the final bank-fix commit's full-suite receipt; new exact-commit verification follows. Serial browser32-distinct-source profile:552283136 sampled whole-browser PSS bytes,1520.2ms prepare/0.3ms replay/25.7ms edit/91.7ms maximum UI timer gap; latest-edit error0. Synthetic ten-second sources,50ms sampling, not compiled Next/Electron or a memory improvement. SoundCraft adaptation unchanged; no whole-app speed claim.

### Canonical-order compatibility correction (full-suite finding retained)

Full source at intermediate bank-fix commit `a71383b661aeb503cc4f56dda9dfe236f9232716` failed **1406/1407**,39suites,0cancel/skip,712721ms: unchanged `service.test.ts:389` requires vocals/drums/bass/other order. Receipt `.data/acceptance/source-suite/2026-10-19T18-13-56.692Z-12039.{json,tap}`, equal start/end digest `d31e922557fcc2498109f80dabf39b742fc436e87aa107af21c993cfe5e060a4`. Initial alphabetical ordering was deterministic but did not preserve that existing contract. Production now derives ORDERBY rank from **existing** `DEFAULT_STEM_CHANNEL_TYPES`, then stem type and UUID; saved explicit snapshots keep their original order. No acceptance weakened. Focused real library/source/provisioning/security69/69PASS (15845ms); new final full-source receipt pending. Earlier successes and this intermediate failure remain separate.

### Final local verification — canonical implementation bbae353

**Exact code head:** `bbae3531b8f9130bc8caf1f9f66bbc8b2b22a224`. Canonical full source **1407PASS/39suites/0FAIL/0CANCEL/0SKIP**,698204ms; equal START/END commit and sourceDigest `8ccbda44f0e93329405540787cbb6fbba488c3eab9d5dccce79b78e956576165`. Receipt `.data/acceptance/source-suite/2026-10-19T18-27-51.830Z-16194.{json,tap}`. Complete serial browser/audio **53PASS/0FAIL/0SKIP**,303135ms; unchanged bank gate207851ms/176400stereo frames/maxsampleerror0.00009349733591079712/exact donor retained across restart. New controlled public-source/model-import UI3.128s. Intermediate1406/1407 and52/53 failures above are retained, not averaged or hidden.

Root/production-worker typecheck, lint0errors/48existingwarnings, Next build, desktop compile/staging PASS. **Actual packaged headless native runtime64steps PASS**: Node staged server, embeddedPG/FFmpeg/localworker, explicit full-source bridge, version/export, two supervisor restarts, offline loopback core and cleanup. Separation correctly reports missing weights; passthrough is labelled unseparated. `.data/acceptance/music-bbae353/desktop-headless-report.json`. NOT Electron (binary/display unavailable), NOT learned model execution. No Windows-return dependency.

Unchanged bounded SoundCraft benchmark median25.579607ms, same PCM SHA5183fa2841894687679dda7c8a1041646041cc1818ab75fdafc6c928e1cdc4c7; no whole-app extrapolation.32 distinct10s stereo browser sources:549474304 sampled PSS bytes,1407.4ms preparation/.2ms replay/19.7ms edit/89.7ms maximum UI gap/error0, not a material memory improvement or compiled Next/Electron acceptance.

Documentation-only publication has separate exact-revision CI receipts on **PR15** after authoritative runs complete; the above local code-head receipts are not inherited by a different SHA. No merge/close. **Cancellation gate remains CLOSED**, regardless of CI: actual four/six learned stems/quality and real-music inference, live usable catalogue/current terms/region checks, fully connected performance/recording and Electron remain essential. Next: legitimately obtain/permit/import the four exact pinned MDX files, prepare the recipe, then execute the retained real CC-BY excerpt through production inference; validate live reviewed public discovery/play/acquisition where the provider host is authorised. Missing external prerequisites narrow claims only, not the rest of the implemented workflow.

## Replacement scorecard and implementation map

| Essential category | Status | Existing execution path / persistence | Evidence and remaining gate |
|---|---|---|---|
| Discovery / usable music access | **Partial; live access unaccepted** | `DiscoverCatalog` → `/api/public/projects` → published Arena projects; `streaming/adapters.ts` and `library-sync.ts` normalize external metadata; `authorized-source-resolver.ts` only dispatches to an explicitly configured compliant resolver | Inspected actual paths. New reviewed public Archive adapter and real publisher-licensed GitHub excerpt acquisition are detailed above. No configured resolver/equivalent commercial catalogue; live Archive access unexecuted. Arena release search is not STEM.FM's catalogue. Provider IDs, playlists and subscription offline files are not exportable audio. Essential gap, not excluded scope. |
| Owned-file import / compatibility | **Partial** | Library/ConversionWorkbench → library ingest/conversion handlers → native ffprobe/FFmpeg → private verified objects → source/track/conversion rows | Historical exact-ff09 native six-codec processing and reviewed AIFF/ALAC→FLAC recovery are evidence for that revision. MP3/AAC/WAV/FLAC browser-direct; AIFF/ALAC require explicitly reviewed derivatives. No protected-stream extraction. Current production swap proof uses native file intake, not a new browser-upload acceptance. |
| Genuine four-stem separation | **Blocked** | intake/mode selection → source + processing job → shared local/external separation handler → MDX `stems_4` recipe → validated private WAVs + atomic stem rows/job completion | Native Node ONNX binding actually loads; required four pinned model files absent. No genuine inference/quality, real-song residual, alignment or four-stem export acceptance. Registry points to Hugging Face, outside this sandbox's network allowlist. No repeated blocked download or replacement engine installed. |
| Model acquisition / resumption | **Mechanics verified; genuine-model execution blocked** | Existing MDX registry → seeder → model/status/seed routes → exact-target failed-job retry | Real local HTTP + SIGKILL/new-process resumption, revision-bound partials, strict ranges/validators, checksum-gated atomic install and cross-process publication lock.Historical23 seeding/status/recipe tests plus new owner-file import/provenance/cancellation regressions pass with controlled bytes; NOT weights/inference. `stems_4` endpoint now prepares ALL four registry models before retrying its job. UI distinguishes partial/resumable/download/verifying/model-ready and unavailable ONNX runtime. |
| Six-stem preparation / mapping | **Blocked / Partial** | Existing `deep.ts` Demucs bridge; PR14 proposes managed preparation, checksummed acquisition/import and UI | Python 3.11.2 exists; torch/demucs/numpy/soundfile/librosa/Python ORT and checkpoint absent. PR14 source inspected without importing/merging. Required checkpoint host is outside allowlist; code license does not establish checkpoint redistribution rights. Library/session now preserve actual `model` and use existing `laneDisplayName`: deep `other` = **Other**, MDX four-stem `other` = **Melody**. This is label correctness, NOT a verified six→four regrouping. Guitar+piano+other regrouping/quality remains unaccepted. |
| Playback / mixing controls | **Partial**, bounded transport **Verified** | TrackPlayer / SessionDeck → `useStemTransport` → real HTML media + Web Audio gain/solo/mute/inserts/master tap → existing playback state | Current 28 browser transport/session regressions pass, including meter signal, gain/mute/solo, loops, recording tap, transitions and source-replacement faults. Browser fixtures control HTTP; not real inference/Electron. Current compiled production proof independently verifies real donor signal, clock alignment and no unrelated lane reload. |
| Cross-track live mixing | **Partial** | Session UI → session swaps API/service → durable swap ledger → same deck's media lanes; Studio handoff reuses immutable assets | Fixed a reproduced silent donor change: same media/graph rejoins the current audible clock after new metadata, honors pause, fences replaced loads, reports failure. Actual compiled production swap/save/reopen/handoff/export passes. **P0.1 corrected and connected-tested:** existing job UUIDs identify separate published banks; ambiguous sources require explicit choice rather than eight lanes. Sessions pin exact per-membership assets and swaps pin exact donor UUIDs. Actual PostgreSQL + processing publication + SessionExperience/Chromium + database restart + Studio/version/FFmpeg decode gate passes (controlled spectral inference, not learned inference). |
| Tempo/key / transitions / loops | **Partial** | Session compatibility + beat/cue controller; TrackPlayer transport loops; Studio transforms → authorized asset audition/native DSP and canonical export | Current Studio suite executes pitch/tempo audition, stale-analysis rejection and local/isolated worker export parity. Session hard cuts/crossfades and cancellation execute. Live session compatibility is not proof of automatic/manual pitch/time matching; single-track loops are not a complete saved multi-track session loop workflow. Meeting-point mode explicitly lacks section-aware cue execution. |
| Sessions / continuity | **Partial** | `session-service.ts` → listening tables, transition JSON, swaps; faithful vs explicit sequential handoff | Current real production donor swap and position survive session reload, then Studio version/export reload. Existing transition/pause/fault regressions pass. New connected bank gate retains exact session and donor identity through later runs and database restart; legacy NULL snapshots block until explicit bank repair, preserving saved levels. Do not silently flatten/discard cues or substitute another generation. |
| DAW / arrange / process / export | **Partial**, bounded connected path **Verified** | existing Session→Studio handoff → remix tracks/clips/automation → save versions → canonical PCM Worker audition + queued FFmpeg/export → immutable objects | Current 23 actual browser/route/PG/FFmpeg integration tests pass, including range edits, undo/redo, version reopen, FX, export and transform parity. Additional current compiled production donor session→Studio→saved WAV→decoded spectral verification passes. Not a complete real-song separation→performance recording→restart acceptance. One earlier timed-split export differed by one PCM frame; do not claim bit/sample-exact universal export timing. |
| Reliability / recovery | **Partial** | existing job ownership/cancellation/finalization, private object validation, saved versions, explicit errors | New delayed donor/pause/revert/missing-source tests pass; existing worker interruption/cache-disposal and faulted export/retry paths execute in current Studio suite. New transport load deadline is 30s; failed replacement stops rather than silently omitting a lane. Focused partial-upload failure/actual retry regression preserves the previous bank, cleans unpublished objects and publishes a distinct recovered bank. No power-loss or orphan-scavenging claim. |
| Performance | **Partial** | canonical `ArrangementPreparation` + PCM Worker; existing source cache / master mix cache | Fresh 4/16/32 independently ingested stereo 10s sources measured, whole Chromium descendant-tree PSS sampled every 50ms. Reuse one dry scratch bus, not one full bus per serial track; deterministic allocation regression and PCM tests pass. **32-source sampled memory remains ~531 MiB in final suite**, not materially improved. Fresh harness excludes compiled Next hydration; historical 614.7 MiB / 254.9ms whole-flow observations remain historical, NOT revalidated or disproven. See measurements below. |
| Independence / desktop | **Partial / Blocked** | existing native FFmpeg, embedded PG, private local storage, optional in-process worker; desktop staged Next runtime | Current desktop TypeScript compile and server staging pass; no Electron executable/display available. Browser is not desktop acceptance. Local conversion/playback does not require TunePat, Redis or a streaming subscription. Offline learned separation requires the absent licensed models/runtime; no external app launcher counts as native replacement. |
| Overall connected replacement | **Broken / Blocked — gate closed** | Existing architecture retained, no parallel library/player/queue or added product dependency | Real-song learned stems + correct generation identity + usable catalogue access + connected matching/session/DAW/record/export/restart + realistic desktop performance remain essential. Green CI cannot satisfy these missing results. |

## Source-first reuse / acquisition record

- Reused existing `useStemTransport`, SessionExperience, source ingest/library/session services, private storage, canonical PCM/DSP Worker, `laneDisplayName`, embedded-PG and browser acceptance harnesses. No dependencies added, no new engine, no duplicate library/queue/persistence subsystem.
- Inspected MDX registry/recipe/seeding/session code, deep bridge, worker publication transaction, installed native binding, interpreter/package/model-cache availability; inspected PR14 provisioning runtime and documentation at its existing PR head `536c940c2df502f12f0945789e0053fa68466eff` via GitHub source, not branch switching/merging. PR14's wording about owner-machine inference is historical, not a requirement to return to Windows.
- Registry weights total roughly 148 MB for four-stem recipe (Kim vocals + drums + bass + other), none present. Existing code supplies checksum/integrity/publication machinery, but code/license/readiness are not executable weights or inference. Deep additionally needs its Python stack and `5c90dfd2-34c22ccb.th`. No new runtime/model acquisition attempted; allowed-host and license gaps are recorded, not bypassed with unverified mirrors/dummy weights.
- Existing branch-sweep manifest records imported original Waveyard engine/tests and why rejected monorepo/test-profile scaffolding was not imported. Existing REA research records evidence/provenance contracts, not a music engine; no blind REA import or new dependency. No other executable supplied music-engine/model installation was found in the inspected repository/cache/opt/interpreter locations.
- Existing npm-packaged Chromium153 at `/tmp/chromium` and NSS libraries were reused; no repeat browser/model download. No credential, DRM, protected audio capture or private TunePat interface work.

## Current connected production proof (synthetic, not inference)

`/home/user/master-production-swap-final3.txt` / `master-production-swap-result.json`:

- Current production Next page + real authenticated-session fixture + PG/private storage, two distinct 30s source mixes and 8 independently encoded, explicitly synthetic fixture lanes; not fabricated learned inference.
- Current live drum replacement audible after **145.540 ms** (one observation, includes UI/API/poll scheduling); all four observed lane clocks **4.191565s**, all playing; unaffected bass element retained, **0 reloads**.
- Saved swap **4.020317s** survives session reload; explicit sequential Studio handoff, immutable version, actual queued FFmpeg WAV, download/decode and Studio reload retain it.
- Final export **2,646,000 frames / 60s**. Projection amplitudes: pre-swap original220Hz **0.02121296**, donor660Hz **2.42e-7**; post-swap original **2.74e-7**, donor **0.02121252**. No renderer exceptions. End-to-end **10,328.145ms**.
- Earlier attempts retained: exact-frame assumption failed by one frame on one timed split; rerun accidentally reused identical fixture audio and appended a second bank (source checksum dedupe is real, bank contamination is a real defect); completed export is a Download link after reopen, not the fixture's assumed Export button. Corrected fixture uses unique phase/content, asserts new source identity and tests actual completed UI. None of those attempts is relabelled successful.

## Distinct-source performance receipts and budgets

All fresh rows below use actual canonical controller/Worker, native PG/owned private files, 32 unique source IDs, synthetic PCM and 10s stereo 44.1kHz. They do **not** include full compiled Next navigation/hydration or genuine separation. Sampler includes Chromium process descendants and shared-page PSS, not Node/FFmpeg/OS totals; 50ms sampling can miss instantaneous peaks. Engine byte counters are not process-memory limits.

| sources | baseline cold ms / PSS MiB | scratch-reuse isolated repeat cold ms / PSS MiB | final full-suite cold ms / PSS MiB | final prep-stage max UI gap ms | final warm / master edit ms |
|---|---|---|---|---:|---|
| 4 | 371.0 / 281.3 | 395.3 / 261.3 | 327.9 / 276.4 | 34.3 | 0.2 / 13.5 |
| 16 | 950.5 / 384.9 | 857.7 / 369.7 | 850.8 / 386.0 | 50.4 | 0.2 / 20.9 |
| 32 | 1600.3 / 527.4 | 1422.3 / 527.7 | 1415.8 / 531.0 | 93.7 | 0.1 / 17.4 |

All retain 441,000 frames, exact half-amplitude master edit, one decode per distinct source and valid cache replay. Single-run timing differences are not a statistically established speedup. A further `copyFromChannel` experiment **did not reduce whole-browser memory** (32-source ~533.8 MiB) and was reverted, not presented as an optimization.

Enforced preparation-stage regression budgets: max UI gap <250ms; warm same-buffer replay <20ms; no lost frames/source identities or PCM change. Provisional cold target <2s for this 32×10s preparation-only workload passed; provisional sampled browser target **512 MiB failed**. Neither target replaces desktop/full-flow/load/long-track/effects/cancel budgets. Dominant retained source ownership still exists in both main decode cache and Worker for cancellation/reuse; this delivery does not claim that solved.

## Highest-priority remaining acceptance

1. P0.1 underlying identity correction now has connected controlled-audio proof; retain full regression/CI coverage and explicitly repair ambiguous legacy sessions. Genuine-model acceptance below remains required; controlled inference is not a replacement-quality claim.
2. Genuine four-stem real-song inference, quality/alignment and export with verified available weights; six-source regrouping and distribution/license evidence. Missing weights only block this execution, not independent engineering.
3. Legitimate usable catalogue/search/acquisition acceptance, kept distinct from metadata/reference import and Arena publication search.
4. Connected live automatic/manual matching, saved session loops, recording, faithful Studio edits/export and service restart under the corrected identities.
5. Compiled production 4/16/32 distinct-source whole-flow profiling with stage attribution, process-tree/child memory, cold/warm/effects/export/cancel/replacement; historical full-page gap must be freshly measured before a whole-flow performance pass. Desktop acceptance remains unavailable here, not delegated back to Windows.

## Exact revision verification receipt

Implementation **`08e53dfc5f1a20a4a1f8b8e69669bdbca09b62af`**, clean/pushed: full source **1377 pass / 0 fail / 0 skip**,39 suites,645018.192ms, start=end hash. Exact-head paired CI [39254132028](https://github.com/imlochie/arena-os-canonical/actions/runs/39254132028) and [39254123588](https://github.com/imlochie/arena-os-canonical/actions/runs/39254123588) SUCCESS/all4jobs. Clean-head package restaging + headless supervisor/Chromium acceptance **58 checks PASS**, including ordered shutdown/restart and persisted session/Studio references/edits/export. This is not Electron or genuine inference. The local focused40 are included in1377; browser28/Studio23/staged58 are separate overlapping evidence layers, not a replacement-capability sum. The follow-up receipt-only commit changes documentation, not tested implementation. Gate remains CLOSED.

### Follow-up CI / fault-injection reliability correction

Receipt-only10632e0: CI39255689431 succeeded; CI39255697465 failed an existing conversion interruption test (other jobs and new transport/session steps passed). Full signed assertion logs were inaccessible; annotation retained. A local isolated run independently reproduced State:R immediately after SIGSTOP readiness IPC. Corrected fixture now acknowledges observed kernel State:T with a bounded deadline; parent retains strict state/partial-output/cancel/retry checks and requires confirmation. No application change. Final local native10 and full durable99 pass; overlapping counts, not additive. Original failed CI and rejected rerun request remain in the continuation chronology. New final-head CI is reported in the PR receipt, not retroactively as a first-attempt pass of10632e0.


### P0.1 continuation — 2026-10-19

- Two four-lane runs publish distinct banks using existing processing jobs/assets (no new registry). Bank1/bank2 session memberships each contain four intended assets; additional runs never re-resolve a pinned donor by type.
- Permanent connected gate: `tests/acceptance/studio-fx.test.mjs`, test name `P0 bank gate`; actual PostgreSQL restart, real media playback, exact donor source, eight Studio tracks across TWO four-lane items, actual queued FFmpeg export. 176400 stereo frames at 44.1 kHz; decoded maximum sample error 0.00009349733591079712 against arrangement from exact pinned WAVs (threshold 0.0003; frame tolerance ≤1). Controlled spectral inference seam, NOT genuine learned inference or Electron.
- Library/worker checks: 41/41 before additional partial-upload regression; focused partial-upload/actual retry 1/1. These overlap broader runs; do not add counts as distinct acceptance. Session browser suite 17/17; typecheck/build pass; lint zero errors, 48 existing warnings. Complete source-suite attempt still pending at documentation time, not reported green.
- Canonical desktop migration uses statement breakpoints (PGlite initially rejected the unsplit migration; fixed and revalidated). All legacy selection values remain NULL until explicit selection; no destructive repair.
- P0.2 provisioning inspection confirms checksum-bound atomic install and shared in-flight downloads already exist. Interrupted downloads currently lose their temporary bytes: resumable provisioning remains unfinished. No unavailable weights downloaded or dummy models installed. Genuine inference, licensed catalogue, Electron and replacement gate remain unaccepted. **Cancellation gate CLOSED.**
- Broad source run follow-up: failures explicitly report missing shared PostgreSQL (`PG required`); full suite is **not green**. Scoped independently provisioned PG/worker/browser evidence above remains bounded; do not attribute prior CI to this patch.


### P0 provisioning/source absorption — 2026-10-19

- Reconciled checkout files exactly to63d9158; local Git metadata had reverted to f0e4180. Temporary-index comparison showed no file differences against63d9158 before a mixed metadata reconciliation; no working file discarded. PR15 head63d9158 and PR14 head536c940c remain OPEN. Starting63 CI39266205690 success;39266196825 failed browser job while static/A7/Compose passed. Signed failed-log retrieval was unavailable; do not conflate the two runs.
- Corrected complete-source invocation: `npm test` now starts owned embedded PostgreSQL, applies canonical desktop migrations, serializes legacy whole-table-clearing test files, retains raw TAP/dated structured checkpoints, fingerprints source and exits nonzero on failure/change. Initial corrected full run at dirty63d9158:1389 tests/39 suites/0fail/0skip, exit0,807440ms. Later edits require their own final-head verification; this is not that result. See `docs/SOURCE-TESTING.md`.
- Existing seeder now retains revision-bound partials, validates If-Range/Content-Range/validators/length/encoding, safely restarts incompatible responses, verifies SHA before final rename, and coordinates same-process/file/process callers. Actual SIGKILL sample:262144 prefix bytes persisted,1835008 resumed bytes,2097152 final bytes, SHA256 `00f9b2692b77ab01c8a7e1598ebfa15897db79229ec47ccc7d46d204356cc504`. Test data are random fixture bytes, not models. Full seeding/status/recipe suite23pass0fail (`provision-all-seeding-final.txt`); additional target-readiness changes passed actual recipe/status handler regression.
- SoundCraft sorted-breakpoint approach integrated into shared automation and actual PCM renderer: unchanged Node controlled dense-lane benchmark median4777.547875→29.972894ms, identical Float32 PCM SHA256 `5183fa2841894687679dda7c8a1041646041cc1818ab75fdafc6c928e1cdc4c7`.13 focused automation/PCM tests pass. Not whole-app/browser/Electron/memory/genuine-song performance. Source comparison, licence pins and selective non-reuse decisions: `docs/waveyard-source-absorption.md`.
- New inspection: native Node ONNX binding loads. No compatible ONNX/checkpoint files found under /home/user or /opt; Python torch/demucs/numpy/soundfile/librosa/ORT missing. PR14 pure preparation source inspected at its exact head, not merged. No model host retried or arbitrary mirror used. No authorised searchable music catalogue/resolver acquired. Electron binary/display still missing; preflight is not desktop acceptance.
- This extends provisioning and automation, not the overall replacement gate. Genuine four-stem inference, authorised music access, connected real-song matching/recording/export/reopen and everyday desktop performance remain unaccepted. **Cancellation gate CLOSED.**

### Exact code-head validation —004a3eb

- Complete source: **1397/1397 pass,39 suites,0fail/0skip**, exit0,935162ms. Start/end commit004a3eb and sourceDigest2edda97385d57c4a5fa20f3dc9ccc66ee2c1e776374459175f5dceee4181ad0d match. Owned migrated PostgreSQL, no mock/skip replacement; dated structured receipt and TAP under `.data/acceptance/source-suite/2026-10-19T15-24-33.389Z-6760.*`.
- Focused session browser17/17; isolated full Studio/browser/PG/FFmpeg24/24, including bank-identity restart/export gate (176400stereo frames/max error0.00009349733591079712). Earlier overlapping Studio23/24 Toggle loop timeout and killed concurrent build remain failures, not hidden. Isolated production build and desktop server staging pass, including shipped licence notice. Typecheck, worker production typecheck, desktop compile and lint pass (48existing warnings).
- Benchmark repeated at committed head: dense automation median33.451378ms, same PCM SHA256; earlier median29.972894ms remains the initial controlled after result. No material-memory/whole-app performance claim.
- CI004a3eb:39277641295 push browser/A7/Compose verified green;39277650097 PR A7/Compose green. Remaining static/PR-browser statuses still in_progress in latest run/check JSON; job-detail API502 prevents further inspection. Watch exit0 did not equal completed JSON; **full CI success not claimed**. Documentation follow-up is not covered by these code-head receipts.
- Model provisioning is a real new recoverable capability, not real separation acceptance: absent pinned weights/authorized model-host access still block genuine four-stem output; deep packages/checkpoint and equivalent licensed catalogue access remain missing. **Cancellation gate CLOSED.**
- CI follow-up: BOTH004a3eb runs39277641295/39277650097 now authoritatively SUCCESS. Docs-only1d091b8 push browser passed, but PR39280998002 browser FAILED at the P0 bank gate (annotation verified). Exact assertion inaccessible through current log-host restrictions; cause unresolved, not assumed timeout. Static/final run metadata still incomplete. Latest-head blanket green remains unaccepted; preserve failed attempt alongside local24/24 and earlier exact-source CI successes. See PR15 comment6271327559/follow-up for current receipt without attributing checks across heads.

### 2026-10-20 — ownership proposal tested; recovery correctness retained

Reviewed PR16 `349cd678` against published571a05a; no PR14/15/16 merge. Exact
PR16 full typecheck +10focusedPASS. Existing real-browser4/16/32-source harness
actually exists on BOTH heads. Three controlled baseline/candidate-overlay runs
per implementation now include complete stereo cold/edit SHA256, exact frames,
UI gaps/replay/edit times and real Chromium descendant PSS. At32, median sampled
peak529.43→519.64MiB (still FAIL provisional512MiB), natural retained526.14→416.79MiB;
all six complete hashes match at every workload. These are not native/Next/
inference measurements. Details, exact identities/commands/failures and evidence
locations: `docs/waveyard-performance-ownership.md` appended review.

**Ownership release NOT accepted:** existing warm cancellation test regresses;
controlled source-endpoint outage makes cancel/retry fail after a successful
render because its only source owner was terminated. Keep owner-branch decoded
recovery copies. Independently fixed real Chromium clone-failure orphan rejection
and raw/finished/playback source-version invalidation, with per-asset isolation
(no neighbor refetch). Both regressions reproduced before fixes;5focused actual
browser/controller/Worker tests nowPASS; PCM7PASS/types/lintPASS. Broad final-head
source/browser/build/staged-native receipts pending at this checkpoint, not
inherited. Historical failed instrumentation preserved/excluded from table.
No changed replacement/inference/acquisition/Electron claim. Gate CLOSED.

### 2026-10-20 next mandate — durable collection-file acquisition + recovery

**Acquisition implemented:** on existing Discover/Archive interface inspect an
eligible public audio item (an album/file group, NOT arbitrary nested Archive
collections), review rights, select files in desired order, Enqueue selected.
Requires existing in-process Waveyard worker (desktop/local mode without Redis).
`processing_jobs` persists stable batch/index/file/provider-SHA1/size/licence
intent, statuses/stages/bytes/attempts/failures/publications. Same batch request
replays saved intent even during metadata outage, never mutates it to another
selection. Existing LocalJobBroker executes serially; PG advisory locks + run IDs
fence other processes/cancel/late writes. Explicit Resume after runtime restart
restarts the download; Retry is explicit for failed/cancelled items. Cancellation
near publication may leave verified library audio, retained and linked rather
than erased or falsely called absent. Attempt history survives retry. Active
cancel→immediate retry tested through real API/broker, not swallowed by active-ID
deduplication. No new downloader process, queue framework or parallel library.

Source asset FK is now nullable ONLY for acquisition via a database CHECK;
other job types still require source identity. No placeholder audio created.
Desktop0024/server0025 migrations, matching worker schema and explicit
conversion/separation guards preserve existing invariants. Import revalidates
rights/file version, checks exact byte count/provider SHA1, performs complete
native FFmpeg decode with `-xerror`, then uses existing checksum-locked library
intake. Completed publication rechecks actual private stored SHA256/length and
owner/source identity. Completion and membership in the existing library playlist
are atomic; selected order survives out-of-order completion/retry. Same output
is played in current TrackPlayer and referenced in existing Waveyard project;
explicit unseparated bridge remains clearly labelled, not inferred stems.

**Executed bounded proof:** existing PG/native Archive contracts6/6, including
cancelled queued work, provider version change/no publication, same-batch offline
replay, wrong-owner refusal, duplicate request/output and actual PG stop/start
resume. Real-browser two-file selection→jobs→ordered playlist→reload→actual
playback→same source/Studio references passes; active cancel/retry completes
without duplicate library track. Separate opt-in real recording uses original
CCBY3 publisher excerpt *Slow Motion Dream*, Steven M Bryant/Ft CSoul/Alex Beroza/
Robert Siekawitch. Actual GitHub blobcc91788843d20ae7af169d6e0f72c2c5658fdb39
retrieved262867bytes/SHA4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507;
publisher-specific media grant at pinned Deezer/Spleeter README c8854001.
Then queued native full-decode/import/provenance/download exact bytes/browser
playback/explicit source-only Studio reference passes. **Archive boundary remains
controlled in this run**, not a real Archive upload/listing/collection or live
provider authorisation claim. Media grant is a publisher statement, not code
licence or independently warranted authorship. Real file retained in ignored
`.data/acceptance/acquisition-next/`, not made an essential shipped dependency.

**Still NOT established:** live Archive inspection/acquisition (fresh request
failed `TypeError: fetch failed` here), provider terms/region/uploader authority,
nested collection traversal, byte-range resumption/automatic startup rescheduling
or arbitrary commercial-service acquisition. Spotify/Apple/Tidal references are
not downloadable audio. No DRM/access bypass or nominal support claim. This is
an implemented/tested native slice with real-audio downstream proof, NOT the
required complete live real-world acquisition acceptance. Recorded-source
notices are visible/downloadable; automatic export notice propagation unfinished.

**Memory:** original PR16 remains draft/unmerged. Independently developed encoded
Blob recovery retains a usable source outside terminable Worker, releasing a
decoded copy only after success and only when smaller original bytes survive.
Warm cancel, warm clone/error during source outage retain1fetch/error0; individual
revision/neighbor isolation and full stereo hashes preserved. Isolated baseline
and candidate each1407sourcePASS/58browserPASS; overlaps not summed. A self-found
budget-retry bypass was reproduced and fixed before combined verification.
Latest comparable3runs each:32-source median PSS peak526.59→508.69MiB, natural
retained521.35→403.50MiB; all6 cold/edit hashes match at4/16/32. Latest3peaks
below512MiB, earlier candidate set median519.13MiB remains a limitation, not
whole-app performance acceptance. Details/history: performance-ownership append.
Repaired alternative integrated as source edits, NOT a merge of PR16. Final
combined-head broad source/browser/build/native/CI pending at this checkpoint;
final exact-head receipt closes it without borrowing historical checks.
Genuine learned4/6stem quality, full real source→model→session→export and actual
Electron still unaccepted. **Replacement gate CLOSED.**

## 2026-10-20 — native inference lifecycle repair (new master mandate)

Implemented native cancellation/acknowledgement/restart in the actual project UI,
process abortion, atomic executor claim and cancellation/publication arbitration.
Verified source bytes precede inference; completed banks survive derived-waveform
reporting failure. Public deep readiness now requires actual CLI import and
checkpoint-prefix integrity; it explicitly does not assert learned inference.
See `waveyard-native-separation-lifecycle.md` for execution scope and limits.

| Capability | Current distinction |
| --- | --- |
| Native stop/reload/restart and bank preservation | Implemented; real browser/DB/storage/process checks, controlled inference |
| Deep runtime/checkpoint diagnostics | Real import/hash checks; NOT an inference/quality result |
| Actual learned 4/6 sources and melody assessment | Not accepted; trained checkpoint/runtime unavailable here |
| Live permitted catalogue retrieval | Not accepted; controlled-provider/real-recording evidence remains separate |
| Real recording → learned bank → reopened project → export | Not accepted; no learned bank produced |
| Actual Electron / Windows | Not accepted; binary/display unavailable |

PyPI was rechecked: latest Demucs is now4.1.0 (Python>=3.10), not the independent
PR14's pinned4.0.1. Local legacy-repo compatibility is source-inspected, not a
claim that either version executed inference. No PR merged. **Gate CLOSED.**

## A8 preparation/inference execution checkpoint (2026-10-20)

Gate remains **CLOSED**. PR14 provisioning is selectively reconciled on owner
PR15, not merged. See `DEEP-ENGINE-PROVISIONING.md` and the appended continuation
for changed paths and controlled regressions. The new explicit native Demucs
four-source model is independent of the MDX `stems_4` recipe; accepting one never
accepts the other. A new opt-in hosted test exercises genuine publisher music
and independently trained four/six checkpoints through the existing product.
Its implementation is not its execution: A/B/C/E/F remain unaccepted until an
actual retained per-engine receipt passes; D (crash recovery/guardian matrix)
remains open regardless. Browser evidence cannot become Electron acceptance.
Full replacement, commercial clearance and catalogue access are not claimed.

## A8 actual trained four/six workflow — verified limited scope

**Do not cancel yet; D and broader replacement remain open.** Run
[39390069082](https://github.com/imlochie/arena-os-canonical/actions/runs/39390069082)
on `9e9aec50...` passed actual **Demucs** four AND six trained checkpoints on the
publisher-permitted recording, through native product job/bank/browser player,
persistent session, Studio/version and independently decoded arrangement WAV.
Ten complete distinct stems479832frames each; two exports479808frames each at
44100Hz stereo. Audio, attribution and per-model receipts are in artifact
12249491337 (36.9MB). Exact weights/hashes/failures are appended in continuation.
This establishes A/B/C and browser-scoped E/F, not MDX `stems_4`, Electron,
Windows, semantic instrument quality, hash-locked transitive dependencies or D's
process-crash lease/guardian matrix. In-process cancel/retry tests do not stand
in for process-crash recovery. Low six-source guitar/residual levels are explicit.

### Stronger A8 E check found a real isolation defect

The prior browser-scoped E result did not measure post-fader solo behavior.
Run39392843074 exposed Bass remaining audible after drums solo on a newly loaded
learned bank. Treat that E behavior as **Broken at f3653ac**, not accepted from
ARIA button state. A shared sparse/stale mixer-control fix and bank-scoped loader
are implemented; the unchanged genuine signal assertion and new controlled
Web-Audio regression must pass before this finding is closed. A/B/C/F execution
from earlier trained-model runs is preserved; D, semantic quality, MDX and
Electron/full replacement are still open, never averaged into a pass.

### Incremental D data-safety fixes (not a recovery acceptance pass)

An executor-owned pipe now bounds native Demucs lifetime to its Node executor;
real OS-process tests cover normal exit and abrupt executor death without
signalling an orphan/persisted PID. Recovery adversarial testing then exposed
lost COMMIT acknowledgement deleting an already published bank. Cleanup is now
reference-aware and retains uncertain output, tracks even failed partial writes,
and preserves completed provenance. Three controlled boundary regressions pass.
These are meaningful D improvements, but durable ownership, restart reconciliation
and the full requested crash matrix remain OPEN. b92f183 source1478PASS and CI
39394119736SUCCESS include browser sparse/stale solo regression; outstanding
trained-model runs are not converted into an E/F pass before final receipts.

### Stronger E progress, without concealing two genuine timeout failures

7adf16a exact full source1481PASS/39suites/0SKIP; real local browser transport
12PASS. Genuine39393483566 and39394119731 executed four-source inference,
validation and the real post-fader mute/isolation assertions, but FAILED on a
navigation-invalidated POST response-body read in the test, before six/export.
The shared bank/session acceptance helper now independently verifies actual
request bankId and persisted fresh session asset identities, actual native
navigation and reopen, rather than awaiting the abandoned response body.
A controlled actual-player two-bank regression passes with real analyser signal
checks and saved-bank reopen. Complete learned four/six E/F remains pending the
next genuine run; D and complete replacement remain OPEN.

### Stronger trained-model browser E/F accepted on7136c9d, not full replacement

Genuine run39399418007/job118550100654SUCCESS; durable normalized receipt at
`docs/evidence/waveyard-native-a8-7136c9d.json`, audio/trace/export artifact12253472401.
Both native4/6 trained checkpoints now complete A/B/C plus actual post-fader
mute/isolation signal assertions, actual player session-bank POST/persistence,
native session navigation/reopen and full Studio arrangement/export decode.
This is stronger browser E/F evidence than the earlier UI-state/API-session
runs. Ten full-length distinct stems, two decoded exports; no fake inference.
Six guitar/other low AC RMS and all semantic-quality limitations remain explicit.
Local controlled transport12PASS and connected music regressions4PASS support
regression coverage, not trained-model evidence. Local source1481PASS was exact
7adf16a;7136c9d only changes acceptance/docs, with current CI separate. One prior
parallel CI failed the checkpoint-change invalidation case while the other and
local full suite passed; retain that discrepancy rather than declaring blanket
CI success. **D OPEN; Electron/Windows, MDX and catalogue not accepted; full
replacement CLOSED.** Existing chronology failures are not deleted or reclassified.

Implementation7136c9d subsequently passed BOTH CI39399418135 and39399423575
(source/type/lint/build, real-runtime, images, browser workflows). This does not
erase the prior readiness-test discrepancy or turn D/full replacement green.

## 2026-10-20 continuation — Gate D crash-recovery implementation (OPEN)

Durable native execution journal, incarnation-safe restart reconciliation, shared atomic bank publication, guarded Python **and actual FFmpeg** executor ownership, cancellation arbitration and durable postcommit temporary cleanup are implemented on PR15. Local expanded SIGKILL/fresh-process/real-PG crash matrix41PASS, browser audio transport12PASS, guardian/deep17PASS, typecheck/lint/build pass. Earlier failures and stopped/mixed-source runs are retained, not erased. See [Gate D implementation, crash methods, D1–D10 status and raw evidence](waveyard-native-crash-recovery.md). New genuine trained crash/retry and exact-revision full-source/CI remain outstanding at implementation publication; independent visible reconciler-attempt history remains unaccepted. **D is OPEN**, not averaged against prior genuine7136 A/B/C/E/F or other gates. PR14/15/16 unmerged; Agent B memory/PCM files untouched.
