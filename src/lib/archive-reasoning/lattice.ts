/**
 * Gate 7, slice 7.1: the epistemic lattice, executable.
 *
 * The deterministic core of the reasoning layer —
 *
 *   Evidence → C1–C5 calculus → Bounded Conclusion (ceiling + scope +
 *   window + derivation) → (later slices) Renderer
 *
 * deliberately contains no interpretation: it computes certainty floors
 * and refuses illegitimate constructions. Nothing here calls a model, a
 * clock, a random source, or the network; the same arguments always
 * produce a byte-identical conclusion.
 *
 * Design authority: docs/archive-reasoning-layer.md §2 (C1–C5).
 */

import type {
  Conclusion,
  ConclusionKind,
  DerivationRecord,
  EpistemicStatus,
  EvidenceCollectionKey,
  EvidencePack,
  EvidenceRef,
  RejectKind,
  WindowIdentity,
} from "./types";
import { CONCLUSION_KINDS, EVIDENCE_COLLECTION_KEYS, POSITIVE_KINDS } from "./types";

export { CONCLUSION_KINDS, EVIDENCE_COLLECTION_KEYS };
export type { Conclusion, EvidenceRef, RejectKind, WindowIdentity } from "./types";

/** Calculator error: the calculus refuses, with the violated rule named. */
export class ReasoningRejectError extends Error {
  readonly rejectKind: RejectKind;

  constructor(rejectKind: RejectKind, message: string) {
    super(message);
    this.name = "ReasoningRejectError";
    this.rejectKind = rejectKind;
  }
}

/* ------------------------------ C1 · ceiling ----------------------------- */

const EPISTEMIC_RANK: Record<EpistemicStatus, number> = {
  observed: 3,
  derived: 2,
  "coverage-limited": 1,
  unknown: 0,
};

export function rankStatus(status: EpistemicStatus): number {
  return EPISTEMIC_RANK[status];
}

/** The status an evidence item actually carries. A missing or unrecognized
 *  status FLOORS to `unknown` — it is never estimated into something
 *  higher. (Explicit preferences carry no status in the current contract;
 *  they therefore cannot ground positive claims yet.) */
export function statusOf(item: unknown): EpistemicStatus {
  const raw = (item as { epistemicStatus?: unknown } | null)?.epistemicStatus;
  return typeof raw === "string" && raw in EPISTEMIC_RANK ? (raw as EpistemicStatus) : "unknown";
}

/** The minimum of a non-empty set of statuses. Empty input is a lineage
 *  violation (C4), not an `observed` conclusion. */
export function minStatus(statuses: readonly EpistemicStatus[]): EpistemicStatus {
  if (statuses.length === 0) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a conclusion needs at least one load-bearing evidence item (C4)",
    );
  }
  return statuses.reduce((a, b) => (rankStatus(a) <= rankStatus(b) ? a : b));
}

/* --------------------- C3 · window identity, no merging ------------------- */

/** Canonical, content-based window identity (key order and extra noise
 *  fields do not matter; presence/absence of the three identity fields
 *  does). */
export function windowIdentity(window: WindowIdentity): string {
  return JSON.stringify({
    label: window.label ?? null,
    startsAt: window.startsAt ?? null,
    endsAt: window.endsAt ?? null,
  });
}

/** C3: windows union only by being identical. Anything else would be a
 *  merged window wearing a false provenance — the canonical lie the
 *  upstream direction doc forbids. */
export function unionWindow(windows: readonly WindowIdentity[]): WindowIdentity {
  if (windows.length === 0) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a window union needs at least one window (C3)",
    );
  }
  const first = windowIdentity(windows[0]);
  for (const window of windows.slice(1)) {
    if (windowIdentity(window) !== first) {
      throw new ReasoningRejectError(
        "window_merge",
        `windows with different identities cannot be silently merged: ${first} vs ${windowIdentity(window)}`,
      );
    }
  }
  return windows[0];
}

function windowHasIdentity(window: WindowIdentity): boolean {
  return Boolean(window.label?.trim() || window.startsAt?.trim() || window.endsAt?.trim());
}

/* ----------------------------- references -------------------------------- */

function resolveRef(pack: EvidencePack, ref: EvidenceRef): Record<string, unknown> {
  if (!(EVIDENCE_COLLECTION_KEYS as readonly string[]).includes(ref.collection)) {
    throw new ReasoningRejectError(
      "bad_reference",
      `evidence collection "${String(ref.collection)}" is not one of the seven load-bearing collections`,
    );
  }
  const items = pack.evidence[ref.collection as EvidenceCollectionKey] as readonly unknown[];
  const item = items?.[ref.index];
  if (!item || typeof item !== "object") {
    throw new ReasoningRejectError(
      "bad_reference",
      `no evidence item at ${ref.collection}[${ref.index}] in this pack`,
    );
  }
  if (ref.signalId != null && (item as { signalId?: unknown }).signalId !== ref.signalId) {
    throw new ReasoningRejectError(
      "bad_reference",
      `signalId mismatch at ${ref.collection}[${ref.index}]: ref names ${ref.signalId}`,
    );
  }
  return item as Record<string, unknown>;
}

/* ------------------------------ the builder ------------------------------- */

