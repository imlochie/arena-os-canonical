import type { RemixStateInput, RemixTrackInput } from "@/lib/remix";
import type { GridDivision } from "@/lib/timing";

export type Stem = {
  id: string;
  sourceAssetId: string;
  stemType: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  format: string;
  fileSizeBytes: number;
  checksumSha256: string;
  model: string;
  modelVersion: string;
};

export type SourceAnalysis = {
  id: string;
  status: "queued" | "preparing" | "processing" | "finalizing" | "complete" | "failed" | "cancelled";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  bpm: number | null;
  bpmConfidence: number | null;
  musicalKey: string | null;
  keyConfidence: number | null;
  beatGrid: number[] | null;
  beatConfidence: number | null;
  analysisError: string | null;
  analyzedAt: string | null;
};

export type SourceSectionAnalysis = {
  id: string;
  status: "queued" | "preparing" | "processing" | "complete" | "failed" | "unavailable";
  stage: string;
  attempts: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
};

export type SourceAlignmentInfo = {
  sourceAssetId: string;
  sourceName: string;
  analysisStatus: string;
  bpm: number | null;
  musicalKey: string | null;
  beatGrid: number[] | null;
  beatConfidence: number | null;
  sectionAnalysisStatus: string | null;
};

export type SourceSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  startBeatIndex: number;
  endBeatIndex: number;
  startBar: number;
  endBar: number;
  label: "section";
  labelConfidence: number;
  structuralConfidence: number;
  analysisEngine: string;
  analysisEngineVersion: string;
  sourceChecksumSha256: string;
};

export type Source = {
  id: string;
  originalFilename: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  analysis?: SourceAnalysis | null;
  sectionAnalysis?: SourceSectionAnalysis | null;
  sections?: SourceSection[];
};

export type PersistedTrack = RemixTrackInput & {
  clips: Array<RemixTrackInput["clips"][number] & { id?: string }>;
};

export type Remix = {
  id: string;
  name: string;
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: GridDivision;
  snapEnabled: boolean;
  targetKey: string | null;
  tracks: PersistedTrack[];
};

export type RemixVersionSummary = { id: string; name: string; createdAt: string };

export function sourceStemLabel(source: Source | undefined, stemType: string) {
  const name = source?.originalFilename ?? "Unknown source";
  return `${name} — ${stemType[0]?.toUpperCase() ?? ""}${stemType.slice(1)}`;
}

export function remixState(remix: Remix): RemixStateInput {
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
    targetKey: remix.targetKey,
    tracks: remix.tracks,
  };
}

export function clock(seconds: number) {
  const min = Math.floor(Math.max(0, seconds) / 60);
  const sec = Math.floor(Math.max(0, seconds) % 60);
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function bytes(size: number) {
  return size > 1_000_000
    ? `${(size / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1_000))} KB`;
}
