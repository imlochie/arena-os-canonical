# LUMA

A camera-first, creative photography app for iPhone — built with Expo, React
Native, and TypeScript. LUMA is designed around one idea: **"make this photo
look good"** should be effortless, with advanced controls tucked underneath.

> **Status:** V1 prototype. Genuinely usable to take and edit real photos on an
> iPhone. **Not** production-ready — see [Known limitations](#known-limitations).
>
> LUMA is an independently implemented app inspired by the *strengths* of several
> photo apps (fast aesthetic cameras, creative editing, approachable interaction).
> No proprietary code, assets, branding, or UI from any commercial app are used,
> and its presets do not claim to reproduce any other app's processing.

---

## The vertical slice

The first-milestone flow works end to end:

```
Open app → Pick a camera → Choose a look → Take photo → Edit intensity → Before/After → Save photo
```

## Product framing: cameras, not filters

LUMA is organised around **five cameras, five looks** — you pick the *camera*
that fits the moment, not a filter from a drawer:

| # | Camera | Mood | Underlying family |
|---|--------|------|-------------------|
| 01 | **DigiCam** | Punchy point & shoot | Digital |
| 02 | **Clean** | Soft & true to life | Clean |
| 03 | **FilmBox** | Analog & faded | Film |
| 04 | **Mono** | Timeless monochrome | Black & White |
| 05 | **Nox** | After dark | Night |

This is **presentation only** (`src/cameras/catalog.ts`). Internally every look
is still a `Preset` recipe fed through the `ProcessingEngine`; a camera just
groups a family's looks and adds identity + a viewfinder hint. The engine,
recipes, projects, and persistence are unchanged — so the reframe adds zero risk
to the core.

> **Getting it on your iPhone:** see [`docs/DEVICE_BUILD.md`](./docs/DEVICE_BUILD.md).

## 1. Repository structure

```
luma/
├── app/                       # Expo Router routes (file-based navigation)
│   ├── _layout.tsx            # Root stack: gesture root, safe area, dark status bar
│   ├── (tabs)/
│   │   ├── _layout.tsx        # Bottom tabs (custom TabBar)
│   │   ├── index.tsx          # CAMERA (default landing screen)
│   │   ├── edit.tsx           # EDIT (import + recent projects)
│   │   ├── create.tsx         # CREATE (creative layers)
│   │   └── settings.tsx       # SETTINGS
│   ├── editor.tsx             # Full-screen non-destructive editor (modal route)
│   ├── licenses.tsx           # Open-source licenses
│   └── privacy.tsx            # Privacy statement
├── src/
│   ├── cameras/               # Camera catalog (product framing over presets)
│   ├── engine/                # Image engine (isolated behind an interface)
│   │   ├── types.ts           # Core data model: Adjustments, Preset, EditRecipe, Layer, Project
│   │   ├── adjustments.ts     # Pure composition math (preset × intensity + offsets)
│   │   ├── colorPipeline.ts   # Pure color math -> Skia 4×5 color matrix + uniforms
│   │   ├── shaders.ts         # SkSL grain / character shaders
│   │   ├── history.ts         # Generic undo/redo
│   │   ├── layers.ts          # Creative layer stack operations
│   │   ├── ProcessingEngine.ts# The swappable engine interface
│   │   ├── SkiaProcessingEngine.ts # V1 backend (Skia) + high-quality export
│   │   └── index.ts           # getEngine()/setEngine() + re-exports
│   ├── presets/               # Preset library (original recipes) + serialization
│   ├── storage/               # KV store + project/preset/settings repositories
│   ├── state/                 # zustand stores (editor session, settings)
│   ├── ui/                    # Components, hooks (import/export/presets), haptics
│   ├── theme/                 # Design tokens (dark-first, photographic)
│   └── data/                  # In-app license list
├── assets/                    # Icon, splash, adaptive icon
├── docs/ARCHITECTURE.md       # Key decisions (read this!)
├── docs/DEVICE_BUILD.md       # Get LUMA onto your iPhone (EAS, no Mac)
├── THIRD_PARTY_LICENSES.md    # Authoritative license record
├── app.json                   # Expo config + iOS permissions
├── eas.json                   # EAS Build profiles
└── package.json
```

## 2. Dependencies and licenses

All runtime dependencies are permissive (MIT / BSD / Apache-2.0). No GPL/AGPL.
Full table: [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) (mirrored
in-app under **Settings → Open-source licenses**).

Highlights, chosen for **Expo SDK 57** compatibility (verified against the SDK's
bundled native-module versions before installing):

- **Expo SDK 57** / **React Native 0.86** / **React 19** — app runtime
- **Expo Router** — navigation
- **expo-camera / expo-image-picker / expo-media-library** — capture, import, save
- **@shopify/react-native-skia** — GPU preview + export (isolated, replaceable)
- **react-native-reanimated + gesture-handler + worklets** — responsive, tactile UI
- **zustand** — state; **AsyncStorage** — local persistence

## 3. Implemented features

**Camera (V2 — swipeable cameras)**
- A snap-scrolling **five-camera selector** (number · name · mood); the chosen
  camera gives the viewfinder an identity (tint + vignette hint)
- Per-camera **look** sub-selector (the family's looks)
- Rear/front switch, flash (off/auto/on), large tactile shutter
- Recent-photo / import shortcut; capture hands straight off to the editor with
  the chosen look preselected
- Permissions requested on demand, with a graceful denied state

**Edit (non-destructive)**
- Preset application + adjustable **intensity**
- Manual adjustments: exposure, contrast, highlights, shadows, temperature,
  tint, saturation, sharpness, grain, vignette, fade
- **Press-and-hold before/after** comparison
- Undo / redo / reset
- High-quality **export**: save to Photos (new file) or share

**Preset system**
- Original recipe library across Digital, Clean, Film, Black & White, Night
- Presets are **editable parameter recipes** (not baked filters), with
  intensity, duplication, reset, and serialization (foundation for user presets)

**Create (lightweight compositor)**
- Text, shape, and sticker layers over the edited photo
- Direct-manipulation drag / pinch-scale / rotate; per-layer opacity, visibility,
  ordering, delete

**Settings**
- Image quality, save behavior, haptics, appearance (dark), reset presets,
  privacy info, app version, licenses — **no accounts, no cloud, no analytics**

**Engine**
- GPU color grading via a 4×5 color matrix + grain/vignette overlays
- Preview and export share the same pure math (WYSIWYG)
- Entire engine isolated behind `ProcessingEngine` for a future native backend

## 4. Known limitations

- **Live full-feed preview grading on the camera is not real.** The viewfinder
  is tinted/vignetted to *hint* at the selected camera's identity, but the feed
  is not truly graded in real time. True live preview needs a frame processor /
  native camera pipeline (the #1 next bottleneck). The real look is applied,
  non-destructively, the instant you capture and land in the editor.
- **Mono camera** can't desaturate the live RN feed without a frame processor, so
  its viewfinder shows a "MONO · applied on capture" note; the B&W look is real
  in the editor/export.
- **Highlights/shadows are matrix approximations**, not true tone-curve
  operations. Real curves/HSL/halation/etc. are reserved for the native engine;
  the data model (`AdvancedEffects`) already has slots for them.
- **Crop UI is not built yet** (the recipe carries a normalised crop; the
  interactive cropper is a follow-up).
- **Projects are not auto-saved** from the editor yet (the persistence layer and
  tests exist; wiring "save project" into the editor is a small follow-up).
- Export uses a JS base64 encoder for the Skia byte buffer; fine for typical
  photos, but a native file writer would be faster for very large images.
- Grain/vignette are good, tasteful approximations — **not** claimed to match any
  commercial app. Reference-image tuning is intended (see below).
- Runs on **device** (Skia/Reanimated/Camera are native); not meant for web.

## 5. iOS / EAS build instructions

No Mac required — EAS builds in the cloud.

```bash
cd luma
npm install

# One-time:
npm i -g eas-cli
eas login
eas build:configure         # links/creates the EAS project

# Development client (for fast iteration with native modules):
eas build --profile development --platform ios

# Internal preview build (installable .ipa via TestFlight/ad-hoc):
eas build --profile preview --platform ios

# Production:
eas build --profile production --platform ios
```

Then install on your iPhone (TestFlight or the EAS install link) and run:

```bash
npx expo start --dev-client   # if using the development build
```

Local checks (no device needed):

```bash
npm run typecheck   # tsc --noEmit  (clean)
npm run lint        # eslint        (clean)
npm test            # jest          (100 tests)
npx expo export --platform ios   # verifies the Metro bundle builds
```

> Note: `app.json` sets the bundle identifier to `com.luma.app`. Change it (and
> the `name`/`slug`) if you register your own bundle id in Apple Developer.

## 6. Next technical bottlenecks

1. **Live camera preview grading.** The biggest UX unlock. Needs a native frame
   processor (or a native Core Image camera pipeline) to apply the look to the
   live viewfinder. This is exactly why processing is isolated behind
   `ProcessingEngine`.
2. **Native Core Image / Metal engine.** Real tone curves, per-channel curves,
   HSL, halation, chromatic aberration, masks — implement `ProcessingEngine`
   natively and swap it in `getEngine()`.
3. **Reduced-resolution preview proxy** for very large images to keep drags
   buttery, with full-res export unchanged.
4. **Interactive crop/rotate** UI bound to the existing `Crop` recipe field.
5. **Project auto-save & thumbnails** wired into the editor lifecycle.
6. **Reference-image tuning harness** (below).

## 7. Reference testing (for tuning, later)

The app is structured so reference photographs can be pushed through multiple
preset versions and compared (original vs. a reference result vs. ours) to tune
recipes. The engine's pure math is deterministic and already has a small
deterministic pixel-fixture test (`src/engine/__tests__/engine.test.ts`). We do
**not** scrape or circumvent any commercial app; comparisons are done manually
with images you provide. Visual equivalence is never claimed without
reference-image testing.

## 8. Design language

Dark-first, photographic, minimal, tactile, slightly cinematic. A single warm
amber accent; native iOS conventions where they help. See `src/theme/tokens.ts`.

---

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the key decisions and
the rationale behind the engine boundary.
