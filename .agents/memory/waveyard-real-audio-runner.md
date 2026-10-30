---
name: Waveyard real-audio test runner
description: Runtime-resolution behavior when invoking the opt-in separation measurement test.
---

The real-audio measurement test uses TypeScript modules with extensionless imports. In this workspace, root `pnpm exec tsx` and `pnpm --filter @workspace/arena exec tsx` do not resolve the runner, and Node 24's built-in type stripping does not resolve those imports. The TypeScript runner belongs to the scripts workspace, so `pnpm --filter @workspace/scripts exec tsx` works.

**Why:** stripping TypeScript types does not provide the module-resolution behavior required by this source graph, and pnpm exposes `tsx` through the scripts workspace rather than the root or library package.

**How to apply:** invoke the measurement through the scripts workspace's resolver-aware runner, and keep platform and model evidence explicit in every report. A Linux CPU run is not Windows validation.
