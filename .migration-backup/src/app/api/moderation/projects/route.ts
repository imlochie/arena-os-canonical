import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  projects,
} from "@/db/waveyardSchema";
import { requireModerator } from "@/lib/waveyard/publication";

const STATUSES = new Set(["active", "reported", "hidden", "removed"]);

export async function GET(request: Request) {
  try {
    await requireModerator();
    const status = new URL(request.url).searchParams.get("status") ?? "reported";
    if (!STATUSES.has(status))
      return NextResponse.json({ error: "Unknown moderation status." }, { status: 422 });
    const rows = await db
      .select({
        id: projects.id,
        title: projects.title,
        visibility: projects.visibility,
        publicationStatus: projects.publicationStatus,
        moderationStatus: projects.moderationStatus,
        updatedAt: projects.updatedAt,
        creatorDisplayName: sql`'Local owner'`,
      })
      .from(projects)
      .where(
        and(
          eq(projects.moderationStatus, status),
          eq(projects.publicationStatus, "published"),
        ),
      )
      .orderBy(desc(projects.updatedAt))
      .limit(100);
    return NextResponse.json({ projects: rows });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
