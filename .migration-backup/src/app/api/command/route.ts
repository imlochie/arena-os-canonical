import { db } from "@/db";
import {
  artifacts,
  battles,
  collabs,
  councilRuns,
  projectMemory,
  projects,
} from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

// GET → Command Centre intelligence: active projects, recent activity,
// decisions / open questions / artifacts / contradiction signals.
export async function GET() {
  try {
    const projs = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(12);
    const [decisions] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectMemory)
      .where(eq(projectMemory.kind, "decision"));
    const [openQ] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projectMemory)
      .where(eq(projectMemory.kind, "open_question"));
    const [arts7] = await db.select({ n: sql<number>`count(*)::int` }).from(artifacts);
    const [bothBad] = await db
      .select({ n: sql<number>`count(*) filter (where winner = 'both-bad')::int` })
      .from(battles);
    const [ties] = await db
      .select({ n: sql<number>`count(*) filter (where winner = 'tie')::int` })
      .from(battles);

    const [recentBattles, recentCollabs, recentCouncils, recentArtifacts] = await Promise.all([
      db.select().from(battles).orderBy(desc(battles.createdAt)).limit(5),
      db.select().from(collabs).orderBy(desc(collabs.createdAt)).limit(5),
      db.select().from(councilRuns).orderBy(desc(councilRuns.createdAt)).limit(5),
      db.select().from(artifacts).orderBy(desc(artifacts.createdAt)).limit(8),
    ]);

    // Per-project pulse
    const pulse = await Promise.all(
      projs.slice(0, 6).map(async (p) => {
        const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(artifacts).where(eq(artifacts.projectId, p.id));
        const [d] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(projectMemory)
          .where(sql`${projectMemory.projectId} = ${p.id} AND ${projectMemory.kind} = 'decision'`);
        const [q] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(projectMemory)
          .where(sql`${projectMemory.projectId} = ${p.id} AND ${projectMemory.kind} = 'open_question'`);
        return { ...p, artifacts: a?.n ?? 0, decisions: d?.n ?? 0, openQuestions: q?.n ?? 0 };
      })
    );

    return Response.json({
      projects: pulse,
      intelligence: {
        decisions: decisions?.n ?? 0,
        openQuestions: openQ?.n ?? 0,
        artifacts: arts7?.n ?? 0,
        contradictions: (bothBad?.n ?? 0) + (ties?.n ?? 0),
        bothBad: bothBad?.n ?? 0,
        ties: ties?.n ?? 0,
      },
      recent: {
        battles: recentBattles.map((b) => ({ id: b.id, prompt: b.prompt.slice(0, 120), winner: b.winner, projectId: b.projectId, createdAt: b.createdAt })),
        collabs: recentCollabs.map((c) => ({ id: c.id, challenge: c.challenge.slice(0, 120), strategy: c.strategy, projectId: c.projectId, createdAt: c.createdAt })),
        councils: recentCouncils.map((c) => ({ id: c.id, jobId: c.jobId, material: c.material.slice(0, 120), projectId: c.projectId, createdAt: c.createdAt })),
        artifacts: recentArtifacts,
      },
    });
  } catch (e) {
    console.error(e);
    return Response.json({ projects: [], intelligence: { decisions: 0, openQuestions: 0, artifacts: 0, contradictions: 0, bothBad: 0, ties: 0 }, recent: { battles: [], collabs: [], councils: [], artifacts: [] } });
  }
}
