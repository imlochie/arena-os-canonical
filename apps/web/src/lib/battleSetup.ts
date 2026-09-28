import { db } from "@/db";
import { assistants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { FREE_MODELS, getModel, randomImagePair, randomPair } from "./models";

export interface FighterInput {
  type?: "model" | "assistant";
  id?: string;
}

export interface Side {
  modelId: string;
  assistantId?: string;
  assistantName?: string;
  sys: string;
}

export interface ResolvedSetup {
  a: Side;
  b: Side;
  sampling: string;
  category: string;
}

function validTextModel(id?: string): boolean {
  const m = FREE_MODELS.find((x) => x.id === id);
  return !!m && m.kind === "text";
}

function validImageModel(id?: string): boolean {
  const m = FREE_MODELS.find((x) => x.id === id);
  return !!m && m.kind === "image";
}

async function resolveSide(
  f: FighterInput | undefined,
  isImage: boolean,
  legacyModelId?: string
): Promise<Side | null> {
  const input: FighterInput = f ?? (legacyModelId ? { type: "model", id: legacyModelId } : {});
  if (!input.id) return null;

  if (input.type === "assistant" && !isImage) {
    try {
      const [a] = await db.select().from(assistants).where(eq(assistants.id, input.id)).limit(1);
      if (a && validTextModel(a.baseModel)) {
        return { modelId: a.baseModel, assistantId: a.id, assistantName: a.name, sys: a.systemPrompt };
      }
    } catch {
      /* fall through */
    }
    return null;
  }
  // model (or unknown → validate kind)
  if (isImage && validImageModel(input.id)) {
    return { modelId: input.id, sys: `You are ${getModel(input.id).name}.` };
  }
  if (!isImage && validTextModel(input.id)) {
    return {
      modelId: input.id,
      sys: `You are ${getModel(input.id).name}. Answer helpfully with markdown formatting. Be concise but complete.`,
    };
  }
  return null;
}

/**
 * Resolve both fighters from a battle request body.
 * Supports legacy {modelAId, modelBId} and new {fighterA:{type,id}, fighterB}.
 * Assistant battles credit the assistant's base model for Elo (documented).
 */
export async function resolveFighters(body: any): Promise<ResolvedSetup> {
  const category = (body.category ?? "general").toString();
  const isImage = category === "image";
  let sampling = "targeted";

  let a = await resolveSide(body.fighterA, isImage, body.modelAId);
  let b = await resolveSide(body.fighterB, isImage, body.modelBId);

  if (!a || !b || (a.modelId === b.modelId && a.assistantId === b.assistantId)) {
    const [m1, m2] = isImage ? randomImagePair() : randomPair();
    a = {
      modelId: m1.id,
      sys: isImage ? `You are ${m1.name}.` : `You are ${m1.name}. Answer helpfully with markdown formatting. Be concise but complete.`,
    };
    b = {
      modelId: m2.id,
      sys: isImage ? `You are ${m2.name}.` : `You are ${m2.name}. Answer helpfully with markdown formatting. Be concise but complete.`,
    };
    sampling = "uniform-random";
  }

  return { a, b, sampling, category };
}

/** Position-bias mitigation: randomly assign which side appears left (A) vs right (B). */
export function assignSides(setup: ResolvedSetup): { left: Side; right: Side; swapped: boolean } {
  if (Math.random() < 0.5) {
    return { left: setup.a, right: setup.b, swapped: false };
  }
  return { left: setup.b, right: setup.a, swapped: true };
}
