/**
 * Personalisation evidence normalizer — the Gate-6 fidelity core.
 *
 * Translates a contract-validated wire payload into Arena's faithful
 * reasoning context. The discipline of this module is preservation, not
 * interpretation:
 *
 *   - All eight contract collections cross verbatim (plus `domain`). Array
 *     order and item identity are untouched.
 *   - No field is renamed, recomputed, defaulted, rounded, re-labeled, or
 *     dropped. `batchIds` crosses as `batchIds`; the adapter does not
 *     invent an `ingestionBatch` abstraction because that phrase does not
 *     appear in the transport.
 *   - Empty collections stay present and empty: an empty `uncertainties`
 *     is evidence ("no recorded uncertainties"), never a license to
 *     manufacture uncertainty, interpretation, preference, or confidence.
 *   - Epistemic status is never upgraded: upstream `derived` stays
 *     `derived`; a missing optional field stays missing.
 *   - The result is deep-frozen: evidence is not mutable state.
 *
 *   Translate shape, not meaning.
 *
 * What the adapter ADDS is transport labeling only (Arena may label the
 * source of evidence): which contract, which endpoint, when Arena received
 * it — as metadata WRAPPING the evidence, never inside it.
 */

import { personalisationContractMeta } from "./generated/contract";
import type { PersonalisationContext } from "./generated/types";
import type {
  PersonalisationEvidenceClient,
  PersonalisationEvidenceReception,
} from "./types";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Normalize (faithfully preserve) a contract-validated wire payload.
 *  Callers must have run the payload through the seam's runtime validator
 *  first — createPersonalisationEvidenceClient does this at ingress. */
export function normalizePersonalisationContext(
  wire: PersonalisationContext,
): PersonalisationEvidenceReception {
  return {
    transport: {
      endpoint: "GET /assistant/personalisation-context",
      contractSource: personalisationContractMeta.sourceSpec,
      contractRef: personalisationContractMeta.sourceRef,
      receivedAt: new Date().toISOString(),
    },
    evidence: deepFreeze({
      domain: wire.domain,
      facts: wire.facts,
      observedSignals: wire.observedSignals,
      temporalSignals: wire.temporalSignals,
      collectionFacts: wire.collectionFacts,
      interpretations: wire.interpretations,
      uncertainties: wire.uncertainties,
      explicitPreferences: wire.explicitPreferences,
      constraints: wire.constraints,
    }),
  };
}

/** The full receive pipeline: fetch (server-to-server) → validate at
 *  ingress (inside the client) → normalize into the frozen evidence body.
 *  This is the STOP point of Gate 6: what comes out is evidence with
 *  transport provenance, and nothing else. */
export async function fetchPersonalisationEvidence(
  client: PersonalisationEvidenceClient,
): Promise<PersonalisationEvidenceReception> {
  return normalizePersonalisationContext(await client.getPersonalisationContext());
}
