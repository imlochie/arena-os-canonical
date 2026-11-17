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

For hybrid matching, use role-specific evidence from the stems the arrangement
will actually retain. A donor's full-mix chroma includes backing that a vocal
swap discards; it must not veto or rank the retained vocal against the anchor
bed. Conversely, compare isolated vocal notes with retained-bed harmony when
available. Drum section choices require checksum-current isolated attacks on
both beat grids; whole-mix rhythm/phase is context for that role, and only a
measured `replace` or `layer` decision selects donor drums. Vocal section
alignment still has the whole-mix rhythm/phase limitation until stem-level
phrase alignment is supported. Coarse vocal-activity windows identify activity
and entry timing, not lyrics or words; reconcile them with pitch-note evidence
rather than treating one detector's silence as definitive.

**Why:** The automatic hybrid compared complete source mixes even when it
rendered only the anchor bed and donor vocal, and could select a passage whose
discarded backing drove the decision. Stem-specific harmony, activity, pitch
notes and drum transients already exist in the same persisted workflow.

**How to apply:** Keep passage structure separate from retained-role judgments;
use the exact saved tempo transform and source window for both evidence and
rendering. Let matched role-specific measurements replace irrelevant source-mix
gates, but label them as audition evidence until human references and listening
tests establish accuracy and quality.

When consuming persisted analysis evidence, validate the version constant for
that analysis contract, not merely the shared engine name or a generic stem
version. A specialized local analysis can reuse the engine identifier while
carrying its own version.

**Why:** The automatic-remix drum loader compared worker output version 1.1.0
against the generic stem-analysis version 1.0.0. The worker had persisted
current, checksum-bound events, but the route discarded them before planning.

**How to apply:** Keep worker persistence checks and route-consumption checks
paired in one database acceptance test. Verify that valid persisted evidence
changes the plan, while stale engine versions remain unavailable.

Do not add a fixed accompaniment-similarity weight to semantic form recurrence
without real-song evidence that it improves independent labels. A synthetic
corroboration case passed, but full-track tests on September shifted an already
closer boundary in the wrong direction, and Another One Bites the Dust still
produced no form.

**Why:** Arrangement activity can recur independently of semantic form; passing
a synthetic drum-loop test does not show that the signal improves verse/chorus
recognition.

**How to apply:** Evaluate changes against full-track human annotations and keep
structural repetition separate from semantic labels until that evidence supports
their connection.
