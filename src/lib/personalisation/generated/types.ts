/**
 * -----------------------------------------------------------------------------
 * AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source of truth : https://github.com/imlochie/SomeSafePortablesoftware/blob/arena/01a0b5e9-somesafeportablesoftware/lib/api-spec/openapi.yaml
 * Upstream ref    : imlochie/SomeSafePortablesoftware@b5ca1647883cc06c9180015b07470a7880d1a56a
 *
 * Byte-for-byte reproducible: regenerate whenever the upstream OpenAPI
 * document changes (npm run generate:personalisation-contract), then commit both
 * generated files together. The --check mode fails if the committed output
 * is stale with respect to the given spec.
 *   npm run generate:personalisation-contract
 * -----------------------------------------------------------------------------
 */
/**
 * AUTO-GENERATED TypeScript types for the Archive Assistant
 * personalisation-evidence boundary (the Gate-6 seam). Mirrors the OpenAPI
 * component schemas referenced by the single sanctioned seventh read,
 * GET /assistant/personalisation-context. Regenerate; never hand-edit.
 */

export type BehavioralSignal = {
  signalId: string;
  profile: "long_term" | "recent" | "collection";
  signalType: string;
  subjectIdentity: string;
  value: Record<string, unknown>;
  epistemicStatus: "derived";
  scopeIdentity: string;
  coverage: Record<string, unknown>;
  provenance: SignalProvenance;
  derivedAt: string;
  [key: string]: unknown;
};

export type PersonalisationCollectionFact = BehavioralSignal & {
  evidenceClass: "collection_fact";
};

export type PersonalisationContext = {
  domain: string;
  facts: Array<PersonalisationFact>;
  observedSignals: Array<PersonalisationObservedSignal>;
  temporalSignals: Array<PersonalisationTemporalSignal>;
  collectionFacts: Array<PersonalisationCollectionFact>;
  interpretations: Array<PersonalisationInterpretation>;
  uncertainties: Array<PersonalisationUncertainty>;
  explicitPreferences: Array<Record<string, unknown>>;
  constraints: Array<string>;
};

export type PersonalisationFact = {
  evidenceClass: "fact";
  factType: string;
  value: unknown;
  epistemicStatus: "observed" | "derived" | "coverage-limited" | "unknown";
  provenance: Record<string, unknown>;
  [key: string]: unknown;
};

export type PersonalisationInterpretation = {
  evidenceClass: "interpretation";
  statement?: string;
  epistemicStatus?: "derived" | "unknown";
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PersonalisationObservedSignal = BehavioralSignal & {
  evidenceClass: "observed_signal";
};

export type PersonalisationTemporalSignal = BehavioralSignal & {
  evidenceClass: "temporal_signal";
};

export type PersonalisationUncertainty = {
  evidenceClass: "uncertainty";
  reason?: string;
  epistemicStatus?: "coverage-limited" | "unknown";
  scopeIdentity?: string;
  coverage?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SignalProvenance = {
  derivedFrom: string;
  observationIds: Array<number>;
  eventIds: Array<number>;
  evidenceKeys: Array<string>;
  providerEventIds: Array<string>;
  ingestionBatchIds: Array<string>;
  batchIds: Array<string>;
  eventOccurredAt: Array<string>;
  observedAt: Array<string>;
  scopeIdentity: string;
  [key: string]: unknown;
};
