---
name: Artifact workflow port collisions
description: Recognize and recover managed artifact workflows when stale service processes keep their configured ports busy.
---

When a managed artifact workflow reports EADDRINUSE and Vite shifts to a fallback port, first identify the process actually bound to each configured port. Stale copies of the same workspace's web, API, or mockup services can outlive an earlier workflow run; the UI may still appear to work while the managed workflow is marked failed.

**Why:** In the Replit workspace, an earlier web/API/mockup process set held their usual ports after later managed restarts failed. The mockup server's fallback port was particularly misleading: its status said "running," but it was not on its configured port.

**How to apply:** Use the workflows skill and exact artifact-owned service names. Stop the affected project's services, confirm which expected ports are free and which processes remain, then restart artifact workflows one at a time. Verify the reported `openPorts`, readiness logs, and a request to each expected port; don't accept an automatic fallback port as success.
