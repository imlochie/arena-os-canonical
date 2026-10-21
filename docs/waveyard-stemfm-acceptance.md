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
