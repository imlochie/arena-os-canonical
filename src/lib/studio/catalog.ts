// Curated Studio catalog.
//
// When a live WanGP bridge is reachable, the real model list comes from
// WanGP itself (session.list_model_metadata). This catalog is the offline
// fallback / demo catalog: a curated, accurate subset of the families WanGP
// supports (https://github.com/deepbeepmeep/Wan2GP — docs/MODELS.md), plus
// the built-in ComfyUI workflow templates.
//
// model_type ids below match WanGP's own selector ids so settings, saved jobs
// and prompts stay interchangeable between this app and WanGP.

import type { StudioModelInfo } from "./types";

const V = (m: Omit<StudioModelInfo, "source">): StudioModelInfo => ({ ...m, source: "wangp" });

// ---- WanGP families (offline catalog) ----
export const WANGP_CATALOG: StudioModelInfo[] = [
  // Video — Wan 2.1 / 2.2
  V({
    modelType: "t2v_2_2",
    name: "Wan 2.2 Text-to-Video",
    modality: "video",
    family: "wan2_2",
    familyLabel: "Wan 2.2",
    description: "Mature general-purpose text-to-video. Broad LoRA + WanGP feature support.",
    minVram: 8,
  }),
  V({
    modelType: "i2v_2_2",
    name: "Wan 2.2 Image-to-Video",
    modality: "video",
    family: "wan2_2",
    familyLabel: "Wan 2.2",
    description: "Animate a start image. General-purpose image-to-video.",
    minVram: 8,
  }),
  V({
    modelType: "ti2v_2_2",
    name: "Wan 2.2 TI2V 5B",
    modality: "video",
    family: "wan2_2",
    familyLabel: "Wan 2.2",
    description: "Smaller unified text/image-to-video path. Fast, light on VRAM.",
    minVram: 6,
  }),
  V({
    modelType: "vace_14B",
    name: "Wan VACE 14B",
    modality: "video",
    family: "vace",
    familyLabel: "Wan VACE",
    description: "Inpainting, outpainting, object replacement, motion/depth/pose control.",
    minVram: 8,
  }),
  V({
    modelType: "animate",
    name: "Wan 2.2 Animate",
    modality: "video",
    family: "wan",
    familyLabel: "Wan Animate",
    description: "Character animation / performer replacement from reference + control video.",
    minVram: 8,
  }),
  V({
    modelType: "scail2_14B",
    name: "SCAIL-2 14B",
    modality: "video",
    family: "scail",
    familyLabel: "SCAIL",
    description: "Character animation and motion transfer.",
    minVram: 8,
  }),
  V({
    modelType: "bernini",
    name: "Bernini-R",
    modality: "video",
    family: "bernini",
    familyLabel: "Bernini",
    description: "Video-to-video generation and multi-reference conditioning.",
    minVram: 8,
  }),
  V({
    modelType: "infinitetalk",
    name: "InfiniteTalk",
    modality: "video",
    family: "wan",
    familyLabel: "InfiniteTalk",
    description: "Audio-driven talking heads with sliding windows for long dialogue.",
    minVram: 8,
  }),
  V({
    modelType: "multitalk",
    name: "MultiTalk",
    modality: "video",
    family: "wan",
    familyLabel: "MultiTalk",
    description: "Audio-driven dialogue video with multiple speakers.",
    minVram: 8,
  }),
  V({
    modelType: "vista4d",
    name: "Vista4D",
    modality: "video",
    family: "vista4d",
    familyLabel: "Vista4D",
    description: "Reshoot a dynamic scene from a new camera trajectory.",
    minVram: 10,
  }),
  // Video — LTX-2
  V({
    modelType: "ltx2_22B_distilled_1_1",
    name: "LTX-2.3 Distilled 1.1 22B",
    modality: "video",
    family: "ltx2",
    familyLabel: "LTX-2",
    description: "Fast general-purpose start: video + native audio, start/end frames, control video, sliding windows.",
    minVram: 8,
  }),
  V({
    modelType: "ltx2_22B_msr_v2",
    name: "LTX-2.3 MSR V2 22B",
    modality: "video",
    family: "ltx2",
    familyLabel: "LTX-2",
    description: "Accepts 2–5 subject/object references for consistent shots.",
    minVram: 8,
  }),
  V({
    modelType: "joyai_echo_surgical",
    name: "JoyAI-Echo Surgical",
    modality: "video",
    family: "ltx2",
    familyLabel: "LTX-2",
    description: "Connected multi-shot stories with recurring characters, voices, objects and locations.",
    minVram: 8,
  }),
  // Video — other families
  V({
    modelType: "hunyuan_1_5_t2v",
    name: "HunyuanVideo 1.5 8.3B",
    modality: "video",
    family: "hunyuan",
    familyLabel: "Hunyuan",
    description: "Text-to-video / image-to-video family with distilled and upsampler variants.",
    minVram: 8,
  }),
  V({
    modelType: "longcat_video",
    name: "LongCat Video",
    modality: "video",
    family: "longcat",
    familyLabel: "LongCat",
    description: "General video model.",
    minVram: 8,
  }),
  V({
    modelType: "longcat_avatar_v1_5",
    name: "LongCat Avatar 1.5",
    modality: "video",
    family: "longcat",
    familyLabel: "LongCat",
    description: "Distilled audio-driven avatar / talking-head model.",
    minVram: 8,
  }),
  V({
    modelType: "k5_pro_t2v",
    name: "Kandinsky 5 Pro 19B",
    modality: "video",
    family: "kandinsky",
    familyLabel: "Kandinsky 5",
    description: "Text/image-to-video with controllable camera motion. Lite & distilled variants available.",
    minVram: 10,
  }),
  V({
    modelType: "ovi_1_1",
    name: "Ovi 1.1",
    modality: "video",
    family: "ovi",
    familyLabel: "Ovi",
    description: "Video with synchronized soundtrack — especially good with speaking characters.",
    minVram: 8,
  }),
  V({
    modelType: "magi_human_distill",
    name: "Magi Human (Distill)",
    modality: "video",
    family: "magi",
    familyLabel: "Magi Human",
    description: "Audio-driven talking-head video with staged high-resolution variants.",
    minVram: 8,
  }),
  // Image
  V({
    modelType: "krea2_raw",
    name: "Krea 2 RAW",
    modality: "image",
    family: "krea2",
    familyLabel: "Krea 2",
    description: "Polished, aesthetic images. Undistilled CFG-guided checkpoint.",
    minVram: 8,
  }),
  V({
    modelType: "krea2_turbo",
    name: "Krea 2 Turbo",
    modality: "image",
    family: "krea2",
    familyLabel: "Krea 2",
    description: "Faster distilled Krea 2 for iteration.",
    minVram: 6,
  }),
  V({
    modelType: "qwen_image_edit_plus_20B",
    name: "Qwen Image Edit Plus 20B",
    modality: "image",
    family: "qwen_image",
    familyLabel: "Qwen Image",
    description: "Multi-subject composition, strong text rendering, reference-based editing.",
    minVram: 8,
  }),
  V({
    modelType: "z_image",
    name: "Z-Image Turbo 6B",
    modality: "image",
    family: "z_image",
    familyLabel: "Z-Image",
    description: "Efficient distilled generator — great for fast iteration.",
    minVram: 6,
  }),
  V({
    modelType: "ideogram4",
    name: "Ideogram 4",
    modality: "image",
    family: "ideogram",
    familyLabel: "Ideogram",
    description: "Typography, layout, graphic design and structured composition.",
    minVram: 8,
  }),
  V({
    modelType: "flux_1_schnell",
    name: "Flux 1 Schnell",
    modality: "image",
    family: "flux",
    familyLabel: "Flux",
    description: "Fast 4-step Flux generation. Klein / Chroma / Kontext variants in WanGP.",
    minVram: 6,
  }),
  V({
    modelType: "hidream_o1_dev_2604",
    name: "HiDream O1 Dev",
    modality: "image",
    family: "hidream",
    familyLabel: "HiDream",
    description: "Text-to-image and image-reference generation.",
    minVram: 8,
  }),
  // Audio / TTS / music
  V({
    modelType: "qwen3_tts_base",
    name: "Qwen3 TTS Base",
    modality: "audio",
    family: "qwen3_tts",
    familyLabel: "Qwen3 TTS",
    description: "Flexible voice-cloning text-to-speech baseline.",
    minVram: 6,
  }),
  V({
    modelType: "index_tts2",
    name: "IndexTTS2",
    modality: "audio",
    family: "index_tts",
    familyLabel: "IndexTTS2",
    description: "Expressive emotion control for voice cloning and dialogue.",
    minVram: 6,
  }),
  V({
    modelType: "ace_step_v1_5_xl",
    name: "ACE-Step 1.5 XL",
    modality: "audio",
    family: "ace_step",
    familyLabel: "ACE-Step",
    description: "Full-song generation with strong lyric adherence.",
    minVram: 6,
  }),
  V({
    modelType: "stable_audio3_small",
    name: "Stable Audio 3 Small",
    modality: "audio",
    family: "stable_audio",
    familyLabel: "Stable Audio",
    description: "Instrumentals, loops, ambience and sound effects from descriptive prompts.",
    minVram: 6,
  }),
];

