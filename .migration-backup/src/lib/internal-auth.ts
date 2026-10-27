/**
 * Internal service authentication.
 *
 * Arena has two entry legs (see docs/archive-assistant-integration.md):
 *
 *   Browser  ──(user auth: the existing app-wide posture)──▶ /api/chat
 *   Service  ──(internal credential: THIS module)──────────▶ /api/internal/chat
 *
 * The internal credential is `ARENA_INTERNAL_API_KEY`, a server-only shared
 * secret. It is NEVER sent to the browser: the browser chat flow does not
 * use an Authorization header at all (BYOK keys travel in the JSON body),
 * so any Bearer on the reasoning route is either this credential or a user
 * token being forwarded to Archive Assistant.
 *
 * The secret authenticates machine callers such as Archive Assistant's
 * `arenaCanonicalClient`, which already sends
 * `Authorization: Bearer $ARENA_CANONICAL_API_KEY` when that variable is set
 * on the Archive Assistant side — set both variables to the same value and
 * the bridge is authenticated with no Archive Assistant code changes.
 *
 * Fails closed: when the key is not configured, the internal route answers
 * 503 rather than accepting unauthenticated service traffic. Missing and
 * wrong secrets produce the identical 401 response (no oracle).
 */

import { timingSafeEqual } from "node:crypto";

export type InternalAuthState =
  | { status: "not_configured" }
  | { status: "ok" }
  | { status: "missing" }
  | { status: "invalid" };

type EnvLike = Record<string, string | undefined>;

export function getInternalApiKey(env: EnvLike = process.env): string | null {
  const key = env.ARENA_INTERNAL_API_KEY?.trim();
  return key ? key : null;
}

/** Constant-time secret comparison that also tolerates length mismatch
 *  without short-circuiting the length signal into a timing oracle. */
export function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Burn an equivalent-length comparison before reporting failure.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Evaluate the request against the internal credential. */
export function internalAuthState(req: Request, env: EnvLike = process.env): InternalAuthState {
  const key = getInternalApiKey(env);
  if (!key) return { status: "not_configured" };
  const token = bearerToken(req);
  if (token === null) return { status: "missing" };
  return secretsEqual(token, key) ? { status: "ok" } : { status: "invalid" };
}

/** Uniform 401 for missing AND wrong secrets: a caller cannot probe which
 *  part failed. */
export function internalUnauthorizedResponse(): Response {
  return Response.json(
    { ok: false, error: "unauthorized_internal_caller", message: "A valid internal service credential is required." },
    { status: 401 },
  );
}

export function internalNotConfiguredResponse(): Response {
  return Response.json(
    {
      ok: false,
      error: "internal_auth_not_configured",
      message: "ARENA_INTERNAL_API_KEY is not set on the server; the internal service route is disabled.",
    },
    { status: 503 },
  );
}
