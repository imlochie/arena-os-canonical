import { db } from "@/db";
import { models } from "@/db/schema";
import { FREE_MODELS } from "./models";

let seeded = false;

export async function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  try {
    const rows = FREE_MODELS.map((m) => ({
      id: m.id,
      name: `${m.emoji} ${m.name}`,
      provider: m.provider,
      description: m.description,
      isFree: true,
    }));
    for (const r of rows) {
      await db
        .insert(models)
        .values(r)
        .onConflictDoUpdate({
          target: models.id,
          set: { name: r.name, provider: r.provider, description: r.description },
        });
    }
  } catch {
    // seeding is best-effort (e.g. table not pushed yet in some envs)
    seeded = false;
  }
}
