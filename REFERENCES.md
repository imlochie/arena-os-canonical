# REFERENCES — open-source map for Arena OS

> Curated references and resources for anyone (or any **agent**) working on this project:
> coding agents extending the app, and the in-app cognitive agents (Council / Collab /
> Workforce) that can be fed sections of this file as working context.
>
> **How to use this file:** every section maps to a part of this app. Entries carry a
> license where it matters (this project is $0 / free-tier / open-first — licenses are
> decision-makers, not footnotes). Last audited: 2026-09-16.

Related docs: [`STUDIO.md`](./STUDIO.md) (multimodal Studio guide) · [`AGENTS.md`](./AGENTS.md)
(repo orientation for coding agents) · [`bridges/README.md`](./bridges/README.md) (WanGP bridge API).

---

## 1. The Wan + WanGP stack (Studio's primary backend)

The Studio's `wangp` backend wraps WanGP; the models underneath are Alibaba's Wan family.

| Resource | What it is | License | Why it matters here |
| --- | --- | --- | --- |
| [deepbeepmeep/Wan2GP](https://github.com/deepbeepmeep/Wan2GP) | "A fast AI Video Generator for the GPU Poor" — one-stop app for video/image/audio models on 6GB+ VRAM. Our `bridges/wangp_bridge.py` wraps its official `shared/api.py` | WanGP terms (free local use, attribution required) | The Studio's main engine. Its `docs/` (API.md, MODELS.md, CLI.md, DEEPY.md) is the canonical contract |
| [Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1) | Official Wan 2.1: T2V/I2V/FLF2V/T2I/V2A, 1.3B runs on ~8GB VRAM | Apache-2.0 | Reference implementation; ComfyUI native support; powers our ComfyUI t2v/i2v templates |
| [Wan-Video/Wan2.2](https://github.com/Wan-Video/Wan2.2) | Wan 2.2: MoE A14B + dense TI2V-5B (720p on consumer GPUs) | Apache-2.0 | Default video model in the Studio catalog (`t2v_2_2`, `i2v_2_2`, `ti2v_2_2`) |
| [Wan-Video/Wan-skills](https://github.com/Wan-Video/Wan-skills) | **AI Agent Skills for Wan** — installable skill packages that let an AI agent drive Wan AIGC capabilities via API calls (image gen/editing, PPTX generation) | Apache-2.0 | Perfect model for giving *our* in-app agents generation skills — a pattern to borrow for a future Studio skill/command integration |
| [Wan-Video/Wan-Animate-2](https://github.com/Wan-Video/Wan-Animate-2), [Wan-Video/Wan-Dancer](https://github.com/Wan-Video/Wan-Dancer) | Motion-transfer / dance specializations | Apache-2.0 | Upstream of WanGP's Animate modes |
| [deepbeepmeep/mmgp](https://github.com/deepbeepmeep/mmgp) | "Memory Management for the GPU Poor" — the library that lets big models run on small VRAM | MIT | The core trick behind WanGP's low-VRAM profiles (`--profile` flags we pass through the bridge) |
| [deepbeepmeep/LTX-Desktop-WanGP](https://github.com/deepbeepmeep/LTX-Desktop-WanGP) | Desktop app powered by WanGP, built on its API | — | Prior art: another third-party app integrating WanGP the same way we do |
| [deepbeepmeep/YuEGP](https://github.com/deepbeepmeep/YuEGP) | Song generator (lyrics + genre → full song) for the GPU poor, via mmgp | — | Same "GP" pattern; reference for audio model integration |
| Pinokio ([pinokio.co](https://pinokio.co) · [repo](https://github.com/pinokiocomputer/pinokio)) | One-click installer that runs WanGP and hundreds of local AI apps | MIT | Easiest way for users to get WanGP onto the GPU machine that runs our bridge |

## 2. Video generation landscape (what else could sit behind the Studio)

All reachable through WanGP or ComfyUI; listed for catalog curation and future backends.

| Resource | Notes | License |
| --- | --- | --- |
| [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) | Open-source audio+video model: weights, distilled variants, LoRAs/IC-LoRAs, modular trainer, RTX-optimized inference. WanGP's LTX-2.3 modes come from here | Open weights: free for non-commercial + small business; $10M+ revenue needs a commercial license |
| [Lightricks/ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | Official ComfyUI nodes for LTX-Video/LTX-2 | — |
| [Lightricks/LTX-Desktop](https://github.com/Lightricks/LTX-Desktop) | Open-source desktop app for LTX models | Apache-2.0 |
| [Tencent-Hunyuan/HunyuanVideo](https://github.com/Tencent-Hunyuan/HunyuanVideo) | HunyuanVideo 1/1.5 — strong open video family, also in WanGP | Tencent Community License (check terms) |
| [THUDM/CogVideo](https://github.com/THUDM/CogVideo) | CogVideoX family (T2V/I2V, image animation) | Apache-2.0 (code); weights restricted |
| [hpcaitech/Open-Sora](https://github.com/hpcaitech/Open-Sora) | Full training + inference pipelines (research-grade) | Apache-2.0 |
| [genmoai/models](https://github.com/genmoai/models) | Mochi 1 — high-quality open T2V | Apache-2.0 |
| [xdit-project/xDiT](https://github.com/xdit-project/xDiT) | Multi-GPU parallel inference for DiT video models (used by HunyuanVideo) | Apache-2.0 |
| [jianzhnie/awesome-text-to-video](https://github.com/jianzhnie/awesome-text-to-video) | Actively-maintained survey of the whole T2V landscape (Wan 2.2, HunyuanVideo 1.5, LTX-2.3, SkyReels, MAGI-1, …) | CC (awesome list) |
| [comfyanonymous/ComfyUI_examples](https://comfyanonymous.github.io/ComfyUI_examples/) + [comfy.org workflows](https://comfy.org/workflows) | Ready-made API-format workflows for Wan 2.1/2.2, VACE, FLF2V, LTX… — paste straight into our custom-workflow box | Docs |

## 3. Image generation

| Resource | Notes | License |
| --- | --- | --- |
| [QwenLM/Qwen-Image](https://github.com/QwenLM/Qwen-Image) | Qwen-Image / Edit Plus — strong open image+edit family (ranked the open #1 in 2026 surveys) | Apache-2.0 |
| [HiDream-ai/HiDream-I1](https://github.com/HiDream-ai/HiDream-I1) (+ [HiDream-O1-Image](https://github.com/HiDream-ai/HiDream-O1-Image)) | 17B sparse-MoE generator and unified O1 pixel-transformer (T2I + editing + personalization) | MIT |
| [black-forest-labs/flux](https://github.com/black-forest-labs/flux) | FLUX.1/FLUX.2 family — schnell/klein are permissive; dev carries commercial restrictions | Apache-2.0 (schnell/klein); dev restricted |
| ComfyUI ([repo](https://github.com/comfyanonymous/ComfyUI)) | Node-graph engine — our second Studio backend | GPL-3.0 |
| [lllyasviel/Fooocus](https://github.com/lllyasviel/Fooocus) · [stable-diffusion-webui-forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) · [AUTOMATIC1111/stable-diffusion-webui](https://github.com/AUTOMATIC1111/stable-diffusion-webui) · [InvokeAI/InvokeAI](https://github.com/InvokeAI/InvokeAI) | The other major local image UIs — useful for LoRA/workflow conventions and community model support | GPL-3.0 (Fooocus, A1111) · Apache-2.0 (InvokeAI core) |
| [huggingface/diffusers](https://github.com/huggingface/diffusers) | The canonical diffusion library everything above builds on | Apache-2.0 |

## 4. Audio — speech, music, sound

The Studio's audio tab targets WanGP audio models; these are the open ecosystem around them.

**TTS / voice**

| Resource | Notes | License |
| --- | --- | --- |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 82M param TTS — the efficiency king, CPU-friendly | Apache-2.0 |
| [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) | Zero-shot voice cloning + emotion control, top open quality | MIT |
| [rhasspy/piper](https://github.com/rhasspy/piper) → [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) | Edge/embedded TTS, 30+ languages. Original MIT repo archived; active fork is GPL-3.0 | MIT → GPL-3.0 (fork) |
| [suno-ai/bark](https://github.com/suno-ai/bark) | Generative audio w/ non-speech effects | MIT |
| [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) | Strong zero-shot cloning | Code MIT · weights CC-BY-NC-4.0 |
| [coqui-ai/TTS](https://github.com/coqui-ai/TTS) (XTTS-v2) | Classic voice cloning stack | CPML — non-commercial |
| IndexTTS-2 / Fish Speech | Expressive cloning (in WanGP) | Non-commercial without contact |

**Music / sound**

| Resource | Notes | License |
| --- | --- | --- |
| [ace-step/ACE-Step](https://github.com/ace-step/ACE-Step) | Full-song generation (vocals + BGM) from lyrics/style, <4GB VRAM — our `ace_step_v1_5_xl` catalog entry | Apache-2.0 |
| [ace-step/awesome-ace-step](https://github.com/ace-step/awesome-ace-step) | Curated map of the whole open music-gen landscape (with license table) | CC0 |
| [multimodal-art-projection/YuE](https://github.com/multimodal-art-projection/YuE) | Lyrics → full song, multilingual, voice cloning | Apache-2.0 |
| [facebookresearch/audiocraft](https://github.com/facebookresearch/audiocraft) | MusicGen et al. | MIT |
| [hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio) | Video-to-audio soundtracks (WanGP post-processing uses it) | MIT |
| [Stability-AI/stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) | Stable Audio 3 tooling | MIT (code) · weights restricted |
| [ASLP-lab/DiffRhythm](https://github.com/ASLP-lab/DiffRhythm) | Full-length songs in ~10s | Apache-2.0 |

## 5. Low-VRAM / GPU-poor tooling

The accelerators WanGP recommends/uses — relevant when tuning bridge `cli_args` (`--attention`, `--profile`).

| Resource | Notes | License |
| --- | --- | --- |
| [deepbeepmeep/mmgp](https://github.com/deepbeepmeep/mmgp) | Memory-management profiles for consumer GPUs | MIT |
| [thu-ml/SageAttention](https://github.com/thu-ml/SageAttention) | Quantized attention — ~30-40% faster video gen | MIT |
| [woct0rdho/SpargeAttn](https://github.com/woct0rdho/SpargeAttn) | Sparse attention for spatial upsampling | MIT |
| [nunchaku-tech/nunchaku](https://github.com/nunchaku-tech/nunchaku) | INT4/SVQuant inference — big VRAM savings | Apache-2.0 |
| [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | GGUF-quantized diffusion models in ComfyUI | — |
| [pytorch/ao](https://github.com/pytorch/ao) (TorchAO) + [TimDettmers/bitsandbytes](https://github.com/TimDettmers/bitsandbytes) | Quantization toolkits (int8/fp8/NF4) | BSD-3 · Apache-2.0 |
| RIFE ([hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE)) · [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | Temporal/spatial upsampling (WanGP Media Flow) | MIT · BSD-3 |
| [kijai/ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) | Wan node wrappers with VRAM knobs for ComfyUI | — |

## 6. Local & free LLM inference (the text Arena's engine room)

What the app's text arena (Pollinations default, BYOK boosts) can grow into.

| Resource | Notes | License |
| --- | --- | --- |
| [Pollinations](https://pollinations.ai) | Keyless free text+image API — this app's default provider | Free API |
| [ollama/ollama](https://github.com/ollama/ollama) | De-facto local runner, OpenAI-compatible server | MIT |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | The engine under everything; `llama-server` speaks OpenAI API | MIT |
| [vllm-project/vllm](https://github.com/vllm-project/vllm) | High-throughput serving for bigger boxes | Apache-2.0 |
| [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) | In-browser LLM — **already a dependency of this app** (`src/lib/webllm.ts`) | Apache-2.0 |
| [ml-explore/mlx](https://github.com/ml-explore/mlx) | Apple-Silicon-native inference | MIT |
| [janhq/jan](https://github.com/janhq/jan) · [open-webui/open-webui](https://github.com/open-webui/open-webui) · [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) · [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | Local-first chat UIs — feature inspiration for Chat/Assistants pages | AGPL-3.0 · custom BSD (branding clause) · MIT · MIT |
| [mostlygeek/llama-swap](https://github.com/mostlygeek/llama-swap) | Hot-swap models behind one OpenAI-compatible endpoint | MIT |
| [OpenRouter](https://openrouter.ai) · [Groq](https://console.groq.com) | Free-tier aggregate APIs this app already supports via BYOK | Free tiers |

## 7. Arena, evals & rating math (the app's core concept)

| Resource | Notes | License |
| --- | --- | --- |
| [lm-sys/FastChat](https://github.com/lm-sys/FastChat) | The OG Chatbot Arena codebase: battle UI, multi-model serving, OpenAI-compatible APIs, MT-bench + LLM-as-judge (`fastchat/llm_judge`) | Apache-2.0 |
| LMArena methodology ([overview](https://www.emergentmind.com/topics/chatbot-arena)) | Pairwise blind battles → **Bradley-Terry** ratings with confidence intervals, bootstrap, active sampling — the stats our `src/lib/elo.ts` simplifies | Docs |
| [vivekjoshy/openskill.py](https://github.com/vivekjoshy/openskill.py) ([docs](https://openskill.me)) | Patent-free TrueSkill-style ratings w/ uncertainty — the natural upgrade path from point-Elo | MIT |
| [Urcra/skill-rating](https://github.com/Urcra/skill-rating) | Rust rating library (Elo/Glicko) if we ever port ratings | MIT |
| [EleutherAI/lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) | Standard benchmark runner (100+ tasks) | MIT |
| [stanford-crfm/helm](https://github.com/stanford-crfm/helm) | Holistic multi-metric evaluation | Apache-2.0 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | Config-driven eval/Red-teaming for prompts — would fit the Judge feature | MIT |
| [open-compass/open-compass](https://github.com/open-compass/open-compass) | Large-scale eval toolkit | Apache-2.0 |

## 8. Serving layers & headless APIs

| Resource | Notes | License |
| --- | --- | --- |
| [gradio-app/gradio](https://github.com/gradio-app/gradio) + `gradio_client` | Most local AI apps (incl. WanGP) expose Gradio; `gradio_client` can drive any Gradio app headlessly — a fallback path if the WanGP bridge is ever unavailable but the WanGP UI is running | Apache-2.0 |
| OpenAI-compatible API convention | `llama-server`, Ollama, vLLM, FastChat, llama-swap all speak it — the obvious target for a future `local` text backend | Spec |
| WanGP docs: `docs/API.md`, `docs/CLI.md`, `docs/DEEPY.md`, `docs/REMOTE_LLMS.md` | The official API our bridge wraps; headless queue processing (`wgp.py --process queue.zip`); Deepy agent internals; remote-LLM (Codex/Claude) integration | Docs (in WanGP repo) |

## 9. Model hubs & discovery

| Resource | Notes |
| --- | --- |
| [Hugging Face](https://huggingface.co) | Canonical hub — Wan/LTX/Flux/HiDream weights; `hf` CLI for scripted downloads |
| [ModelScope](https://modelscope.cn) | Alibaba's hub — often first home of Wan/Qwen releases, and the same org behind our hosted BYOK endpoint |
| [CivitAI](https://civitai.com) | Community checkpoints + LoRAs (WanGP has a built-in CivitAI browser/downloader) |

## 10. Agent conventions & skills (meta: agents working on/with this app)

| Resource | Notes | License |
| --- | --- | --- |
| [AGENTS.md](https://agents.md) convention | Root-file convention for orienting coding agents — this repo now ships `AGENTS.md`; symlink `CLAUDE.md` → `AGENTS.md` if you use Claude Code | Spec |
| [modelcontextprotocol](https://modelcontextprotocol.io) ([repo](https://github.com/modelcontextprotocol)) | Open standard for tool-using agents — natural evolution for the app's Workforce/cognitive agents and for exposing Studio generation as tools | MIT |
| [Wan-Video/Wan-skills](https://github.com/Wan-Video/Wan-skills) | Official agent-skill packaging for Wan AIGC — steal this pattern for "Studio skills" (see §1) | Apache-2.0 |
| Agent Skills pattern ([guide](https://www.agentpatterns.ai/standards/agents-md/)) | AGENTS.md = project context; Skills = task knowledge. Complementary layers | Docs |

## 11. Prompting & knowledge resources

| Resource | Notes |
| --- | --- |
| [DAIR.AI Prompt Engineering Guide](https://www.promptingguide.ai) ([repo](https://github.com/dair-ai/Prompt-Engineering-Guide)) | The open prompting textbook — feed to Council/Collab agents |
| [f/awesome-chatgpt-prompts](https://github.com/f/awesome-chatgpt-prompts) | Huge prompt library — seed data for the Templates feature |
| [Lilian Weng — Prompt Engineering](https://lilianweng.github.io/posts/2023-03-15-prompt-engineering/) | The classic technical deep-dive |
| WanGP `docs/PROMPTS.md` | Model-specific prompt syntax (commands like `[duration=3s]`) — relevant to Studio prompt handling |

## 12. Licensing quick sheet (what the Studio can offer commercially)

| Tier | Models |
| --- | --- |
| **Permissive (Apache-2.0/MIT)** | Wan 2.1/2.2 · Qwen-Image · HiDream-I1/O1 · GLM-Image · FLUX schnell/klein · Mochi · Open-Sora · ACE-Step · YuE · MusicGen · Kokoro · Chatterbox · Bark · Piper (original MIT) |
| **Conditional / threshold** | LTX-2 (free < $10M revenue) · HunyuanImage 3.0 (<100M MAU) · ComfyUI (GPL-3.0, strong copyleft) |
| **Non-commercial** | FLUX dev · XTTS-v2 (CPML) · F5-TTS weights · Fish Speech · Stable Audio Open weights · IndexTTS-2 |

---

*Maintenance: when adding a Studio backend or model family, add its upstream repo here
(link + license + one-line relevance) in the same PR.*
