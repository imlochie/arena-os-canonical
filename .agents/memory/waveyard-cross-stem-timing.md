---
name: Waveyard cross-stem timing
description: When isolated stem onset evidence may drive a shared timing correction.
---

Only comparisons between the same musical role may authorize a common phase shift (for example, retained bass against donor bass). Drum, bass, and melodic attacks can occupy different phases by design; cross-role comparisons stay visible as context but must not steer timing corrections.

**Why:** Matching unlike attacks can erase intentional syncopation and make a mathematically confident but musically wrong alignment.

**How to apply:** Keep role identity attached to measured events through mashup and live-swap planning. Require consistent, bounded same-role evidence, preserve vocal phrasing, and never describe onset similarity as proof of mix quality.

A verified active drum donor may still define the shared tempo and bar clock for the whole live mix. Rebase other layers' measured beat/section timing into that clock after their own tempo stretch, while retaining each role's expressive phase. This is a common clock, not cross-role onset matching.

**Why:** Bass and vocal placement must respond to the rhythm the listener currently hears, not a stale clock from the untouched source, without forcing every attack onto the drum transient.

**How to apply:** Keep tempo-master authority separate from role-specific phase corrections. Use the active drum grid for live entry/section mapping only when its timing evidence is reliable; keep same-role onset analysis scoped to that role and leave placement unchanged when evidence is missing or incompatible.

For automated activity gates, do not treat `AudioParam.value` as the effective gain after scheduling automation; it may remain at its intrinsic value while a ramp is active. Track the commanded target separately, and verify the signal downstream of the gate.

**Why:** Reading the stale value made a real browser gate mute correctly but skip reopening on later activity, while unit mocks concealed the behavior.

**How to apply:** When adding automated fades, ducks, or other conditional gain changes, test a close-and-reopen cycle with browser audio and measure output after the gate, not only the parameter value.
