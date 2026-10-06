// Studio — multimodal generation hub (video / image / audio).
//
// Backends:
//  - "wangp"    : WanGP (Wan2GP) by DeepBeepMeep via the local bridge
//                 (bridges/wangp_bridge.py wrapping WanGP's official shared/api.py)
//  - "comfyui"  : any ComfyUI server (Wan 2.1/2.2, LTX-Video, ... via API-format workflows)
//  - "dashscope": Alibaba Cloud Model Studio hosted Wan API (BYOK, optional)
//  - "demo"     : fully local procedural preview engine (no GPU needed, offline-safe)
//
// WanGP attribution (required by the WanGP terms): this app clearly discloses
// that generation through the "wangp" backend is powered by WanGP by DeepBeepMeep.

export type StudioBackend = "wangp" | "comfyui" | "dashscope" | "demo";
export type StudioModality = "video" | "image" | "audio";

export interface StudioBackendStatus {
  backend: StudioBackend;
  online: boolean;
  url: string;
  detail?: string;
  version?: string;
}

export interface StudioModelInfo {
  modelType: string;
  name: string;
  modality: StudioModality;
  outputs?: string[];
  family?: string;
  familyLabel?: string;
  description?: string;
  // rough VRAM guidance (GB) where known — informational only
  minVram?: number;
  available?: boolean; // when the live backend can confirm local files
  source: StudioBackend;
  experimental?: boolean;
  notes?: string;
}

export interface StudioModelDetail {
  modelType: string;
  name: string;
  modality: StudioModality;
  source: StudioBackend;
  defaults?: Record<string, unknown>; // WanGP settings-shaped defaults
  schema?: Record<string, unknown>; // capability / frame-limit metadata
  availability?: Record<string, unknown>;
  notes?: string[];
}

export type StudioJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface StudioJobFile {
  name: string;
  // served through /api/studio/jobs/{id}/media?f=...
  url: string;
  mediaType: string; // "video/mp4" | "image/svg+xml" | "audio/wav" | ...
  kind: StudioModality;
  size?: number;
}

export interface StudioJob {
  id: string;
  backend: StudioBackend;
  externalId: string | null;
  modelType: string;
  modelName: string;
  modality: StudioModality;
  prompt: string;
  negativePrompt: string;
  settings: Record<string, unknown>;
  status: StudioJobStatus;
  phase: string;
  progress: number; // 0..1
  files: StudioJobFile[];
  preview: string | null; // data URI (progress preview) when available
  error: string | null;
  seed: number | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioGenerateRequest {
  backend: StudioBackend;
  modality: StudioModality;
  modelType: string;
  prompt: string;
  negativePrompt?: string;
  seed?: number | null;
  settings?: Record<string, unknown>;
  projectId?: string | null;
  // client-side backend config (BYOK / local URLs — never persisted server-side)
  backends?: {
    wangpUrl?: string;
    comfyUrl?: string;
    dashscopeKey?: string;
    dashscopeRegion?: string;
  };
}

// Normalized progress snapshot each backend client produces.
export interface BackendJobSnapshot {
  status: StudioJobStatus;
  phase: string;
  progress: number; // 0..1
  files: { name: string; mediaType: string; kind: StudioModality; size?: number; url?: string }[];
  error?: string;
  preview?: string | null; // data-URI progress preview (WanGP bridge)
}
