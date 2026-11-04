# Waveyard four-stem reference evaluation

> **Authorization correction (2026-11-04):** the older MUSDB18-HQ source-license claim in this document was wrong. SigSep's official track list marks both “BKS - Bulldozer” and “Angels In Amplifiers - I'm Alright” as DSD/Restricted, and SigSep says MUSDB18 access is limited to academic use. The historical numbers below are retained only for audit; do not use them as authorized product-quality evidence or redistribute the audio. The current live-mashup assessment uses separately licensed CC BY 4.0 recordings.

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

The opt-in real-audio benchmark accepts `WAVEYARD_REAL_AUDIO_INPUT` for a single track or `WAVEYARD_REAL_AUDIO_TRACKS_MANIFEST` for a multi-track run. For multi-track quality comparisons, use at least two tracks and give each an input excerpt plus a reference manifest containing dataset/license attribution and four aligned reference-stem files. The input excerpt and all references must cover the same samples, duration, and 44.1 kHz stereo signal; when a source mix is cropped with `startSeconds`/`maxSeconds`, the reference stems must already be cropped to that exact interval. Reference paths are relative to their reference manifest; input and reference-manifest paths are relative to the tracks manifest.

Example tracks manifest:

```json
{
  "schemaVersion": 1,
  "tracks": [
    {
      "id": "authorized-track-a",
      "label": "Authorized track A",
      "inputPath": "audio/authorized-track-a-mix.wav",
      "referenceManifestPath": "references/authorized-track-a.json"
    },
    {
      "id": "authorized-track-b",
      "label": "Authorized track B",
      "inputPath": "audio/authorized-track-b-mix.wav",
      "referenceManifestPath": "references/authorized-track-b.json"
    }
  ]
}
```

Each referenced per-track manifest has the existing single-track shape:

```json
{
  "dataset": "<authorized dataset and release>",
  "datasetUrl": "<official dataset page>",
  "track": "<authorized track title>",
  "license": "<terms confirmed by the rights holder>",
  "attribution": "<complete required attribution>",
  "referenceStems": {
    "vocals": "<aligned-vocals.wav>",
    "drums": "<aligned-drums.wav>",
    "bass": "<aligned-bass.wav>",
    "other": "<aligned-other.wav>"
  }
}
```

The strings in angle brackets are placeholders. Do not run the reference benchmark until the source terms permit the intended use and all four reference stems are authorized.

Run it with:

```sh
WAVEYARD_REAL_AUDIO_TRACKS_MANIFEST=docs/waveyard-quality-tracks.example.json \
WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS=3 \
WAVEYARD_REAL_AUDIO_REPORT=generated-artifacts/waveyard-multi-track/report.json \
node scripts/waveyard-real-audio-benchmark.mjs
```

The sequential 2/1 and bounded-parallel 1/2 CPU settings are paired for every track and repetition; the first setting alternates by repetition. Each paired group is checked for an identical source-file SHA-256, processed-excerpt SHA-256 and timing window, reference metadata and four reference-file SHA-256 values, and all four registry-pinned model checksums. The worker also verifies that each reference stem decodes to the exact sample count and rate of the measured excerpt. This checks file identity and duration, not that a mislabeled reference is musically aligned, so the supplied stems must originate from the corresponding track and crop.

Schema-version 2 reports keep each track's input/reference hashes, timing summaries, stem metrics, recombination metrics, paired deltas, and listening kit under `tracks[]`. `qualityComparison.pairedMetricSummaries.perTrack` reports the objective metrics separately for each track; `acrossTracks` pools paired observations and includes ranges, but can hide a track-specific outlier, so always inspect each track. `WAVEYARD_REAL_AUDIO_BENCHMARK_REPETITIONS` accepts 2–10 (default 3), `WAVEYARD_REAL_AUDIO_REPORT` selects the report path, and `WAVEYARD_REAL_AUDIO_LISTENING_DIR` optionally selects the listening-kit root; otherwise kits are placed alongside the report. Single-track runs without references remain supported for timing/listening only.

Reports include per-run stage timings, elapsed time, playback timer gaps, and measured OS/CPU. The checksummed input/model and reference evidence is per track, while all CPU comparisons use the same two settings. Objective scores do not prove equivalence or replace listening review. Windows runs are CPU-only and do not represent DirectML performance; Linux measurements are not Windows evidence.

Each successful paired benchmark creates a blind listening kit from the first matched repetition. Share only the `participant/index.html` page and its `participant/audio/` files with listeners; keep `organizer/answer-key.json` private until judgments are collected. A/B assignments are randomized independently for each stem, stem order is randomized, and the key maps both labels to the CPU setting and includes the exact output WAV SHA-256 values plus input, excerpt, and model checksums. Each listener rates audible difference (1–5), preference (A/B/no preference), reports headphone use, and may add a note; the page downloads one JSON response file. Responses are not uploaded. Summarize returned files with:

```sh
node scripts/waveyard-blind-listening-report.mjs \
  generated-artifacts/<benchmark>-blind-listening/organizer/answer-key.json \
  generated-artifacts/<benchmark>-blind-listening/organizer/listener-summary.json \
  generated-artifacts/<response-1>.json [<response-2>.json ...]
```

The summary reports valid response files and per-stem counts, rating distributions, and setting preferences. It does not claim a verified unique-person count; use an optional anonymous listener code to help an organizer identify repeat submissions.

## Historical source authorization

- The official [SigSep track list](https://github.com/sigsep/website/blob/master/content/datasets/assets/tracklist.csv) marks both tracks above as `DSD, Restricted`; neither is CC BY-NC-SA.
- The official [MUSDB18 page](https://sigsep.github.io/datasets/musdb.html) says dataset access is restricted to academic use and requires an access request.
- The earlier Hugging Face mirror metadata was not sufficient authority to relabel those source tracks. Their audio and derived listening files are excluded from the new study and from any claim about commercially usable product capability.
- The previous “licensed reference material” and listener notes are not a valid authorization record. Preserve the numeric history only as a record of what was measured, with the access limitation above.

## Human listening review

Status: **completed with limited notes**. The listener's only observation was that option A was consistently clearer than its comparison. The player orders the reference before the separated estimate; this likely means the references were clearer, but the response did not explicitly define A or identify individual stems. No positive usability claim is made from this review.

## Sequential versus bounded-parallel CPU listening

Status: **matched outputs compared; no listener panel collected**. On 2026-11-02, the paired benchmark separated the same 8-second excerpt (starting at 20 seconds) twice with each setting on Linux x64 CPU. Both settings used the same input checksum, processed-excerpt checksum, and four pinned model checksums. In the first matched repetition, each of the four sequential/parallel WAV pairs had the same SHA-256 checksum, so the files were byte-for-byte identical. Listeners cannot hear a difference between those exact files. This says nothing about other inputs or runtimes. No people submitted judgments (n=0); there is no listener preference or subjective rating result.

The participant kit is written under `generated-artifacts/waveyard-cpu-listening/report-blind-listening/participant/`; the report is `generated-artifacts/waveyard-cpu-listening/report.json`, and the private setting-to-label key is in the sibling `organizer/` folder. Share the participant folder only. This is one excerpt on one Linux CPU runtime; it does not establish universal quality or equivalence.

Any later panel result must state the number of listeners, number of valid judgments per stem, whether listeners used headphones, and that the panel/sample cannot establish a universal quality or equivalence claim. Results from one short excerpt, one machine, one operating system, or a small/self-selected listener group apply only to those conditions.
