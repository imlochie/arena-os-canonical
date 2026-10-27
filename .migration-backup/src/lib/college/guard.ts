// ===========================================================================
// LAYER 9 — THE GUARD
// ===========================================================================
// One choke point. Every College route asks the same question in the same
// way, so there is exactly one place to audit and exactly one place to get it
// wrong.
//
// Design notes worth keeping:
//
// 1. FAILURE IS EXPLICIT. A refused call says which capability was required,
//    which surface asked, and why the answer was no. Silent 404s and vague
//    403s make a security boundary unauditable, and §FAILURE says no silent
//    degradation.
//
// 2. LOCAL DEVELOPMENT IS NOT A BACKDOOR. When COLLEGE_AUTH_MODE is unset and
//    the request is from loopback, the guard grants control_room — but it
//    *says so* in the response and logs it. The moment COLLEGE_AUTH_MODE=strict
//    is set (as it must be for any deployment) loopback gets no privilege.
//    A backdoor you forget about is the one that matters.
//
// 3. THE GUARD NEVER CONSULTS THE BRIEFING, THE LEDGER, OR FACULTY. Authority
//    is structural, not interpretive. Nothing a model says can widen it.
// ===========================================================================

import { db } from "@/db";
import { collegeDevices } from "@/db/college";
import { eq } from "drizzle-orm";
import {
  hashToken,
  surfaceCan,
  REFUSAL,
  type Capability,
  type Surface,
} from "./surfaces";

export interface Caller {
  surface: Surface;
  deviceId: string | null;
  deviceName: string;
  /** True when authority came from loopback dev mode rather than a token. */
  development: boolean;
}

export interface GuardFailure {
  ok: false;
  status: 401 | 403;
  body: {
    error: string;
    required: Capability;
    surface: Surface | null;
    note: string;
  };
}

export type GuardResult = { ok: true; caller: Caller } | GuardFailure;

/** Strict mode is mandatory anywhere the College is reachable off-device. */
function strictMode(): boolean {
  return process.env.COLLEGE_AUTH_MODE === "strict";
}

function isLoopback(req: Request): boolean {
  // The Host header is the only thing that reliably distinguishes a developer
  // hitting localhost from a phone on the internet.
  //
  // Note on x-forwarded-for: Next.js sets it to 127.0.0.1 on *every* request,
  // including direct loopback ones, so treating its presence as "came via a
  // proxy" rejects the local developer too. Instead the forwarded chain is
  // checked for any address that is NOT loopback — that is what actually
  // indicates the request travelled.
  const h = req.headers;
  const host = (h.get("host") ?? "").split(":")[0];
  const hostIsLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!hostIsLocal) return false;

  const chain = `${h.get("x-forwarded-for") ?? ""},${h.get("x-real-ip") ?? ""}`;
  const hops = chain
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const anyRemote = hops.some(
    (ip) => ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1"
  );
  return !anyRemote;
}

function bearer(req: Request): string | null {
  const raw = req.headers.get("authorization") ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve who is calling. Returns null when no valid credential is present.
 * Also stamps last_seen_at, which is the only write the guard ever performs —
 * it is device telemetry, not institutional history, and deliberately does not
 * touch the event ledger.
 */
export async function identify(req: Request): Promise<Caller | null> {
  const token = bearer(req);
  if (token) {
    const rows = await db
      .select()
      .from(collegeDevices)
      .where(eq(collegeDevices.tokenHash, hashToken(token)))
      .limit(1);
    const device = rows[0];
    if (!device) return null;
    if (device.revokedAt) return null;

    void db
      .update(collegeDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(collegeDevices.id, device.id))
      .catch(() => {});

    return {
      surface: (device.surface as Surface) ?? "campus",
      deviceId: device.id,
      deviceName: device.name,
      development: false,
    };
  }

  if (!strictMode() && isLoopback(req)) {
    return {
      surface: "control_room",
      deviceId: null,
      deviceName: "local development",
      development: true,
    };
  }

  return null;
}

/**
 * The call every route makes.
 *
 *   const g = await guard(req, "edit_curriculum");
 *   if (!g.ok) return refuse(g);
 */
export async function guard(req: Request, required: Capability): Promise<GuardResult> {
  const caller = await identify(req);

  if (!caller) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "Not a paired surface.",
        required,
        surface: null,
        note: "The College only speaks to devices that have been paired from the Control Room. Send Authorization: Bearer <token>.",
      },
    };
  }

  if (!surfaceCan(caller.surface, required)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: REFUSAL[required],
        required,
        surface: caller.surface,
        note: `The "${caller.surface}" surface does not hold "${required}". This is a structural ceiling: it cannot be granted per-device, and no credential widens it.`,
      },
    };
  }

  return { ok: true, caller };
}

/** Turn a guard failure into a Response. Kept separate so routes stay terse. */
export function refuse(f: GuardFailure): Response {
  return Response.json(f.body, { status: f.status });
}
