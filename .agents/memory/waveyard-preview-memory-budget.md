---
name: Waveyard preview memory budgets
description: Keep browser PCM memory estimates and acceptance fixtures reliable across actual device sample rates.
---

Use the AudioContext's actual sample rate when estimating decoded PCM memory. Browser contexts can run at 44.1 kHz even when a test or developer assumes 48 kHz; a fixture that only crosses the limit at 48 kHz can silently pass on another machine.

**Why:** The headless browser used 44.1 kHz, so a four-stem test sized near the 128 MiB cap did not exercise the rejection path that it crossed at 48 kHz.

**How to apply:** Calculate estimates from the running context and choose long-track / many-stem fixtures that exceed the limit with margin at both 44.1 and 48 kHz.
