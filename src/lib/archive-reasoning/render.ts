/**
 * Gate 7, slice 7.4: the renderer contract — the mouth, not the brain.
 *
 * The renderer turns a CERTIFIED structured conclusion into language
 * without adding information. It reads only the conclusion envelope
 * (never the evidence pile), applies fixed deterministic templates, and
 * attaches the certificate as an attribution the sentence never travels
 * without. It does not calculate, infer, select evidence, raise a
 * ceiling, or invent temporal language; there are no model calls here
 * and never will be — if phrasing ever becomes model-assisted, it may
 * only render what this file renders (design §5).
 *
 * Two guards:
 *   - assertRendererVocabulary: template text is scanned for affect /
 *     second-person / upgrade words. Quoted SUBJECTS are exempt on
 *     purpose: "movie:love-actually" is a title, not an emotion.
 *   - fail-closed discrimination: any claim shape the renderer does not
 *     recognize is an unsupported_claim throw, never an improvisation.
 */

import { windowIdentity } from "./lattice";
import type {
  AggregationClaim,
  Conclusion,
  ContradictionClaim,
  EvidenceRef,
  RenderedConclusion,
  RestatementClaim,
  TemporalClaim,
  WindowComparisonClaim,
  WindowIdentity,
} from "./types";

export class RenderError extends Error {
  readonly renderKind: "unsupported_claim" | "forbidden_vocabulary";

  constructor(renderKind: "unsupported_claim" | "forbidden_vocabulary", message: string) {
    super(message);
    this.name = "RenderError";
    this.renderKind = renderKind;
  }
}

/* --------------------------- vocabulary guard ---------------------------- */

const FORBIDDEN_VOCABULARY =
  /\b(love|like|likes|liked|enjoy|enjoyed|enjoying|favourite|favorite|prefer|prefers|preferred|adore|obsessed|taste|tasty|recommend|recommendation|recommendations|suggest|suggests|suggestion|interest|interested|interesting|score|scores|rank|ranks|ranking|best|growing|surging|waning|trending)\b|\byou\b|\byour\b/i;

/** Throws RenderError if template-produced text carries affect, upgrades,
 *  or second-person language. Exported for direct testing. */
export function assertRendererVocabulary(templateText: string): void {
  const hit = FORBIDDEN_VOCABULARY.exec(templateText);
  if (hit) {
    throw new RenderError(
      "forbidden_vocabulary",
      `rendered text contains forbidden vocabulary "${hit[0]}" — the mouth does not invent affect`,
    );
  }
}

/* ------------------------------ builder ---------------------------------- */

/** Segments keep template text (scanned) apart from quoted data (exempt). */
class StatementBuilder {
  private scanned: string[] = [];
  private parts: string[] = [];

  text(value: string): this {
    this.scanned.push(value);
    this.parts.push(value);
    return this;
  }

  /** A quoted data value: rendered with double quotes, never scanned. */
  quote(value: unknown): this {
    this.parts.push(`"${String(value)}"`);
    return this;
  }

  finish(): string {
    assertRendererVocabulary(this.scanned.join(""));
    return this.parts.join("");
  }
}

/* ------------------------------ phrasing --------------------------------- */

function windowPhrase(window: WindowIdentity): string {
  const { label, startsAt, endsAt } = window;
  const bounds = startsAt && endsAt
    ? ` (${startsAt} to ${endsAt})`
    : endsAt
      ? ` ending ${endsAt}`
      : startsAt
        ? ` starting ${startsAt}`
        : "";
  if (label) return `the ${label} window${bounds}`;
  if (startsAt && endsAt) return `the window from ${startsAt} to ${endsAt}`;
  if (endsAt) return `the window ending ${endsAt}`;
  if (startsAt) return `the window starting ${startsAt}`;
  return "the undeclared window";
}

function primitive(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
  return "{…}";
}

