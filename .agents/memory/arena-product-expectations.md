---
name: Arena product expectations
description: The user's product-wide expectation for local-first capabilities and subscription-replacing tools.
---

Arena should be a ChatGPT-like personal workspace with useful local capabilities and tools, including practical open-source alternatives to paid software where feasible. Prioritize real end-to-end utility over presets, surface copy, or claims of readiness. The user is frustrated by capabilities hidden behind unusable UI, disconnected stages, and repeated readiness claims without proof. Preserve existing ideas and implementations that genuinely serve the vision; inspect and test before replacing them, and prefer additive changes that keep prior behavior covered. Defer Windows-specific benchmarking until the rest of the product work is finished.

**Why:** The user said previous passes felt like an empty shell and that they had not been able to use the product despite repeated claims that it was ready. They emphasized that presets must not stand in for capabilities and that product stages need to work together. On 2026-10-29, they affirmed the expectation-aligned work was on track and asked to keep checking against their expectations; they also explicitly asked to fast-forward progress without regressing prior work that had a real idea or implementation.

**How to apply:** Keep checking each change against the user's latest product expectations. Look for blockers from capability, discoverability, handoff, persistence, speed, and failure-recovery perspectives. Before replacing existing behavior, inspect its intent and tests; make targeted changes and preserve the contracts that still work. Verify complete input-to-usable-output workflows and distinguish truly local capabilities from cloud-backed features. Do not claim readiness without observable evidence.

Prioritize the already-approved main-chat Arcade roadmap over unrelated small fixes and additional suggestions.

**Why:** The user repeatedly pointed to the main chat's existing queue after the agent substituted side fixes and confused that queue with background task slots.

**How to apply:** Inspect the live ownership and dependency records before explaining why queued work is waiting. Follow the existing roadmap; do not infer that main-chat tasks need approval again or that every blocked item is directly waiting for a concurrency slot.

When the user directs moving on from blocked work to an already-approved task,
proceed with the requested work rather than demanding that they repeat the
instruction through a task button. Leave incomplete work honestly incomplete.

**Why:** The user explicitly corrected repeated requests to start the next task
after already directing that the blocked compatibility work be set aside.

**How to apply:** Distinguish task bookkeeping from actual technical dependencies.
Do not falsely complete a task to advance the queue or use its assignment as a
reason to ignore the user's current work direction.
Do not claim the active task has switched when only the subject of file edits
has changed. The user specifically objected to work branching out under the
old assignment instead of an actual task transition. If reassignment is not
available, disclose that limitation before starting edits for the next task.
