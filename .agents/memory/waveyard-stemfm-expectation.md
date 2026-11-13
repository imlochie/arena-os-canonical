---
name: Waveyard product expectation
description: The user's core product expectation for Waveyard playback and Studio handoff.
---

Automatically producing complete, listenable mashups from arbitrary songs is the acceptance goal: replacing a stem, overlaying contrasting drums, or producing a technically valid export is not sufficient. Vocal flow is equally important to the backing arrangement: when lyrics enter, phrase/cadence timing, and how vocals adapt to drums, bass, and instrumental changes must be measured and used. Acoustic fit outranks lyric semantics. Tempo matching must include measured beat-phase alignment; musical fit, downbeats and phrase selection need their own evidence.

**Why:** the user explicitly rejected the native-tempo drum replacement demonstration as unsynchronised, not the requested intelligent mashup, and clarified that Waveyard's primary purpose is to transform arbitrary songs into complete mashups—not only separate, edit, or find compatible passages. They later clarified that vocal/lyric flow and its timing against drums, bass, and instrumentals matter just as much as the backing music, while audible musical fit must remain decisive.

**How to apply:** Build toward full arrangements where vocals, drums, bass, and instrumental layers can be transformed and timed together. Demonstrate recognisably different songs with measured timing and real stems; evaluate vocal entry and phrase preservation against the beat and backing, then assess harmonic and acoustic fit. Treat transcripts as optional supporting evidence, never a substitute for audio. Song extensions must be grounded in detected musical structure rather than arbitrary looping. Never present a channel-routing diagnostic as intelligent-mashup proof.

Waveyard should function as a Stem.fm replacement with extra features. Live stem swapping and isolation are core capabilities, and the active stem controls should expose both directly instead of hiding source swaps in a lower-level picker. Independent stems may be swapped at the same time: apply session responses per session-track/stem channel, because out-of-order full-session snapshots can otherwise erase a different channel's newer choice or revert playback state. A pending donor must be cancellable as soon as the save starts; if cancellation is requested before the save returns, remove the persisted choice before allowing its audio to take over. Speed control should offer an explicit pitch-follow versus pitch-lock choice that behaves consistently on both original and swapped layers; never expose a toggle that silently affects only one playback path. Keep pitch lock real-time and bounded-memory: preserve original media pitch natively and process live donor stems in an AudioWorklet, releasing the main-thread PCM after ownership transfers rather than rendering a second full-song copy. Test pitch at both speed limits and assert that the browser graph includes a connected donor processor. Session DJ controls should be interactive and beat-aligned, and Studio should be understandable and usable after a listening session. Mobile screenshots supplied by the user are usability references for clear, interactive controls—not pixel-perfect specifications. The user also wants TunePat/Apple Music considered as a future library source if it can be made fluid, or at minimum as a tool to back up and store their Apple Music library.

**Why:** the user explicitly described these as expected product behavior, not optional enhancements or preset content, asked for quick and visible Stem.fm-like swapping, pitch choice, DJ-style interaction, provided mobile usability references, and named Apple Music backup/library use as a future focus. Browser verification showed that separately saved stem choices can receive full session responses in reverse order, so treating those snapshots as interchangeable loses real user state; cancellation also needs to cover the interval before a pending save returns. The user's laptop has also run out of disk space during builds, so pitch-mode changes should not add a second full-length PCM render.

**How to apply:** Put clearly labelled isolate and donor-swap actions together on the active stems, and verify them on desktop and mobile. Keep independent channel saves usable, merge each response only into its own channel while preserving the latest transport state, and test with reversed save and donor responses plus real audio graphs. Show cancel immediately when a swap save begins; if canceled then, retain the user's intent and delete the just-saved swap before it can install. Keep pitch-lock consistent across original and swapped layers, use real audio-frequency checks at the speed limits, and keep the audible mix intact if preparation fails. Use analyzed beat-grid data for loops and keep cue/loop controls reachable in the player. Prioritize reliable replacement and a clear session-to-Studio workflow. Keep the Apple Music source/backup workflow in scope. Verify real end-to-end behavior rather than relying on labels, explanations, or a build alone.

**Tempo-match latency constraint:** Do not trade BPM-match pitch preservation for a varispeed shortcut.

**Why:** BPM correction and the user's session-speed pitch-follow/pitch-lock preference are independent behaviors; one rate-and-pitch mode can conflate them and silently change the sound.

**How to apply:** Any streaming tempo-match optimization must verify BPM alignment and both speed pitch modes independently before replacing the existing path.

**Audible remix evidence:** A running media clock or a donor replacement event is not proof of fluid mashups. Demonstrations must make the changed stem recognisable while the other song's identifiable vocals or backing continue, and show restoration in the same recording.

**Why:** The user could not distinguish the earlier melody-swap clips from one song interrupting another and specifically requested contrasting drums or vocals. They reiterated that understanding STEM.FM's actual combined workflow matters more than a replacement-mechanism demonstration.

**How to apply:** Separate channel-identity diagnostics from musical-quality claims. Show the source stems and an uninterrupted swap/restore, verify retained channels are audible rather than merely advancing, and do not claim STEM.FM parity without the paired-song controls, timing and harmonic behaviour working together.

**Passage-ranking evidence rule:** Move an arrangement entry only when the source passages have comparable phrase lengths and current rhythm, harmonic, and beat-phase measurements. Rank the available candidates without presenting the relative rank as a calibrated quality score; when the evidence is incomplete, preserve a safe fallback and keep mashup creation available.

