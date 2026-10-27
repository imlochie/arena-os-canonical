# Waveyard P4 — Stem2 Integration Plan

Written **before** implementation (P4 mandate, step 2). Continues from `49a3472`
(P3 session engine) on `arena/01a10c30-arena-os-canonical`.

Product rule: Stem2 becomes a **real hardware surface** for Waveyard. No fake
device controls, no simulated connection states, no pretend Bluetooth APIs, no
UI that claims control Waveyard has not actually established. P4 is additive —
the P2/P3 audio engine (`useStemTransport`, `TrackPlayer`, `SessionExperience`,
session logic) is consumed, never rewritten.

---

## 1. What Stem2 actually is (researched, public sources)

From the STEM.FM help center FAQ (`help.stem.fm/articles/stem2-faqs`) and the
product page (`stem.fm/stem2`), read 2026-10-08:

- **Stem2 is a Bluetooth speaker.** It pairs like any Bluetooth audio device
  and, per the product page, plays "the full mix from any audio app you send
  over Bluetooth" — no account needed. The device's own stem keys act on
  STEM.FM catalogue music and user-uploaded stems, **not** on arbitrary
  Bluetooth audio.
- **Physical playback controls exist on the device**: tap = play/pause,
  forward/back buttons = skip (hold = seek during local playback). Over
  Bluetooth these behave like standard media controls.
- **USB-C is charging, powering accessories, and *future* data/audio output** —
  not a current control interface.
- **MIDI controller support is listed as "planned"** — not shipped.
- **stem.fm/setup** ("mirror audio and controls", Mac/Windows/Linux/Android,
  "a Chromium-based browser such as Chrome is required"; iOS needs the native
  app) is STEM.FM's own web-app mechanism. The platform list plus the
  Chromium-only requirement is consistent with Web Bluetooth (GATT), but **no
  service or characteristic documentation is public**. That mechanism is
  theirs; we do not reimplement it and we do not guess the protocol.
- Battery/firmware/Wi-Fi management exists **inside their app**, not via any
  public interface available to another application.
- Local playback from 64 GB internal storage, STEM-button processing, and
  account-linked syncing are STEM.FM-service features, not interfaces we can
  drive.

**Conclusion:** the one interface Stem2 genuinely exposes to *any* audio app
today is **Bluetooth audio output** (OS-level, A2DP) plus, in all likelihood,
**standard Bluetooth media commands** from its playback buttons (AVRCP-style).
Everything deeper is undocumented or unshipped.

## 2. What this application environment can actually do

Waveyard's desktop app runs Electron **44.5.1** (Chromium ~136). Verified
against the runtime and the repo's TypeScript 5.9 `lib.dom`:

| Capability | Availability | Notes |
|---|---|---|
| `navigator.mediaDevices.enumerateDevices()` | ✅ present | Lists `audiooutput` endpoints (OS Bluetooth/USB devices appear once paired at OS level). Labels can be empty without media permission — handled honestly in UI. |
| `navigator.mediaDevices` `devicechange` event | ✅ present | Real connect/disconnect observation for endpoints. |
| `AudioContext.setSinkId()` | ✅ present in Chromium ≥110 (not in TS `lib.dom`) | **The** real routing primitive: routes an entire Web Audio graph to a chosen output device. Feature-detected at runtime with a local interface; absence degrades honestly. |
| `HTMLMediaElement.setSinkId()` | ⚠️ not usable here | Waveyard's audio elements feed `MediaElementAudioSourceNode`s; output then flows through the `AudioContext`, so the context is the routing point. |
| `navigator.mediaSession` + `MediaMetadata` | ✅ present | Standard **receive** path for OS/hardware media keys (play/pause/next/previous, now-playing metadata). Whether Stem2's buttons emit these commands requires on-device verification — we wire the standard path and say exactly that. |
| Web Bluetooth (`navigator.bluetooth`) | ❌ not implemented by us | API exists in Chromium, but requires documented GATT services. Stem2's are undocumented; Electron also needs `select-bluetooth-device` wiring. Mandate: no undocumented protocols. |
| Web MIDI | ❌ not implemented by us | Stem2 MIDI is "planned", i.e. no device-side interface exists today. |
| Battery / firmware / Wi-Fi status | ❌ no web API | Never displayed (no fake values). |

## 3. Capability matrix (adapter truth, v1)

States are exactly the mandated set — no richer state is invented:

