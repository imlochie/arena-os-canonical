import { db } from "@/db";
import { councilArtifacts } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET → artifact library across all council runs
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 30), 60);
  try {
    const rows = await db.select().from(councilArtifacts).orderBy(desc(councilArtifacts.createdAt)).limit(limit);
    return Response.json({ artifacts: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ artifacts: [] });
  }
}
