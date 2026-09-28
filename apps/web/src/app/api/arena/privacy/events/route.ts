import { db } from "@/db";
import { privacyEvents } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET → recent privacy audit events (metadata only, never content)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
  try {
    const rows = await db.select().from(privacyEvents).orderBy(desc(privacyEvents.createdAt)).limit(limit);
    return Response.json({ events: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ events: [] });
  }
}
