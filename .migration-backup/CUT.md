# ✂️ Cut Lab — browser-native video editor

OpenCut-inspired editing for your Studio generations — **100% in the browser, zero
dependencies, zero egress**: canvas compositor + Web Audio + MediaRecorder export.
Nothing is uploaded anywhere; exported files go straight to your downloads.

For the heavyweight experience (multi-track timelines, effects, keyframes, masks)
run [OpenCut](https://github.com/OpenCut-app/OpenCut) itself — see
[`REFERENCES.md §2b`](./REFERENCES.md). Cut Lab is the lightweight companion that's
always one click away from the Studio.

## Quick start

1. Generate something in the **Studio** (or skip to step 2 and use demo clips).
2. Open **✂️ Cut** (nav) — or press **✂️** on any finished Studio job to jump straight in.
3. Add clips: **From Studio** list, **📁 Upload** (video/image files), or **✨ Demo clip**
   (procedural — try the whole editor with zero assets).
   **🪄 Auto-montage Studio** builds a timeline from your latest generations.
4. Trim (in/out points), reorder (◀ ▶), duplicate, delete; set per-clip volume.
5. **▶ Preview** — the canvas plays through the whole timeline.
6. **⬇️ Export video** — renders in real time and downloads a `.webm`
   (or `.mp4` on Safari-only environments).

## Concepts

| Concept | Notes |
| --- | --- |
| **Project aspect** | 16:9 (1280×720) · 9:16 (720×1280) · 1:1 (960×960). Media is letterboxed into it. |
| **Clips** | `video` (mp4/webm from Studio or uploads — audio mixed on export), `image` (stills — Studio images, SVG demo outputs), `procedural` (seeded animated generator, no source). |
| **Trim** | In/out points into the source. Timeline length = Σ (out − in). |
| **Save / load** | Projects persist server-side in the `cut_projects` table (auto-created; in-memory fallback when the DB is down). |
| **Re-link** | Uploaded files live only in the browser session (`blob:` URLs). Saving marks them *unlinked*; reloading a project lets you re-link each one to a fresh file. Studio clips use durable same-origin URLs and survive reloads. |
| **Export** | Real-time capture: a 20s timeline takes ~20s. Keep the tab visible. Output stays on your machine. |

## Studio → Cut handoff

Finished Studio jobs (video/image) show a **✂️** button linking to
`/cut?import=<jobId>&f=<fileName>` — the Cut Lab fetches the job, adds the clip
(durations probed from real media), and titles the project after the model.
Audio-only generations aren't visual clips (yet).

## Under the hood

```
browser
 ├── renderFrame()        canvas compositor: video frames / images / procedural
 │                        (letterboxed, deterministic from clip seed)
 ├── driveMediaAt()       keeps the active <video> synced; pauses the rest
 ├── exportTimeline()     canvas.captureStream(30) + Web Audio mixdown
 │                        → MediaRecorder → webm (vp9/vp8, opus) / mp4 fallback
 └── /api/cut*            project CRUD (Postgres best-effort, memory fallback)
```

| Path | Purpose |
| --- | --- |
| `src/lib/cut/types.ts` | clip/project types + pure timeline math |
| `src/lib/cut/render.ts` | canvas renderer + media pool + playback sync |
| `src/lib/cut/exporter.ts` | MediaRecorder export (audio graph, progress, cancel) |
| `src/lib/cut/projects.ts` | server-side project persistence |
| `src/lib/cut/client.ts` | client-safe barrel |
| `src/app/api/cut/*` | routes: list/save/get/delete |
| `src/components/CutLab.tsx` | the editor UI |

### Upgrade paths

- **Faster-than-realtime / frame-accurate export**: [MediaBunny](https://github.com/Vanilagy/mediabunny)
  (WebCodecs, MIT, zero-dep) — render each frame deterministically and mux mp4/webm
  exactly like OpenCut does.
- **FFmpeg power tools**: [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) for
  transcode/complex filters (~30MB wasm, so it's deliberately not a dependency today).
- **Full editor**: run OpenCut next to this app and hand it files — its rewrite is
  building an Editor API, plugin system, MCP server and headless mode, which would
  make it a first-class Studio backend one day.
