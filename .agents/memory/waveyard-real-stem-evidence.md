---
name: Waveyard real-stem evidence
description: Avoid false positives in real-audio acceptance when the stem-analysis worker falls back to source-only structure.
---

Real separated files in an acceptance fixture are not proof that downstream structure analysis consumed them. A completed separation must carry matching source-publication provenance, and the test must assert measured stem evidence in the persisted result.

**Why:** A real-song route previously passed with separated asset files present, while the section worker correctly excluded those assets because their completed separation publication did not contain the source identity. Only an assertion requiring a real semantic result exposed the source-only fallback. This can otherwise make a passing route misleading.

**How to apply:** For tests that claim separated-stem structure or musical-form evidence, seed a source-bound completed publication and inspect the worker's persisted stem-backed observations. Source-only fallback is still the correct behavior for genuinely absent, stale or corrupt stems; do not relax provenance checks to satisfy a fixture.
