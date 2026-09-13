import { standardApiError } from "@/lib/apiErrors";
import { db } from "@/db";
import { chats, chatMessages } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [chat] = await db.select().from(chats).where(eq(chats.id, id)).limit(1);
    if (!chat) return standardApiError("RESOURCE_NOT_FOUND", "Not found.", 404);
    const msgs = await db.select().from(chatMessages).where(eq(chatMessages.chatId, id));
    msgs.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
    return Response.json({ chat, messages: msgs });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Failed.", 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.delete(chatMessages).where(eq(chatMessages.chatId, id));
    await db.delete(chats).where(eq(chats.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    console.error(e);
    return standardApiError("API_OPERATION_FAILED", "Failed.", 500);
  }
}
