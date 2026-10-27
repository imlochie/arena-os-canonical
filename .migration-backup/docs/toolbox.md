# The Toolbox — local conversion, no websites

Wave 6. The converter websites and HandBrake, replaced with a local tool that
runs entirely on this machine through the bundled ffmpeg. Nothing is ever
uploaded anywhere; the "cloud" in this pipeline is a folder on your disk.

## Where things live

```
src/lib/toolbox/convert.ts    engine: storage, probing, queue, progress, hardware detection
src/lib/toolbox/presets.ts    the preset ladder + ffmpeg arg maps
src/app/api/toolbox/route.ts  GET manifest / file download, POST upload|convert|delete
src/app/toolbox/page.tsx      the page (/toolbox, in nav under Create)
```

Scratch storage: `.arena-data/toolbox/in` (uploads, sha256-prefixed names) and
`.arena-data/toolbox/out` (outputs, UUID-prefixed). Both are pruned after 24
hours on every new job; deleting a job removes its files immediately.

## The honest speed story

This is a HandBrake replacement that is *faster where speed is actually
available*, and never lies about which engine it used:

- **Hardware encoders are probed for real** — one 1-frame lavfi encode per
  candidate (`videotoolbox` on macOS, `nvenc`/`amf`/`qsv` on Windows,
  `vaapi` on Linux when `/dev/dri/renderD128` exists), cached for the
  process. If none works, the answer is `null` and jobs say
  `software:libx264` on the tin.
- **Audio stream-copies when codecs already agree** (AAC in → AAC out is a
  copy, not a re-encode).
- **Presets only downscale** — a 720p source under "Fast 1080p" stays 720p;
  nothing is ever upscaled into bigger, worse files.
- **Remux presets are `-c copy`** — container changes in seconds, zero
  quality loss, the exact thing converter websites charge for.
- **CRF single-pass everywhere** — no pointless two-pass ABR.
- **Images run two-at-a-time**, video serially (one encode at a time is
  almost always faster than thrashing the same cores).

Every job records its engine (`hardware:h264_vaapi`, `software:libx264`,
`stream-copy`), real progress (parsed from `-progress pipe:1`, so the bar
reflects ffmpeg's own out_time), speed multiplier, and input→output sizes.

## The preset ladder

| Preset | Output | What it does |
| --- | --- | --- |
| Fast 1080p30 / 720p30 / 480p30 | mp4 | H.264 CRF 22/22/23, capped, no upscaling |
| HEVC 1080p30 | mp4 | H.265 CRF 26 (`hvc1` tag) — roughly half the size |
| WebM 1080p | webm | VP9 CRF 32 + Opus (the slow one, honestly labeled) |
| Remux MKV / MP4 | mkv/mp4 | `-c copy`, instant |
| Animated GIF | gif | 12fps, 480px, two-pass palette |
| MP3 (V0) / M4A (192k) / Opus (128k) / WAV | audio | extract-or-convert |
| JPEG q85 / WebP q82 / PNG | image | the image-converter jobs |

Plus a **Custom** job: width cap, fps cap, CRF — persisted with the job (the
first draft dropped custom params at execution; fixed and regression-tested),
with the output format whitelisted to mp4/mkv/webm.

## Guardrails

- Inputs must live in `.arena-data/toolbox/in` (realpath-checked); nothing
  outside it can be fed to ffmpeg through the API.
- 2 GB input cap, 16-job queue cap, 30-minute per-job timeout.
- Files ffmpeg can't read are rejected at upload with a clean 400 (and the
  bytes are deleted), never silently "converted".
- A job ffmpeg genuinely can't do (e.g. MP3 from a silent video) records the
  real ffmpeg error on the job.

## Tests (all real, zero mocks of our code)

- `src/lib/toolbox/toolbox.test.ts` — 13 tests: probe honesty, arg-map
  promises (downscale-only, copy-if-aac, remux `-c copy`, hardware
  labeling, custom clamping), path safety, and real end-to-end runs:
  4K→480p with re-probed output (height, duration, codec), MP3 extraction,
  MKV remux, GIF palette, PNG→WebP, WAV + Opus, the clean-reject path, the
  honest-failure path, and job deletion.
- `src/app/api/toolbox/routes.test.ts` — 7 tests: manifest, real multipart
  upload + probe, clean 400 for non-media, the full route flow (upload →
  convert → poll → download with content-type/length → clear), path-traversal
  rejection, bad preset/action rejection, custom-knob persistence.
