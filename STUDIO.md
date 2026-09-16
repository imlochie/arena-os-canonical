# 🎬 Studio — multimodal generation (WanGP · ComfyUI · hosted · demo)

The Studio (`/studio`) adds **video, image and audio generation** to Arena OS with a
GPU-poor-first architecture: it drives the best available backend and never hard-fails.

| Backend | What it runs | Needs |
| --- | --- | --- |
| **WanGP (Wan2GP)** | Wan 2.1/2.2, LTX-2/2.3, HunyuanVideo 1/1.5, LongCat, Kandinsky 5, Qwen Image, Krea 2, Flux, Z-Image, Qwen3 TTS, ACE-Step, Stable Audio… | A CUDA GPU (6GB+ VRAM) anywhere on your LAN + the bridge |
| **ComfyUI** | Any ComfyUI workflow — Wan 2.1/2.2 native nodes, LTX-Video, or anything you export | A reachable ComfyUI server |
| **Hosted (BYOK)** | Wan 2.2 T2V Plus + Qwen-Image via Alibaba DashScope | DashScope API key (stored in your browser only) |
| **Demo** | Procedural previews (animated SVG / artwork / synthesized WAV) | Nothing — always works, fully local |

> **Attribution (required by the WanGP terms):** generation through the WanGP backend
> is powered by **WanGP (Wan2GP) by DeepBeepMeep** — https://github.com/deepbeepmeep/Wan2GP.
> This app discloses that clearly in the Studio UI and here in the docs.

---

## 1. WanGP backend (recommended)

WanGP is a one-stop generative app for the GPU poor. It ships an official in-process
Python API (`shared/api.py`) — the bridge in `bridges/wangp_bridge.py` wraps it as a
tiny JSON/HTTP service (stdlib only, no extra pip installs).

### Setup

1. **Install WanGP on the machine with the GPU** (see its
   [installation guide](https://github.com/deepbeepmeep/Wan2GP) — conda/venv, Pinokio,
   or the desktop launcher):

   ```bash
   git clone https://github.com/deepbeepmeep/Wan2GP.git
   cd Wan2GP
   conda create -n wan2gp python=3.11.14 && conda activate wan2gp
   pip install torch==2.10.0 torchvision==0.25.0 torchaudio==2.10.0 --index-url https://download.pytorch.org/whl/cu130
   pip install -r requirements.txt
   ```

2. **Run the bridge** from inside that environment (from the WanGP folder):

   ```bash
   python /path/to/arena-os-canonical/bridges/wangp_bridge.py --root . --port 7862
   # optional: --profile 4 --attention sdpa --output-dir /some/dir
   ```

   `--root` can also be provided via the `WANGP_ROOT` env var. The bridge binds to
   `127.0.0.1` by default; use `--host 0.0.0.0` only on a trusted LAN.

3. **Point Arena OS at it**: Studio → ⚙️ Backends → *WanGP bridge URL*
   (default `http://127.0.0.1:7862`). Server-side default can be set with the
   `WANGP_BRIDGE_URL` env var.

That's it. The Studio now lists your **live WanGP model catalog** (with local file
availability), submits jobs, streams progress/preview, and serves the generated files.

### How settings map

The Studio sends WanGP-shaped settings (`model_type`, `prompt`, `negative_prompt`,
`resolution`, `num_inference_steps`, `video_length`, `seed`, …). The **Advanced → raw
settings JSON** box is merged over them, so anything WanGP supports can be set.

**Power-user workflow:** in the WanGP web UI, configure a model and click
**Export Settings**, then paste that JSON into the Studio's Advanced box and edit the
prompt. (`video_length` accepts seconds like `"10s"` — WanGP converts it to frames.)

### Testing without a GPU

```bash
python bridges/wangp_bridge.py --mock
```

runs the bridge against a fake session — full HTTP contract, fake progress events and
mock outputs. Useful for developing against the WanGP path on any machine.

---

## 2. ComfyUI backend

Point the Studio at any ComfyUI server (⚙️ Backends → *ComfyUI URL*, default
`http://127.0.0.1:8188`, or the `COMFYUI_URL` env var).

- **Built-in templates**: Wan 2.1 Text-to-Video (1.3B) and Wan 2.1 Image-to-Video
  (14B 480p) using ComfyUI's native Wan nodes. They need the usual model files
  (`models/unet`, `models/vae`, `models/text_encoders`, `models/clip_vision`).
