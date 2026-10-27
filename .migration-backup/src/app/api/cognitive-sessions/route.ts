import { db } from "@/db";
import { cognitiveSessions } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 100);
  const projectId = url.searchParams.get("projectId");

  try {
    const base = db.select().from(cognitiveSessions);
    const rows = projectId
      ? await base.where(eq(cognitiveSessions.projectId, projectId)).orderBy(desc(cognitiveSessions.createdAt)).limit(limit)
      : await base.orderBy(desc(cognitiveSessions.createdAt)).limit(limit);
    return Response.json({ sessions: rows });
  } catch (error) {
    console.error("cognitive sessions GET error", error);
    return Response.json({ sessions: [] });
  }
}
