// ============================================================================
// Lochie Life College — coordination graph (SERVER ONLY)
// ============================================================================
// LAYER 6 §8 §9 §10 §11 §12.
//
// Coordination used to be protocol-level: the code knew that a factual
// uncertainty meant "run the researcher". That worked, but it meant the
// configuration the founder wrote was decorative — the sequence was hardcoded.
//
// This module resolves an explicit GRAPH of who may talk to whom, built from
// the effective policy of each serving member. Two rules:
//
//   1. Edges come from configuration, never from convenience. If the Critic
//      may not consult the Registrar, no runtime shortcut may invent that.
//   2. The graph is inspectable. "Why did the Instructor ask the Researcher?"
//      must be answerable by looking at an edge, not by reading the source.
//
// Edges are also intersected with institutional reality: a position that does
// not attend class cannot be consulted during one, no matter what a member's
// configuration says.
// ============================================================================

import type { EffectivePolicy } from "./attention-resolver";
import { getFacultyPosition } from "./faculty";

export type EdgeKind = "consult" | "defer" | "hand_off" | "interrupt" | "report" | "escalate";

/**
 * Targets that are NOT faculty positions.
 *
 * Deferring "whether the curriculum should change" to the founder is not a
 * broken edge — it is the single most important thing a faculty member can do
 * with a question that is not theirs to answer. These targets sit outside the
 * class, so the edge does not fire during teaching; it produces a governance
 * item (§31) at closure instead.
 */
export const EXTERNAL_AUTHORITIES: Record<string, string> = {
  founder: "The founder is the institutional authority for curriculum decisions.",
  "institutional authority":
    "Formal assessment and institutional determinations require authority the College has not delegated to faculty.",
  institution: "An institutional decision is required.",
};

export function isExternalAuthority(target: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_AUTHORITIES, target.toLowerCase().trim());
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Why this edge exists — configuration, position policy, or institution. */
  basis: string;
  /** The specific matter, for defer edges. */
  matter?: string;
}

export interface GraphNode {
  positionKey: string;
  memberName: string;
  /** Present in this class at all? */
  attending: boolean;
  /** Human description of what this node is for. */
  remit: string;
}

export interface CoordinationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Matters that leave the class entirely, because the position they belong
   * to is not a faculty position at all. These become governance items, not
   * runtime edges.
   */
  escalations: Array<{ from: string; to: string; matter: string; basis: string }>;
  /** Edges a member's configuration asked for that the institution refused. */
  refused: Array<{ from: string; to: string; kind: EdgeKind; reason: string }>;
  note: string;
}

/**
 * Build the coordination graph for one class.
 *
 * `policies` are the effective policies of the members actually serving.
 * Positions not in the map are not in the class, and cannot be reached.
 */
