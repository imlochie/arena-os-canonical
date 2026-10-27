# Gate 7 — explicit-preference provenance verification

> **Date:** 2026-09-19 · **Arena commit:** `9ece4c3` · **Upstream:** `1a2200bcbb496154f9ed9ede77059d6be9d0a1be`
> ("Add provenance identity for explicit preferences", branch arena/01a0b5e9-somesafeportablesoftware,
> atop base 8e54a283c392c53f64099a903b293de220e565ce)
> **Command:** `node --import ./scripts/register-src-loader.mjs scripts/e2e-gate7-preference-provenance.mjs`
> **Status:** **PREFERENCE PROVENANCE VERIFIED** (21/21 checks)

## Producer contract (verified from the tree at 1a2200b, not from reports)

- `recordExplicitPreference()` accepts NO caller provenance; it writes
  `{preferenceId: row.id, source: "operator_statement", observedAt, scopeIdentity}`
  derived from the row itself — no response-time identifier, no watch-event
  identifiers anywhere in the shape.
- `observedAt` explicit input is preserved; omitted → insertion time.
- Read-time classification: a stored row is `authoritative` only when its
  stored provenance matches the row on all four fields; anything else — the
  pre-1a2200b shape, mismatches, tampering — is `legacy` with
  `provenance: null`, never silently upgraded.
- Owner isolation enforced by the authenticated owner query (per-owner DB
  select; owner identity appears nowhere on the emitted record).
- OpenAPI: items are typed `PersonalisationExplicitPreference`
  (8 required fields) with closed `PreferenceProvenance`
  (additionalProperties: false, source enum [operator_statement], nullable
  oneOf); TS/Zod generated artifacts agree (checked: api.zod.ts,
  generated type files present for the two new schemas).

## Checks (real capture through the real seam)

| # | Group | Check | Outcome |
|---|-------|-------|---------|
| 1 | CANONICAL | preferenceId survives unchanged (wire → normalized pack) | ✅ 1 |
| 2 | CANONICAL | subjectType survives unchanged (wire → normalized pack) | ✅ "genre" |
| 3 | CANONICAL | subjectIdentity survives unchanged (wire → normalized pack) | ✅ "Japanese cinema" |
| 4 | CANONICAL | statement survives unchanged (wire → normalized pack) | ✅ "I am into Japanese cinema right now." |
| 5 | CANONICAL | scopeIdentity survives unchanged (wire → normalized pack) | ✅ "plex:movies-v1" |
| 6 | CANONICAL | observedAt survives unchanged (wire → normalized pack) | ✅ "2026-09-18T12:00:00.000Z" |
| 7 | CANONICAL | provenanceStatus survives unchanged (wire → normalized pack) | ✅ "authoritative" |
| 8 | CANONICAL | provenance survives unchanged (wire → normalized pack) | ✅ {"preferenceId":1,"source":"operator_statement","observedAt":"2026-09-18T12:00:00.000Z","scopeIdentity":"plex:movies-v1"} |
| 9 | CANONICAL | provenance shape closed: exactly {preferenceId, source, observedAt, scopeIdentity} | ✅ ["observedAt","preferenceId","scopeIdentity","source"] |
| 10 | CANONICAL | observedAt is the producer value, not capture/insertion time at read | ✅ 2026-09-18T12:00:00.000Z (wire) === 2026-09-18T12:00:00.000Z (capture, seeded 2026-09-18T12:00:00.000Z — yesterday, not now) |
| 11 | IDENTITY | no watch-event / behavioural identifiers substitute for preferenceId | ✅ preferenceId,source,observedAt,scopeIdentity |
| 12 | IDENTITY | owner scoping rides the authenticated context; no owner field on the record or its provenance | ✅ owner keys on record: none |
| 13 | LEGACY | legacy row stays legacy across the seam (status verbatim) | ✅ pack.provenanceStatus=legacy |
| 14 | LEGACY | legacy provenance === null verbatim — never replaced with a synthetic object | ✅ null |
| 15 | LEGACY | legacy fields still public payload (id/statement/scope preserved; never upgraded to canonical) | ✅ preferenceId=2 statement="Legacy statement" scope=plex:movies-v1 |
| 16 | EPISTEMIC | no conclusion forms from the preference's provenance under the unchanged calculus (recorded, not patched) | ✅ VOID (lineage_incomplete) — _statement-level provenance is not behavioural lineage — lattice wall fires by design_ |
| 17 | EPISTEMIC | as-of temporal claim: refused — provenance does not license behavioural claims | ✅ VOID (lineage_incomplete) |
| 18 | EPISTEMIC | window comparison: refused — provenance does not license behavioural claims | ✅ VOID (lineage_incomplete) |
| 19 | EPISTEMIC | positive aggregate: refused — provenance does not license behavioural claims | ✅ VOID (lineage_incomplete) |
| 20 | EPISTEMIC | no contradiction surfaces treat the preference as behavioural evidence | ✅ [] |
| 21 | DETERMINISM | replay: normalized representation byte-identical (no wall-clock, no generated ids) | ✅ explicitPreferences A===B: true; full pack A===B: true |

## What the evidence licenses (and what it does not)

The provenance establishes exactly: **an identified explicit preference
statement with source, observation time, and scope.** It does not
establish observed/repeated behaviour, enjoyment, liking, taste,
recommendation suitability, interest, completion, or rewatch — and
under the unchanged calculus none of those form: the preference still
has no behavioural lineage handles, so the lattice wall refuses
(lineage_incomplete), which is the correct void under current rules.
No conclusion kind added; no preference-specific rule added; no taste
path added. Arena preserves and identifies; it does not upgrade.
