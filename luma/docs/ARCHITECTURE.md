# LUMA Architecture & Key Decisions

This document records the important architectural decisions for the V1
prototype so future work (especially a more advanced processing engine) can
build on a stable foundation.

## 1. Non-destructive editing is the core contract

An edit is **data, never pixels**. A rendered image is always a pure function of
`(SourceAsset, EditRecipe)`:

```
render(source, recipe, preset) -> pixels
```

- The original photo URI is never modified. Saving writes a **new** file.
- The `EditRecipe` (`src/engine/types.ts`) is a small, serialisable object:
  `{ presetId, presetIntensity, adjustments, crop, advanced? }`.
- History (undo/redo) snapshots the recipe + canvas, not images.

This makes editing reliable, cheap to persist, and trivial to unit-test.

## 2. The processing engine is isolated behind an interface

`ProcessingEngine` (`src/engine/ProcessingEngine.ts`) is the single boundary the
whole app talks to for image processing. V1 ships `SkiaProcessingEngine`
(React Native Skia, MIT). A future native **Core Image / Metal / MPS** backend
can be dropped in by implementing the same interface and returning it from
`getEngine()` — **no UI, preset, or data-model code changes.**

The engine layer is deliberately split:

- **Pure math** (`colorPipeline.ts`, `adjustments.ts`): maps normalised
  adjustments to a Skia-compatible 4×5 color matrix + shader uniforms. No native
  imports, so it runs in Node unit tests and produces identical results on device.
- **Native rendering** (`SkiaProcessingEngine.ts`, `PhotoRenderer.tsx`): consumes
  that math. Native modules are `require()`d lazily so the math stays testable.

### Why a color matrix + overlay shaders (not a bespoke GPU engine)?

The brief explicitly says: do **not** build a custom GPU engine in V1. A 4×5
color matrix covers exposure, contrast, white balance, saturation, and tonal
lift on the GPU essentially for free. Grain and vignette — which a matrix cannot
express — are layered as a noise runtime shader + a radial-gradient overlay.
This is fast, predictable, and good enough to produce genuinely nice looks,
while leaving richer effects (curves, HSL, halation, chromatic aberration,
masks) to the future engine. The data model already reserves space for them
(`AdvancedEffects`).

## 3. Preview vs. export

- **Preview** (`PhotoRenderer`) renders on-screen via Skia at view resolution.
- **Export** (`SkiaProcessingEngine.exportImage`) renders to an offscreen Skia
  surface at export resolution and writes a JPEG/PNG file.

Both consume the **same** pure math, so what you see is what you export.

## 4. Presets are editable recipes, not baked filters

`Preset` = a partial `Adjustments` recipe + a default intensity + metadata.
Intensity blends the recipe toward neutral, so any preset is smoothly dialable.
Presets can be duplicated into editable user copies, reset, serialised, and
(future) user-created. Built-ins live in code; user presets persist locally.

The composition rule (heavily tested) is:

```
effective = clamp( preset.adjustments * intensity + manualOffsets )
```

Manual offsets are **independent** of the preset, so changing intensity never
destroys a user's manual tweaks.

## 5. State & persistence

- `zustand` holds the in-memory editing session (`editorStore`) and settings.
- Undo/redo is a generic, immutable, bounded history (`engine/history.ts`).
- Live drags call `preview*` (no history) and commit **once** on release, so a
  whole slider drag collapses to a single, meaningful undo step.
- Persistence is behind a `KVStore` interface (AsyncStorage on device,
  in-memory in tests). Projects, user presets, and settings are separate
  documents. Images are referenced by URI, never inlined.

## 6. Navigation

Expo Router, file-based. Four primary tabs — **Camera · Edit · Create ·
Settings** — with Camera as the index route so it is always one tap away. The
editor is a full-screen route pushed over the tabs; licenses/privacy are modals.

## 7. Performance principles applied in V1

- Pure math is memoised; matrix/uniform recompute is negligible.
- GPU rendering via Skia keeps slider drags smooth.
- Live drags avoid history churn (single commit on release).
- Export runs off the preview path at full quality.

### Known performance follow-ups
- Reduced-resolution preview for very large source images (decode a downscaled
  proxy for the on-screen canvas; export still uses full res).
- Debounced/cached preset-thumbnail rendering in the carousel.
