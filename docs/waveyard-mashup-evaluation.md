# Waveyard live stem-swap evaluation

This is a small, repeatable evaluation of real source audio through Waveyard's local separation worker and `SessionExperience` live-swap controls. It is evidence about those runs, not a claim that Waveyard is a complete Stem.fm replacement or that its mixes sound good. The separate full-track, two-reviewer ground-truth protocol and its current blocked status are documented in [waveyard-ground-truth-evaluation.md](./waveyard-ground-truth-evaluation.md).

## Licensed source tracks

All audio used for this evaluation is from Kevin MacLeod's Incompetech pages and is labeled **Creative Commons Attribution 4.0 (CC BY 4.0)**. The generated listening kit includes credits and describes the edits. Keep those credits with any audio or derived mix that is shared.

| Track | Publisher tempo | Official source page |
| --- | ---: | --- |
| Monkeys Spinning Monkeys | 144 BPM | [Incompetech track page](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400011) |
| Sneaky Snitch | 87 BPM | [Incompetech track page](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100772) |

The current run uses 15-second-start excerpts; exact duration, source SHA-256, model SHA-256, stem hashes, analysis confidence, and measured output data are recorded in the ignored `generated-artifacts/waveyard-mashup-quality/` reports. Do not substitute the old MUSDB18 DSD/Restricted material documented in `waveyard-separation-quality.md`.

## Method and rerun

The local worker processes excerpts with the pinned `kim_vocal_2`, `kuielab_b_drums`, `kuielab_b_bass`, and `kuielab_b_other` models. The browser test loads the real stem WAVs into the production Waveyard `SessionExperience`, plays the lead track, performs the selected live donor swap, verifies unaffected lead-stem clocks continue, and captures baseline and swapped audio. Its library/session API is fixture-backed; audio bytes, separation, component, and browser audio graph are real.

1. Download the two tracks from their official pages into `generated-artifacts/waveyard-mashup-quality/sources/`, preserving the listed filenames.
2. Run Waveyard analysis on the two sources and the eight-second audition window:

   ```sh
   pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/waveyard-mashup-analysis.ts" -- \
     "$PWD/generated-artifacts/waveyard-mashup-quality/audio-analysis.json" 15 8 \
     "$PWD/generated-artifacts/waveyard-mashup-quality/sources/monkeys-spinning-monkeys.mp3" \
     "$PWD/generated-artifacts/waveyard-mashup-quality/sources/sneaky-snitch.mp3"
   ```

3. Separate each real excerpt with the production local-worker retry path. Keep ORT at one thread so other work can still run; reports record actual CPU timing and playback timer gaps:

   ```sh
   for id in monkeys-spinning-monkeys sneaky-snitch; do
     base="$PWD/generated-artifacts/waveyard-mashup-quality"
     if [ "$id" = monkeys-spinning-monkeys ]; then duration=12; else duration=8; fi
     WAVEYARD_ORT_INTRA_OP_THREADS=1 WAVEYARD_ORT_INTER_OP_THREADS=1 \
     WAVEYARD_REAL_AUDIO_INPUT="$base/sources/$id.mp3" \
     WAVEYARD_REAL_AUDIO_START_SECONDS=15 \
     WAVEYARD_REAL_AUDIO_MAX_SECONDS="$duration" \
     WAVEYARD_REAL_AUDIO_BENCHMARK_CPU_ONLY=1 \
     WAVEYARD_REAL_AUDIO_AUDITION_DIR="$base/mixtures/$id" \
     WAVEYARD_REAL_AUDIO_REPORT="$base/$id-separation-report.json" \
     pnpm --filter @workspace/scripts exec tsx --test --test-isolation=none \
       --test-name-pattern='the pinned four-model recipe separates a real audio excerpt' \
       "$PWD/lib/arena/src/lib/waveyard/worker-local/separation-real-ort.test.ts"
   done
   ```

   The separation test writes the report and audition WAVs before enforcing the playback responsiveness gate. A nonzero test result must be treated as a failure even when it leaves usable diagnostic audio.
