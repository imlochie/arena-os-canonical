---
name: Task queue direction
description: Respect task ownership and avoid growing the queue without clear direction.
---

Check the live project-task state before starting queued work. Treat `IN_PROGRESS` tasks as owned and do not independently implement or propose duplicate work for them. Keep work aligned to the user's existing priorities and accepted queue; do not add or suggest extra tasks unless the user asks for them or a clear, necessary gap requires it. Do not turn optional edge-case tests or small extensions into new follow-up tasks when they can be completed in the current work. When the user asks to reduce the queue, do not add tasks; identify and remove duplicate or low-value items first, and clearly distinguish verified/merged work from pending work.

Finish the user's current multi-step request before moving to other queued work. Explicitly account for unfinished requested outcomes; a merged supporting test is not proof that its product goal has been achieved.

**Why:** The user wants focused progress toward a usable product, has repeatedly called out skipped requests, and is frustrated by extra tasks accumulating without a clear direction; a large queue also makes completed work hard to distinguish from unfinished work.

**How to apply:** When asked to take the next task, select work that is not already in progress; if the visible queue does not expose an unowned task, ask for the next item rather than guessing. Do not end routine work by proposing optional follow-ups. If asked to purge or prioritize tasks, audit existing work before creating anything new and report merged/completed separately from pending.
