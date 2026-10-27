// ============================================================================
// Lochie Life College — faculty output contract (SERVER ONLY)
// ============================================================================
// LAYER 6 §32 §33 §34.
//
// A faculty member does not "reply". It returns a STRUCTURED PROPOSAL, and the
// runtime decides whether that proposal is permitted. This is the seam between
// "what a language model produced" and "what the institution allows to happen".
//
// The distinction matters because the alternative — letting model text flow
// straight into the College — is exactly how an institution loses control of
// its own records. Model output must never directly mutate curriculum,
// timetable, institutional history, authority, or faculty configuration.
//
// The contract is deliberately small and deliberately conservative:
//
//   ACTION     what the member wants to do
//   CONTENT    the substance
//   TARGET     who it is for
//   REASON     why
//   CONFIDENCE how sure
//   EVIDENCE   what it rests on
//
// Everything is parsed defensively. A model that ignores the format still
// produces a valid OBSERVE proposal rather than an error, because a garbled
// observation is recoverable and a crashed class is not.
// ============================================================================

import { hasAuthority, type AuthorityKey } from "./authority";
import { getFacultyPosition } from "./faculty";

/** What a faculty member can ask to do. Ordered least → most consequential. */
export const FACULTY_ACTIONS = [
  "observe",
  "speak",
  "consult",
  "defer",
  "propose",
  "record",
] as const;

export type FacultyAction = (typeof FACULTY_ACTIONS)[number];

export const ACTION_MEANING: Record<FacultyAction, string> = {
  observe: "Note something internally. Produces no student-facing output.",
  speak: "Address the student directly.",
  consult: "Ask another faculty member a bounded question.",
  defer: "Hand this matter to the position whose remit it actually falls in.",
  propose: "Offer something for institutional consideration. Never self-activating.",
  record: "Assert that something is record-worthy. Filing remains a separate act.",
};

/** Which authority each action requires before the runtime will execute it. */
const ACTION_REQUIRES: Record<FacultyAction, AuthorityKey | null> = {
  observe: "observe",
  speak: "teach",
  consult: null, // consultation is coordination, not authority
  defer: null, // deferral is coordination, not authority
  propose: null, // proposing is always allowed; activating never is
  record: "record",
};

export type Confidence = "high" | "moderate" | "low" | "uncertain";

export interface FacultyProposal {
  action: FacultyAction;
  content: string;
  /** "student" | "faculty:<key>" | "system" */
  target: string;
  reason: string;
  confidence: Confidence;
  evidence: string;
  /** True when the model did not supply a parseable contract and we inferred. */
  inferred: boolean;
}

export interface ValidatedOutput {
  proposal: FacultyProposal;
  /** Whether the runtime will carry out the requested action. */
  permitted: boolean;
  /** The action actually executed — may be downgraded from what was asked. */
  executedAction: FacultyAction;
  /** Why, in institutional terms. Always populated. */
  basis: string;
  /** Populated when the requested action was refused or downgraded. */
  refusal?: string;
  /** True when this came from the offline fallback, not a real model. */
  fallback: boolean;
  /** The raw `via` string from the AI layer, for the inspector. */
  via: string;
}

// ---------------------------------------------------------------------------
// The instruction given to the model
// ---------------------------------------------------------------------------

/**
 * Appended to a faculty member's task. Kept short deliberately: a long format
 * spec crowds out the actual teaching instruction, and the parser tolerates
 * failure anyway.
 */
