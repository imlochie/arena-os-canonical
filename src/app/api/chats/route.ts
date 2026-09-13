import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { chats, chatMessages, assistants } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { generate, type ChatMsg } from "@/lib/ai";
import { getModel } from "@/lib/models";
import { isEphemeralBody, isLocalOnlyBody, logPrivacyEvent } from "@/lib/privacy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const rows = await db.select().from(chats).orderBy(desc(chats.createdAt)).limit(30);
    return Response.json({ chats: rows });
  } catch (e) {
    console.error(e);
    return Response.json({ chats: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const mode = body.mode as "create" | "message";
    const keys = body.keys;
    const localOnly = isLocalOnlyBody(body);
    const ephemeral = isEphemeralBody(body);
    const genKeys = localOnly ? undefined : keys;

    // Ephemeral chats: stateless, never persisted. Client keeps the transcript.
    if (ephemeral) {
      const history: ChatMsg[] = Array.isArray(body.history) ? body.history : [];
      const message: string = (body.message ?? "").toString().trim();
      if (!message && history.length === 0) {
        return standardApiError("INVALID_REQUEST", "Message required.", 400);
      }
      const modelId = (body.modelId ?? "openai").toString();
      getModel(modelId);
      let system: string | undefined;
      let effectiveModel = modelId;
      if (body.assistantId) {
        const [a] = await db
          .select()
          .from(assistants)
          .where(eq(assistants.id, String(body.assistantId)))
          .limit(1);
        if (a) {
          system = a.systemPrompt;
          effectiveModel = a.baseModel;
        }
      }
      const full: ChatMsg[] = [...history.slice(-20), ...(message ? [{ role: "user" as const, content: message }] : [])];
      const result = await generate({
        modelId: effectiveModel,
        messages: full,
        system,
        temperature: body.temperature ?? 0.7,
        keys: genKeys,
        localOnly,
      });
      await logPrivacyEvent("ephemeral_chat", `localOnly=${localOnly}`);
      return Response.json({ ephemeral: true, reply: result.text, via: result.via, ms: result.ms, localOnly }, { status: 201 });
    }

    if (mode === "create" || (!body.chatId && body.message)) {
      const modelId = (body.modelId ?? "openai").toString();
      const assistantId: string | undefined = body.assistantId;
      const message: string = (body.message ?? "").toString().trim();
      if (!message) return standardApiError("INVALID_REQUEST", "Message required.", 400);
      getModel(modelId);

      let system: string | undefined;
      let effectiveModel = modelId;
      if (assistantId) {
        const [a] = await db.select().from(assistants).where(eq(assistants.id, assistantId)).limit(1);
        if (a) {
          system = a.systemPrompt;
          effectiveModel = a.baseModel;
        }
      }

      const title = message.length > 60 ? message.slice(0, 60) + "…" : message;
      const [chat] = await db
        .insert(chats)
        .values({ title, modelId: effectiveModel, assistantId: assistantId ?? null, projectId: body.projectId ? String(body.projectId) : null })
        .returning();
      await db.insert(chatMessages).values({ chatId: chat.id, role: "user", content: message });

      const history: ChatMsg[] = [{ role: "user", content: message }];
      const temp = body.temperature ?? 0.7;
      const result = await generate({ modelId: effectiveModel, messages: history, system, temperature: temp, keys: genKeys, localOnly });
      await db.insert(chatMessages).values({ chatId: chat.id, role: "assistant", content: result.text });

      return Response.json({ chat, reply: result.text, via: result.via, ms: result.ms, localOnly }, { status: 201 });
    }

    // mode === 'message'
    const chatId: string = body.chatId;
    const message: string = (body.message ?? "").toString().trim();
    if (!chatId || !message) return standardApiError("INVALID_REQUEST", "ChatId + message required.", 400);

    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    if (!chat) return standardApiError("RESOURCE_NOT_FOUND", "Chat not found.", 404);

    let system: string | undefined;
    if (chat.assistantId) {
      const [a] = await db.select().from(assistants).where(eq(assistants.id, chat.assistantId)).limit(1);
      if (a) system = a.systemPrompt;
    }

    await db.insert(chatMessages).values({ chatId, role: "user", content: message });
    const prior = await db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId));
    // sort by createdAt asc and take last 20
    prior.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
    const history: ChatMsg[] = prior
      .slice(-20)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const result = await generate({
      modelId: chat.modelId,
      messages: history,
      system,
      temperature: body.temperature ?? 0.7,
      keys: genKeys,
      localOnly,
    });
    await db.insert(chatMessages).values({ chatId, role: "assistant", content: result.text });
    return Response.json({ reply: result.text, via: result.via, ms: result.ms, localOnly });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Chat failed.", 500);
  }
}
