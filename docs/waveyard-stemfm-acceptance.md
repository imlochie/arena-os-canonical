# Waveyard vs STEM.FM — executable gap ledger, 2026-10-21

**Parity OPEN; superiority OPEN. No release or merge approval.** This is an evidence index, not a replacement DAW or a change to the release contract. Starting checkout04d50f05836f15d867d6baf8e77a7b736dad1fc0, clean, fixed Agent A session branch. PR22 is Agent B's current separate Arcade work; its tree is untouched. PR14/16 remain untouched. The older completion plan's later Parts7/8 already describe console/inserts/cleanup/mastering implementation; its earlier “UI next” paragraphs are not current gaps.

## Research and method

Public official help inspected21October2026, not a paid hands-on comparative evaluation. Claims below describe documented functionality, not independently measured competitor quality, actual catalogue licensing/access in our region, or every undocumented implementation detail. This matrix is a living inventory; newly discovered relevant functionality must be added, not silently excluded. Rights/subscription and device prerequisites are real dependencies, not permission to acquire protected audio.

Sources:
- [Help index: app, DAW, uploads, sharing, publishing, hardware and artist rights](https://help.stem.fm/)
- [Online player: discovery, genres/moods, links, uploads, four stems and formats](https://help.stem.fm/articles/stem-player-online)
- [Quantised mute/isolate/swap: bar, beat, half, quarter](https://help.stem.fm/articles/app-faq-stem-swap-mute-isolate-on-beat)
- [Instant Restore and hold/release](https://help.stem.fm/articles/app-faq-quantise-performance)
- [Key strategies: Camelot, Match, Preserve, Off](https://help.stem.fm/articles/app-key-matching)
- [Supported links/playlist import](https://help.stem.fm/articles/does-stemfm-work-with-any-song)
- [DAW master track, transforms, upload, order/overrides](https://help.stem.fm/articles/starting-your-first-project-in-stem-daw)
- [DAW saving, per-stem WAV export and live mix recording](https://help.stem.fm/articles/saving-and-exporting-in-stem-daw)
- [Mix snapshot sharing versus recorded gesture history](https://help.stem.fm/articles/sharing-your-mix)
- [Full Tracks/Balanced/Short & Punchy](https://help.stem.fm/articles/choosing-a-transition-mode)
- [Stem2: Bluetooth, local playback, account/Wi-Fi/firmware, NFC and planned features](https://help.stem.fm/articles/stem2-faqs)
- [iOS listing: microphone, recording, suggestions, shuffle and session visibility](https://apps.apple.com/gb/app/stemfm/id6753893767)

## Feature-by-feature acceptance map

PASS below is a bounded named test, never whole-category parity. HISTORICAL PASS belongs to its original revision. OPEN includes unverified implementations; it does not mean absent. External access cannot be called PASS merely because an adapter exists.

| Mandatory experience | Current existing path / acceptance and gap |
|---|---|
| Track/artist search | Library service/search + MusicHome; local SQL integration tests. Commercial catalogue equivalence OPEN. |
| Genre/mood/vibe discovery | ArchiveAudioDiscovery, DiscoverCatalog and streaming metadata; useful lawful playable recommendations across sources OPEN. |
| Catalogue acquisition | Reviewed public Archive adapter + configured authorized-source resolver. No invented catalogue size or commercial rights. Live service access/credentials and licensed playable breadth OPEN. |
| Song-link intake | authorized-source-resolver + acquisition jobs; requires a compliant configured resolver, metadata URL is not audio. Live supported Spotify/Apple/YouTube acquisition OPEN. |
| Playlist-link import | Existing streaming adapters/library sync; playlist export matching retains unresolved references. Full live supported playlist-to-playable session parity OPEN. |
| Owned full-file upload/import | source-ingest/audio, conversion engine/native FFmpeg and Library; connected licensed recording acceptance exists at04d. Current head rerun required. |
| Existing separate stems | Existing bank/asset-selection contracts; no assumption that arbitrary files are aligned. User-driven validated multi-file aligned import acceptance OPEN. |
| MP3/WAV/M4A/FLAC and conversion | Native probe/decoder/conversion, not filename-based success; format-specific current-head journey OPEN until exercised. |
| Microphone/voice/instrument capture | Voice/recording surfaces are not proof of library microphone intake → separation/session. Connected microphone workflow OPEN. |
| Personal library/uploads/likes/recent | library service, collections and TrackPlayer; core SQL tests exist, full comparative mobile usability OPEN. |
| Sessions create/add/remove/reorder | session-service + SessionExperience; existing actual-audio/session/SQL tests. |
| Session suggestions/recommendations | existing match/analysis routes; recommendations require available playable bytes and measured evidence. Difficult-material quality OPEN. |
| Session prompt generation | automatic remix/BuildProject paths exist; actual idea→coherent session quality OPEN, not inferred from returned JSON. |
| Suggested continuation/endless playback/shuffle | Existing next-session-track logic does not establish complete recommendation/endless/shuffle equivalence. OPEN. |
| BPM/key metadata | source analyses, beat-grid and musical-key contracts. Confidence/unknowns retained; diverse real-music accuracy OPEN. |
| Four-stem trained separation | Historical learned Demucs4 PASS at c82; MDX recipe/model/runtime status separate. Current head inference and quality OPEN. Other is not relabelled Melody. |
| Six-stem and actual stem reuse | Historical learned6/player/session/Studio/export PASS at c82; current-head inference/quality OPEN. Category count is not superiority. |
| Preparation/progress/cancel/error/retry | Existing shared processing jobs, native journal, broker/worker and deep preparation; never fabricate success/fallback. Current exact acceptance required. |
| Durable source/bank ownership | checksum-pinned private objects, bank identity/asset snapshots, atomic publication; existing regressions retain committed audio under uncertainty. |
| D1–D10 | Canonical definitions/status in waveyard-native-crash-recovery.md, especially D8 independent reconciliation history. All10 mandatory; Gate D OPEN. Controlled44 crash cases ≠ complete trained matrix. |
| Independent stem volume | Canonical useStemTransport media/Web Audio gain; existing player and console. |
| Mute/isolate/restore | This increment adds SessionExperience controls over the same gains, exact fader recall and pre-isolation mix restoration, persisted in existing transition JSON. Evidence below. |
| Snap half/quarter/beat | This increment interpolates only inside strictly ordered measured beat intervals; source-clock queue with explicit unavailable evidence and deadline cancellation. Not sample-locked. |
| Bar changes | New4-beat grouping explicitly anchored to grid origin, NOT verified downbeat/bar detection. True musical bar parity OPEN. |
| Instant Restore | This increment provides immediate versus snapped restore; same canonical graph. Pointer hold/release gesture parity remains OPEN; isolate currently explicit toggle/button. |
| Cross-song swaps/restoration | Existing exact donor UUID + media-lane clock rejoin and durable swap log. Beat-accurate ready-buffer swap/cross-BPM phase matching OPEN; new snap preference does NOT quantise existing swap network requests. |
| Transport continuity | Existing two physical decks, source cursor, pause/seek/freeze/crossfade recovery. Pending new mix gestures cancelled on context change; no stale replay after reopen. |
| Key strategies | Existing musical-key/Camelot primitives + Studio pitch render. Live session Camelot/Match/Preserve/Off audition equivalence OPEN. |
| Automatic tempo matching | Existing Studio transforms/elastic/native export; live multi-deck tempo phase-lock OPEN. Compatibility score is not an applied transform. |
| Automatic transitions | Existing manual/beat/bar/meeting-point config and actual crossfades; Full/Balanced/Short session strategies, cue intelligence and musical quality OPEN. |
| Loop/speed/pitch performance | Existing transport loops and Studio transform audition; saved multi-track performance loop/key-tempo strategies OPEN. |
| Performance recording | Canonical transport master tap, CompareAB and Visualizer record actual audio. Listening-session gesture recording/export is not established; OPEN. |
| Mix snapshot sharing | Public project publication exists; immutable exact listening-session tracks/stem/settings share-link workflow OPEN. No gesture replay inferred. |
| Session visibility/popular/shared discovery | Publication/moderation paths exist; private/unlisted/public listening-session parity OPEN. |
| Timeline placement/move/cut/trim/loop/layer | Existing arrangement/clip-selection/Timeline/Inspector and canonical render. No second engine introduced. Current regression required. |
| Multi-source arrangements | Existing source pool/placement + faithful or explicit sequential session→Studio handoff; no discarded transitions/cursor. Live mix gestures are NOT recorded automation. |
| Master song tempo/key and per-song overrides | ProjectMusicalWorld/Studio transforms exist; automatic first/top-song master reference and reorder/rematch UX parity OPEN. |
| Per-stem effects/mixer/master | MixerConsole/InsertRack and shared worker DSP exist. Inspected registry exposes22 named insert processors, not proof of the required26-processor product claim. Reconcile missing/distinct four + audition/export coverage OPEN, not silently reduced. |
| Metering/buses/advanced routing | Real analyser taps and pure mixer routing exist; full persisted console bus-to-audition-to-export workflow OPEN until proven. |
| Export individual stems | Existing checksummed asset download/bundles; native decode tests. Batch selected song/stem export UX parity OPEN. |
| Export finished mixes | Existing queued WAV/version/rights ZIP + independent full decode; current exact connected run required. |
| Project save/reopen/version/undo | Existing remix persistence/history; no new persistence store. Complete packaged crash/recovery and portability acceptance OPEN. |
| Cross-device portability | Server database + immutable audio/bundles stronger architectural basis than local-only storage, but full import/reopen on another machine OPEN. No superiority claim. |
| Piano roll/MIDI | Existing studio/piano-roll, MIDI-file/native export; functional tests exist, integrated musical usability OPEN. |
| Mashup intelligence | Existing MashupStudio + measured analysis. Difficult-real-material coherence/subjective quality OPEN. |
| Vocal chops | Existing VocalChops + measured vocal events/derived assets. Current real-music generation/reuse acceptance OPEN. |
| A/B DNA helix + recorder | CompareAB actual independent sources/master tap + recorder exist; current recording/decode and human usability OPEN. |
| Customisable13-scene visualiser | Existing VisualizerStudio + scene renderer/recorder; scene-by-scene functional/customisation/persisted recording acceptance OPEN. |
| Mobile/responsive/touch | Browser architecture + media-session hardware keys; no native iOS app parity or comprehensive mobile audio interruption acceptance. OPEN. |
| Physical Stem1/Stem2 controls | Existing stem2 capability/routing/media-session contracts and honest device panel. Real hardware account sync/Wi-Fi/offline storage/LEDs/firmware/NFC/pairing remain BLOCKED by hardware/protocol/provider prerequisites, not claimed from Bluetooth audio. |
| Hardware software equivalents | Software controls, saved private assets and media keys are partial equivalents; physical battery/acoustics/durability are device properties, inventoried not fabricated in software. Real-device tests still required. Firmware-planned features remain distinguished from shipped competitor claims. |
| Publishing/rights/artist payments | Existing publication acknowledgments/moderation/attribution are not fingerprinting, commercial licensing, royalty settlement or ownership verification. Relevant rights/publishing/claim/takedown parity OPEN. No DRM bypass. |

## Highest-value ordering after live inspection

1. Close actual session-performance gap using existing transport + existing transition JSON (this increment); prove audio timing, restoration, no stale queue, persisted recall and regression.
2. Phase-preserving prepared donor swaps + applied live tempo/key matching; these unlock coherent real multi-song performance rather than just scores/UI.
3. Lawful playable catalogue acquisition/provider integration and session suggestions, with explicit unavailable prerequisites; no repeat of known-inaccessible download loops.
4. Current-head genuine inference/quality corpus and complete canonical D1–D10, especially D8; dense mixes/difficult vocals/transients/genres require authorised sources/reference stems and listening, not synthetic quality scores.
5. Connected performance recording → portable project/reopen/export and target native/mobile/hardware acceptance.

## This increment's executable evidence and limitations

- `performance.test.ts`: variable-tempo grid interpolation/no extrapolation, invalid grids, missed deadline/pause/seek, exact non-unity recall/isolate/restore, transition-JSON validation.
- Existing `library/service.test.ts` extended through real API PATCH, canonical PostgreSQL/migrations, fresh Node application process and invalid-patch preservation. Real synthetic PCM intake, not trained inference or abnormal shutdown acceptance.
- Existing `session-runtime.test.mjs` extended: analyser samples and actual HTML source clock prove no premature mute and silence near target, settings/muted recall reload, isolate/Instant Restore audio, pause/seek/cancel/missing-grid behavior. Controlled HTTP persistence is explicitly NOT SQL; SQL proof is separate above.
- Source-clock dispatch is browser-frame best effort with80ms lateness rejection, not sample-exact output scheduling. A backgrounded/missed action is cancelled, not delivered off-beat on return. No extrapolated BPM/grid/downbeat.
- Faders remain immediate; new snap setting covers mix actions only, not network-driven swaps. Up to64 pending gestures, explicit overflow refusal. Paused actions apply immediately; pending actions are not durably replayed.
- Existing debounced save acknowledgement/error reporting was not upgraded here; browser-close-before-save and network write failures are OPEN, not durable-success claims. Recall is proven after actual persistence, not merely after an optimistic control change.
- Failed baseline UI test retained under `.data/waveyard-performance/before.tap` (20s timeout because controls are absent), with a build plugin serving unmodified04d SessionExperience. Its old harness header hashes the working-file path, NOT the plugin override; baseline identity is the explicit git-show loader, not that printed hash. No failure hidden.
- Final exact-head source/build/browser/connected/staged/genuine CI receipts must be recorded after commit; precommit results are not inherited by a changed SHA. No fair same-material STEM.FM comparison has been executed; superiority remains OPEN.

## Continuation: acknowledged session edits (2026-10-21)

The original increment's exact-head result is `cadccef` (1625 source tests, 32 browser/audio tests, seven hosted successes including genuine Demucs 4/6). Raw receipt: `.data/waveyard-performance/receipt.md`. Those counts do not automatically validate this continuation.

Implemented the next save-reliability slice in the canonical SessionExperience, not another persistence service:

- One per-controller serial PATCH writer coalesces each track's latest mix/settings snapshot. A delayed predecessor cannot overwrite a later request from this controller. Completed transition cue writes use the same writer; advancing decks no longer cancels the outgoing edit debounce.
- Pending/saving/acknowledged/error states are distinct from the separate transport restore-point indicator. HTTP/network failures keep the latest snapshot in this page, show the rejection and offer explicit retry. Failed edits are not silently replayed by a timer. Studio handoff awaits edit acknowledgement and stops on rejection.
- Page-hidden/unload paths flush without waiting for debounce, use keepalive and warn before leaving with unacknowledged edits. This is best-effort close protection, NOT a durable journal, browser termination/OS-kill recovery or a guarantee that an accepted navigation waits for a slow server.
- Permanent tests: delayed ordering/coalescing and lost ACK in the pure queue; actual 503/retry/reload, delayed writes across deck advance, and real beforeunload warning/reload in the browser; actual PostgreSQL commit followed by injected lost ACK, explicit latest-edit retry and fresh application-process reopen.

Precommit 23 browser and 32 real-PostgreSQL service tests passed. Initial queue test failed because Node strip-only mode does not support TypeScript constructor parameter properties; replaced with explicit fields (failure retained). Initial browser run had an intermittent existing seek assertion (21 pass/1 fail; expected 8, observed 2.2); unchanged targeted diagnostic and subsequent full run passed. Root cause remains unresolved, not labelled fixed or suppressed. Raw attempts: `.data/waveyard-save-reliability/`.

Remaining: cross-tab/client write ordering, transport cursor save ordering, hanging/lost responses, browser keepalive budgets, and accepted-close/abrupt-kill recovery. No new backend revision protocol or persistent journal was invented. Hold/release isolation, prepared quantised swaps, live tempo/key matching and all other essential OPEN rows above remain in force. Final committed checks must be recorded separately; no completion/release claim.

A follow-up review found a removed-membership edge: a pending PATCH could fail with404 after an acknowledged DELETE and block retained tracks. Only an acknowledged removal now discards that membership's queue entry; a late404 for that removed entry cannot strand other writes. Pure and real-browser regressions cover it. The first `6c446bd` local source/build runs were deliberately interrupted as superseded, retained under `.data/waveyard-save-reliability/`; they are not acceptance passes. Final-head runs must be separate.

Final2203361 browser run exposed an existing incorrect isolation measurement (35 pass/1 fail): the test expected the master bus silent although bass should remain audible. Prior early-start silence could satisfy that check. The harness now binds analysers to their actual HTML media sources and requires audible bass (>0.04 RMS), silent drums (<0.001), then restored audible drums (>0.06). Silence threshold/timeout unchanged; this strengthens the prior startup-sensitive check rather than hiding the failed signal. Raw failure remains in `.data/waveyard-save-final/browser.tap`. The2203361 source run was deliberately interrupted for this test correction; not a source acceptance pass. Production code is unchanged by the measurement correction.

## Continuation: ordered transport restore points (2026-10-21)

The dependency-first persistence work continues in the existing player, with no new persistence store. Cursor PUTs previously ran concurrently. A real-browser regression withheld the first seek request while a newer seek and stop were sent; baseline8347370 sent three requests before the first acknowledgement (expected one). The second regression found no cursor-specific retry/error state. Both failures are retained in `.data/waveyard-cursor/before.tap`.

- Transport restore points now use a separate instance of the existing acknowledged save queue with PUT, keepalive, latest-snapshot coalescing, HTTP/network error detail and explicit retry. Failed requests are not silently retried by the periodic timer. Duplicate acknowledged snapshots are not resent. Live audio never awaits saving.
- Page-hidden/unload handling captures and flushes the latest cursor as well as pending mix edits, and warns if either remains unacknowledged. Best effort only: no unsaved disk journal, accepted-navigation guarantee, hanging-response timeout, cross-tab revision protocol or general abrupt-kill recovery is claimed.
- New browser tests exercise delayed seek→new seek→stop ordering and503→latest cursor retry→reopen. Actual PostgreSQL/API integration injects a lost response after a real PUT commit, retries the latest cursor explicitly, kills the handler application process with real SIGKILL after acknowledgement, and reopens the persisted cursor in a fresh process. The database stays running; this is not a database/OS power-loss, full Next/Electron crash, in-flight or before-debounce guarantee. D1–D10 stays OPEN.
- Corrected the evidence-retention defect: quantised-audio samples now default to a unique timestamp/process directory (or an explicitly supplied evidence directory), and full observations also appear in retained TAP. No reconstruction of the lost historical cadccef raw samples is claimed.

Precommit checks:26 actual session browser tests and33 real-PostgreSQL library tests pass, plus typecheck and changed-file lint. Final committed revision requires its own checks. The older intermittent seek failure remains unexplained: the new delayed-request reproduction establishes a distinct ordering bug, not its root cause. Existing save-mix, isolate, transition and other advanced Waveyard workflows remain preserved. Hold/release, prepared swaps, applied tempo/key, catalogue/quality and other OPEN rows remain mandatory.

## Continuation: prepared live selection and true held monitoring (2026-10-21)

This implementation continues `ca965817f65b7d461c0f28074ccccf6922884550` on the fixed PR15 branch; prior source/hosted counts above remain **HISTORICAL PASS**, not acceptance of these edits. PR15 was inspected OPEN with no submitted reviews; no other PR/base/Agent B work was changed.

- The existing `useStemTransport` now prepares/decodes an exact donor asset without reloading or disconnecting the working source. A prepared buffer voice enters the **same** lane gain/pan/inserts/mono/analyser/master graph. The original media element remains the transport clock, with its input gated silent during replacement. Committed source routing is explicitly separate from the audio tag's original/clock URL. No second player, mixer, session model, or audio files are created.
- Independent A/B buttons select a single source per exact category; the existing Swap/Revert controls remain. A 5ms linear source crossfade suppresses abrupt switching. Source position and playback rate determine the WebAudio scheduled start/offset. The measured next boundary is chosen before preparation; insufficient preparation lead rejects explicitly, retaining the working mix, rather than claiming a late/midbeat success. Immediate means commit after preparation, not zero download/decode latency. Cached donor decode retention is bounded to eight entries per physical deck; full-file decode still has material memory costs on long music, and mobile/hardware limits remain OPEN.
- Requested/prepared/scheduled/committed/acknowledged states are distinguished in UI status and selection save status. Only committed selections enter another instance of the **existing** acknowledged serial/coalescing writer, against the existing swap endpoint/provenance table. Older ACKs cannot reapply an obsolete donor over local committed intent. Failures retain the audible selection, expose HTTP/error details and explicit retry. Acknowledged membership deletion forgets only that member's writes. Existing mix/cursor queues and best-effort unload warnings remain; no cross-client CAS, disk journal, complete gesture recording or general abrupt-close durability claim.
- Existing swap provenance and timed Studio ranges are retained. A return to A is an explicit exact-original selection, not deletion of one row that could reveal an older donor. Only the latest acknowledged category selection is recalled; coalescing is **not** complete performance capture/replay.
- **True hold-to-isolate** is a temporary monitor overlay inside the canonical mixer: mouse/primary pointer, captured outside release, touch, keyboard, cancel/lost capture, window blur, hidden page, transport/context interruption and unmount. It never saves a temporary zeroed mix. Release returns the underlying canonical mix, including non-unity gains and pre-muted lanes, without modifying pan/phase/inserts/other mixer flags. The persistent Isolate toggle and persistent Mute remain distinct. Instant Restore uses its existing persisted setting; disabled release waits for the selected measured boundary, enabled release is immediate. An unavailable release boundary restores safely rather than stranding isolation.
- Off/quarter/half/beat work from the measured grid, including nonzero origin/offset and rate. `bar` is a persisted, honest **unavailable** path without separate trustworthy downbeat evidence. Existing four-beat mode remains explicitly labelled non-bar. No downbeat detector or fabricated first-beat bar origin was added. Mute/held-monitor dispatch still uses the existing source-frame queue/80ms late rejection; unlike prepared source scheduling, it is not sample-locked. Applied tempo/key matching is not claimed.

### Evidence chronology (working tree; final committed acceptance still pending)

**PASS, scoped:** intermediate existing browser/WebAudio regression 41/41; actual canonical PostgreSQL service 33/33; performance unit 5/5; changed-file lint 0 errors/warnings and typecheck. Raw artifacts: `.data/waveyard-live-stems/`.

New executable UI checks independently inspect each canonical lane's raw PCM for vocals/drums/bass/instruments: both source frequencies, calibrated gain, replaced-source suppression and unchanged unrelated channels, repeated both-direction switching, pre-muted lanes, saved recall, real pointer/touch release and interruptions. They use **controlled distinguishable PCM and HTTP**, not two trained musical recordings, SQL, native GUI or a human audition. PostgreSQL proof is separately labelled. No silent-master isolation assertion is used.

Failures are retained, not erased or counted as passes:
- `initial-browser.tap`: prior slow-donor expectation incorrectly expected an aborted donor to resume after pause; updated to require the working original and no saved donor. The old URL-based assertion is replaced with committed routing **plus actual independent audio**, not label-only evidence.
- `four-and-hold-first.tap` / `four-probe.tap`: new test's initial gain expectation omitted the canonical mono-centre StereoPanner's `sqrt(1/2)` factor. Replaced with an analytic **bounded expected gain** (both lower and upper bounds), not arbitrary lower signal thresholds. `four-and-hold-after-calibration.tap` retained the subsequent touch failure: CDP was touching an off-viewport button after the preceding seek scrolled away; the test now scrolls the real target into view before actual touch dispatch (`touch-visible.tap`).
- `prepared-timing-first.tap`: deliberately short cold preparation missed its boundary honestly; immediate cold timing also included real decode time. Successful boundary tests now separately prepare the donor through real B→A controls first; cold/missed preparation remains a separate rejection test, not hidden by longer timeouts.
- `prepared-warm-timing.tap` / `timing-save-context.tap`: first rate test sampled during a just-changed rate; then FFT peak timing lagged due to analyser smoothing. Rate is settled before measurement. `raw-waveform-timing.tap` retains both FFT display values **and independent raw waveform source components**; the same 80ms onset bound is unchanged. Do not equate a smoothed spectrum display with the actual audio transition.

**OPEN:** exact final commit/source digest and artifact hashes; complete final browser/SQL/build/desktop/connected/full-source/fresh-hosted matrix; multi-subdivision mute/held restore timing expansion; full musical-input/listening/click/perceptual corpus; downbeat provenance/detection; native GUI/mobile/hardware parity; full D1–D10/26-processor and broader parity/release gates. These working-tree slices are implementation progress, not the complete STEM.FM acceptance or release.


Further implementation/proof in the same uncommitted continuation:
- New `session-live.test.ts` combines the actual UI/shared WebAudio with **production** session/mix/cursor/swap and verified private-asset/range handlers against a fresh canonical PostgreSQL cluster. Sixteen independently measured category/direction switches, real SQL selection ACKs,503/no DB success, explicit retry, audible reload and held monitoring pass. It uses an isolated HTTP adapter, **not compiled Next rendering**; generated PCM banks are explicitly labelled controlled fixtures, not model output. Raw full input SHA256s, per-lane before/after measurements, SQL payloads and request statuses are in its JSON receipt. CI retains it inside the existing Waveyard artifact; no deadline/assertion/workflow gate was relaxed.
- Source-context fences now include the exact original asset in selection POSTs; an obsolete source-bank request is refused409 without inserting a selection. Explicit bank changes pause/cancel source work and await outstanding selection ACKs. Preserved provenance no longer traps bank changes: a separate confirmed, explicit “clear saved swap records” action acknowledges each existing DELETE, prepares original sources while paused and preserves audio assets/mix/cues. Normal A/B selection does not silently erase Studio ranges.
- A shorter donor reaching EOF silences/reports **only its lane**, retaining all unrelated signals; choosing A recovers without stopping other categories. Decoder/start failures retain the old input path. Context suspension, scheduled seek/rate changes and acknowledged membership removal have executable recovery coverage.
- Quarter/half/beat mute/unmute and true held start/release now have independent raw-lane source-clock observations at80/137/120BPM and nonzero offsets. The original80ms dispatch rejection is unchanged;150ms is the existing full-analyser-window settle bound, not an enlarged dispatch deadline. `subdivision-monitor-first.tap` retained a half-beat test timeout caused by observing a very short-lived DOM pending label after its boundary; positive monitor cases now deliberately obtain measured subdivision lead before interaction (`subdivision-monitor-lead.tap`), while separate near-boundary source tests remain strict.
- `combined-first.tap` retained an invalid test assumption that a rapid coalesced A selection had already been acknowledged before injecting503. The combined case now explicitly awaits its real baseline ACK (`combined-acknowledged-baseline.tap`), then asserts rejection/retry against actual stored rows. `combined-bank-fences.tap` / `combined-fenced-final-working.tap` additionally prove explicit clearing/bank reuse and stale-source409. Initial combined typecheck (relative helper import/unsupported job field) and the later JSX apostrophe lint failure remain in raw logs; both fixed without changing app/package configuration or test limits.
- The complete intermediate precommit runs are55 browser/WebAudio PASS and39 focused PASS (=33 existing service +5 performance +1 combined test), zero failures/skips. They precede the final bank-fence edits and are not inherited as exact-final-revision results. Final committed checks must still establish their own identity.

The feature commit is `ddd81f90b0216d0bea1d2d07015b745230ce71a8`. Its automatic genuine workflow `39597355371` was **SKIPPED**, because that existing workflow explicitly requires `[a8-inference]` in the push message. It is not a genuine-inference pass. This documentation continuation requests that unchanged gate through its established marker, not a weakened assertion or a workflow/timeout change. The just-started ddd81 local full-source/build pipelines were deliberately stopped as superseded after identifying this trigger omission; partial logs are retained under `.data/waveyard-live-stems/ddd81-superseded/`, not counted as acceptance. No product/test code changes after ddd81 are implied by this metadata-only continuation. Fresh final-revision source/build/hosted receipts are still required and recorded separately.

A further **reproduced rapid-input edge** supersedes2b1c2cf: holding completion/clock animation frames while real AudioContext playback advances allowed B to become audible before the promise/state completion. Pressing B again then treated that already-executed voice as pending, rolled it back and started a duplicate replacement. The isolated unmodified-source failure is retained in `rapid-due-before.tap` (real440Hz audible; repeated B still not committed in UI). `replaceSource`/transport cancellation now first promote a due, valid DSP result before superseding it. Genuine not-yet-executed work still aborts; cancellation inside the5ms ramp returns smoothly to the working source. The permanent regression with withheld frames requires truthful committed B, continued440Hz and exactly **one** buffer start; `rapid-due-after.tap` passes alongside pause/start-failure fences. This is a product fix, not an unchanged rerun.

The2b1c2cf full-source/integrated watchers were deliberately stopped before editing and are not final acceptance. Its production build, desktop compile/stage/headless, root typecheck/lint and production-worker typecheck passed; completed local raw and hosted genuine4/6 + trained-SIGKILL receipts are retained under `.data/waveyard-live-stems/2b1c2cf-superseded/`. A mis-scoped broad legacy worker TypeScript command failed on the known absent archived-web/Vitest test imports; the canonical `tsconfig.production.json` command passed separately. No worker configuration/dependency or assertions were changed to conceal that failure. The final rapid-fix revision requires fresh full-source, browser/integration/build and hosted checks again, with `[a8-inference]` retained on the real implementation commit.

## Verified live-stem product freeze and final continuation ledger (2026-10-21)

**Product source revision:** `93c497173e241499f10c855c421b6b8c6be9be8b`, source digest `f71173ff394babb74c8e1a2ca950777d500fcb28f90a3b5b9a60927135d8cd89`. Full-source start **2026-10-21T12:21:29.939Z**, end **12:38:44.689Z**, identity/digest unchanged, exit0. The next continuation changes only this evidence chronology and the existing P0 Studio regression, not runtime/source behavior. Its **exact final commit, start/end digest, local and hosted outcomes** are published in the [final gate ledger](https://github.com/imlochie/arena-os-canonical/pull/15#issuecomment-6316184862). At this chronology freeze those fresh continuation checks are **PENDING**, not inferred from the product-parent results. The linked ledger retains this pending entry and appends the actual final results, avoiding a further self-referential documentation-only revision after verification.

### Product-parent receipts (independent, overlapping scopes — do not add totals)

| Scope | Actual result at93c4971 | Limits |
|---|---|---|
| Full source + real isolated PostgreSQL | **1632 PASS / 0 FAIL / 0 SKIP**,39suites,1,034,750ms; matching start/end identity | Source/integration, not all browser/platform acceptance |
| Session + canonical WebAudio browser | **56 PASS / 0 FAIL / 0 SKIP**,96,083.7ms | Synthetic distinguishable PCM; includes new delayed-completion-frame regression |
| Performance + SQL service + combined actual UI/handlers/PG/audio | **39 PASS / 0 FAIL / 0 SKIP**,28,266.1ms | HTTP adapter case is not compiled Next |
| Authorised original → conversion → Waveyard/Studio | **1 PASS**,17,241.0ms | One licensed recording; not a diverse music corpus |
| Root/production-worker typecheck, lint, Next build | **PASS**; lint0errors/48warnings | Broad archived worker config failure remains retained separately |
| Desktop compile/stage/headless | **PASS**, exact staged identity match | Linux supervisor/headless, NOT native GUI/Windows |
| Compiled staged supervisor/browser/Studio/cursor/reuse | **58 PASS steps**,0failed | Synthetic passthrough plus controlled failure injection; not learned input |
| **Compiled Next principal-category positive workflow** | **PASS**:16 independently measured A/B commits (four categories × both directions × two rounds), then rejected-save/retry/SQL/reload and held restoration;19observations,17acknowledged SQL records | Two fixture-published four-lane banks, not two real learned music songs; independent per-lane signal, not silent-master proof |
| Broad Studio acceptance before test-contract correction | **34 PASS / 1 FAIL / 2 SKIP**,314,708ms | Genuine model/crash cases intentionally gated locally; genuine hosted separately. **Do not label this broad run green.** |
| Strengthened P0 candidate, same unmodified runtime | **1 PASS**,224,921ms | Actual processing/publication/PG/browser/restart/decoded export; controlled inference seam, not genuine model |

The broad Studio failure was the old requirement that donor selection change the lane clock element's `src`. The retained failure already showed original `src` plus correct donor `data-active-source`. The continuation **retains the original clock**, requires exact donor UUID, and strengthens the regression with independent non-silent donor amplitude/suppressed-original measurements before **and after fresh server/PG restart**, while preserving all bank/publication and decoded-export assertions/deadlines. Candidate pinned amplitude expected0.03001847; actual0.03001037 before/0.02995119 after; original leakage0.00036066/0.00030443. Independent176400-frame export maximum error0.0000934973 remains below the unchanged0.0003 threshold. No assertion or deadline was removed to make the run green.

The compiled-positive harness failures are also retained: first wrong adapter URL rather than the compiled session route; then an unfenced16-ledger expectation despite intentional latest-intent coalescing; then a rejection matcher that omitted the save URL's query parameters. Corrections use the actual session route, require **each existing16 SQL ACKs before the next measured gesture**, and match the real route pathname including query-bearing requests. The16/17 record assertions were retained, not lowered. Successful rendering/API/media/range/SQL execute the compiled application; only the explicit503 is injected.

### Capability scorecard at product freeze

- **PASS (controlled actual UI/audio):** existing canonical player independently switches vocals/drums/bass/instruments A↔B, one active source per baseline lane, without resetting the original clock or changing other lane signals/levels; wider explicit layers remain separate. Prepared donor/error/latest-intent/supersession fences, including already-audible DSP before a delayed UI frame, are exercised.
- **PASS (controlled browser + SQL):** true hold/release, nondefault and pre-muted mixes, transient monitor distinct from persisted mute, ordinary/cancel/blur/context/transport interruption, acknowledged retry/reload, persisted Instant Restore and measured immediate/beat/half/quarter behavior. Browser onset tolerances are not a claim of hard realtime/sample locking.
- **BLOCKED / honest unavailable:** trustworthy bar/downbeat origin is absent in these session grids; Bar performance actions are refused rather than inventing every fourth beat as a verified bar.
- **PASS (separate genuine hosted slice):** run[39598919901](https://github.com/imlochie/arena-os-canonical/actions/runs/39598919901), exact93c4971, actual independently trained legacy4/6 output, valid decoded stems, saved player/session/derived Studio/export and narrow trained-child SIGKILL recovery. Complete checkpoint SHA256:4s `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`;6s `34c22ccb381c6f9fdbf324f04e1e2fe21aaaf293f5ded163a162697ff9a02ddd`. Source SHA remains `4b431d535d235bd81b62f816f08c3f1afb6679d2706d84b3b75903b7df909507`. These are NOT synthetic principal-category A/B proof or MDX-ONNX/subjective music quality acceptance; `other` remains residual, not a verified melody label.
- **OPEN:** second lawful/diverse real-song corpus and trained two-song swapping/listening quality, long-song/mobile memory, cross-client/CAS and generic unrelated mutation-ACK metadata reconciliation, gesture replay/abrupt-kill donor-journal durability, native GUI/mobile/hardware,26processors and complete D1–D10. Narrow successes do not close GateD or authorize merge/release/full parity.

Raw product-parent artifacts: `.data/waveyard-live-stems/93c4971-verified-product/` (`sha256.json` contains the complete file manifest). Important SHA256:

- full-source receipt: `b7ab06abfdca3863468365a1f45b474e58fada40a548f28f7b5cee9f4b7d3cb9`
- compiled principal positive: `97d25589e8d1e0cab7d9c6909254ae02d8d4ff64422544cfa4fe260b1a53f383`
- staged58step report: `ce1b245cd647f12df0fe11776f341f235cc6ede68b3071c8ccf5c2d55c4e6a86`
- combined UI/handler/PG/audio: `8a11a9465eb8da74168d3877f4d36dd04c3dec3b5fc4da10cbbd5a0318bde614`
- genuine4/6 receipt: `69e1ffa0a82f88c0dd5794bef230ab5f3801accf199ec35a851b18a4bc78f6a7`
- trained-crash receipt: `d9c91c696f8469fbbc5f1d491beedc026c78b23b2a3c43a3605c9e2f1fa42480`
- strengthened P0 candidate TAP: `d84f06b92a249a7abe1ee6ab4fb6bb4ff1572e4dd26d55eb23e248618906fb50`

The final continuation's fresh raw receipts use `.data/waveyard-live-stems/{source,source-live,hosted,final-live,connected,studio}/` and root final TAP/identity/staged/compiled-positive reports. Its official workflow IDs and end-state SHA manifest will be appended to the linked final gate ledger. Earlier skipped/stopped/failed revisions remain historical; successful product-parent source results do not erase the retained broad Studio/hosted browser failures or imply the final continuation passed before it actually runs.