export function wangpCatalog(modality?: string): StudioModelInfo[] {
  return modality ? WANGP_CATALOG.filter((m) => m.modality === modality) : WANGP_CATALOG;
}

// ---- Built-in ComfyUI workflow templates (API format) ----
// These are editable starting points. The robust path is always "custom":
// export any workflow from ComfyUI (File → Export Workflow (API)) and paste it,
// then reference {{PROMPT}}, {{NEGATIVE}}, {{SEED}}, {{WIDTH}}, {{HEIGHT}},
// {{LENGTH}}, {{STEPS}}, {{CFG}}, {{FPS}} anywhere in the JSON.

export interface ComfyTemplate {
  id: string;
  name: string;
  modality: "video" | "image";
  description: string;
  // API-format workflow JSON with {{PLACEHOLDER}} tokens
  workflow: Record<string, unknown>;
}

const wanT2VWorkflow = {
  "30": {
    class_type: "UNETLoader",
    inputs: { unet_name: "wan2.1_t2v_1.3B_fp16.safetensors", weight_dtype: "default" },
    _meta: { title: "Wan 2.1 T2V UNet" },
  },
  "36": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" }, _meta: { title: "Wan VAE" } },
  "38": {
    class_type: "CLIPLoader",
    inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
    _meta: { title: "UMT5 XXL text encoder" },
  },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}", clip: ["38", 0] }, _meta: { title: "Prompt" } },
  "68": {
    class_type: "CLIPTextEncode",
    inputs: { text: "{{NEGATIVE}}", clip: ["38", 0] },
    _meta: { title: "Negative prompt" },
  },
  "66": {
    class_type: "EmptyHunyuanLatentVideo",
    inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", length: "{{LENGTH}}", batch_size: 1 },
    _meta: { title: "Video size" },
  },
  "88": { class_type: "ModelSamplingSD3", inputs: { shift: 8, model: ["30", 0] } },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: "{{SEED}}",
      steps: "{{STEPS}}",
      cfg: "{{CFG}}",
      sampler_name: "uni_pc",
      scheduler: "simple",
      denoise: 1,
      model: ["88", 0],
      positive: ["6", 0],
      negative: ["68", 0],
      latent_image: ["66", 0],
    },
  },
  "63": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["36", 0] } },
  "50": {
    class_type: "SaveAnimatedWEBP",
    inputs: { filename_prefix: "studio_wan_t2v", images: ["63", 0], fps: "{{FPS}}", lossless: false, quality: 90, method: "default" },
  },
};

