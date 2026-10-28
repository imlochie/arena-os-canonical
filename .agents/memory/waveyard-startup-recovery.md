---
name: Waveyard startup recovery
description: Keep boot-time local worker recovery reliable across transient database connection failures.
---

Wrap API-startup job recovery in a bounded retry for transient PostgreSQL/network connection errors only. Retry the full, idempotent recovery sequence so an interruption between recovery phases does not strand work. Preserve the last error when retries exhaust, and fail fast on schema or configuration errors.

**Why:** The API awaits recovery before accepting requests. A brief database connection interruption should not prevent the service from starting, but retrying permanent errors would hide broken migrations or schema.

**How to apply:** When adding boot-time recovery steps, ensure they are safe to repeat, use the shared bounded retry helper, and test transient recovery, permanent failure without retry, and retry exhaustion.