4. Generate the manifest, run the real browser live-swap capture, and build the participant kit:

   ```sh
   node scripts/waveyard-mashup-manifest.mjs \
     generated-artifacts/waveyard-mashup-quality/manifest.json
   WAVEYARD_MASHUP_MANIFEST="$PWD/generated-artifacts/waveyard-mashup-quality/manifest.json" \
     node scripts/waveyard-live-stems.mjs --mashup-evaluation-only
   node scripts/waveyard-mashup-listening.mjs build \
     generated-artifacts/waveyard-mashup-quality/manifest.json \
     generated-artifacts/waveyard-mashup-quality/live-captures/browser-live-swap-captures.json \
     generated-artifacts/waveyard-mashup-quality/blind-listening
   ```

5. Give listeners `blind-listening/participant/index.html`, its `audio/` directory, and `LICENSES.md`. The page runs locally and downloads a JSON response; it sends no data anywhere. Keep `organizer-answer-key.json` private. Summarize returned files with:

   ```sh
   node scripts/waveyard-mashup-listening.mjs summarize \
     generated-artifacts/waveyard-mashup-quality/blind-listening/evaluation-report.json \
     generated-artifacts/waveyard-mashup-quality/blind-listening/organizer-answer-key.json \
     generated-artifacts/waveyard-mashup-quality/blind-listening/responses/*.json
   ```

## Current measured run

Two CC BY 4.0 excerpts were separated on a four-vCPU Linux x64 host using the pinned local CPU models. The WAV outputs were readable, finite PCM16 stereo at 44.1 kHz, and had no clipped samples. Separation is still slow: the 12-second *Monkeys Spinning Monkeys* excerpt took 89.1 seconds (7.42× real time); the 8-second *Sneaky Snitch* excerpt took 110.5 seconds (13.81× real time). The worker test's playback heartbeat gap was 134 ms for the first run and 5.06 seconds for the second, which failed its 1-second responsiveness gate. That heartbeat is a runtime responsiveness proxy, not a measurement of physical speakers or Windows behavior.

Waveyard analyzed the excerpts at 71.777 BPM (confidence 0.296) and 43.428 BPM (confidence 0.211), while the publishers list 144 and 87 BPM. These are roughly half-time readings with low tempo confidence. The app's tempo policy only stretches near-equal tempos or a 0.5×/1×/2× lock; these two tracks do not qualify. Accordingly, both live swaps stayed at native tempo (ratio 1), rather than applying the requested ratios 0.605 and 1.653. This is expected by the current compatibility rule, not evidence of a failed swap. A compatible real-track pair is still needed to measure an applied tempo match.

The Linux Chromium run captured two eight-second `other`-stem swaps, one in each direction. The donor became audible in 232 ms and 241 ms respectively, while the other three lead-stem clocks advanced by about 1.22–1.28 seconds without pausing. Baseline and swapped recordings were converted from browser WebM/Opus to PCM16 WAV for the blind kit; each A/B pair is trimmed to identical sample counts (8.40 seconds here), so duration does not disclose the version. Sample peaks ranged from −11.64 to −9.68 dBFS with zero near-full-scale samples. These signal measurements do not establish whether either mix sounds musically good.

The analysis selected Camelot mode from Waveyard's own key output (`C major` and `D minor`); no independent key reference or human pitch judgment was available. The blind participant kit is ready, but **listener count is N=0**. No sound-quality, artifact, harmonic-fit, or preference conclusion is justified yet. The complete hashes and per-stem/per-capture measurements are in `generated-artifacts/waveyard-mashup-quality/blind-listening/evaluation-report.json`; the audio and generated reports are ignored build artifacts, not source-controlled project files.

## Interpretation limits

- The CPU separation test is an offline operation. Its timer assertions measure whether the test's playback heartbeat continues during processing; they are not a Windows or mobile benchmark.
- The blind kit contains matched-duration listening clips per combination. Browser capture uses Chromium WebM/Opus and the kit converts those captures to PCM16 WAV; this does not recover or claim lossless capture.
- The report measures sample peak, RMS, PCM clipping counts, live tempo ratio, unchanged-stem playback clocks, and browser timing events. These do not establish harmonic fit, artifact annoyance, or listener preference.
- Anonymous ratings count returned submissions, not identity-verified unique people. Until responses are supplied, the human listener count is **zero**.
- The browser capture is Linux Chromium with a fixture-backed session route. It does not establish Windows, iOS, physical-device, or native-app behavior.