export function outputContractInstruction(allowed: FacultyAction[]): string {
  return [
    "",
    "---",
    "",
    "END YOUR RESPONSE WITH A CONTRACT BLOCK, exactly in this form:",
    "",
    "[[ACTION: one of " + allowed.join(" | ") + "]]",
    "[[TARGET: student | faculty:<position> | system]]",
    "[[CONFIDENCE: high | moderate | low | uncertain]]",
    "[[REASON: one short sentence]]",
    "[[EVIDENCE: what this rests on, or \"none\"]]",
    "",
    "Everything before the block is your CONTENT. State your real confidence —",
    "uncertainty is a legitimate scholarly answer and is never penalised here.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TAG = (name: string, text: string): string | null => {
  const m = text.match(new RegExp(`\\[\\[\\s*${name}\\s*:\\s*([^\\]]*)\\]\\]`, "i"));
  return m ? m[1].trim() : null;
};

function coerceAction(raw: string | null, fallback: FacultyAction): FacultyAction {
  if (!raw) return fallback;
  const v = raw.toLowerCase().trim();
  const hit = FACULTY_ACTIONS.find((a) => v === a || v.startsWith(a));
  return hit ?? fallback;
}

function coerceConfidence(raw: string | null): Confidence {
  const v = (raw ?? "").toLowerCase().trim();
  if (v.startsWith("high")) return "high";
  if (v.startsWith("mod") || v.startsWith("med")) return "moderate";
  if (v.startsWith("low")) return "low";
  if (v.startsWith("unc")) return "uncertain";
  // No stated confidence is itself informative — do not invent "high".
  return "moderate";
}

/**
 * Parse a model response into a proposal.
 *
 * `defaultAction` is what the runtime asked this member to do, and is used
 * when the model returns no contract block at all. That is a normal outcome
 * for the offline fallback and must not be treated as an error.
 */
export function parseFacultyOutput(
  text: string,
  defaultAction: FacultyAction,
  defaultTarget: string
): FacultyProposal {
  const hasBlock = /\[\[\s*ACTION\s*:/i.test(text);
  const action = coerceAction(TAG("ACTION", text), defaultAction);
  const target = (TAG("TARGET", text) ?? defaultTarget).slice(0, 120);
  const reason = (TAG("REASON", text) ?? "").slice(0, 600);
  const evidence = (TAG("EVIDENCE", text) ?? "").slice(0, 1200);
  const confidence = coerceConfidence(TAG("CONFIDENCE", text));

  // Strip the contract block out of the student-facing content.
  const content = text
    .replace(/\[\[\s*(ACTION|TARGET|CONFIDENCE|REASON|EVIDENCE)\s*:[^\]]*\]\]/gi, "")
    .trim();

  return {
    action,
    content,
    target,
    reason: reason || (hasBlock ? "" : "No contract block returned; runtime applied the assigned action."),
    confidence,
    evidence: evidence && !/^none$/i.test(evidence) ? evidence : "",
    inferred: !hasBlock,
  };
}

// ---------------------------------------------------------------------------
// Validation — the runtime decides, not the model
// ---------------------------------------------------------------------------

/**
 * Validate a proposal against the member's actual authority.
 *
 * Refusal is never silent and never fatal. An action the member may not take
 * is DOWNGRADED to observation, with the content preserved, because the
 * thinking may still be worth keeping even when the act is not permitted.
 */
export function validateFacultyOutput(input: {
  proposal: FacultyProposal;
  positionKey: string;
  grantedAuthority: string[];
  /** Actions the runtime is willing to accept at this execution point. */
  allowedActions: FacultyAction[];
  via: string;
}): ValidatedOutput {
  const { proposal, positionKey, grantedAuthority, allowedActions, via } = input;
  const position = getFacultyPosition(positionKey);
  const name = position?.name ?? positionKey;
  const fallback = via.startsWith("local:") || via.startsWith("offline");

  const base = { proposal, fallback, via };

  // 1. Is this action available at this point in the runtime at all?
  if (!allowedActions.includes(proposal.action)) {
    return {
      ...base,
      permitted: false,
      executedAction: "observe",
      basis: `${name} proposed to ${proposal.action}, which is not one of the actions available at this point in the class.`,
      refusal: `Action "${proposal.action}" is not permitted here. Available: ${allowedActions.join(", ")}. The content is preserved as an observation.`,
    };
  }

  // 2. Does the member hold the authority the action requires?
  const needed = ACTION_REQUIRES[proposal.action];
  if (needed) {
    const check = hasAuthority(positionKey, grantedAuthority, needed);
    if (!check.allowed) {
      return {
        ...base,
        permitted: false,
        executedAction: "observe",
        basis: `${name} proposed to ${proposal.action}, which requires ${needed} authority.`,
        refusal: `${check.reason} The action was refused and the content retained as an observation. Personality and phrasing cannot create authority.`,
      };
    }
  }

  // 3. Recording is permitted, but it proposes — it never files.
  if (proposal.action === "record" && position && !position.mayFileRecords) {
    return {
      ...base,
      permitted: true,
      executedAction: "record",
      basis: `${name} may assert record-worthiness. Filing remains a separate explicit institutional act.`,
    };
  }

  return {
    ...base,
    permitted: true,
    executedAction: proposal.action,
    basis: `${name} is permitted to ${proposal.action} at this point.`,
  };
}

/**
 * How the fallback should be labelled wherever output is displayed.
 *
 * §34: fallback output is evidence that ROUTING worked. It is not evidence
 * about language quality, and must never be presented as though it were.
 */
export function executionLabel(via: string): {
  kind: "model" | "fallback";
  label: string;
  caution: string;
} {
  if (via.startsWith("local:") || via.startsWith("offline")) {
    return {
      kind: "fallback",
      label: "FALLBACK EXECUTION",
      caution:
        "Produced by the offline fallback engine, not a language model. This demonstrates routing, authority and state — it says nothing about the quality of teaching.",
    };
  }
  return {
    kind: "model",
    label: `MODEL EXECUTION (${via})`,
    caution: "",
  };
}
