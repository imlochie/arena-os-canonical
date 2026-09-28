import { db } from "@/db";
import { models, modelCategoryRatings } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { ensureSeeded } from "@/lib/seed";
import { eloCIHalfWidth, isProvisional, winProbability } from "@/lib/ratings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureSeeded();
  const url = new URL(req.url);
  const category = (url.searchParams.get("category") ?? "overall").toString();
  try {
    if (category === "overall") {
      const rows = await db.select().from(models).orderBy(desc(models.elo));
      const top = rows[0]?.elo ?? 1200;
      return Response.json({
        category: "overall",
        leaderboard: rows.map((r) => ({
          ...r,
          ci: eloCIHalfWidth(r.battles ?? 0),
          provisional: isProvisional(r.battles ?? 0),
          expectedVsTop: Math.round(winProbability((r.elo ?? 1200) - top) * 1000) / 10,
        })),
      });
    }
    const all = await db.select().from(models);
    const catRows = await db
      .select()
      .from(modelCategoryRatings)
      .where(eq(modelCategoryRatings.category, category));
    const byModel = new Map(catRows.map((r) => [r.modelId, r]));
    const merged = all
      .map((m) => {
        const c = byModel.get(m.id);
        const elo = c?.elo ?? 1200;
        const b = c?.battles ?? 0;
        return {
          ...m,
          elo,
          battles: b,
          wins: c?.wins ?? 0,
          ties: c?.ties ?? 0,
          ci: eloCIHalfWidth(b),
          provisional: isProvisional(b),
          expectedVsTop: 0,
        };
      })
      .sort((a, b) => b.elo - a.elo);
    const top = merged[0]?.elo ?? 1200;
    for (const m of merged) m.expectedVsTop = Math.round(winProbability(m.elo - top) * 1000) / 10;
    return Response.json({ category, leaderboard: merged });
  } catch (e) {
    console.error(e);
    return Response.json({ category, leaderboard: [] });
  }
}
