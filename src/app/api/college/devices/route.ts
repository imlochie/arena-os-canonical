// ===========================================================================
// LAYER 9 — DEVICE PAIRING
// ===========================================================================
// How a phone becomes a recognised surface of the College.
//
// The enrolment authority is physical possession of the Control Room. You
// generate a code at the desk, type it into the phone within ten minutes, and
// the phone receives a long-lived token exactly once. There is no password, no
// email, no account recovery — because there is one student and inventing a
// user-account system would be building the generic school-management
// application the founder explicitly rejected.
// ===========================================================================

import { db } from "@/db";
import { collegeDevices, collegePairingCodes } from "@/db/college";
import { desc, eq } from "drizzle-orm";
import { guard, refuse } from "@/lib/college/guard";
import {
  mintPairingCode,
  mintToken,
  timingSafeEqual,
  PAIRING_CODE_TTL_MINUTES,
  SURFACE_CEILING,
  type Surface,
} from "@/lib/college/surfaces";

export const dynamic = "force-dynamic";

// GET → the roster of paired devices. Control Room only: knowing which
// devices can reach the institution is itself administrative information.
export async function GET(req: Request) {
  const g = await guard(req, "institutional_decision");
  if (!g.ok) return refuse(g);

  const devices = await db
    .select()
    .from(collegeDevices)
    .orderBy(desc(collegeDevices.createdAt));

  return Response.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      surface: d.surface,
      platform: d.platform,
      tokenHint: d.tokenHint ? `…${d.tokenHint}` : "",
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      revokedReason: d.revokedReason,
      capabilities: SURFACE_CEILING[(d.surface as Surface) ?? "campus"],
    })),
    note: "Tokens are stored as hashes and cannot be shown again. A lost device is handled by revoking, not by recovering.",
  });
}

// POST → two actions.
//   {action:"pair_code"}                     Control Room: mint a pairing code.
//   {action:"redeem", code, name, platform}  Phone: exchange it for a token.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  // ---- redeem: deliberately UNGUARDED ------------------------------------
  // This is the one endpoint an unpaired device may call, because it is the
  // only way to become paired. Its security is the code itself: 8 characters
  // of ~5 bits each, single-use, and dead in ten minutes.
  if (action === "redeem") {
    const code = String(body.code ?? "").trim().toUpperCase();
    const name = String(body.name ?? "").trim();
    if (!code) return Response.json({ error: "code required" }, { status: 400 });
    if (!name) return Response.json({ error: "name required" }, { status: 400 });

    const rows = await db
      .select()
      .from(collegePairingCodes)
      .where(eq(collegePairingCodes.code, code))
      .limit(1);
    const found = rows[0];

    // One refusal for every failure mode. Distinguishing "no such code" from
    // "expired code" would tell an attacker which guesses were once real.
    const invalid = Response.json(
      {
        error: "That pairing code is not valid.",
        note: "Codes are single-use and expire after ten minutes. Generate a new one from the Control Room.",
      },
      { status: 401 }
    );
    if (!found) return invalid;
    if (!timingSafeEqual(found.code, code)) return invalid;
    if (found.usedAt) return invalid;
    if (found.expiresAt.getTime() < Date.now()) return invalid;

    const { token, hash, hint } = mintToken();
    const [device] = await db
      .insert(collegeDevices)
      .values({
        name,
        surface: found.surface,
        tokenHash: hash,
        tokenHint: hint,
        platform: String(body.platform ?? "unknown"),
      })
      .returning();

    await db
      .update(collegePairingCodes)
      .set({ usedAt: new Date(), usedByDeviceId: device.id })
      .where(eq(collegePairingCodes.id, found.id));

    return Response.json(
      {
        token,
        device: {
          id: device.id,
          name: device.name,
          surface: device.surface,
          capabilities: SURFACE_CEILING[(device.surface as Surface) ?? "campus"],
        },
        note: "This token is shown exactly once. Store it in the device keychain. If it is lost, revoke the device and pair again.",
      },
      { status: 201 }
    );
  }

  // ---- everything else is Control Room ------------------------------------
  const g = await guard(req, "institutional_decision");
  if (!g.ok) return refuse(g);

  if (action === "pair_code") {
    const surface = (String(body.surface ?? "campus") as Surface);
    if (surface !== "campus" && surface !== "control_room") {
      return Response.json({ error: "surface must be campus or control_room" }, { status: 400 });
    }
    const code = mintPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60_000);
    await db.insert(collegePairingCodes).values({ code, surface, expiresAt });
    return Response.json(
      {
        code,
        surface,
        expiresAt,
        capabilities: SURFACE_CEILING[surface],
        note: `Type this into the device within ${PAIRING_CODE_TTL_MINUTES} minutes. It works once.`,
      },
      { status: 201 }
    );
  }

  return Response.json({ error: `unknown action "${action}"` }, { status: 400 });
}

// PATCH → revoke. Immediate, permanent, and the only answer to a lost phone.
export async function PATCH(req: Request) {
  const g = await guard(req, "institutional_decision");
  if (!g.ok) return refuse(g);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const id = String(body.id ?? "");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const [updated] = await db
    .update(collegeDevices)
    .set({
      revokedAt: new Date(),
      revokedReason: String(body.reason ?? "revoked from the Control Room"),
    })
    .where(eq(collegeDevices.id, id))
    .returning();

  if (!updated) return Response.json({ error: "no such device" }, { status: 404 });

  return Response.json({
    device: { id: updated.id, name: updated.name, revokedAt: updated.revokedAt },
    note: "Revocation takes effect on the next request. The device row is kept, not deleted — which devices were trusted, and when that ended, is part of the record.",
  });
}