function metricPhrase(value: unknown): string {
  if (value === null || value === undefined) return "an empty record";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.length === 0 ? "an empty list" : `[${value.map(String).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "an empty record";
    return entries.map(([k, v]) => `${k}=${primitive(v)}`).join(", ");
  }
  return String(value);
}

const COLLECTION_NOUN: Record<string, string> = {
  facts: "facts",
  observedSignals: "observed signals",
  temporalSignals: "temporal signals",
  collectionFacts: "collection facts",
  interpretations: "interpretations",
  uncertainties: "uncertainties",
  explicitPreferences: "explicit preferences",
};

function refDescription(ref: EvidenceRef): string {
  return ref.signalId ?? `${ref.collection}[${ref.index}]`;
}

function subjectSuffix(builder: StatementBuilder, subject: unknown): void {
  if (typeof subject === "string" && subject) {
    builder.text(" for ").quote(subject);
  }
}

/* ------------------------- per-kind renderers ----------------------------- */

const VALUE_CLASSES = ["fact", "observed_signal", "temporal_signal", "collection_fact"];

function renderRestatement(conclusion: Conclusion): string {
  const claim = conclusion.claim as Partial<RestatementClaim>;
  if (!claim || typeof claim.evidenceClass !== "string" || !claim.restates) {
    throw new RenderError("unsupported_claim", "restatement claim is not the shape the renderer was certified for");
  }
  const b = new StatementBuilder();
  if (VALUE_CLASSES.includes(claim.evidenceClass)) {
    b.text(`The archive records ${metricPhrase(claim.value)}`);
    subjectSuffix(b, claim.subject);
    b.text(` in ${windowPhrase(conclusion.window)}.`);
  } else {
    b.text("An item of class ").quote(claim.evidenceClass).text(" is recorded");
    subjectSuffix(b, claim.subject);
    b.text(` in ${windowPhrase(conclusion.window)}.`);
  }
  return b.finish();
}

function renderAggregation(conclusion: Conclusion): string {
  const claim = conclusion.claim as AggregationClaim;
  const members = (claim as { members?: readonly EvidenceRef[] }).members;
  const collection = members?.[0]?.collection;
  const noun = collection ? COLLECTION_NOUN[collection] : undefined;
  if (!claim || !noun || (claim.mode !== "count" && claim.mode !== "sum" && claim.mode !== "subjects")) {
    throw new RenderError("unsupported_claim", "aggregation claim is not a certified mode/membership");
  }
  const b = new StatementBuilder();
  const window = windowPhrase(conclusion.window);
  if (claim.mode === "count") {
    b.text(`${claim.count} ${noun} recorded in ${window}.`);
  } else if (claim.mode === "sum") {
    b.text(`The archive records a total of ${claim.sum} across ${claim.count} ${noun} in ${window}.`);
  } else {
    b.text(`${claim.count} ${noun} covering ${claim.subjects.length} distinct subject${claim.subjects.length === 1 ? "" : "s"} in ${window}: `);
    claim.subjects.forEach((subject, i) => {
      if (i > 0) b.text(", ");
      b.quote(subject);
    });
    b.text(".");
  }
  return b.finish();
}

function renderTemporal(conclusion: Conclusion): string {
  const claim = conclusion.claim as Partial<TemporalClaim & WindowComparisonClaim>;
  const b = new StatementBuilder();
  if (typeof claim.metricKey === "string" && Array.isArray(claim.perWindow) && Array.isArray(claim.comparisons)) {
    // Window comparison: numbers + relation words only.
    const c = claim as WindowComparisonClaim;
    if (c.perWindow.length < 2) {
      throw new RenderError("unsupported_claim", "comparison claim needs its per-window points");
    }
    if (typeof c.subject === "string") b.quote(c.subject).text(": "); else b.text("The subject: ");
    b.text(`${c.metricKey} was `);
    c.perWindow.forEach((point, i) => {
      if (i > 0) b.text(i === c.perWindow.length - 1 ? " and " : ", ");
      b.text(`${point.value} in ${windowPhrase(point.window)}`);
    });
    b.text("; ");
    c.comparisons.forEach((comparison, i) => {
      if (i > 0) b.text("; then ");
      b.text(
        comparison.relation === "equal"
          ? "the later window is equal"
          : `the later window is ${comparison.relation} by ${Math.abs(comparison.delta)}`,
      );
    });
    b.text(".");
    return b.finish();
  }
  if (claim.signal && "metric" in claim && claim.window) {
    const c = claim as TemporalClaim;
    b.text(`As of ${c.asOf ?? "the recorded derivation time"}, ${metricPhrase(c.metric)} is recorded`);
    subjectSuffix(b, c.subject);
    b.text(` in ${windowPhrase(c.window)}.`);
    return b.finish();
  }
  throw new RenderError("unsupported_claim", "temporal claim is neither a certified as-of nor a certified comparison");
}

function renderContradiction(conclusion: Conclusion): string {
  const claim = conclusion.claim as Partial<ContradictionClaim>;
  if (!claim?.a || !claim.b || typeof claim.conflictingField !== "string" || typeof claim.overlapBasis !== "string") {
    throw new RenderError("unsupported_claim", "contradiction claim is not the certified both-sides shape");
  }
  const noun = COLLECTION_NOUN[claim.collection as string] ?? "evidence";
  const b = new StatementBuilder();
  b.text(`${noun.replace(/^./, (ch) => ch.toUpperCase())} evidence disagrees: `)
    .quote(refDescription(claim.a.ref))
    .text(` records ${metricPhrase(claim.a.value)}`);
  if (claim.a.window) b.text(` in ${windowPhrase(claim.a.window)}`);
  b.text(", while ")
    .quote(refDescription(claim.b.ref))
    .text(` records ${metricPhrase(claim.b.value)}`);
  if (claim.b.window) b.text(` in ${windowPhrase(claim.b.window)}`);
  b.text(`; overlap basis: ${claim.overlapBasis}. Both statements are preserved; no resolution is made.`);
  return b.finish();
}

function renderAbsence(conclusion: Conclusion): string {
  const claim = conclusion.claim as { open?: unknown };
  const b = new StatementBuilder();
  if (typeof claim.open === "string" && claim.open) b.quote(claim.open); else b.text("The matter in question");
  b.text(` remains open — no positive evidence is available within scope ${conclusion.scopeIdentity} in this evidence delivery.`);
  return b.finish();
}

/* ------------------------------ entry point ------------------------------- */

export function renderConclusion(conclusion: Conclusion): RenderedConclusion {
  let statement: string;
  switch (conclusion.kind) {
    case "restatement":
      statement = renderRestatement(conclusion);
      break;
    case "aggregation":
      statement = renderAggregation(conclusion);
      break;
    case "temporal_synthesis":
      statement = renderTemporal(conclusion);
      break;
    case "contradiction":
      statement = renderContradiction(conclusion);
      break;
    case "absence_qualified":
      statement = renderAbsence(conclusion);
      break;
    default:
      throw new RenderError("unsupported_claim", `no certified template for kind "${String(conclusion.kind)}"`);
  }

  const windowKey = windowIdentity(conclusion.window);
  const rule = conclusion.derivation.rule;
  // Attribution mechanics are declared text — scanned too; lineage refs
  // are data and travel in quotes.
  assertRendererVocabulary(`${conclusion.epistemicStatus} ${conclusion.scopeIdentity} ${windowKey} ${rule}`);
  const refs = conclusion.derivation.loadBearing.map(refDescription);
  const attribution =
    `status ${conclusion.epistemicStatus} · scope ${conclusion.scopeIdentity} · window ${windowKey} · rule ${rule} · via ` +
    refs.map((ref) => `"${ref}"`).join(", ");

  const rendered: RenderedConclusion = {
    kind: conclusion.kind,
    statement,
    attribution,
    epistemicStatus: conclusion.epistemicStatus,
    scopeIdentity: conclusion.scopeIdentity,
    windowKey,
    derivation: { rule, refs },
  };
  for (const key of Object.keys(rendered) as (keyof RenderedConclusion)[]) {
    const value = rendered[key];
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(rendered);
}