**Why:** On real full-track audio, transient coincidences can appear persuasive while the corresponding structural passage has missing or mismatched evidence. The user expects complete mashup production, but not unsupported claims that a weak measurement makes the arrangement musically intelligent or listenable.

**How to apply:** Keep transient alignment subordinate to musical evidence, and treat absent lyric timing, semantic form labels, and listening evaluation as genuine capability gaps. Do not invent a numeric quality threshold without real-world validation.

**Stem.fm research boundary (checked 2026-11-05):** its public site describes real-time stem control, but the DAW endpoint returned 401 without a session. Public pages do not establish the product's internal timing or audio algorithms.

**Why:** the supplied mobile screenshots show concrete user-facing controls, while the authenticated app could not be inspected; assuming hidden implementation details would repeat unsupported parity claims.

**How to apply:** Treat the user's screenshots and accessible public pages as evidence of visible workflows. Separate those observations from unverified internals, and do not claim algorithmic equivalence without direct evidence.

**Device-sync privacy rule:** Prefer QR-paired, direct laptop-to-device live-session sync; do not depend on paid cloud storage. Any optional cloud relay must be free and end-to-end encrypted. The fixed local-owner identity is not an access-control boundary.

**Why:** The user wants to scan a QR code to sync the live session, with the laptop hosting it or a free service as fallback, and prioritizes personal privacy.

**How to apply:** Default to direct, local pairing and minimum live-session data. Require secure pairing before exposing control, and never expose owner-scoped library or playback data through an unauthenticated endpoint.

**Whole-track evidence and sampler controls:** Mashup planning should compare local, beat-aligned windows throughout longer sections rather than only comparing one summary per section. Beat tracking should correct gradual drift only from measured attacks and within bounded corrections. Vocal timing must eventually identify actual phrase/word starts independently from form labels. The chop sampler should offer pitch-diverse, key-aware choices and audible Chopped, Chipmunk, and Screwed treatments.

**Why:** The user asked for a long vocal phrase to find a suitable part inside a longer backing passage, better beat detection, and a smart sampler that selects useful note-specific chops for chopping, pitching, and sampling. A detected passage or synthetic test does not prove a real mix sounds good.

**How to apply:** Keep the rolling comparison source-checksum-bound, beat-grid-aware, bounded in cost, and subordinate to a safe fallback. Validate phrase timing and full rendered mixes separately on complete real tracks; do not call pitch-continuity runs lyrics. Keep the sampler’s note/key filters and style selection visible and connected to actual render behavior, and describe quality claims only at the level supported by listening evidence.

**Timestamped transcript evidence:** Waveyard should be able to generate or import a transcript with timing and use those timestamps as optional vocal phrase/word timing evidence for mashup placement and snapping. This is not a semantic-form label or a substitute for measured audio.

**Why:** The user proposed an embedded-timestamp transcript generator so the planner can better time lyrics in a mashup.

**How to apply:** Make transcription explicitly user-triggered, disclose when audio will be sent to an external provider, and bind editable timestamps to the source/stem checksum and transcription engine. Prefer the isolated vocal stem. Keep mashup creation available when transcription is unavailable or declined; do not represent coarse ASR segments as word-level forced alignment.

**Full mashup workflow:** Analyze complete songs first; find rhythm, downbeats, repeated structures, arrangement changes, and vocal activity/phrase-entry candidates; let the user audition and adjust a donor entry with evidence-based snapping; arrange and transform the layers together; render the complete mashup; then save, reopen, edit, and export the same arrangement.

**Why:** The user’s multi-step prompt makes whole-song, arbitrary-pair mashup production the goal. Analysis, section labels, phrase timing, swaps, arrangement, and exports are successive parts of that workflow—not independent endpoints or prerequisites that can block creation.

**How to apply:** Keep semantic labels, measured structural events, and vocal timing as separate evidence. A snap may use real phrase/activity points or measured beat/section boundaries, but must say what signal it used and fall back honestly when evidence is missing. Judge progress by whether the complete rendered result is more useful and remains editable after reopening, not by added labels or passing synthetic tests alone. Evaluate a proposed placement over the material it actually renders: a locally fitting discovery window is not evidence that the rest of a moved vocal body fits.

**Intelligence-upgrade scope:** Make connected improvements to musical recognition and timing; do not impose a one-change-per-sweep limit. Use all usable supplied recordings, not only the original pair. Connect complementary evidence to actual production decisions and compare before/after behavior. More UI controls, confidence fields, evaluation infrastructure or speculative semantic labels are not substitutes for better musical decisions.

**Why:** The user explicitly requested meaningful musical intelligence and audible results, not another detector or UI redesign, while preserving arbitrary-song generation and honest uncertainty. They corrected the artificial one-change limit and emphasized that the collected musical evidence should inform the engine together, not accumulate as unrelated statistics.

**How to apply:** Reuse current analyzers, persisted provenance, planners and renderers. Keep unit, synthetic, real-song analytical, rendered-signal and independent listening evidence separate; do not introduce heavyweight dependencies without demonstrated practical value. When the user requests verse/chorus accuracy, implement an actual form inference path and measure its behavior; an audit that only says form recognition is absent does not fulfill that request. Report single-listener reference comparisons separately from independently reviewed accuracy.
