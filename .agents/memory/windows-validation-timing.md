---
name: Windows validation timing
description: Prepare Windows-side validation without repeatedly asking the user to run it while broader product gaps remain.
---
Continue preparing Windows validation and the measurement path. Do not press the user to run it until the remaining product work is small and Windows-side evidence is the actual blocker.

**Why:** the user clarified that they want preparation to continue, but repeated requests to run Windows checks are frustrating while many product gaps remain.

**How to apply:** keep improving portable checks, setup instructions, and report capture; defer requests for the user's Windows run until the broader product work is nearly complete.

The final Windows pass is the agreed timing for target-Windows verification rather than connecting Windows CI during implementation.

**Why:** the user explicitly chose “Defer to final Windows pass” so queued implementation can continue.

**How to apply:** record deferred feature acceptance in its status document, not as completed Windows support. Keep runtime safety gates active and avoid treating an implementation-step closure as release readiness.
