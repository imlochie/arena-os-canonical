import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import {
  arcadeGames,
  assistants,
  battleMessages,
  battles,
  chatMessages,
  chats,
  collabContributions,
  collabs,
  councilArtifacts,
  councilRuns,
  modelCategoryRatings,
  models,
  privacyEvents,
  promptTemplates,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DELETE → right to erasure. ?scope=all|battles|chats|collabs|arcade|council|library|audit&resetElo=1&confirm=yes
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") ?? "all";
    const resetElo = url.searchParams.get("resetElo") === "1";
    if (url.searchParams.get("confirm") !== "yes") {
      return standardApiError("ADD_CONFIRM_YES_TO_WIPE", "Add confirm=yes to wipe.", 400);
    }
    const deleted: Record<string, number> = {};
    const wipeTable = async (name: string, table: any) => {
      const rows = await db.delete(table).returning({ id: sql`1` });
      deleted[name] = rows.length;
    };

    if (scope === "all" || scope === "battles") {
      await wipeTable("battleMessages", battleMessages);
      await wipeTable("battles", battles);
    }
    if (scope === "all" || scope === "chats") {
      await wipeTable("chatMessages", chatMessages);
      await wipeTable("chats", chats);
    }
    if (scope === "all" || scope === "collabs") {
      await wipeTable("collabContributions", collabContributions);
      await wipeTable("collabs", collabs);
    }
    if (scope === "all" || scope === "arcade") {
      await wipeTable("arcade", arcadeGames);
    }
    if (scope === "all" || scope === "council") {
      await wipeTable("councilArtifacts", councilArtifacts);
      await wipeTable("councilRuns", councilRuns);
    }
    if (scope === "all" || scope === "library") {
      const tpl = await db.delete(promptTemplates).where(eq(promptTemplates.isDefault, false)).returning({ id: sql`1` });
      deleted["templates"] = tpl.length;
      // Assistants wipe removes user creations; starters regenerate on next load.
      await wipeTable("assistants", assistants);
    }
    if (scope === "all" || scope === "audit") {
      await wipeTable("audit", privacyEvents);
    }
    if (resetElo) {
      await db
        .update(models)
        .set({ elo: 1200, battles: 0, wins: 0, ties: 0, avgLatencyMs: 0, updatedAt: new Date() });
      const cats = await db.delete(modelCategoryRatings).returning({ id: sql`1` });
      deleted["categoryRatings"] = cats.length;
    }
    await logPrivacyEvent("wipe", `scope=${scope} resetElo=${resetElo} deleted=${JSON.stringify(deleted)}`);
    return Response.json({ ok: true, scope, resetElo, deleted });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Wipe failed.", 500);
  }
}
