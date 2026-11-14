# Waveyard listening pack v1

15 rendered mashups. **N = 0 listeners.** Nothing here is a quality claim.

Start here: open `index.html` in a browser. It plays every file inline, so you
can audition on a phone without downloading anything.

## What is in here

```
dry/            10 renders, production settings, nothing synced
tempo-synced/    5 renders that exercise tempo stretching
manifests/       measurements for each pack (JSON)
assessment/      blank sheet — fill this in yourself
all-wavs/        all 15 as 16-bit 44.1 kHz WAV (~188 MB)
all-mp3s/        all 15 as 192 kbps MP3 (~26 MB, use this on a phone)
index.html       player for everything above
```

Every render exists as **both WAV and MP3**. Same audio; the MP3 is 7× smaller.
If you are on a phone, use the MP3s.

## Play these two first

`tempo-synced/11-synced-close` then `tempo-synced/14-control-dry`.

Same two sources. Same arrangement decision. One is stretched, one is not. That
pair is the cleanest test of whether syncing is worth anything musically, and it
takes one A/B to answer.

## The 10 dry renders are not synced — on purpose

All ten use stretch ×1.000. Rubato a-cappella singing scores tempo confidence
0.132–0.245 against a 0.5 gate, so the planner withheld stretching every time.
That is correct fail-safe behaviour, not a bug. It means the dry pack shows
**honesty, not mashup competence**.

Lowering the gate to make the pack look synced would have been the wrong fix, and
was not done.

## The 5 synced renders declare their tempo

Tempo confidence (and in two cases key confidence) is supplied as input. Stretch
ratios are therefore exact and intended, not analysed:

| File | Declared | Applied |
|---|---|---|
| 11-synced-close | 100 vs 112 BPM | ×0.893 |
| 12-synced-half-time | 70 vs 140 BPM | ×1.000 (half-time lock, not a halved vocal) |
| 13-synced-large-warp | 96 vs 128 BPM | ×0.750 |
| 14-control-dry | 103.36 vs 112.35 BPM (**real**, untrusted) | ×1.000 (withheld) |
| 15-hostile-untrusted-keys | 92 vs 84 BPM, keys 3 semitones apart | ×1.095, **0 semitones** |

Stretching, beat grids, entry placement, arrangement and the mix are all still
the production code path. Only the confidence input is supplied.

## Known weaknesses — read after listening, not before

- **The vocal is often barely present.** In 3 of the 5 synced cases it is audible
  for only 13–21 % of the runtime (9.9 s of 68.6 s). A short vocal cameo over a
  long bed will read as a weak arrangement even when every individual decision is
  sound.
- **Mix balance is measured on whole source files**, not on the placed material,
  and hit the ±6 dB clamp in 6 of 15 renders. Balance may be audibly off in a way
  no number in the manifests reflects.
- **No separation stage ran.** Inputs were already isolated (a cappella vocals,
  instrumental beds). Separation models are not obtainable in this environment.
- **The corpora are small and narrow** — Turkish makam a cappella over 13 CC0
  electronic/lo-fi beds. Absence of a problem here is not evidence of general
  capability.

## Credits

Vocals: MTG turkish-makam-solo-voice dataset, **CC BY 4.0** (attribution
required). Beds: AERIS MUSIC, **CC0 1.0**.

Both licences are recorded in the manifests under `manifests/`.