export type BuildConclusionArgs<TClaim = Record<string, unknown>> = {
  readonly kind: ConclusionKind;
  readonly pack: EvidencePack;
  /** Which deterministic rule produced this conclusion (e.g. "restate.v1"). */
  readonly rule: string;
  /** The evidence the conclusion stands on. Empty means no conclusion. */
  readonly loadBearing: readonly EvidenceRef[];
  readonly window: WindowIdentity;
  /** Optional: explicit scope. When omitted, the common declared scope of
   *  the evidence is used; when supplied, no evidence may declare a
   *  different one (C3 — never exceed the evidence's own scope). */
  readonly scopeIdentity?: string;
  readonly claim?: TClaim;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Build a bounded conclusion or throw ReasoningRejectError.
 *
 *  C1  epistemicStatus is computed as the minimum load-bearing status —
 *      there is deliberately no way to pass one in.
 *  C2  a positive kind grounded (even partly) on `unknown` is void.
 *  C3  window is caller-declared per rule; scope is derived-or-checked
 *      and may never exceed the evidence's declared scope.
 *  C4  rule + non-empty, resolvable load-bearing refs are mandatory.
 *  C5  refs may only address the seven evidence collections. */
export function buildConclusion<TClaim = Record<string, unknown>>(
  args: BuildConclusionArgs<TClaim>,
): Conclusion<TClaim> {
  if (!(CONCLUSION_KINDS as readonly string[]).includes(args.kind)) {
    throw new ReasoningRejectError("void_claim", `unknown conclusion kind "${String(args.kind)}"`);
  }
  if (!args.rule.trim()) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a conclusion needs the deterministic rule that produced it (C4)",
    );
  }
  if (args.loadBearing.length === 0) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a conclusion needs at least one load-bearing evidence item (C4)",
    );
  }
  if (!windowHasIdentity(args.window)) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "a conclusion needs a window identity: label and/or bounds (C3)",
    );
  }

  const items = args.loadBearing.map((ref) => resolveRef(args.pack, ref));

  // C4 · provenance completeness (design §2): every load-bearing item must
  // carry at least one lineage handle sufficient to re-derive it —
  // derivedFrom, or a non-empty signalIds / eventIds / providerEventIds /
  // batchIds. The seam normally refuses such evidence at ingress; this
  // lattice is the defense-in-depth: anything that reaches it out-of-seam
  // still cannot ground a conclusion. Missing lineage ≠ usable evidence.
  for (const [position, item] of items.entries()) {
    const provenance = (item as { provenance?: unknown }).provenance;
    const record =
      provenance !== null && typeof provenance === "object"
        ? (provenance as Record<string, unknown>)
        : null;
    const hasHandle =
      record !== null &&
      (typeof record.derivedFrom === "string" && record.derivedFrom.trim().length > 0 ||
        ["signalIds", "eventIds", "providerEventIds", "batchIds"].some(
          (key) => Array.isArray(record[key]) && record[key].length > 0,
        ));
    if (!hasHandle) {
      const ref = args.loadBearing[position];
      throw new ReasoningRejectError(
        "lineage_incomplete",
        `load-bearing evidence ${ref.signalId ?? `${ref.collection}[${ref.index}]`} carries no lineage handle (C4 · provenance completeness); a conclusion that cannot name its derivation path is void`,
      );
    }
  }

  // C3 · scope: never broader than what the evidence declares.
  const declaredScopes = new Set(
    items
      .map((item) => item.scopeIdentity)
      .filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0),
  );
  let scopeIdentity: string;
  if (args.scopeIdentity != null && args.scopeIdentity.trim()) {
    if (![...declaredScopes].every((scope) => scope === args.scopeIdentity)) {
      throw new ReasoningRejectError(
        "scope_merge",
        `conclusion scope "${args.scopeIdentity}" exceeds the evidence's declared scope(s): ` +
          [...declaredScopes].join(", "),
      );
    }
    scopeIdentity = args.scopeIdentity;
  } else if (declaredScopes.size === 1) {
    scopeIdentity = [...declaredScopes][0];
  } else if (declaredScopes.size === 0) {
    throw new ReasoningRejectError(
      "lineage_incomplete",
      "no evidence declares a scope; the calling rule must supply scopeIdentity explicitly",
    );
  } else {
    throw new ReasoningRejectError(
      "scope_merge",
      `load-bearing evidence declares multiple scopes: ${[...declaredScopes].join(", ")}`,
    );
  }

  // C1 · computed ceiling; C2 · unknown ground voids positive claims.
  const statuses = items.map(statusOf);
  const ceiling = minStatus(statuses);
  if ((POSITIVE_KINDS as readonly string[]).includes(args.kind) && statuses.includes("unknown")) {
    throw new ReasoningRejectError(
      "void_claim",
      `positive kind "${args.kind}" cannot stand on unknown evidence (C2)`,
    );
  }

  const derivation: DerivationRecord = {
    rule: args.rule.trim(),
    loadBearing: args.loadBearing.map((ref) => ({ ...ref })),
  };

  return deepFreeze<Conclusion<TClaim>>({
    kind: args.kind,
    epistemicStatus: ceiling,
    scopeIdentity,
    window: { ...args.window },
    derivation,
    claim: (args.claim ?? ({} as TClaim)),
  });
}
