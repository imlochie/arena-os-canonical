# Waveyard live key-shift validation

## What this check validates

`scripts/waveyard-live-key-real-track.ts` runs the production `LiveStemWsola` and
`LiveKeyShift` implementations on a ten-second excerpt decoded from a local
audio file. It checks a set of pitch corrections while the tempo processor
changes between 1.00×, 0.85×, 1.15×, 0.90×, and 1.10×. The output is a compact
JSON measurement; the script does not save or upload decoded audio.

Run it with an audio file you have permission to use:

```sh
pnpm --filter @workspace/scripts exec tsx $PWD/scripts/waveyard-live-key-real-track.ts -- /absolute/path/to/authorized-audio-file.mp3 30
```

The final argument is the excerpt start time in seconds (default `30`). FFmpeg
decodes only the requested ten seconds to stereo 48 kHz floating-point PCM for
analysis. The source file itself is left unchanged.

The script passes the following checks for each rate segment:

- Pitch-class spectrum follows the requested semitone shift (cosine similarity
  at least `0.90` against the same WSOLA-tempo-processed excerpt).
- Output RMS remains within 3 dB of the unshifted tempo-matched signal.
- No sample clipping; output peak stays at or below 1.0.
- Estimated envelope delay is at most 80 ms.
- The WSOLA and pitch-shift processors emit the same number of frames.

These are regression thresholds for a useful local fixture, not a promise that
every song, browser, device, or output route will sound clean. Spectrum
similarity cannot detect every audible artifact, such as transient smearing,
vocal formant change, or musical dissonance.

## Recorded Linux fixture result

The most recent run used a user-supplied 48 kHz stereo MP3 and a ten-second
excerpt beginning at 30 seconds. Its license/provenance was not independently
checked. Treat it only as a private local QA input; this result does not verify
permission to capture, distribute, or archive it.

| Shift | Lowest pitch-class similarity across tempo changes |
| ---: | ---: |
| -11 semitones | 0.958 |
| -6 semitones | 0.967 |
| -3 semitones | 0.979 |
| 0 semitones | 1.000 |
| +3 semitones | 0.982 |
| +6 semitones | 0.973 |
| +11 semitones | 0.953 |

Across the nonzero shifts and all five tempo segments, the measured RMS change
was -1.42 to -0.61 dB, the largest output peak was 0.719, no clipped samples or
large sample jumps were found, and the envelope-delay estimate was 20 ms. The
Linux processing time was about 0.09× excerpt duration on this runner. That is
an offline CPU measurement, not a Windows, browser worklet, or hardware
real-time guarantee.

The bounded `-11 … +11` range is the implementation limit and was sampled at
the extremes; the result does not establish equal quality for all genres or
larger shifts. Prefer disabling matching (or using Preserve/Off) when either
track lacks a usable key estimate, the correction is outside the supported
range, a transition sounds worse after listening, or the active browser cannot
run the required AudioWorklet. Waveyard's key-matching calculation already
declines to produce a correction when key metadata is unavailable.

The browser acceptance in `scripts/waveyard-live-stems.mjs --key-matching-only`
separately checks the live worklet wiring, playback clock, and deck transition.
Its source tracks are synthetic tones. It is not evidence that a distinct,
real separated-stem swap has been auditioned. Real mashup quality remains a
separate listening/measurement task.
