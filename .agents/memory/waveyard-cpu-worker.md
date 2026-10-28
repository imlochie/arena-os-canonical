---
name: Waveyard CPU worker packaging
description: Packaging and runtime constraints for API-owned CPU-intensive Waveyard worker threads.
---

Run CPU-heavy audio work outside the API event loop, and ship the worker as a separate bundled entry rather than trying to import the API bundle or relying on source TypeScript at runtime.

**Why:** The API bundle includes server startup and dependencies that are unsuitable as a worker entry. In this workspace, source-based workers inherit Node runtime arguments that worker threads reject, while the separately bundled worker runs cleanly in both the API service and regression tests.

**How to apply:** Keep database and storage coordination in the API process; send only typed inputs, progress, results, and explicit errors across the worker boundary. Add the worker entry to the API build and test through that emitted bundle.
