import { db } from "@/db";
import { assistants } from "@/db/schema";
import { eq } from "drizzle-orm";
import { FREE_MODELS, getModel, randomImagePair, randomPair } from "./models";
import { resolveModelId } from "./runtime";

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
  const m = FREE_MODELS.find((x) => x.id === (id ? resolveModelId(id) : id));
  return !!m && m.kind === "text";
}

function validImageModel(id?: string): boolean {
  const m = FREE_MODELS.find((x) => x.id === (id ? resolveModelId(id) : id));
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
  // model (or unknown → validate kind). Legacy aliases resolve first so old
  // selections (e.g. "offline-sage") land on their honest execution target
  // instead of invalidating the battle into a random pair.
  const resolvedId = input.id ? resolveModelId(input.id) : undefined;
  if (isImage && validImageModel(resolvedId)) {
    return { modelId: resolvedId as string, sys: `You are ${getModel(resolvedId as string).name}.` };
  }
  if (!isImage && validTextModel(resolvedId)) {
    return {
      modelId: resolvedId as string,
      sys: `You are ${getModel(resolvedId as string).name}. Answer helpfully with markdown formatting. Be concise but complete.`,
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

  // Identical selections normally re-roll into a random pair (openai vs
  // openai is a pointless fight). EXCEPT local-engine-backed picks: silently
  // swapping a Local Engine battle for a random cloud pair would be a bait &
  // switch. Keep them so the route's same-engine guard can refuse honestly.
  const sameEnginePick =
    !!a && !!b && a.modelId === b.modelId && getModel(a.modelId).backend === "arena-local-engine";

  if (!a || !b || (a.modelId === b.modelId && a.assistantId === b.assistantId && !sameEnginePick)) {
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
