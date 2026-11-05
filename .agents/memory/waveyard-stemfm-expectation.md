---
name: Waveyard product expectation
description: The user's core product expectation for Waveyard playback and Studio handoff.
---

Intelligent mashups are the acceptance goal: replacing a stem or overlaying contrasting drums is not sufficient. Tempo matching must include measured beat-phase alignment; musical fit, downbeats and phrase selection need their own evidence.

**Why:** the user explicitly rejected the native-tempo drum replacement demonstration as unsynchronised, not the requested intelligent mashup.

**How to apply:** Demonstrate recognisably different songs with real measured timing, matched tempo and beat phase, then assess phrase/key compatibility. Never present a channel-routing diagnostic as intelligent-mashup proof.

Waveyard should function as a Stem.fm replacement with extra features. Live stem swapping and isolation are core capabilities, and the active stem controls should expose both directly instead of hiding source swaps in a lower-level picker. Independent stems may be swapped at the same time: apply session responses per session-track/stem channel, because out-of-order full-session snapshots can otherwise erase a different channel's newer choice or revert playback state. A pending donor must be cancellable as soon as the save starts; if cancellation is requested before the save returns, remove the persisted choice before allowing its audio to take over. Speed control should offer an explicit pitch-follow versus pitch-lock choice that behaves consistently on both original and swapped layers; never expose a toggle that silently affects only one playback path. Keep pitch lock real-time and bounded-memory: preserve original media pitch natively and process live donor stems in an AudioWorklet, releasing the main-thread PCM after ownership transfers rather than rendering a second full-song copy. Test pitch at both speed limits and assert that the browser graph includes a connected donor processor. Session DJ controls should be interactive and beat-aligned, and Studio should be understandable and usable after a listening session. Mobile screenshots supplied by the user are usability references for clear, interactive controls—not pixel-perfect specifications. The user also wants TunePat/Apple Music considered as a future library source if it can be made fluid, or at minimum as a tool to back up and store their Apple Music library.

**Why:** the user explicitly described these as expected product behavior, not optional enhancements or preset content, asked for quick and visible Stem.fm-like swapping, pitch choice, DJ-style interaction, provided mobile usability references, and named Apple Music backup/library use as a future focus. Browser verification showed that separately saved stem choices can receive full session responses in reverse order, so treating those snapshots as interchangeable loses real user state; cancellation also needs to cover the interval before a pending save returns. The user's laptop has also run out of disk space during builds, so pitch-mode changes should not add a second full-length PCM render.

**How to apply:** Put clearly labelled isolate and donor-swap actions together on the active stems, and verify them on desktop and mobile. Keep independent channel saves usable, merge each response only into its own channel while preserving the latest transport state, and test with reversed save and donor responses plus real audio graphs. Show cancel immediately when a swap save begins; if canceled then, retain the user's intent and delete the just-saved swap before it can install. Keep pitch-lock consistent across original and swapped layers, use real audio-frequency checks at the speed limits, and keep the audible mix intact if preparation fails. Use analyzed beat-grid data for loops and keep cue/loop controls reachable in the player. Prioritize reliable replacement and a clear session-to-Studio workflow. Keep the Apple Music source/backup workflow in scope. Verify real end-to-end behavior rather than relying on labels, explanations, or a build alone.

**Tempo-match latency constraint:** Do not trade BPM-match pitch preservation for a varispeed shortcut.

**Why:** BPM correction and the user's session-speed pitch-follow/pitch-lock preference are independent behaviors; one rate-and-pitch mode can conflate them and silently change the sound.

**How to apply:** Any streaming tempo-match optimization must verify BPM alignment and both speed pitch modes independently before replacing the existing path.

**Audible remix evidence:** A running media clock or a donor replacement event is not proof of fluid mashups. Demonstrations must make the changed stem recognisable while the other song's identifiable vocals or backing continue, and show restoration in the same recording.

**Why:** The user could not distinguish the earlier melody-swap clips from one song interrupting another and specifically requested contrasting drums or vocals. They reiterated that understanding STEM.FM's actual combined workflow matters more than a replacement-mechanism demonstration.

**How to apply:** Separate channel-identity diagnostics from musical-quality claims. Show the source stems and an uninterrupted swap/restore, verify retained channels are audible rather than merely advancing, and do not claim STEM.FM parity without the paired-song controls, timing and harmonic behaviour working together.

**Device-sync privacy rule:** Prefer QR-paired, direct laptop-to-device live-session sync; do not depend on paid cloud storage. Any optional cloud relay must be free and end-to-end encrypted. The fixed local-owner identity is not an access-control boundary.

**Why:** The user wants to scan a QR code to sync the live session, with the laptop hosting it or a free service as fallback, and prioritizes personal privacy.

**How to apply:** Default to direct, local pairing and minimum live-session data. Require secure pairing before exposing control, and never expose owner-scoped library or playback data through an unauthenticated endpoint.
