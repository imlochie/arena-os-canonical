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

Isolated drum tempo is useful when the full mix estimate is weak, but it is not
an unconditional replacement for full-mix tempo. Require exact current source
and drum-stem provenance, a duration-bounded beat grid whose interval agrees
with its BPM, and credible confidence. If full-mix and isolated-drum BPM disagree
materially, retain the full-mix result rather than choosing whichever is more
convenient. Donor preview warming and committed swaps must derive their tempo
ratio from the same selected evidence.

**Why:** A real full-song pair showed that isolated drums can strengthen a weak
mix estimate and safely drive the live deck clock, while a deliberately
conflicting analysis fixture showed that blindly preferring the stem would
produce a false tempo master. Preparing a donor at native tempo and recomputing
the ratio only after selection also wastes the user's wait and defeats
preparation.

**How to apply:** Validate provenance and beat-grid consistency at the persisted
boundary; share one tempo-selection function between candidate display,
preparation, swap selection and the deck master. Keep measured preparation
latency visible and distinguish a completed live audio-graph test from
persisted-route or listening-quality evidence.

Do not enable a replacement harmonic front end on controlled chord fixtures
alone, or treat spectral reconstruction fit as chord accuracy.

**Why:** A note-spectrum prototype passed controlled cases while failing the
owner's full recording gate. Original recordings and recombined cached stems
also produced different fit measurements; neither alone identifies the cause.

**How to apply:** Keep source, bed and recombined controls distinct, preserve
failed candidates outside the runtime, and require real-recording evidence
before integration. Unknown accuracy must remain unknown without chord labels.
