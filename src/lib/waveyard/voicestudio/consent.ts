/**
 * Voice identity consent registry — the legal/ethical gate for voice
 * conversion. Identity cloning (making output sound like a specific
 * person) is only permitted when a matching consent record exists:
 *
 *   - "own-voice": the target voice is the user themself.
 *   - "licensed": documented right to use that voice model (contract,
 *     marketplace license, estate/label permission, …).
 *
 * STYLE TRANSFER ("make my delivery feel like Frank Ocean's phrasing" via
 * pitch/timing character) is explicitly NOT identity cloning and does not
 * require a consent record — but the capability labels must never claim
 * identity conversion when running style transfer.
 *
 * No enforcement happens "elsewhere": the job contract validator refuses
 * to build identity-conversion jobs without consent, so every downstream
 * consumer (queue, worker, provenance) is safe by construction.
 */

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

export const VOICE_CONSENT_FORMAT = "waveyard-voice-consent-v1" as const;

export const RIGHTS_BASES = ["own-voice", "licensed"] as const;
export type RightsBasis = (typeof RIGHTS_BASES)[number];

export const VoiceConsentRecordSchema = z.object({
  format: z.literal(VOICE_CONSENT_FORMAT),
  id: z.string().min(1),
  /** Stable identity of the target voice (model id or person id). */
  voiceId: z.string().min(1),
  displayName: z.string().min(1),
  rightsBasis: z.enum(RIGHTS_BASES),
  /** Free-form but required evidence description for licensed voices. */
  evidence: z.string().min(3),
  scope: z.enum(["conversion", "conversion+public-release"]),
  grantedAt: z.string(),
});

export type VoiceConsentRecord = z.infer<typeof VoiceConsentRecordSchema>;

export class ConsentRegistry {
  private readonly records = new Map<string, VoiceConsentRecord>();

  /** Register a consent record. Returns its verifiable id. */
  grant(input: {
    voiceId: string;
    displayName: string;
    rightsBasis: RightsBasis;
    evidence: string;
    scope?: VoiceConsentRecord["scope"];
  }): VoiceConsentRecord {
    if (input.rightsBasis === "own-voice" && input.evidence.trim().length < 3)
      throw new Error("Own-voice consent still requires an attestation statement.");
    if (input.rightsBasis === "licensed" && input.evidence.trim().length < 10)
      throw new Error("Licensed voices require a concrete rights description (≥ 10 chars).");
    const record: VoiceConsentRecord = {
      format: VOICE_CONSENT_FORMAT,
      id: randomUUID(),
      voiceId: input.voiceId,
      displayName: input.displayName,
      rightsBasis: input.rightsBasis,
      evidence: input.evidence,
      scope: input.scope ?? "conversion",
      grantedAt: new Date().toISOString(),
    };
    this.records.set(record.voiceId, record);
    return record;
  }

  revoke(voiceId: string): boolean {
    return this.records.delete(voiceId);
  }

  /** Consent fingerprint — verifiable provenance without exposing evidence. */
  fingerprint(voiceId: string): string | null {
    const record = this.records.get(voiceId);
    if (record === undefined) return null;
    return createHash("sha256")
      .update(`${record.id}|${record.voiceId}|${record.rightsBasis}|${record.grantedAt}`)
      .digest("hex")
      .slice(0, 16);
  }

  /** The gate: does a valid consent record exist for this voice? */
  canCloneIdentity(voiceId: string): boolean {
    return this.records.has(voiceId);
  }

  list(): VoiceConsentRecord[] {
    return [...this.records.values()];
  }
}
