import { db } from "@/db";
import { assistants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { FREE_MODELS, getModel } from "./models";

// Re-export client-safe strategy definitions for server convenience
export { STRATEGIES, getStrategy, type Strategy } from "./strategies";

export interface CollaboratorInput {
  type?: "model" | "assistant";
  id?: string;
}

export interface Collaborator {
  type: "model" | "assistant";
  id: string;
  label: string;
  emoji: string;
  modelId: string;
  assistantId?: string;
  sys: string;
  role: string; // assigned thinking role
}

function validTextModel(id?: string): boolean {
  const m = FREE_MODELS.find((x) => x.id === id);
  return !!m && m.kind === "text";
}

export async function resolveCollaborator(
  input: CollaboratorInput,
  role: string
): Promise<Collaborator | null> {
  if (!input.id) return null;
  if (input.type === "assistant") {
    try {
      const [a] = await db.select().from(assistants).where(eq(assistants.id, input.id)).limit(1);
      if (a && validTextModel(a.baseModel)) {
        const m = getModel(a.baseModel);
        return {
          type: "assistant",
          id: a.id,
          label: a.name,
          emoji: a.avatar,
          modelId: a.baseModel,
          assistantId: a.id,
          sys: `${a.systemPrompt}\n\n[Collaboration role: ${role}. ${m.name} engine.]`,
          role,
        };
      }
    } catch {}
    return null;
  }
  if (!validTextModel(input.id)) return null;
  const m = getModel(input.id);
  return {
    type: "model",
    id: m.id,
    label: m.name,
    emoji: m.emoji,
    modelId: m.id,
    sys: `You are ${m.name}, collaborating as "${role}" in a multi-AI council. ${m.description}`,
    role,
  };
}

export function randomCollaborators(n: number): CollaboratorInput[] {
  const pool = FREE_MODELS.filter((m) => m.kind === "text" && m.id !== "offline-sage");
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map((m) => ({ type: "model" as const, id: m.id }));
}
