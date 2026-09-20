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
Open app → Camera → Select preset → Take photo → Edit intensity → Before/After → Save photo
```

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

**Camera**
- Rear/front switch, flash (off/auto/on), large tactile shutter
- Tactile preset carousel with the selected look clearly badged
- Recent-photo / import shortcut; capture hands straight off to the editor
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

- **Live full-feed preview grading on the camera is not applied to the raw
  viewfinder.** The selected look is shown as a badge and applied instantly on
  capture. True live preview needs a frame processor / native camera pipeline
  (a deliberate future step — see next bottlenecks).
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
