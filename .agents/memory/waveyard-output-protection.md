---
name: Waveyard output protection
description: Why session peak protection belongs after deck summing and what browser peak evidence proves.
---

Protect the combined session output rather than independently limiting decks or rewriting saved stem faders.

**Why:** Equal-power overlap can exceed full scale even when both individual decks are safe. Donors and correlated stems can add further overload. Per-deck meters and quadrature RMS alone cannot prove the final sum is safe.

**How to apply:** Keep monitoring and recording on the protected side of the shared output. Validate an individually-safe correlated overlap separately from intentionally overloaded uncorrelated stem mixtures. Measure the actual sum and preserve saved fader ratios. A sample-peak ceiling is not an inter-sample true-peak guarantee or physical Windows audio-driver acceptance.

Gain commands immediately followed by Play need synchronous audio intent, not only a React state update.

**Why:** React batching can let the incoming deck briefly start with its previous master value before the fade envelope begins.

**How to apply:** Assert the actual master gain at the incoming media's Play call is zero for a nonzero-duration fade, as well as checking the later fade envelope.

Use stereo PCM for near-full-scale speaker-channel tests and distinguish deliberate correlation from merely equal-frequency tones.

**Why:** Mono centre panning attenuates speaker channels, while independently started equal-frequency tones can cancel because their phases differ. Either can hide the intended overload.

**How to apply:** Use explicitly labelled same-polarity held stereo PCM for deterministic worst-case overlap, and distinct-frequency stereo stems for a separate overload stress case. Do not describe either synthetic fixture as music-quality or hardware acceptance.

Reconstructed-peak tests must measure the limiter's output, including transient gain-envelope changes, not only estimate peaks on the input.

**Why:** A time-varying gain curve can create new inter-sample overshoot even when input reconstruction is measured and sample peaks stay below the nominal ceiling.

**How to apply:** Use an explicit oversampling method, test the post-limiter stereo PCM at supported sample rates, and keep browser analyser evidence separate from reconstructed-peak and physical-device claims.
