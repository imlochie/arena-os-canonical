---
name: Partial task-update failures
description: Task content changes can persist even when dependency configuration fails.
---

Treat a task update that reports a dependency-configuration failure as potentially partially applied, not rolled back.

**Why:** The task service saved title/description edits before returning a dependency error; a dependency-only retry also failed while the content remained updated.

**How to apply:** Re-fetch the task before retrying. Retry dependencies separately if appropriate, keep content changes idempotent, and distinguish edited plans from successfully changed dependencies or archived queue cards. Do not claim queue entries were removed by a content update.