- **Custom workflows (recommended for anything serious)**: build a workflow in
  ComfyUI, **File → Export Workflow (API)**, paste the JSON into the Studio's
  workflow box, and add placeholder tokens:

  | Token | Replaced by |
  | --- | --- |
  | `{{PROMPT}}` / `{{NEGATIVE}}` | prompt / negative prompt |
  | `{{SEED}}` | seed (random or fixed) |
  | `{{WIDTH}}` / `{{HEIGHT}}` | resolution from the UI |
  | `{{LENGTH}}` / `{{FPS}}` | frame length / fps |
  | `{{STEPS}}` / `{{CFG}}` | steps / guidance |

  Example: `{"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{PROMPT}}", "clip": ["38", 0]}}}`

Progress is tracked through ComfyUI's `/queue` + `/history`; outputs are streamed from
`/view`. Cancellation deletes the job from the queue.

> Tip: WanGP also ships as **ComfyUI custom nodes** — you can use this backend with a
> ComfyUI install that has the WanGP nodes.

---

## 3. Hosted backend (BYOK, no GPU needed)

Optional cloud fallback using Alibaba Cloud Model Studio (DashScope):

- Video: `wan2.2-t2v-plus` (async task → `video_url`)
- Image: `qwen-image` (synchronous)

Add your API key in ⚙️ Backends (stored in **localStorage only**, sent per request,
never persisted server-side; region selectable intl / cn). Docs:
[DashScope video-generation API](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference).
This path is experimental and clearly badged in the UI — endpoints may change upstream.

---

## 4. Demo mode

When no backend is reachable the Studio still works end-to-end: jobs run a simulated
pipeline (load → encode → denoise → decode → save) and produce deterministic
**procedural previews** from the prompt + seed:

- video → animated SVG scene
- image → generative SVG artwork
- audio → synthesized WAV (chords + melody + kick)

Everything is local — zero network egress, matching the app's Local Mode philosophy.
Demo outputs are clearly labelled as *not* model generation.

---

## 5. Under the hood

```
Browser ── /api/studio/* (Next.js server) ──► WanGP bridge ──► WanGP shared/api.py ──► GPU
                                        ├──► ComfyUI HTTP API (/prompt /history /view)
                                        ├──► DashScope REST (BYOK, only when a key is set)
                                        └──► demo engine (procedural, in-process)
```

- **Jobs** are persisted in the `studio_jobs` Postgres table (auto-created; see
  `drizzle/0009_studio_jobs.sql`). If the DB is down, jobs fall back to an in-memory
  store so the Studio keeps working.
- **Media** is streamed through `/api/studio/jobs/{id}/media?f=…` with HTTP `Range`
  support, so `<video>` seeking works. Demo media is regenerated deterministically.
- **Privacy**: local backends never leave the machine. The hosted path is the only
  egress and is logged as a metadata-only privacy event (`studio.generate.egress`).
- **Artifacts**: any finished job can be saved to the artifact library
  (`sourceType: "studio"`) from the 📦 button.

### Files

| Path | Purpose |
| --- | --- |
| `bridges/wangp_bridge.py` | stdlib-only HTTP bridge over WanGP's official API (with `--mock`) |
| `src/lib/studio/types.ts` | shared types |
| `src/lib/studio/catalog.ts` | curated offline WanGP catalog + ComfyUI workflow templates |
| `src/lib/studio/wangp.ts` | bridge client |
| `src/lib/studio/comfyui.ts` | ComfyUI client (submit / poll / cancel / media + token substitution) |
| `src/lib/studio/hosted.ts` | DashScope BYOK client |
| `src/lib/studio/demo.ts` | procedural demo engine (SVG / WAV) |
| `src/lib/studio/jobs.ts` | orchestrator: submit, refresh, persist, media serving |
| `src/app/api/studio/*` | API routes |
| `src/components/StudioLab.tsx` | Studio UI |

## 6. Further resources

[`REFERENCES.md`](./REFERENCES.md) maps the whole open-source landscape around the
Studio — upstream model repos (Wan, LTX-2, HunyuanVideo, Qwen-Image, HiDream, Flux…),
audio/music engines, low-VRAM acceleration libraries, arena/ELO tooling, model hubs,
agent-skill patterns, and a licensing quick sheet for what can be used commercially.

Trim and export your generations in the **Cut Lab** (`/cut`) — a browser-native,
OpenCut-inspired editor. See [`CUT.md`](./CUT.md).