export function buildCoordinationGraph(
  policies: Map<string, EffectivePolicy>
): CoordinationGraph {
  const present = new Set(policies.keys());
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const escalations: CoordinationGraph["escalations"] = [];
  const refused: CoordinationGraph["refused"] = [];

  for (const [key, policy] of policies) {
    const position = getFacultyPosition(key);
    nodes.push({
      positionKey: key,
      memberName: policy.memberName || position?.name || key,
      attending: Boolean(position?.participatesInClass),
      remit: position?.remit ?? "",
    });
  }

  const addEdge = (
    from: string,
    to: string,
    kind: EdgeKind,
    basis: string,
    matter?: string
  ) => {
    // A matter that belongs to an authority outside the College's faculty
    // leaves the class. This is correct behaviour, not a missing edge.
    if (isExternalAuthority(to)) {
      if (!escalations.some((e) => e.from === from && e.to === to && e.matter === matter)) {
        escalations.push({
          from,
          to,
          matter: matter ?? "(unspecified)",
          basis: EXTERNAL_AUTHORITIES[to.toLowerCase().trim()],
        });
      }
      return;
    }
    // A target that is not in this class cannot be reached from it.
    if (!present.has(to)) {
      refused.push({
        from,
        to,
        kind,
        reason: `${to} is not serving in this class, so the edge cannot be used. Configure an assignment if this coordination is genuinely required.`,
      });
      return;
    }
    const target = getFacultyPosition(to);
    // Administration does not attend teaching. It RECEIVES, it does not consult.
    if (target && !target.participatesInClass && kind !== "report" && kind !== "hand_off") {
      refused.push({
        from,
        to,
        kind,
        reason: `${target.name} is ${target.branch} and does not attend teaching sessions. It can receive a hand-off or a report, but cannot be consulted mid-class.`,
      });
      return;
    }

    // The same boundary in the other direction, which matters more. A position
    // that does not attend class cannot reach INTO one — Administration must
    // not interrupt teaching or consult mid-lesson. It may still DEFER, because
    // deferral is how a position says "this matter is not mine", and routing a
    // teaching question back to the Instructor is exactly right.
    const origin = getFacultyPosition(from);
    if (origin && !origin.participatesInClass && kind !== "defer" && kind !== "hand_off") {
      refused.push({
        from,
        to,
        kind,
        reason: `${origin.name} is ${origin.branch} and does not attend teaching sessions, so it cannot ${kind} during one. Administration must not silently become teaching faculty.`,
      });
      return;
    }
    if (from === to) return;
    if (edges.some((e) => e.from === from && e.to === to && e.kind === kind)) return;
    edges.push({ from, to, kind, basis, matter });
  };

  for (const [key, policy] of policies) {
    const who = policy.memberName || key;

    for (const to of policy.mayConsult) {
      addEdge(
        key,
        to,
        "consult",
        policy.configurationApplied
          ? `${who} is configured to consult ${to}.`
          : `The ${key} position policy permits consulting ${to}.`
      );
    }

    for (const d of policy.deferMatters) {
      addEdge(
        key,
        d.to,
        "defer",
        `${who} defers "${d.matter}" to ${d.to}. Deferral is successful coordination, not failure.`,
        d.matter
      );
    }

    for (const to of policy.mayHandOffTo) {
      addEdge(key, to, "hand_off", `${who} may hand off to ${to} across a branch boundary.`);
    }

    if (policy.interruptionAuthority !== "none") {
      // Interruption is directed at whoever currently holds the floor, which in
      // practice is the instructor. It is an authority, not a free channel.
      addEdge(
        key,
        "instructor",
        "interrupt",
        `${who} holds "${policy.interruptionAuthority}" interruption authority.`
      );
    }
  }

  // Administration RECEIVES record-worthy events. This edge is institutional,
  // not configurable — the Registrar's remit is to be told.
  if (present.has("registrar")) {
    for (const key of present) {
      if (key === "registrar") continue;
      const p = getFacultyPosition(key);
      if (!p?.participatesInClass) continue;
      addEdge(
        key,
        "registrar",
        "report",
        "Record-worthy events reach Administration. This is institutional, not configurable."
      );
    }
  }

  return {
    nodes,
    edges,
    escalations,
    refused,
    note:
      "Edges come from member configuration and position policy. Faculty cannot communicate along an edge that does not exist here, and no runtime shortcut may invent one.",
  };
}

/** Can `from` consult `to` in this class? */
export function canConsult(graph: CoordinationGraph, from: string, to: string): boolean {
  return graph.edges.some((e) => e.from === from && e.to === to && e.kind === "consult");
}

/** Who does `from` defer this matter to, if anyone? */
export function deferTargetFor(
  graph: CoordinationGraph,
  from: string,
  eventType: string
): { to: string; matter: string } | null {
  const hit = graph.edges.find(
    (e) =>
      e.from === from &&
      e.kind === "defer" &&
      e.matter &&
      (e.matter === eventType || eventType.includes(e.matter) || e.matter.includes(eventType))
  );
  return hit ? { to: hit.to, matter: hit.matter! } : null;
}

/** Render the graph the way the brief draws it, for the inspector and CLI. */
export function renderGraph(graph: CoordinationGraph): string {
  const lines: string[] = [];
  const byFrom = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from)!.push(e);
  }
  for (const node of graph.nodes) {
    const out = byFrom.get(node.positionKey) ?? [];
    lines.push(node.memberName ? `${node.positionKey} (${node.memberName})` : node.positionKey);
    out.forEach((e, i) => {
      const last = i === out.length - 1;
      lines.push(`${last ? "└──" : "├──"} ${e.kind} → ${e.to}${e.matter ? ` ("${e.matter}")` : ""}`);
    });
    if (!out.length) lines.push("└── (no outgoing coordination)");
    lines.push("");
  }
  return lines.join("\n").trim();
}
