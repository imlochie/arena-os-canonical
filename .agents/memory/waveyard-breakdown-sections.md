---
name: Waveyard breakdown sections
description: The user's distinction between breakdowns, bridges, and instrumental passages.
---

In Waveyard section annotations, a breakdown is a distinct structural event: the arrangement strips down to core vocals and percussion, or the band drops away and leaves claps or similarly sparse elements. Do not automatically relabel it as a bridge or generic instrumental.

**Why:** the user explicitly distinguishes this form because it changes how stems and vocal/percussion arrangements should be understood.

**How to apply:** keep `breakdown` as its own section label in annotation and evaluation schemas; preserve the reviewer’s original wording when a controlled label is unavailable.

Signal-derived `breakdown-candidate` labels are not equivalent to adjudicated
musical-form annotations. Their boundaries and fingerprints may inform passage
matching, but they must remain role-neutral in automatic arrangement scoring
until real-song validation shows the label is trustworthy.

**Why:** real-stem energy changes can identify an arrangement drop several
seconds before or after a listener's named section boundary; treating the
candidate as confirmed would turn a useful signal into a false semantic claim.

**How to apply:** keep evidence strength separate from probability, preserve the
candidate as a distinct label, and do not award or penalize a mix placement as
a confirmed breakdown solely from this signal.
