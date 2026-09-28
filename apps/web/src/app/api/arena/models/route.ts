import { db } from "@/db";
import { models } from "@/db/schema";
import { FREE_MODELS } from "@/lib/models";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  try {
    const rows = await db.select().from(models);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const merged = FREE_MODELS.map((m) => {
      const dbRow = byId.get(m.id);
      return {
        ...m,
        elo: dbRow?.elo ?? 1200,
        battles: dbRow?.battles ?? 0,
        wins: dbRow?.wins ?? 0,
        ties: dbRow?.ties ?? 0,
      };
    });
    return Response.json({ models: merged });
  } catch {
    return Response.json({
      models: FREE_MODELS.map((m) => ({ ...m, elo: 1200, battles: 0, wins: 0, ties: 0 })),
    });
  }
}
