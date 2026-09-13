import { db } from "@/db";
import { collabs, models, modelCategoryRatings } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

// POST → crown the most helpful contributor (small Elo signal, K=8, documented)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) {
      return validationError("INVALID_REQUEST", "Contributor index is required.");
    }
    const [collab] = await db.select().from(collabs).where(eq(collabs.id, id)).limit(1);
    if (!collab) return validationError("SESSION_NOT_FOUND", "Requested execution was not found.", 404, "session");
    if (collab.bestContributor !== null && collab.bestContributor !== undefined) {
      return validationError("INVALID_SESSION_STATE", "A contributor has already been crowned.", 409, "session");
    }
    const stored: any[] = JSON.parse(collab.collaborators || "[]");
    const winner = stored[index];
    if (!winner) return validationError("INVALID_REQUEST", "Contributor index is invalid.");

    await db.update(collabs).set({ bestContributor: index }).where(eq(collabs.id, id));

    // Small collaboration credit (not a battle win): +5 Elo, counts as a battle rep
    const modelId = winner.modelId as string;
    const [row] = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
    if (row) {
      await db
        .update(models)
        .set({
          elo: (row.elo ?? 1200) + 5,
          battles: (row.battles ?? 0) + 1,
          wins: (row.wins ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(models.id, modelId));
    }
    const cat = collab.category || "general";
    const [crow] = await db
      .select()
      .from(modelCategoryRatings)
      .where(and(eq(modelCategoryRatings.modelId, modelId), eq(modelCategoryRatings.category, cat)))
      .limit(1);
    if (crow) {
      await db
        .update(modelCategoryRatings)
        .set({ elo: (crow.elo ?? 1200) + 5, battles: (crow.battles ?? 0) + 1, wins: (crow.wins ?? 0) + 1, updatedAt: new Date() })
        .where(and(eq(modelCategoryRatings.modelId, modelId), eq(modelCategoryRatings.category, cat)));
    } else {
      await db.insert(modelCategoryRatings).values({ modelId, category: cat, elo: 1205, battles: 1, wins: 1 });
    }

    return Response.json({ ok: true, bestContributor: index, modelId, eloBonus: 5 });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "CROWN_PERSISTENCE_FAILED", message: "Unable to crown contributor.", stage: "persistence", retryable: true });
  }
}
