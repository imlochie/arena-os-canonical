---
name: Browser workspace privacy
description: Keep browser profile state separate from user-facing task artifacts and agent context.
---

Browser profiles are private runtime state, not task artifacts. Do not expose their contents in agent file maps, report downloads, or general workspace enumeration.

**Why:** Chromium profiles contain login state, caches, and lock/socket symlinks. Treating them as ordinary task files can disclose account state and make artifact enumeration fail even when the task's report was saved successfully.

**How to apply:** Retain this separation when adding browser controls or changing recursive file tools. Only deliberate captures, reports, and other task outputs should be offered as results.
