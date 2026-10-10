# The 13-Tools Map — deep dive, comparison, and integration plan

Mandate: take the 13 AI tools worth using today, find their open-source
counterparts, compare feature-by-feature with Arena OS, and spread as much as
possible across the app — personal project, no commercial restraints, brick
walls to be scaled, walked around, or smashed.

**What shipped in Wave 1 (this commit): the Creative Suite** (`/creative`, a
Rooms + launcher surface): research with citations, decks from a prompt,
podcasts from any text, voice TTS, captions. Plus the environment
self-healing (`scripts/environment-restore.mjs`).

## The map

| # | Tool | What it does | Open-source counterparts (studied) | Arena OS status | Plan |
|---|------|--------------|-------------------------------------|-----------------|------|
| 1 | ChatGPT | everyday chat | Open WebUI, LibreChat | **Have** — chat + battles + council + congress, Model Hub (local models, BYOK, keyless remote) | Done (Model Hub, `551cd76`→restored) |
| 2 | Claude | long docs, careful writing, code | same + big-context local models (Qwen 32B via Ollama) | **Have** — same surfaces; document-length contexts via hub models | Wave 3: file attachments in chat |
| 3 | Gemini photo-edit | edit photos by description | IOPaint (LaMa + instruct-pix2pix, Apache-2.0), ComfyUI + Qwen-Image-Edit | **Partial** — Studio already speaks ComfyUI (`comfyui.ts`), incl. workflow templates | Wave 2: "edit by instruction" Studio template + imgly browser bg-removal |
| 4 | Perplexity | research with sources | **Perplexica** (Apache-2.0): SearXNG metasearch → embed rerank → LLM w/ citations; focus modes | **Shipped (Wave 1)** — `/api/creative/research`: local sources (chats + archive, offline-real) + optional SearXNG (`RESEARCH_SEARXNG_URL`), numbered citations, honest "unverified" marking | Wave 2: embed rerank + focus modes; chat "Research" toggle |
| 5 | NotebookLM | PDFs → podcast/study guide | **podcastfy** (Apache-2.0), open-notebooklm (Llama+MeloTTS) | **Shipped (Wave 1)** — `/api/creative/podcast`: two-host script (any model incl. Local Engine) + real audio via voice tiers | Wave 2: point at archive items/waveyard notes directly |
| 6 | Gamma | deck from one prompt | **Presenton** (Apache-2.0): prompt/doc → deck, HTML/Tailwind themes, PPTX+PDF export, MCP server | **Shipped (Wave 1)** — `/api/creative/slides`: prompt → deck (any model), self-contained HTML deck, **real .pptx** (pptxgenjs, offline) | Wave 2: themes, doc-ingestion, PDF export |
| 7 | Canva | designs, bg removal | Penpot (design), **rembg/IOPaint RemoveBG**, @imgly/background-removal (browser ONNX) | Wave 1 attempted imgly — its onnxruntime-node postinstall fetches from nuget (blocked here; owner-side fine). | Wave 2: Studio ComfyUI RMBG workflow + imgly client |
| 8 | Midjourney | artistic images | ComfyUI/SD.Next/Fooocus; **already wired** via Studio (demo engine offline, ComfyUI/WanGP live) | **Have** — Studio image jobs | Wave 2: prompt-enhancer preset |
| 9 | Flow (Veo) | video clips with sound | **Wan 2.1/2.2** (Apache-2.0), HunyuanVideo, LTX-Video — Studio already runs WanGP (`wangp.ts`) + ComfyUI native | **Have** — Studio video jobs | Wave 2: foley/music bed from Waveyard on the timeline (Cut Lab) |
| 10 | KlingAI | cheaper quality video | same open models (that's the whole point — free-local) | **Have** — same | — |
| 11 | ElevenLabs | voices, dubbing, cloning | **msedge-tts** (free Edge voices), Piper/Kokoro (local), Coqui XTTS (cloning), OS voices (say/SAPI/espeak) | **Shipped (Wave 1)** — `src/lib/creative/voice.ts`: ElevenLabs BYOK → Edge (free) → OS voices, honest per-tier status; podcast synthesis uses it | Wave 2: dubbing pipeline (transcribe → translate → TTS); voice cloning owner-side (XTTS) |
| 12 | Suno | full songs with vocals | **ACE-Step** (Apache-2.0, 8GB VRAM, vocals, ~4min), **YuE** (7B, 16GB+, strongest vocals), DiffRhythm, MusicGen (instrumental) | **Partial** — Waveyard does stems/mashups; generation is the missing half of "mashups + extension" | Wave 2: ACE-Step/YuE as Studio backends (ComfyUI nodes exist); lyric sheet input |
| 13 | CapCut | Shorts editing, auto captions | **faster-whisper**/whisper.cpp, auto-editor, ffmpeg (core of Waveyard) | **Shipped (Wave 1)** — `/api/creative/captions`: transcript→timed SRT/VTT (offline-real); audio→text via Groq/OpenAI whisper BYOK (request shape unit-tested; owner-side network) | Wave 2: burn-in + Cut Lab timeline integration |

## Wave 3 additions (shipped)

- **Shorts (CapCut, #13)**: `POST /api/creative/shorts` — audio + text/SRT →
  real MP4 with waveform + burned-in subtitles (ffmpeg, offline-real,
  110KB proof artifact verified `ftyp`).
- **Dubbing (ElevenLabs, #11)**: transcribe (Groq/OpenAI BYOK) → translate
  (any model) → speak (voice tiers) with per-stage honest status.
- **Background removal (Canva, #7)** + **face swap (aifaceswap.io)** +
  **songs with vocals (Suno, #12)**: three new ComfyUI Studio templates
  (RMBG / ReActor / ACE-Step) — owner-side GPU, never faked.
- **Personal ingest**: `POST /api/library/ingest` (yt-dlp) → real library
  intake; honest 503 when the binary is absent.

## Brick walls, revisited (personal-use rules)

- **ChatGPT subscription ≠ API** — already answered honestly with OpenAI BYOK (Model Hub).
- **YouTube/Spotify ingestion** — previously off-limits for commercial caution; for a personal app, `yt-dlp` (owner-side binary) becomes the ingestion path for Waveyard sources. Plan: Wave 3 "Personal Ingest" (subprocess, honest "yt-dlp not installed" state). Spotify remains read-only metadata via official API only.
- **Model weights blocked in sandbox** — nuget/HF/ollama-registry unreachable here. All pipelines are owner-side-verifiable by design; sandbox proofs use labeled test-doubles and honest-unavailable states (evidence rules unchanged).
- **Voice cloning** — legal gray zone publicly; personally usable. Wave 2+, clearly labeled, never default.

## Where things live

- `src/lib/creative/{voice,podcast,slides,research,captions}.ts` + `creative.test.ts`
- `src/app/api/creative/{voice,podcast,slides,research,captions}/route.ts`
- `src/app/creative/page.tsx` (Rooms: "Creative Suite", launcher keyword-searchable)
- Cross-links: Studio (video/image), Waveyard (music/stems), Model Hub (brains), Cut Lab (timeline — captions burn-in Wave 2)

## Honesty ledger (Wave 1 proofs, run live)

- Deck → **real 92KB .pptx** (PK/ZIP magic verified), HTML deck, offline engine labeled.
- Research → real local-source grounding (seeded chat message found + cited), honest note when no sources.
- Podcast → script + synthesis attempted through all 3 voice tiers; sandbox failure message lists each tier's exact reason (no key / TLS blocked / no espeak). Never faked audio.
- Captions → timed SRT/VTT from plain text (round-trip unit-tested); transcription request shape verified against injected fetch.
- Battery: see commit message (full run before commit).
