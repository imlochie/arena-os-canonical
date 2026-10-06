import { db } from "@/db";
import { models } from "@/db/schema";
import { FREE_MODELS, LOCAL_ENGINE_ID } from "@/lib/models";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "@/lib/runtime";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

const tierSummary = [
  { tier: "local-engine" as const, label: TIER_LABELS["local-engine"], description: TIER_DESCRIPTIONS["local-engine"], readyByDefault: true, requiresNetwork: false, defaultModelId: LOCAL_ENGINE_ID },
  { tier: "local-llm" as const, label: TIER_LABELS["local-llm"], description: TIER_DESCRIPTIONS["local-llm"], readyByDefault: false, requiresNetwork: false, defaultModelId: null },
  { tier: "remote-free" as const, label: TIER_LABELS["remote-free"], description: TIER_DESCRIPTIONS["remote-free"], readyByDefault: false, requiresNetwork: true, defaultModelId: null },
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
    return Response.json({ models: merged, tiers: tierSummary });
  } catch {
    return Response.json({
      models: FREE_MODELS.map((m) => ({ ...m, elo: 1200, battles: 0, wins: 0, ties: 0 })),
      tiers: tierSummary,
    });
  }
}
