---
name: Waveyard real-audio test runner
description: Runtime-resolution behavior when invoking the opt-in separation measurement test.
---

The real-audio measurement test uses TypeScript modules with extensionless imports. In this workspace, root `pnpm exec tsx` and `pnpm --filter @workspace/arena exec tsx` do not resolve the runner, and Node 24's built-in type stripping does not resolve those imports. The TypeScript runner belongs to the scripts workspace, so `pnpm --filter @workspace/scripts exec tsx` works.

**Why:** stripping TypeScript types does not provide the module-resolution behavior required by this source graph, and pnpm exposes `tsx` through the scripts workspace rather than the root or library package.

**How to apply:** invoke the measurement through the scripts workspace's resolver-aware runner, pass the test file by absolute path because pnpm changes the working directory to that package, and keep platform and model evidence explicit in every report. A Linux CPU run is not Windows validation.

When a browser acceptance test forwards `/api` calls to an isolated API process, rewrite `Origin` and `Referer` to that process's loopback origin and remove the page's original `Host` header. Desktop-mode write routes reject the original preview origin even when reads work.

**Why:** forwarding a browser request to a different loopback port changes the API's same-origin trust check; leaving the preview `Origin` in place made real session saves return 403.

**How to apply:** keep browser requests routed to the real isolated API, but align their origin headers with its test server so state-changing routes exercise normal desktop behavior.

On the current Linux x64 runtime, ONNX Runtime may log that the optional shared provider library is missing while CPU inference still works. The crafted CPU session test has passed despite that warning.

**Why:** the provider library belongs to the optional CUDA package on this platform; the base CPU runtime can still execute.

**How to apply:** use the actual CPU session/test result to decide whether inference is blocked; do not treat that warning alone as a failed separation run, and never count it as Windows evidence.