`AVAILABLE | CONNECTED | AUDIO_ONLY | CONTROL_UNAVAILABLE | UNSUPPORTED | REQUIRES_DEVICE_CONNECTION | ERROR`

| Capability | v1 state | Grounding |
|---|---|---|
| **Audio output routing** (Waveyard → device) | `AVAILABLE` (routable endpoints exist) → **`AUDIO_ONLY`** once routed | Real: endpoint listed by the OS + `AudioContext.setSinkId` resolved. Audio demonstrably leaves through the selected endpoint. **No control is claimed alongside it.** |
| **Hardware play/pause/skip** (device → Waveyard) | `AVAILABLE` — standard `mediaSession` path wired; **hardware emission unverified** | Real code path (Chromium media keys → action handlers). Labeled "requires on-device verification" until a real Stem2 confirms it. |
| **Connection observation** | `AVAILABLE` / `REQUIRES_DEVICE_CONNECTION` | We observe *endpoint presence* (enumerate + devicechange). A Bluetooth **name is not a connection claim**. |
| Programmatic output selection | `CONTROL_UNAVAILABLE` if `setSinkId` is missing | Endpoints visible, app cannot pick — audio follows the OS default; the UI says so and points to OS settings. |
| Stem mute/solo/intensity (Waveyard → device) | `UNSUPPORTED` | No public control API. The device's stem keys act on STEM.FM content, not on Bluetooth audio. Stem mixes stay authoritative **in Waveyard** (and that is what the user hears). |
| Device (hardware) volume | `UNSUPPORTED` | No web API for remote speaker volume. Waveyard's master gain is app-side and is never labeled "Stem2 volume". |
| Battery / firmware / Wi-Fi | `UNSUPPORTED` | No interface. Never shown, never faked. |
| Session/track sync with device | `UNSUPPORTED` | No documented protocol. The P3 session engine stays authoritative. |
| `CONNECTED` | reserved | Only claimable when a control path is **demonstrably verified on hardware**. Not claimable in v1. |

Detection honesty: an endpoint whose label matches "Stem 2" is tagged
**"name match"** — a heuristic hint for the user, never a connection claim.
The user explicitly designates which output is their Stem2.

## 4. Architecture

```
src/lib/waveyard/stem2/
  types.ts          capability states, endpoint + runtime-state types, adapter surface
  capability.ts     PURE: environment facts → capability matrix, name heuristic,
                    output-state resolution (fully node-testable)
  routing.ts        Stem2RoutingController: audio-output routing (client-only),
                    context registry + devicechange monitoring + persistence
  media-session.ts  PURE binding: metadata + hardware media-key handlers
  index.ts          the only import surface for the rest of Waveyard
```

The rest of Waveyard talks to Stem2 **only** through this boundary
(`useStem2Output()` hook + `Stem2Panel`). No Stem2 assumptions spread into
`TrackPlayer`/`SessionExperience` beyond mounting the panel and (additively)
the media-key hook.

### Routing the existing graph without touching the engine

`useStemTransport` (and `useArrangementPreview` in the Studio) create their
`AudioContext` internally and are off-limits. Routing decision:

- **Chosen: constructor-level registration.** `installRoutedAudioContext()`
  (idempotent, browser-only) swaps `window.AudioContext` for a subclass that
  registers every context the app creates with the routing service. When a
  route is active, the service calls `setSinkId(deviceId)` on each live
  context; when none is active, **nothing is called and behavior is
  bit-for-bit the stock engine**. Cleanup on `close()`.
- Rejected: modifying `useStemTransport` (forbidden); `element.setSinkId`
  (elements feed `MediaElementAudioSourceNode`s — the context is the output);
  prop-drilling a sink into the transport (no such API; would be an engine
  change).

Because routing acts on the *existing* graphs, the P2 player and the P3
session engine (including crossfades, kept stems, swaps) simply come out of
the chosen output. **There is no second playback engine and no audio
duplication.** Covering Studio contexts too is deliberate: the device is
Waveyard's physical output, app-wide.

### Session integration (step 7)

- The session engine remains authoritative for playback, mixes, transitions.
- Output changes never touch session state; sinks are per-context output
  settings inside the audio graph.
- Device disappearance: Chromium moves audio to the system default
  automatically; the service reports `REQUIRES_DEVICE_CONNECTION` and
  **re-applies the route when the endpoint reappears** (`devicechange`).
