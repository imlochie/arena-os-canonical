---
name: Waveyard startup recovery
description: Keep boot-time worker recovery reliable and orphaned-source cleanup conservative.
---

Wrap API-startup job recovery in a bounded retry for transient PostgreSQL/network connection errors only. Retry the full, idempotent recovery sequence so an interruption between recovery phases does not strand work. Preserve the last error when retries exhaust, and fail fast on schema or configuration errors.

**Why:** The API awaits recovery before accepting requests. A brief database connection interruption should not prevent the service from starting, but retrying permanent errors would hide broken migrations or schema.

**How to apply:** When adding boot-time recovery steps, ensure they are safe to repeat, use the shared bounded retry helper, and test transient recovery, permanent failure without retry, and retry exhaustion.

The user approved startup cleanup of unreferenced Waveyard source files after a 24-hour grace period.

**Why:** the user explicitly chose a 24-hour cleanup window for unreferenced source files.

**How to apply:** Delete only old generated source objects with no canonical source row. Preserve referenced objects, recent objects, and unrelated storage keys; if reference checks fail, do not delete.
