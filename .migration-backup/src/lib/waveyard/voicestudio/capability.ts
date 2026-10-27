/**
 * Voice Studio capability model — honest reporting of what the local
 * runtime can actually do with a voice, mirroring the AI hearing-capability
 * pattern (three modes, exact labels, no overlap in meaning).
 */

export const VOICE_CAPABILITIES = [
  "identity-conversion",
  "style-transfer",
  "pitch-correction",
  "unavailable",
] as const;

export type VoiceCapability = (typeof VOICE_CAPABILITIES)[number];

export type VoiceRuntimeStatus = {
  /** A conversion worker with voice models is reachable. */
  workerAvailable: boolean;
  /** At least one conversion model is installed locally. */
  modelsInstalled: boolean;
  /** GPU available for conversion (models may still run on CPU). */
  gpuAvailable: boolean;
};

/** Exact UI labels — no synonyms. */
export function voiceCapabilityLabel(capability: VoiceCapability): string {
  switch (capability) {
    case "identity-conversion":
      return "Voice conversion: real (consent on file)";
    case "style-transfer":
      return "Style transfer: delivery character, not identity";
    case "pitch-correction":
      return "Pitch correction: tuning only";
    case "unavailable":
      return "Voice conversion unavailable in this session";
  }
}

/**
 * Resolve the honest capability for a requested operation.
 * Identity conversion additionally requires consent — without it the
 * capability is NOT identity-conversion, no matter what the runtime has.
 */
export function resolveVoiceCapability(request: {
  operation: "identity-conversion" | "style-transfer" | "pitch-correction";
  runtime: VoiceRuntimeStatus;
  consentOnFile: boolean;
}): { capability: VoiceCapability; reason: string } {
  if (!request.runtime.workerAvailable || !request.runtime.modelsInstalled) {
    return {
      capability: "unavailable",
      reason: request.runtime.workerAvailable
        ? "No voice models installed locally."
        : "No voice conversion worker available.",
    };
  }
  switch (request.operation) {
    case "identity-conversion":
      if (!request.consentOnFile)
        return {
          capability: "unavailable",
          reason:
            "Identity conversion requires a consent record for the target voice (own-voice or licensed). Style transfer is available without one.",
        };
      return { capability: "identity-conversion", reason: "Consent record verified." };
    case "style-transfer":
      return {
        capability: "style-transfer",
        reason: "Delivery/phrasing character transformation; identity is preserved.",
      };
    case "pitch-correction":
      return { capability: "pitch-correction", reason: "Scale-quantized tuning only." };
  }
}
