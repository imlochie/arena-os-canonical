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
