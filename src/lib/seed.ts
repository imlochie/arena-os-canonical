import { db } from "@/db";
import { models } from "@/db/schema";
import { declaredModelCapabilities, FREE_MODELS, STRUCTURED_OUTPUT_MODELS } from "./models";

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
      availability: m.pollinationsId === "__offline__" ? "available" : "unknown",
      supportsStructuredOutput: STRUCTURED_OUTPUT_MODELS.has(m.id),
      capabilities: JSON.stringify(declaredModelCapabilities(m)),
    }));
    for (const r of rows) {
      await db
        .insert(models)
        .values(r)
        .onConflictDoUpdate({
          target: models.id,
          set: {
            name: r.name,
            provider: r.provider,
            description: r.description,
            supportsStructuredOutput: r.supportsStructuredOutput,
            capabilities: r.capabilities,
          },
        });
    }
  } catch {
    // seeding is best-effort (e.g. table not pushed yet in some envs)
    seeded = false;
  }
}
