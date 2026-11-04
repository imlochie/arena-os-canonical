# Waveyard live key-shift validation

## What this check validates

`scripts/waveyard-live-key-real-track.ts` runs the production `LiveStemWsola` and
`LiveKeyShift` implementations on a ten-second excerpt decoded from a local
audio file. It checks a set of pitch corrections while the tempo processor
changes between 1.00×, 0.85×, 1.15×, 0.90×, and 1.10×. The output is a compact
JSON measurement; the script does not save or upload decoded audio.

Run it with an audio file you have permission to use:

```sh
pnpm --filter @workspace/scripts exec tsx $PWD/scripts/waveyard-live-key-real-track.ts -- /absolute/path/to/authorized-audio-file.mp3 130
```

The final argument is the excerpt start time in seconds (default `30`). FFmpeg
decodes only the requested ten seconds to stereo 48 kHz floating-point PCM for
analysis. The source file itself is left unchanged.

The script passes the following checks for each rate segment:

- Pitch-class spectrum follows the requested semitone shift (cosine similarity
  at least `0.90` against the same WSOLA-tempo-processed excerpt).
- Log-frequency spectrum estimates the requested shift within half a semitone
  for the whole excerpt and for each tempo segment.
- Output RMS remains within 3 dB of the unshifted tempo-matched signal.
- No sample clipping; output peak stays at or below 1.0.
- Estimated envelope delay is at most 80 ms.
- The WSOLA and pitch-shift processors emit the same number of frames.

These are regression thresholds for a useful local fixture, not a promise that
every song, browser, device, or output route will sound clean. Spectrum
similarity cannot detect every audible artifact, such as transient smearing,
vocal formant change, or musical dissonance.

## Recorded Linux fixture result

The recorded acceptance run used a user-supplied 48 kHz stereo MP3 and the
ten-second excerpt beginning at 130 seconds. Its license/provenance was not
independently checked. Treat it only as a private local QA input; this result
does not verify permission to capture, distribute, or archive it.

| Requested shift | Measured semitone shift at 1.00×, 0.85×, 1.15×, 0.90×, 1.10× |
| ---: | ---: |
| -11 | -11, -11, -11, -11, -11 |
| -6 | -6, -6.17, -6, -6, -6 |
| -3 | -3, -3, -3, -3, -3 |
| 0 | 0, 0, 0, 0, 0 |
| +3 | +3, +3, +3, +3, +3 |
| +6 | +6, +6, +6, +6, +6 |
| +11 | +11, +11, +11, +11, +11 |

Across the nonzero shifts and all five tempo segments, pitch-class similarity
was at least 0.988, the measured RMS change was -1.23 to -0.91 dB, the largest
output peak was 0.839, no clipped samples or large sample jumps were found,
and the envelope-delay estimate was 20 ms. The Linux processing time was about
0.09× excerpt duration on this runner. That is an offline CPU measurement, not
a Windows, browser worklet, or hardware real-time guarantee.

The bounded `-11 … +11` range is the implementation limit and was sampled at
the extremes in this one excerpt; this is not evidence of equal quality across
all songs. Two other ten-second excerpts from the same file had windows where
the pitch-spectrum estimate did not distinguish the requested shift from no
shift. That exposes a measurement/track-content confidence gap: do not treat a
high whole-window pitch-class score as proof when the measured semitone
estimate is ambiguous. More authorized, musically varied tracks are needed
before claiming reliable full-library key matching. Prefer disabling matching
(or using Preserve/Off) when either track lacks a usable key estimate, the
correction is outside the supported range, a transition sounds worse after
listening, or the active browser cannot run the required AudioWorklet.
Waveyard's key-matching calculation already declines to produce a correction
when key metadata is unavailable.

The browser acceptance in `scripts/waveyard-live-stems.mjs --key-matching-only`
separately checks the live worklet wiring, playback clock, and deck transition.
Its source tracks are synthetic tones. The real-file runner exercises the
production WSOLA and key-shift processors with PCM from a full mix, but this
workspace has no verified authorized set of separately generated real stems.
So a real separated-stem swap has not been measured here; mashup quality
remains a separate listening/measurement task.
