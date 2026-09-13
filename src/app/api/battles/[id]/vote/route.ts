import { db } from "@/db";
import { battles, models, modelCategoryRatings } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { newElos, type BattleOutcome } from "@/lib/elo";
import { apiErrorResponse, validationError } from "@/lib/apiErrors";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const winner = body.winner as BattleOutcome;
    if (!["a", "b", "tie", "both-bad"].includes(winner)) {
      return validationError("INVALID_REQUEST", "Winner is invalid.");
    }
    const rows = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    const battle = rows[0];
    if (!battle) return validationError("SESSION_NOT_FOUND", "Requested execution was not found.", 404, "session");
    if (battle.winner) {
      // already voted — just reveal (one vote per battle, LMArena rule)
      return Response.json({ battle, alreadyVoted: true });
    }

    const [rowA] = await db.select().from(models).where(eq(models.id, battle.modelAId)).limit(1);
    const [rowB] = await db.select().from(models).where(eq(models.id, battle.modelBId)).limit(1);
    const eloA = rowA?.elo ?? 1200;
    const eloB = rowB?.elo ?? 1200;
    const next = newElos(eloA, eloB, winner);

    await db.update(battles).set({ winner }).where(eq(battles.id, id));

    if (rowA) {
      await db
        .update(models)
        .set({
          elo: next.a,
          battles: (rowA.battles ?? 0) + 1,
          wins: (rowA.wins ?? 0) + (winner === "a" ? 1 : 0),
          ties: (rowA.ties ?? 0) + (winner === "tie" ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(models.id, battle.modelAId));
    }
    if (rowB) {
      await db
        .update(models)
        .set({
          elo: next.b,
          battles: (rowB.battles ?? 0) + 1,
          wins: (rowB.wins ?? 0) + (winner === "b" ? 1 : 0),
          ties: (rowB.ties ?? 0) + (winner === "tie" ? 1 : 0),
          updatedAt: new Date(),
        })
        .where(eq(models.id, battle.modelBId));
    }

    // ---- Per-category Elo (powers category leaderboards) ----
    const cat = battle.category || "general";
    for (const [modelId, side] of [
      [battle.modelAId, "a"],
      [battle.modelBId, "b"],
    ] as const) {
      const existing = await db
        .select()
        .from(modelCategoryRatings)
        .where(and(eq(modelCategoryRatings.modelId, modelId), eq(modelCategoryRatings.category, cat)))
        .limit(1);
      const row = existing[0];
      const myElo = row?.elo ?? 1200;
      // Category Elo updates against the opponent's *category* Elo (or 1200 baseline)
      const oppExisting = await db
        .select()
        .from(modelCategoryRatings)
        .where(
          and(
            eq(modelCategoryRatings.modelId, side === "a" ? battle.modelBId : battle.modelAId),
            eq(modelCategoryRatings.category, cat)
          )
        )
        .limit(1);
      const oppElo = oppExisting[0]?.elo ?? 1200;
      const ordered = side === "a" ? newElos(myElo, oppElo, winner) : newElos(oppElo, myElo, winner);
      const myNext = side === "a" ? ordered.a : ordered.b;
      const won = (side === "a" && winner === "a") || (side === "b" && winner === "b");
      if (row) {
        await db
          .update(modelCategoryRatings)
          .set({
            elo: myNext,
            battles: (row.battles ?? 0) + 1,
            wins: (row.wins ?? 0) + (won ? 1 : 0),
            ties: (row.ties ?? 0) + (winner === "tie" ? 1 : 0),
            updatedAt: new Date(),
          })
          .where(and(eq(modelCategoryRatings.modelId, modelId), eq(modelCategoryRatings.category, cat)));
      } else {
        await db.insert(modelCategoryRatings).values({
          modelId,
          category: cat,
          elo: myNext,
          battles: 1,
          wins: won ? 1 : 0,
          ties: winner === "tie" ? 1 : 0,
        });
      }
    }

    const [updated] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
    return Response.json({ battle: updated, elo: { [battle.modelAId]: next.a, [battle.modelBId]: next.b } });
  } catch (e) {
    console.error(e);
    return apiErrorResponse(e, { code: "VOTE_PERSISTENCE_FAILED", message: "Unable to persist vote.", stage: "persistence", retryable: true });
  }
}
