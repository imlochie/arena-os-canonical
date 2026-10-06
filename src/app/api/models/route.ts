import { db } from "@/db";
import { models } from "@/db/schema";
import { FREE_MODELS, LOCAL_ENGINE_ID } from "@/lib/models";
import { LEVEL_DESCRIPTIONS, LEVEL_LABELS, LEVEL_NUMBER } from "@/lib/runtime";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

const levelSummary = [
  { level: "arena-local" as const, number: LEVEL_NUMBER["arena-local"], label: LEVEL_LABELS["arena-local"], description: LEVEL_DESCRIPTIONS["arena-local"], readyByDefault: true, requiresNetwork: false, defaultModelId: LOCAL_ENGINE_ID },
  { level: "on-device" as const, number: LEVEL_NUMBER["on-device"], label: LEVEL_LABELS["on-device"], description: LEVEL_DESCRIPTIONS["on-device"], readyByDefault: false, requiresNetwork: false, defaultModelId: null },
  { level: "remote" as const, number: LEVEL_NUMBER["remote"], label: LEVEL_LABELS["remote"], description: LEVEL_DESCRIPTIONS["remote"], readyByDefault: false, requiresNetwork: true, defaultModelId: null },
];

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
    return Response.json({ models: merged, levels: levelSummary });
  } catch {
    return Response.json({
      models: FREE_MODELS.map((m) => ({ ...m, elo: 1200, battles: 0, wins: 0, ties: 0 })),
      levels: levelSummary,
    });
  }
}
