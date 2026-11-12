/**
 * Versioned, source-relative evidence consumed by Waveyard's arrangement
 * planners. Individual measurements keep their own provenance so a missing or
 * stale feature cannot be mistaken for a confident value.
 */

import type { PassageFingerprint } from "../types/passage-compatibility";
import type { ChordQuality } from "../types/harmony-analysis";
import type { VocalPitchFrame } from "../types/vocal-analysis";

export const MUSICAL_EVIDENCE_PACKET_FORMAT = "waveyard-musical-evidence-v1" as const;

export type MusicalEvidenceProvenance = {
  analysisId?: string;
  analysisEngine: string;
  analysisEngineVersion: string;
  sourceChecksumSha256: string;
  stemAssetId?: string;
  stemChecksumSha256?: string;
  persistence: "database" | "request";
  contributors?: MusicalEvidenceProvenance[];
};

export type MusicalEvidenceValue<T> =
  | { status: "measured"; value: T; provenance: MusicalEvidenceProvenance }
  | { status: "unavailable"; reason: string };

export type MusicalEvidenceSection = {
  id?: string;
  label: string;
  startMs: number;
  endMs: number;
  startBeatIndex?: number;
  endBeatIndex?: number;
  passageFingerprint?: PassageFingerprint | null;
};

export type MusicalEvidencePhrase = {
  startMs: number;
  endMs: number;
  confidence: number;
};

export type MusicalEvidenceEvent = {
  timestampMs: number;
  strength: number;
  confidence: number;
};

export type MusicalEvidenceChord = {
  startMs: number;
  endMs: number;
  root: string | null;
  quality: ChordQuality;
  confidence: number;
};

export type MusicalEvidencePacket = {
  format: typeof MUSICAL_EVIDENCE_PACKET_FORMAT;
  source: {
    assetId: string;
    checksumSha256: string;
    durationMs: number;
  };
  features: {
    tempo: MusicalEvidenceValue<{ bpm: number; confidence: number | null }>;
    key: MusicalEvidenceValue<{ key: string; confidence: number | null }>;
    beatGrid: MusicalEvidenceValue<{ beatsMs: number[]; confidence: number | null }>;
    sections: MusicalEvidenceValue<MusicalEvidenceSection[]>;
    vocalPhrases: MusicalEvidenceValue<MusicalEvidencePhrase[]>;
    /** Monophonic pitch observations from the current isolated vocal stem; not transcription. */
    vocalPitchFrames?: MusicalEvidenceValue<VocalPitchFrame[]>;
    harmony: MusicalEvidenceValue<MusicalEvidenceChord[]>;
    drumEvents: MusicalEvidenceValue<MusicalEvidenceEvent[]>;
    bassAttacks: MusicalEvidenceValue<MusicalEvidenceEvent[]>;
  };
};

export function measuredEvidence<T>(
  value: T,
  provenance: MusicalEvidenceProvenance,
): MusicalEvidenceValue<T> {
  return { status: "measured", value, provenance };
}

export function unavailableEvidence<T>(reason: string): MusicalEvidenceValue<T> {
  return { status: "unavailable", reason };
}

/** Only return a value when its recorded source identity still matches. */
export function currentEvidenceValue<T>(
  evidence: MusicalEvidenceValue<T>,
  sourceChecksumSha256: string,
): T | null {
  return evidence.status === "measured"
    && evidence.provenance.sourceChecksumSha256 === sourceChecksumSha256
    ? evidence.value
    : null;
}
