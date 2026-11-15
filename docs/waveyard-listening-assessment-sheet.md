# Waveyard listening assessment — blank sheet

**Status: NOT PERFORMED. N = 0 listeners.**

This file is intentionally empty of results. It exists so that human judgements
are recorded here, by a human, separately from the automated measurements in
`manifest.json` and `manifest-synced.json`. Nothing in the manifests is a
listening result, and nothing here may be filled in on the listener's behalf.

## How to listen

Files are in `generated-artifacts/listening-pack/`. Play the WAVs; do not read
the manifests first. The manifests are measurements and knowing them biases the
ear. Compare `11-synced-close` against `14-control-dry` — same two sources, same
arrangement decision, one stretched and one not. That pair is the cleanest test
of whether syncing is worth anything musically.

## Rating scale

Score each 1–5. **1** = broken/unlistenable, **3** = works but sounds amateur,
**5** = would not be embarrassed to play it for someone.

| Dimension | What it means |
|---|---|
| Arrangement | Does the vocal sit where it belongs, or does it arrive and leave at random? |
| Vocal clarity | Can you follow the words/line, or is the vocal buried or thin? |
| Transitions | Do entries and exits sound intentional, or do they cut? |
| Rhythmic stability | Does it groove, or does the vocal drift against the bed? |
| Audio quality | Any artefacts — warble, phasing, pumping, metallic stretch? |

## Sheet

Copy this block per file. Leave blanks blank rather than guessing.

```
File:                            (e.g. 11-synced-close.wav)
Listener:                        Date:
Headphones / speakers:

Arrangement        [1 2 3 4 5]
Vocal clarity      [1 2 3 4 5]
Transitions        [1 2 3 4 5]
Rhythmic stability [1 2 3 4 5]
Audio quality      [1 2 3 4 5]

Most distracting moment (timestamp):
Best moment (timestamp):
Biggest single weakness:
Would you listen again? Y / N
```

## The one question that matters

The owner asked for **the five biggest musical weaknesses**, not a score. When
the sheets are in, collect the free-text "biggest single weakness" lines across
all files and count them. The five most frequent are the answer. Do not average
the scores and call that a finding.

## Known measurement context (read only after listening)

Recorded so the sheets are not mistaken for corroborating the measurements:

- **10 dry cases** are genuinely unsynced: `stretch × 1.000` on every pair,
  because rubato a-cappella singing scores `bpmConfidence` 0.13–0.245 against a
  0.5 gate. This is correct fail-safe behaviour, not a bug.
- **5 synced cases** declare tempo instead of measuring it. Stretching, beat
  grids, entry placement and the mix are production code; only the confidence
  input is supplied. The manifest says so on every row.
- **Vocal coverage is low.** In 3 of the 5 synced cases the vocal is audible for
  only 13–21 % of the runtime (9.9 s of 68.6 s). A short vocal cameo over a long
  bed will read as a weak arrangement even when every individual decision is
  sound.
- **Mix balance is measured on whole source files**, not on the placed material,
  and hit the ±6 dB clamp in 6 of 15 rendered cases. Balance may be audibly off
  in a way no automated number here reflects.
- **No separation stage ran.** Inputs are already isolated (a-cappella vocals and
  instrumental beds); separation models are not obtainable in this environment.
- Both corpora are small and stylistically narrow — Turkish makam a-cappella over
  13 CC0 electronic/lo-fi beds. Absence of a problem here is not evidence of
  general capability.