const wanI2VWorkflow = {
  "30": {
    class_type: "UNETLoader",
    inputs: { unet_name: "wan2.1_i2v_480p_14B_fp16.safetensors", weight_dtype: "default" },
  },
  "36": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "38": {
    class_type: "CLIPLoader",
    inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan", device: "default" },
  },
  "79": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip_vision_h.safetensors" } },
  "165": { class_type: "LoadImage", inputs: { image: "example.png" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "{{PROMPT}}", clip: ["38", 0] } },
  "68": { class_type: "CLIPTextEncode", inputs: { text: "{{NEGATIVE}}", clip: ["38", 0] } },
  "166": { class_type: "CLIPVisionEncode", inputs: { crop: true, clip: ["79", 0], image: ["165", 0] } },
  "25": {
    class_type: "WanImageToVideo",
    inputs: { width: "{{WIDTH}}", height: "{{HEIGHT}}", length: "{{LENGTH}}", batch_size: 1, clip_vision_output: ["166", 0], vae: ["36", 0], start_image: ["165", 0] },
  },
  "88": { class_type: "ModelSamplingSD3", inputs: { shift: 8, model: ["30", 0] } },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: "{{SEED}}",
      steps: "{{STEPS}}",
      cfg: "{{CFG}}",
      sampler_name: "uni_pc",
      scheduler: "simple",
      denoise: 1,
      model: ["88", 0],
      positive: ["6", 0],
      negative: ["68", 0],
      latent_image: ["25", 0],
    },
  },
  "63": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["36", 0] } },
  "50": {
    class_type: "SaveAnimatedWEBP",
    inputs: { filename_prefix: "studio_wan_i2v", images: ["63", 0], fps: "{{FPS}}", lossless: false, quality: 90, method: "default" },
  },
};

export const COMFY_TEMPLATES: ComfyTemplate[] = [
  {
    id: "wan21_t2v",
    name: "Wan 2.1 Text-to-Video (1.3B)",
    modality: "video",
    description:
      "Native ComfyUI Wan 2.1 t2v workflow. Needs wan2.1_t2v_1.3B_fp16.safetensors (models/unet), wan_2.1_vae.safetensors (models/vae) and umt5_xxl_fp8_e4m3fn_scaled.safetensors (models/text_encoders).",
    workflow: wanT2VWorkflow,
  },
  {
    id: "wan21_i2v",
    name: "Wan 2.1 Image-to-Video (14B 480p)",
    modality: "video",
    description:
      "Native ComfyUI Wan 2.1 i2v. Also needs clip_vision_h.safetensors (models/clip_vision) and a start image uploaded to ComfyUI input. Swap the LoadImage 'image' value to your file name.",
    workflow: wanI2VWorkflow,
  },
];

export function comfyTemplates(modality?: string): ComfyTemplate[] {
  return modality ? COMFY_TEMPLATES.filter((t) => t.modality === modality) : COMFY_TEMPLATES;
}

export function findComfyTemplate(id: string): ComfyTemplate | undefined {
  return COMFY_TEMPLATES.find((t) => t.id === id);
}