- Persistence of the preferred output is **machine-local
  (`localStorage`, mirroring the `arena-handoff-drafts` pattern)**, not in the
  database: Chromium `deviceId`s are per-install values, not account/session
  semantics. Restore prefers the exact id, falls back to a label match, else
  reports `REQUIRES_DEVICE_CONNECTION`. Nothing Stem2-specific is added to the
  session data model (mandate: "only where necessary" — it is not).

### UX (step 8)

A compact **Stem2 panel** inside the player and session surfaces (not a
settings page): current route status + reason, real output picker (default or
any enumerated endpoint), name-match hints, and the honest capability list.
The flow stays: library → player → session → Stem2 output. Hardware media keys
work in the standard OS way once audio plays.

## 5. Test strategy (step 9)

- `capability.test.ts` (pure): every state and transition of output-state
  resolution; name heuristic positives/negatives; capability matrix from
  environment facts (including missing `setSinkId`, missing enumeration,
  routing errors, device disappearance/reconnect).
- `routing.test.ts`: the controller driven by an **explicitly simulated**
  environment (fake `AudioContext` subclass, fake `mediaDevices`, fake
  storage — each labeled "simulated, unit test only"): route application to
  live contexts and to contexts created after selection, devicechange
  disappearance → `REQUIRES_DEVICE_CONNECTION`, reappearance → automatic
  restore, persistence + restore (id / label fallback / neither), clear.
- `media-session.test.ts`: binding/unbinding, metadata, handler dispatch,
  release on unmount (fake `mediaSession`).
- No fake device is ever presented as hardware verification.
- Desktop e2e: the harness drives the packaged **server** over HTTP; it has
  no renderer audio stack and no Bluetooth hardware, so it can prove **no**
  Stem2 capability. We add no e2e theater. On-device verification checklist
  (below) is the user's Windows acceptance step for this phase.

## 6. Implement now vs. explicitly unavailable

**Now:** adapter boundary + capability truth; real output enumeration,
selection, routing, persistence, restore, re-route on reconnect; honest
connection reporting; standard media-key receive path; panel UI.

**Explicitly unavailable (shown as such):** any Waveyard→device control
(stem, volume, sync), battery/firmware/Wi-Fi, `CONNECTED` claims, GATT/MIDI.

**Future, without rework:** the adapter interface leaves room for a verified
control transport (documented GATT, shipped MIDI, or a vendor API) as an
optional module behind the same boundary; capability states extend, the
consuming surfaces don't change.

## 7. Windows physical acceptance procedure (P5, 18 steps)

Run on the real Windows machine against a real Stem2. Classify every step
**VERIFIED / PARTIALLY VERIFIED / UNAVAILABLE / FAILED** with observed
evidence — never from documentation alone. Until this procedure is run,
the capability matrix reports media keys as `hardware-pending` and nothing
is marked VERIFIED.

| # | Step | Classification | Observed |
|---|---|---|---|
| 1 | Pair physical Stem2 with Windows (Bluetooth settings) | | |
| 2 | Start Waveyard (packaged app) | | |
| 3 | Play a real library track | | |
| 4 | Open the Stem2 panel (player or session) | | |
| 5 | Select the Stem2 audio output in the panel | | |
| 6 | Confirm music is physically audible from Stem2 | | |
| 7 | Move a Waveyard stem control (mute/solo/volume) | | |
| 8 | Confirm the resulting audio change is audible on Stem2 | | |
| 9 | Enter a Session | | |
| 10 | Perform a transition (crossfade) | | |
| 11 | Confirm the transition audio reaches Stem2 | | |
| 12 | Disconnect Stem2 (power off / Bluetooth off) | | |
| 13 | Confirm playback/session survives (system default) | | |
| 14 | Reconnect Stem2 | | |
| 15 | Confirm the route restores (panel → AUDIO_ONLY, audio returns) | | |
| 16 | Press physical Stem2 play/pause | | |
| 17 | Press physical Stem2 forward/back | | |
| 18 | Record exactly what happened (each command: acted / ignored / unknown) | | |

Notes for the run:

- Steps 5–8, 11, 15 verify the real `AudioContext.setSinkId` routing path.
- Steps 7–8 additionally prove stem mixes stay authoritative IN Waveyard
  (the device receives the resulting audio; no device-side stem control
  is claimed or expected).
- Steps 16–17 are the media-key verification: if the buttons emit standard
  media commands, Waveyard's `mediaSession` handlers respond; if not, the
  capability stays `AVAILABLE / hardware-pending` and honestly unclaimed.
- Steps 12–13 verify the mandated session-survives-disconnect behavior.
