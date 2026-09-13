import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { artifacts, battles, collabs, councilRuns, projectMemory, projects } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const STARTERS = [
  { name: "LOCO PRØD", emoji: "🎛️", description: "Tracks, visuals, lore, formats, publishing strategy." },
  { name: "Personal Systems", emoji: "⚙️", description: "Notion systems, curriculum, governance, automations." },
  { name: "Media Archive", emoji: "🗂️", description: "Screen & media archive, taxonomy, retrieval." },
];

export async function GET() {
  try {
    let rows = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(50);
    if (rows.length === 0) {
      await db.insert(projects).values(STARTERS);
      rows = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(50);
    }
    // Attach counts per project
    const withCounts = await Promise.all(
      rows.map(async (p) => {
        const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(battles).where(eq(battles.projectId, p.id));
        const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(collabs).where(eq(collabs.projectId, p.id));
        const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(councilRuns).where(eq(councilRuns.projectId, p.id));
        const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(artifacts).where(eq(artifacts.projectId, p.id));
        const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(projectMemory).where(eq(projectMemory.projectId, p.id));
        return { ...p, counts: { battles: b?.n ?? 0, collabs: c?.n ?? 0, councils: r?.n ?? 0, artifacts: a?.n ?? 0, memory: m?.n ?? 0 } };
      })
    );
    return Response.json({ projects: withCounts });
  } catch (e) {
    console.error(e);
    return Response.json({ projects: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = (body.name ?? "").toString().trim().slice(0, 80);
    if (!name) return standardApiError("INVALID_REQUEST", "Name required.", 400);
    const description = (body.description ?? "").toString().slice(0, 500);
    const emoji = (body.emoji ?? "📁").toString().slice(0, 8);
    const [row] = await db.insert(projects).values({ name, description, emoji }).returning();
    return Response.json({ project: row }, { status: 201 });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Create failed.", 500);
  }
}
