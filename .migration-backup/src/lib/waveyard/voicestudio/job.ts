/**
 * Voice conversion job contract — the queue payload and validation gate.
 * Jobs are only built through createVoiceConversionJob, which enforces:
 *   - the target voice has a consent record (identity mode)
 *   - parameters are in range
 *   - provenance is attached (source checksum, model, parameters, consent
 *     fingerprint) so every derived audio artifact remains traceable
 * (Waveyard provenance discipline, Part 25 of the completion plan).
 */

import { z } from "zod";

import type { ConsentRegistry } from "./consent";

export const VOICE_CONVERSION_QUEUE = "waveyard-voice-conversion" as const;

export const VOICE_MODELS = ["rvc", "so-vits-svc"] as const;
export type VoiceModelKind = (typeof VOICE_MODELS)[number];

export const VoiceConversionJobSchema = z.object({
  queue: z.literal(VOICE_CONVERSION_QUEUE),
  projectId: z.string().min(1),
  /** Source stem to convert (a vocal stem, not the raw mix). */
  sourceStemAssetId: z.string().min(1),
  /** Target voice identity (must have consent). */
  targetVoiceId: z.string().min(1),
  model: z.enum(VOICE_MODELS),
  /** Semitone transpose −12..+12 (voice character, not chipmunking). */
  transposeSemitones: z.number().int().min(-12).max(12),
  /** 0..1 — how strongly the target identity is applied. */
  identityStrength: z.number().min(0).max(1),
  /** Keep source timing/phrasing exactly (recommended for songs). */
  preserveTiming: z.boolean(),
  provenance: z.object({
    sourceChecksumSha256: z.string().length(64),
    consentFingerprint: z.string().min(8),
    requestedBy: z.enum(["user", "ai-assistant"]),
    createdAt: z.string(),
  }),
});

export type VoiceConversionJob = z.infer<typeof VoiceConversionJobSchema>;

export type JobBuildResult =
  | { ok: true; job: VoiceConversionJob }
  | { ok: false; error: string; errorCode: VoiceJobErrorCode };

export type VoiceJobErrorCode =
  | "CONSENT_MISSING"
  | "INPUT_INVALID"
  | "STEM_REQUIRED"
  | "MODEL_UNKNOWN";

export function createVoiceConversionJob(input: {
  registry: ConsentRegistry;
  projectId: string;
  sourceStemAssetId: string;
  sourceChecksumSha256: string;
  targetVoiceId: string;
  model: string;
  transposeSemitones: number;
  identityStrength: number;
  preserveTiming: boolean;
  requestedBy: "user" | "ai-assistant";
}): JobBuildResult {
  const fingerprint = input.registry.fingerprint(input.targetVoiceId);
  if (fingerprint === null) {
    return {
      ok: false,
      errorCode: "CONSENT_MISSING",
      error:
        `No consent record for voice "${input.targetVoiceId}". ` +
        "Register the voice (own-voice attestation or a license) or use style transfer instead.",
    };
  }
  if (!/^[a-f0-9]{64}$/.test(input.sourceChecksumSha256)) {
    return { ok: false, errorCode: "INPUT_INVALID", error: "Source checksum must be a SHA-256 hex digest." };
  }
  if (!input.sourceStemAssetId.trim()) {
    return { ok: false, errorCode: "STEM_REQUIRED", error: "Voice conversion needs a vocal stem, not a full mix." };
  }
  const parsed = VoiceConversionJobSchema.safeParse({
    queue: VOICE_CONVERSION_QUEUE,
    projectId: input.projectId,
    sourceStemAssetId: input.sourceStemAssetId,
    targetVoiceId: input.targetVoiceId,
    model: input.model,
    transposeSemitones: input.transposeSemitones,
    identityStrength: input.identityStrength,
    preserveTiming: input.preserveTiming,
    provenance: {
      sourceChecksumSha256: input.sourceChecksumSha256,
      consentFingerprint: fingerprint,
      requestedBy: input.requestedBy,
      createdAt: new Date().toISOString(),
    },
  });
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "MODEL_UNKNOWN",
      error: `Job does not match the contract: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    };
  }
  return { ok: true, job: parsed.data };
}
