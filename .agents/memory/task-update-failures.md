---
name: Partial task-update failures
description: Task content changes can persist even when dependency configuration fails.
---

Treat a task update that reports a dependency-configuration failure as potentially partially applied, not rolled back.

**Why:** The task service saved title/description edits before returning a dependency error; dependency-only retries have also failed in isolation and sequentially after queue state changed.

**How to apply:** Re-fetch before retrying. If a dependency-only retry fails, verify the links remain unchanged and stop rather than repeating calls. Keep content edits idempotent, and distinguish edited plans from saved dependencies or archived cards.
