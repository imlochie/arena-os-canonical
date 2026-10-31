# Waveyard four-stem reference evaluation

## Result

The pinned `stems_4` recipe was run on two 8-second, 44.1 kHz stereo excerpts from the MUSDB18-HQ held-out test split. All four model files matched the registry SHA-256 values and ran through the production local worker on Linux x64 CPU. The output was compared to its aligned reference stem and the unseparated mixture.

| Reference track | Stem/model | SI-SDR | Mixture SI-SDR baseline | Improvement |
| --- | --- | ---: | ---: | ---: |
| BKS - Bulldozer | vocals / Kim Vocal 2 | 16.33 dB | -6.30 dB | +22.64 dB |
| BKS - Bulldozer | drums / Kuielab B Drums | 9.75 dB | -0.45 dB | +10.20 dB |
| BKS - Bulldozer | bass / Kuielab B Bass | 5.21 dB | -4.00 dB | +9.22 dB |
| BKS - Bulldozer | other / Kuielab B Other | -0.29 dB | -13.40 dB | +13.11 dB |
| Angels In Amplifiers - I'm Alright | vocals / Kim Vocal 2 | 14.79 dB | -1.77 dB | +16.56 dB |
| Angels In Amplifiers - I'm Alright | drums / Kuielab B Drums | 3.67 dB | -6.51 dB | +10.19 dB |
| Angels In Amplifiers - I'm Alright | bass / Kuielab B Bass | -13.26 dB | -9.03 dB | -4.23 dB |
| Angels In Amplifiers - I'm Alright | other / Kuielab B Other | 4.80 dB | -4.23 dB | +9.04 dB |

The unmodified sum of the four output stems scored 12.64 dB SI-SDR and 12.69 dB residual SDR against the BKS mixture; for Angels In Amplifiers it scored 8.79 dB SI-SDR and 9.21 dB residual SDR. The residual RMS levels were -32.61 dBFS and -28.19 dBFS, respectively. These are measured reconstruction errors, not a claim that the sum is perceptually transparent.

## Interpretation and limitations

- Kim Vocal 2 gave the strongest and most consistent reference improvement in these excerpts (+16.56 to +22.64 dB SI-SDR improvement). That does not establish clean or pleasant vocals on other genres.
- Kuielab B Drums improved over the mixture by about 10 dB on both excerpts, but absolute SI-SDR varied from 3.67 to 9.75 dB. Residual interference/artifacts remain material.
- Kuielab B Bass was inconsistent: +9.22 dB improvement on BKS, but -4.23 dB on Angels In Amplifiers, where it was worse than leaving the mixture unseparated. Do not assume this bass stem is usable for every track.
- Kuielab B Other improved over the mixture in both excerpts, but absolute SI-SDR was -0.29 to 4.80 dB. The broad residual indicates substantial non-target content and/or artifacts.
- The two tracks and short excerpts are not a representative corpus. SI-SDR is gain-invariant and sensitive to alignment; these scores do not measure musical pleasantness, vocal intelligibility, transient quality, or artifact annoyance.
- The listener reported: “option a was always the clearer answer between the differences”. The audition page places the reference first/left and the separated estimate second/right. If “A” refers to that first/left player, the references were clearer in every comparison. The note does not identify per-stem exceptions or give a separate usefulness rating, so do not treat it as a detailed listener score.
- This is one listener's brief review, not a blinded or multi-listener assessment. The scores and listening note together still do not establish that the separated stems are pleasant or useful for production.
- This run is Linux CPU evidence only. It does not establish Windows execution, GPU parity, or broader genre performance.

No score threshold is used as a pass/fail signal. A non-silent or readable file is not quality evidence.

## Method

1. Use the pinned four-model recipe: `kim_vocal_2`, `kuielab_b_drums`, `kuielab_b_bass`, and `kuielab_b_other`, each on the full mixture, with the registry SHA-256 verified before inference.
2. Decode the mixture and reference stems to aligned 44.1 kHz stereo float PCM. The measured excerpt is seconds 30–38 of each track.
3. For each estimate, calculate stereo-flattened SI-SDR against the matching reference. Use one least-squares gain across both channels. Calculate the same reference-vs-mixture SI-SDR baseline and report their difference as SI-SDR improvement.
4. Exclude the first and last 0.5 seconds from reference SI-SDR to reduce model padding/overlap edge influence. Use the full excerpt to evaluate the unscaled sum of all four estimates against the original mixture. Report both SI-SDR and unscaled residual SDR, plus residual RMS.
5. Preserve the paired reference and estimated WAV files under `generated-artifacts/waveyard-separation-quality/` for audition. This directory is ignored by Git; the licensed audio is not committed.

The opt-in real-audio benchmark requires `WAVEYARD_REAL_AUDIO_REFERENCE_MANIFEST` with dataset/license attribution and four aligned reference-file paths; quality comparisons are not produced without references. `WAVEYARD_REAL_AUDIO_AUDITION_DIR` writes WAVs for listening; `WAVEYARD_REAL_AUDIO_REPORT` writes the report. Set `WAVEYARD_REAL_AUDIO_INPUT` to the audio file and run `node scripts/waveyard-real-audio-benchmark.mjs` for paired sequential 2/1 and bounded-parallel 1/2 CPU runs; `WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS` accepts 2–10 (default 3).

The report checks that every run uses the same source and generated excerpt SHA-256, four pinned model checksums, and reference dataset/track metadata plus all four reference-file SHA-256 values. It includes each run's per-stem reference SI-SDR, mixture baseline and improvement, as well as full-excerpt recombined-mixture SI-SDR, residual SDR, and residual RMS. `qualityComparison.pairedMetricSummaries` reports each mode's median/range and the paired parallel-minus-sequential deltas by repetition. These observed objective scores do not prove equivalence or replace listening review; no score threshold is treated as perceptual equivalence. The report also includes per-run stage timings, elapsed time, playback timer gaps, and measured OS/CPU. Windows runs are CPU-only and do not represent DirectML performance; Linux measurements are not Windows evidence.

## Licensed reference material

- Dataset: [MUSDB18-HQ (FLAC Optimized)](https://huggingface.co/datasets/roro128/musdb18-hq-flac), derived from [MUSDB18-HQ](https://huggingface.co/datasets/danjacobellis/musdb18HQ).
- Tracks: “BKS - Bulldozer” and “Angels In Amplifiers - I'm Alright”, held-out test split.
- License: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). The source dataset's non-commercial and share-alike terms apply; do not reuse these references in a commercial evaluation or redistribute them outside the license.
- Attribution: MUSDB18-HQ; distributed by `roro128/musdb18-hq-flac`, derived from `danjacobellis/musdb18HQ`.

## Human listening review

Status: **completed with limited notes**. The listener's only observation was that option A was consistently clearer than its comparison. The player orders the reference before the separated estimate; this likely means the references were clearer, but the response did not explicitly define A or identify individual stems. No positive usability claim is made from this review.
