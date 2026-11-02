/**
 * Local context shims for the ported Waveyard routes.
 *
 * Desktop and development requests retain the single local-owner context.
 * Hosted production requests resolve the owner from a verified WebAuthn
 * session. The fixed owner ID remains the bootstrap identity for existing
 * local library data.
 */

import { and, eq } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@workspace/db";
import { LOCAL_OWNER_ID as SCHEMA_LOCAL_OWNER_ID } from "@workspace/db/schema";
import { projects } from "@workspace/db/waveyardSchema";
import { authenticatedRequestIdentity } from "../requestIdentity";

/** Canonical definition lives in @/db/schema (the schema owns its ids);
 *  re-exported here because the ported Waveyard routes import it from this
 *  module. */
export const LOCAL_OWNER_ID = SCHEMA_LOCAL_OWNER_ID;
const requestContext = new AsyncLocalStorage<Request>();

/** Keep request identity available to the legacy route signatures. */
export function withWaveyardRequestContext<T>(
  request: Request,
  callback: () => T,
): T {
  return requestContext.run(request, callback);
}

export type LocalUser = {
  id: string;
  username: string;
  displayName: string;
  /** The local owner holds every platform role, including moderation. */
  platformRole: "moderator";
};

/**
 * Desktop mode is protected by the API server's loopback-only request gate.
 * Development keeps the local-owner shim for local iteration. Hosted
 * production requests must resolve a verified WebAuthn session.
 */
export async function requireUser(): Promise<LocalUser> {
  const trustedLocalMode = process.env.ARENA_DESKTOP_MODE === "1"
    || process.env.NODE_ENV === "development"
    || process.env.NODE_ENV === "test";
  if (!trustedLocalMode) {
    const request = requestContext.getStore();
    if (!request) {
      throw new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    try {
      const identity = await authenticatedRequestIdentity(request);
      return {
        id: identity.ownerId,
        username: "owner",
        displayName: "Private owner",
        platformRole: "moderator",
      };
    } catch {
      throw new Response(JSON.stringify({ error: "Authentication required." }), {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
  }
  return {
    id: LOCAL_OWNER_ID,
    username: "local-owner",
    displayName: "Local owner",
    platformRole: "moderator",
  };
}

/**
 * Project roles collapse to "owner" locally. Kept async with the original
 * return shape ({ project, role }) so ported route bodies stay line-for-line
 * identical to the originals. Throws Response (404/403) like the original
 * permissions module; ported routes already route those through.
 */
export async function requireProjectRole(
  userId: string,
  projectId: string,
  _minimumRole: "viewer" | "editor" | "owner",
): Promise<{ project: typeof projects.$inferSelect; role: string }> {
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
    .limit(1);
  if (!project) {
    throw new Response(JSON.stringify({ error: "Project not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return { project, role: "owner" };
}
