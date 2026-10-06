/**
 * Local context shims for the ported Waveyard routes.
 *
 * The original Waveyard app is multi-user with sessions and project roles.
 * Arena OS is a local-first, single-owner app with no auth subsystem, so the
 * ported routes resolve the same call shapes against a fixed local owner who
 * owns every project. Every actor column honestly records LOCAL_OWNER_ID.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/waveyardSchema";

export const LOCAL_OWNER_ID = "00000000-0000-4000-8000-000000000001";

export type LocalUser = {
  id: string;
  username: string;
  displayName: string;
  /** The local owner holds every platform role, including moderation. */
  platformRole: "moderator";
};

/** Always resolves: the local owner is the single authenticated user. */
export async function requireUser(): Promise<LocalUser> {
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
  _userId: string,
  projectId: string,
  _minimumRole: "viewer" | "editor" | "owner",
): Promise<{ project: typeof projects.$inferSelect; role: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    throw new Response(JSON.stringify({ error: "Project not found." }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return { project, role: "owner" };
}
