---
name: Windows build resource limits
description: User's reported disk and memory pressure during Arena Windows builds.
---

The user reports that Arena's previous Windows build repeatedly ran the laptop out of disk space and required deleting multiple items; they are also concerned about memory use.

**Why:** Resource pressure has blocked their attempts to build and use the app.

**How to apply:** Distinguish RAM from disk use and separate dependency installation, temporary package staging, final installer files, runtime data, and model downloads. Replit's available disk does not establish the user's Windows capacity; preserve user files and be explicit about what has not been measured.

Build preflight must resolve the dependency store using the pinned package manager entirely offline. If that manager is neither installed nor cached, stop rather than guess a default store volume or bootstrap it over the network.

**Why:** A configured store can be on another drive; guessing or downloading before resolving it defeats the user's disk-exhaustion safeguard.

**How to apply:** Keep the same resolved locations in the before-download report and the build-time sampler. Treat a missing offline manager as an explicit setup prerequisite, not permission to skip the store check.

Offline npm configuration queries are not necessarily read-only: npm can initialize its cache/log directory even for `config get cache`.

**Why:** A real configuration-precedence check created the configured cache directory without downloading any packages.

**How to apply:** Distinguish “no downloads” from “no filesystem writes” in preflight guarantees and tests; allow inspection of either the cache itself or its existing ancestor.

Keep game-build SDK acquisition on demand, separate from building/installing Arena itself.

**Why:** The user's repeated laptop disk exhaustion makes compiler/editor payloads an unacceptable hidden installer prerequisite.

**How to apply:** Show download and unpack budgets before acquisition; retain exact pins, bound staging, and keep disposable SDK cache reset separate from installed games and saves.
