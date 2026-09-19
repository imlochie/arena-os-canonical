/**
 * Shared evidence-access helper for Gate-7 slices (7.3+). Kept separate
 * from the accepted/frozen 7.1–7.2 modules on purpose.
 */

import { ReasoningRejectError } from "./lattice";
import type { EvidencePack, EvidenceRef } from "./types";

/** Resolve an evidence ref against the pack, refusing dangling references. */
export function resolveEvidence(pack: EvidencePack, ref: EvidenceRef): Record<string, unknown> {
  const items = pack.evidence[ref.collection] as readonly Record<string, unknown>[] | undefined;
  const item = items?.[ref.index];
  if (!item || typeof item !== "object") {
    throw new ReasoningRejectError(
      "bad_reference",
      `no evidence item at ${ref.collection}[${ref.index}] in this pack`,
    );
  }
  return item;
}
