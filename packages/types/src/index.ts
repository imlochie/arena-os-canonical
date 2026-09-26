export const STEM_TYPES = ["vocals", "drums", "bass", "other"] as const;
export type StemType = (typeof STEM_TYPES)[number];

export const JOB_STATUSES = ["queued", "preparing", "processing", "finalizing", "complete", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type SeparationJobPayload = {
  processingJobId: string;
  projectId: string;
  sourceAssetId: string;
  model: string;
  requestedDevice: "auto" | "cpu" | "cuda";
};

export type AudioMetadata = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate: number | null;
  container: string;
  sizeBytes: number;
};

export const WAVEFORM_RESOLUTIONS = [256, 512, 1024, 2048, 4096] as const;
export type WaveformResolution = (typeof WAVEFORM_RESOLUTIONS)[number];
export type WaveformJobPayload = {
  waveformJobId: string;
  projectId: string;
  sourceAssetId?: string;
  stemAssetId?: string;
};

export type SourceAnalysisJobPayload = {
  sourceAnalysisId: string;
  projectId: string;
  sourceAssetId: string;
  analysisEngine: string;
  analysisEngineVersion: string;
};

export type ExportJobPayload = {
  exportJobId: string;
  projectId: string;
  remixSessionId: string;
  remixVersionId: string;
  format: "wav";
};

export type WaveformPeaks = { min: number[]; max: number[] };
export type WaveformDocument = {
  format: "waveyard-peaks-v1";
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  resolutions: Record<string, WaveformPeaks>;
};