## Reference and stronger evidence requirement

The user rejected the earlier `other`-stem examples as ambiguous: a whole-song interruption can sound similar. A stronger demonstration must keep recognisable lead vocals/backing audible while changing only distinctly different drums or vocals, then restore the original in the same uninterrupted recording. Compare isolated source stems as well as the master mix. Advancing media clocks alone do not establish that the retained channels remain audible.

STEM.FM's [official swapping guide](https://help.stem.fm/articles/swapping-stems-between-two-songs) describes two prepared songs, four active categories, a tap to toggle a category to the other song, and another tap to toggle back. Its [timing guide](https://help.stem.fm/articles/app-faq-stem-change-delay) distinguishes immediate changes from beat/bar-quantised changes and momentary isolation/restoration. Its [key-matching guide](https://help.stem.fm/articles/app-key-matching) defines Camelot as nearest compatible key and Match Key as the lead's key. Reproducing only the underlying donor-loading operation is not equivalent to this combined workflow.

A new drum comparison uses the user's uploaded *September* audio and Kevin MacLeod's *Funkorama* ([official CC BY 4.0 source](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100474), source SHA-256 `6be229815d85a0b99382b944d31098b882702c04ac7ad899e44ab7f8ba89b5ad`). Initially the separation processes exited with code 137 and the environment's OOM-kill counter increased, including with pre-cropped inputs and with the database fixture removed. Disabling ONNX CPU arena and memory-pattern caching allowed the same pinned four models to complete for both eight-second excerpts. This allocation policy is now shared by normal model-opening paths; weights, model geometry and DSP precision are unchanged. Do not redistribute the user's source or derivatives as CC BY.

The browser harness accepts optional `swapAtSeconds`, `restoreAtSeconds`, and `verifyLayerIdentity` combination fields. The latter checks original-channel gains alongside clocks; restoration checks that the donor stops and the original channel returns. A new Linux Chromium capture exercised these fields with the real separated files. During the swap the original vocals/bass/other gains remained 1, the original drums were 0, and the donor gain was 1. Donor selection-to-audible preparation measured 264 ms; original restoration was confirmed about 5.2 seconds into the diagnostic. The recording is continuous browser master output, not an offline splice. Browser audio-graph initialization now follows a real play gesture rather than assuming the graph exists before playback.

Reproduction:

```sh
# The runner uses the built production inference worker but bypasses library persistence.
WAVEYARD_MODELS_DIR="$PWD/artifacts/api-server/.data/waveyard-models" \
  pnpm --filter @workspace/scripts exec tsx "$PWD/scripts/waveyard-proof-stems.ts" \
  /absolute/path/to/excerpt.wav /absolute/path/to/stem-output 8

WAVEYARD_MASHUP_MANIFEST="$PWD/generated-artifacts/waveyard-drum-swap-proof/manifest.json" \
  node scripts/waveyard-live-stems.mjs --mashup-evaluation-only
```

Evidence is under `generated-artifacts/waveyard-drum-swap-proof/`: per-source inference reports, isolated stem WAVs, `live-captures/browser-live-swap-captures.json`, and `continuous-drums-swap-and-restore.wav`. The last file is decoded from the browser's lossy WebM/Opus recording, not a lossless export. **Tempo and key matching were disabled deliberately** to isolate channel identity; this does not establish musical fit, aligned beats, full-song memory behaviour or STEM.FM parity. No human-listening score has been assigned.

The subsequent production retry → local worker → persisted-output check also passed for the eight-second *September* excerpt (`september-persisted-report.json`): four readable, duration-matched, finite PCM stem files; inference job elapsed 68.8 seconds (8.6× real time), with both native allocation caches disabled. This proves the changed policy reaches the normal worker path, not only the audition runner. It is still substantially slower than real time; preparation speed and full-length memory behaviour remain open, not resolved by the successful short run.
