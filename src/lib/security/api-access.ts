/**
 * Access guard for state-changing / data-exposing API routes.
 *
 * Arena is single-owner: there is no per-record owner column on most tables,
 * so "authorisation" means "is this the owner (or the owner's machine)".
 * A request is allowed when ANY of these hold:
 *
 *  1. Local trust — desktop runtime (ARENA_DESKTOP_MODE=1) or a non-production
 *     dev server, AND the Host header is a loopback name. The Host check is
 *     what stops a LAN client (Host = LAN IP) and DNS-rebinding pages
 *     (Host = attacker.example) from inheriting local trust.
 *  2. A valid owner session cookie (WebAuthn-backed `arena_session`).
 *  3. The internal service bearer key (ARENA_INTERNAL_API_KEY).
 *
 * Everything else is denied with 401 (fail closed). A production server that
 * is not the desktop runtime therefore never grants anonymous access.
 */

import { internalAuthState } from "@/lib/internal-auth";
import { isLoopbackHost } from "./loopback-host";
export { isLoopbackHost };

type EnvLike = Record<string, string | undefined>;

export type AccessDecision =
  | { allowed: true; via: "local" | "session" | "internal" }
  | { allowed: false; status: 401 | 403; reason: string };

export interface AccessDeps {
  env?: EnvLike;
  /** Resolves when the request carries a valid owner session; rejects otherwise. */
  identity?: (req: Request) => Promise<unknown>;
}

function localTrustEnabled(env: EnvLike): boolean {
  return env.ARENA_DESKTOP_MODE === "1" || env.NODE_ENV !== "production";
}

export async function authorizeApiRequest(req: Request, deps: AccessDeps = {}): Promise<AccessDecision> {
  const env = deps.env ?? process.env;

  if (localTrustEnabled(env) && isLoopbackHost(req.headers.get("host"))) {
    return { allowed: true, via: "local" };
  }

  if (internalAuthState(req, env).status === "ok") return { allowed: true, via: "internal" };

  try {
    const identity = deps.identity ?? (async (r: Request) => (await import("@/lib/requestIdentity")).authenticatedRequestIdentity(r));
    await identity(req);
    return { allowed: true, via: "session" };
  } catch {
    return { allowed: false, status: 401, reason: "Authentication required." };
  }
}

/** Returns a Response to send when access is denied, or null when allowed. */
export async function requireApiAccess(req: Request, deps?: AccessDeps): Promise<Response | null> {
  const decision = await authorizeApiRequest(req, deps);
  if (decision.allowed) return null;
  return Response.json({ error: decision.reason }, { status: decision.status, headers: { "cache-control": "no-store" } });
}
