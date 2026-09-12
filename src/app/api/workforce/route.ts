import { db } from "@/db";
import { modelCategoryRatings, models } from "@/db/schema";
import { desc } from "drizzle-orm";
import { WORKFORCE_ROLES } from "@/lib/workforce";

export const dynamic = "force-dynamic";

// GET → roles + live model recommendations (Elo-informed).
// Models are interchangeable workers: the OS picks the best available
// model for each role based on category Elo.
export async function GET() {
  try {
    const all = await db.select().from(models).orderBy(desc(models.elo));
    const cats = await db.select().from(modelCategoryRatings);
    const catBest = new Map<string, string>(); // category -> top model id
    for (const c of cats) {
      const cur = catBest.get(c.category);
      if (!cur) {
        catBest.set(c.category, c.modelId);
        continue;
      }
      const curRow = cats.find((x) => x.category === c.category && x.modelId === cur);
      if ((c.elo ?? 1200) > (curRow?.elo ?? 1200)) catBest.set(c.category, c.modelId);
    }
    const overallBest = all[0]?.id ?? "openai";
    const roles = WORKFORCE_ROLES.map((r) => {
      // Prefer: category leader if it's in the role's shortlist, else shortlist head, else overall best.
      const leader = catBest.get(r.eloCategory);
      const recommended =
        (leader && r.preferredModels.includes(leader) ? leader : null) ??
        r.preferredModels[0] ??
        overallBest;
      const rec = all.find((m) => m.id === recommended);
      return {
        ...r,
        recommendedModel: recommended,
        recommendedElo: rec?.elo ?? 1200,
        basis: leader && r.preferredModels.includes(leader) ? `category leader (${r.eloCategory})` : "role shortlist",
      };
    });
    return Response.json({ roles, overallBest, models: all.map((m) => ({ id: m.id, name: m.name, elo: m.elo })) });
  } catch (e) {
    console.error(e);
    return Response.json({
      roles: WORKFORCE_ROLES.map((r) => ({
        ...r,
        recommendedModel: r.preferredModels[0] ?? "openai",
        recommendedElo: 1200,
        basis: "default shortlist",
      })),
      overallBest: "openai",
      models: [],
    });
  }
}
