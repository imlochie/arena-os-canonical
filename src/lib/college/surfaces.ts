// ===========================================================================
// LAYER 9 — INSTITUTIONAL SURFACES
// ===========================================================================
// "The iPhone should be another institutional surface, not another
// institution."
//
// This module is the seam that makes that sentence enforceable rather than
// aspirational. It deliberately reuses the shape of the Faculty authority
// model (§AUTHORITY: nine keys, hard ceilings, configuration may only
// subtract) because inventing a second, differently-shaped permission system
// is exactly how two institutions accidentally come into existence.
//
// THE RULE: a surface's ceiling is structural. No token, no configuration and
// no future feature may widen it. The phone can inhabit the College. It
// cannot administer it.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

/** The surfaces the College recognises. */
export type Surface = "campus" | "control_room";

/**
 * Capabilities, named after what the caller is *doing institutionally* rather
 * than after HTTP verbs. A verb-based model ("can POST") would drift out of
 * step with meaning the moment a route grew a second responsibility.
 */
export type Capability =
  | "read_state" // see the briefing, timetable, commitments, history
  | "run_session" // open, progress and close a class that the timetable already authorises
  | "record_commitment" // make and close your own commitments
  | "capture_evidence" // photograph a TAFE sheet; submit a quick capture
  | "record_external" // log a TAFE assessment/deadline the provider gave you
  | "edit_curriculum" // change what the College teaches
  | "edit_timetable" // change when the College teaches
  | "configure_faculty" // create, alter, archive faculty
  | "institutional_decision" // resolve governance, file records, decide conflicts
  | "bootstrap"; // reseed canon

/**
 * CEILINGS. The most a surface may ever do.
 *
 * The Campus ceiling is the interesting one. A phone in a pocket is the least
 * defensible device the College will ever talk to, and it is also the one most
 * likely to be used at 11pm with poor judgement. So it can do everything
 * required to *be a student* — arrive, study, commit, capture, report what
 * TAFE said — and nothing required to *be the institution*.
 *
 * Note what is deliberately absent from campus: editing curriculum, editing
 * the timetable, configuring faculty, making institutional decisions, and
 * bootstrap. Those are Control Room acts. This is the same separation the
 * founder drew between administering the institution and inhabiting it.
 */
export const SURFACE_CEILING: Record<Surface, Capability[]> = {
  campus: [
    "read_state",
    "run_session",
    "record_commitment",
    "capture_evidence",
    "record_external",
  ],
  control_room: [
    "read_state",
    "run_session",
    "record_commitment",
    "capture_evidence",
    "record_external",
    "edit_curriculum",
    "edit_timetable",
    "configure_faculty",
    "institutional_decision",
    "bootstrap",
  ],
};

/** Why a surface cannot do something — stated, never silent. */
export const REFUSAL: Record<Capability, string> = {
  read_state: "This surface may not read College state.",
  run_session:
    "This surface may not run sessions. The timetable authorises classes; the surface only enters them.",
  record_commitment:
    "This surface may not record commitments. Only the student commits, and only from a paired surface.",
  capture_evidence: "This surface may not submit evidence.",
  record_external:
    "This surface may not record external academic events.",
  edit_curriculum:
    "Curriculum is edited in the Control Room, not from the Campus. The founder is the institutional authority for curriculum decisions, and that authority is exercised deliberately at a desk — not from a phone.",
  edit_timetable:
    "The timetable is edited in the Control Room. Changing when the College teaches is an institutional act, not a convenience.",
  configure_faculty:
    "Faculty are configured in the Control Room. Who teaches, and with what authority, is not a phone decision.",
  institutional_decision:
    "Institutional decisions — governance, filing, resolving conflicts — are made in the Control Room where the full record is visible. A decision made from a summary is a decision made without the evidence.",
  bootstrap:
    "Bootstrap reseeds institutional canon. It is never available to a mobile surface.",
};

/** Does this surface structurally hold this capability? */
export function surfaceCan(surface: Surface, cap: Capability): boolean {
  return (SURFACE_CEILING[surface] ?? []).includes(cap);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Tokens are stored as SHA-256 hashes, never in plaintext. A stolen database
 * dump should not be a set of working keys.
 *
 * No salt+bcrypt here deliberately: these are 256-bit random tokens, not
 * user-chosen passwords, so they are not dictionary-attackable and the slow
 * hash buys nothing while costing latency on every single request.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function mintToken(): { token: string; hash: string; hint: string } {
  const token = `arena_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token), hint: token.slice(-6) };
}

/** Pairing codes are short enough to type from a screen, and die in minutes. */
export function mintPairingCode(): string {
  // Crockford-ish alphabet: no O/0, I/1, U. Misreading a code at arm's length
  // from a laptop screen is the expected failure mode, not an exotic one.
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3) out += "-";
  }
  return out;
}

export const PAIRING_CODE_TTL_MINUTES = 10;

/**
 * Constant-time string comparison. Token *lookup* is by hash so timing is
 * already uninteresting, but pairing codes are compared directly and are
 * short-lived, low-entropy and human-typed — exactly the shape where a timing
 * oracle is worth denying for free.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
