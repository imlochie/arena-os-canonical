---
name: Task queue ownership
description: Avoid duplicating work already claimed in the project task queue.
---

Check the live project-task state before starting queued work. Treat `IN_PROGRESS` tasks as owned and do not independently implement or propose duplicate work for them.

**Why:** The user expects queued agents to work in parallel without competing edits or redundant tasks.

**How to apply:** When asked to take the next task, select work that is not already in progress; if the visible queue does not expose an unowned task, ask for the next item rather than guessing.
