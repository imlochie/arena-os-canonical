---
name: Waveyard real-stem evidence
description: Tie real-audio evidence to actual publication provenance and the exact composition analyzed.
---

Real separated files in an acceptance fixture are not proof that downstream structure analysis consumed them. A completed separation must carry matching source-publication provenance, and the test must assert measured stem evidence in the persisted result.

**Why:** A real-song route previously passed with separated asset files present, while the section worker correctly excluded those assets because their completed separation publication did not contain the source identity. Only an assertion requiring a real semantic result exposed the source-only fallback. This can otherwise make a passing route misleading.

**How to apply:** For tests that claim separated-stem structure or musical-form evidence, seed a source-bound completed publication and inspect the worker's persisted stem-backed observations. Source-only fallback is still the correct behavior for genuinely absent, stale or corrupt stems; do not relax provenance checks to satisfy a fixture.

Evaluate the exact instrumental composition as well as isolated-layer controls.
An `other`-only harmonic probe is not interchangeable with a bass/drums/other bed,
and adding layers does not necessarily make template evidence stronger.

**Why:** Full-recording component probes produced different harmonic availability
for the isolated layer and the complete bed. Inferring production capability
from either proxy without naming its input would misdiagnose the limitation.

**How to apply:** Keep input hashes and analysis scope explicit, retain controls,
and separate component measurements, published/persisted workflow acceptance,
reference-label accuracy and listening quality. Never lower confidence criteria
just to turn an unavailable musical result into a reported success.

Do not enable a replacement harmonic front end on controlled chord fixtures
alone, or treat spectral reconstruction fit as chord accuracy.

**Why:** A note-spectrum prototype passed controlled cases while failing the
owner's full recording gate. Original recordings and recombined cached stems
also produced different fit measurements; neither alone identifies the cause.

**How to apply:** Keep source, bed and recombined controls distinct, preserve
failed candidates outside the runtime, and require real-recording evidence
before integration. Unknown accuracy must remain unknown without chord labels.
