---
name: Arena product expectations
description: The user's product-wide expectation for local-first capabilities and subscription-replacing tools.
---

Arena should be a ChatGPT-like personal workspace with useful local capabilities and tools, including practical open-source alternatives to paid software where feasible. Prioritize real end-to-end utility over presets, surface copy, or claims of readiness. The user is frustrated by capabilities hidden behind unusable UI, disconnected stages, and repeated readiness claims without proof. Preserve existing ideas and implementations that genuinely serve the vision; inspect and test before replacing them, and prefer additive changes that keep prior behavior covered. Defer Windows-specific benchmarking until the rest of the product work is finished.

**Why:** The user said previous passes felt like an empty shell and that they had not been able to use the product despite repeated claims that it was ready. They emphasized that presets must not stand in for capabilities and that product stages need to work together. On 2026-10-29, they affirmed the expectation-aligned work was on track and asked to keep checking against their expectations; they also explicitly asked to fast-forward progress without regressing prior work that had a real idea or implementation.

**How to apply:** Keep checking each change against the user's latest product expectations. Look for blockers from capability, discoverability, handoff, persistence, speed, and failure-recovery perspectives. Before replacing existing behavior, inspect its intent and tests; make targeted changes and preserve the contracts that still work. Verify complete input-to-usable-output workflows and distinguish truly local capabilities from cloud-backed features. Do not claim readiness without observable evidence.
