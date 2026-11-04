---
name: SourceForge release evidence
description: Separates publisher file hashes from license proof and safe-install readiness for SourceForge packages.
---

A provider SHA-256 pins the bytes of a SourceForge file; it does not prove licensing rights, safe archive contents, or runtime support.

**Why:** Treating a checksum as install readiness would turn review evidence into a capability claim the app has not established.

**How to apply:** Keep unknown-license and uninspected SourceForge files review-only. Before extraction or installation, verify the complete license against the pinned package, inspect archive paths, links, size and supported layout, and require explicit rights confirmation.
