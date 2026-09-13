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
  privacyEvents,
  promptTemplates,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { DATA_POLICY } from "@/lib/privacy";

export const dynamic = "force-dynamic";

// GET → data inventory: what is stored where (right-to-know).
export async function GET() {
  try {
    const count = async (table: any) => {
      const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
      return r?.n ?? 0;
    };
    const [battlesN, msgsN, collabsN, contribsN, chatsN, chatMsgsN, asstN, tplN, eventsN, arcadeN, councilN, councilArtN] =
      await Promise.all([
        count(battles),
        count(battleMessages),
        count(collabs),
        count(collabContributions),
        count(chats),
        count(chatMessages),
        count(assistants),
        count(promptTemplates),
        count(privacyEvents),
        count(arcadeGames),
        count(councilRuns),
        count(councilArtifacts),
      ]);
    let dbBytes: number | null = null;
    try {
      const res = await db.execute(sql`select pg_database_size(current_database())::int as b`);
      const rows = (res as unknown as { rows?: { b?: number }[] }).rows;
      dbBytes = rows?.[0]?.b ?? null;
    } catch {}
    const [voted] = await db
      .select({ n: sql<number>`count(*) filter (where winner is not null)::int` })
      .from(battles);
    return Response.json({
      policy: DATA_POLICY,
      stored: {
        battles: battlesN,
        battleMessages: msgsN,
        votes: voted?.n ?? 0,
        collabs: collabsN,
        collabContributions: contribsN,
        chats: chatsN,
        chatMessages: chatMsgsN,
        assistants: asstN,
        templates: tplN,
        arcade: arcadeN,
        councilRuns: councilN,
        councilArtifacts: councilArtN,
        auditEvents: eventsN,
      },
      dbBytes,
      residency: "local-postgres-only",
      training: "never",
    });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Summary failed.", 500);
  }
}
