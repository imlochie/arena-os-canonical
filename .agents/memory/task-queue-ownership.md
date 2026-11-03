---
name: Task queue direction
description: Respect task ownership and avoid growing the queue without clear direction.
---

Check the live project-task state before starting queued work. Treat `IN_PROGRESS` tasks as owned and do not independently implement or propose duplicate work for them. Keep work aligned to the user's existing priorities and accepted queue; do not add or suggest extra tasks unless the user asks for them or a clear, necessary gap requires it. Group related existing work around a concrete user outcome instead of expanding it into loosely connected branches.

**Why:** The user wants focused progress toward a usable product and is frustrated by extra tasks accumulating without a clear direction.

**How to apply:** When asked to take the next task, select work that is not already in progress; if the visible queue does not expose an unowned task, ask for the next item rather than guessing. Do not end routine work by proposing unrelated follow-ups.
