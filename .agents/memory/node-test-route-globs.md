---
name: Node test discovery for dynamic routes
description: Run acceptance tests located under framework route folders containing bracketed parameters.
---

Do not pass a test file under a literal `[id]` route directory directly to `tsx --test`: quoting the path does not prevent Node's test discovery from treating the brackets as a glob, and it can report zero tests without an error.

**Why:** The production mashup-route acceptance file registered a real PostgreSQL test, but a direct invocation of its bracketed path reported `tests 0`; importing it through a path-safe test entry point registered and ran the test.

**How to apply:** Use a test entry point in a path without glob metacharacters, resolve the route test to a file URL, and dynamically import it. Confirm the runner reports a nonzero test count and inspect the test result rather than relying only on exit code zero.
