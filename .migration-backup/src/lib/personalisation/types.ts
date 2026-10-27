/**
 * Arena-side evidence model for the Gate-6 adapter.
 *
 * These types describe ARENA's faithful evidence container. They are not a
 * reinterpretation of the upstream payload: every field that crosses the
 * seam is the upstream field, typed by the generated contract in
 * ./generated/types.ts (which is itself generated — never hand-authored —
 * from the owner-verified upstream OpenAPI at the pinned ref).
 *
 * The governing rule for anything built from these types:
 *
 *   Arena may transport evidence.
 *   Arena may label the source of evidence.
 *   Arena may not upgrade the epistemic status of evidence.
 *
 * The adapter preserves the distinctions the contract encodes:
 *   observed ≠ interpreted · owned ≠ wanted · watched ≠ liked ·
 *   recent ≠ preferred · incomplete ≠ absent
 */

import type {
  PersonalisationCollectionFact,
  PersonalisationContext,
  PersonalisationFact,
  PersonalisationInterpretation,
  PersonalisationObservedSignal,
  PersonalisationTemporalSignal,
  PersonalisationUncertainty,
} from "./generated/types";

/** The faithful evidence body: all eight contract collections preserved,
 *  each item exactly as validated on the wire. Empty stays empty — an empty
 *  collection is evidence (e.g. "no recorded uncertainties"), never a
 *  signal for the adapter to manufacture content. */
export type PersonalisationEvidenceBody = {
  readonly domain: string;
  readonly facts: readonly PersonalisationFact[];
  readonly observedSignals: readonly PersonalisationObservedSignal[];
  readonly temporalSignals: readonly PersonalisationTemporalSignal[];
  readonly collectionFacts: readonly PersonalisationCollectionFact[];
  readonly interpretations: readonly PersonalisationInterpretation[];
  readonly uncertainties: readonly PersonalisationUncertainty[];
  readonly explicitPreferences: readonly Record<string, unknown>[];
  readonly constraints: readonly string[];
};

/** Transport facts — Arena may label the source of evidence. Everything in
 *  this record is about the TRANSPORT (which contract, which endpoint, when
 *  Arena received it); none of it is evidence semantics. */
export type PersonalisationTransportMeta = {
  readonly endpoint: "GET /assistant/personalisation-context";
  /** Contract provenance straight from the generated snapshot meta. */
  readonly contractSource: string;
  readonly contractRef: string;
  /** When Arena received the payload (Arena-side transport timestamp;
   *  deliberately NOT an epistemic field of any evidence item). */
  readonly receivedAt: string;
};

/** What the seventh read becomes inside Arena: transport-labeled, frozen,
 *  epistemically unaltered evidence. This is the end of Gate 6 — the STOP
 *  point. Anything derived from this body (ranking, candidates, scores,
 *  taste) is Gate-7 territory and does not exist yet. */
export type PersonalisationEvidenceReception = {
  readonly transport: PersonalisationTransportMeta;
  readonly evidence: PersonalisationEvidenceBody;
};

/** The single-method client surface. One read, no parameters, no mutations:
 *  the endpoint is owner-scoped upstream from the forwarded server-to-server
 *  credentials — Arena never passes an owner id, and the request carries no
 *  query input at all. */
export type PersonalisationEvidenceClient = {
  getPersonalisationContext(): Promise<PersonalisationContext>;
};
