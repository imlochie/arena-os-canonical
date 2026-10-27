---
name: Arcade model routing
description: Why game generation and revisions must not silently try unrelated public AI services.
---

Arcade generation and source-based modifications must use a connected provider or a loaded on-device model. When neither is available, report the missing model directly rather than trying unrelated public endpoints or substituting a preset game.

**Why:** Public endpoint cascades can leave custom game requests waiting for multiple timeouts. Revisions also contain the existing game source, which should not be sent to a service the user did not choose.

**How to apply:** Keep classic quick starts separate from custom mechanics. Preserve the current game and the requested change when a modification cannot run. Connecting or changing a provider must be an explicit user action.
