---
name: Waveyard preview memory budgets
description: Keep browser PCM memory estimates and acceptance fixtures reliable across actual device sample rates.
---

Use the AudioContext's actual sample rate when estimating decoded PCM memory. Browser contexts can run at 44.1 kHz even when a test or developer assumes 48 kHz; a fixture that only crosses the limit at 48 kHz can silently pass on another machine.

Reserve 3.5 times decoded PCM plus the largest encoded asset for browser preview peak memory. A real four-minute stereo MP3 produced Chromium PSS peaks around 2.8 times the retained PCM, so a smaller decoder allowance can accept an asset that exceeds the 128 MiB preview budget. Web Audio source nodes can also retain decoded buffers after stop/disconnect; clear their buffer references when discarding an arrangement.

**Why:** A 44.1 kHz headless browser exposed both sample-rate variance and decode-time allocation beyond the previous 1.25x allowance; post-switch PSS fell and the AudioBuffer became collectible after its source node released it.

**How to apply:** Estimate from the running AudioContext rate, validate with a real encoded-audio browser run, and include both a long playable fixture and oversized fixtures that reject before fetch at 44.1 and 48 kHz.
