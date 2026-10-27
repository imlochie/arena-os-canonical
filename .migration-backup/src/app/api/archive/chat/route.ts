import { runAssistant } from "@/lib/archiveAssistant";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST → one Archive Assistant turn: {messages, modelId?, keys?, localOnly?}
// Returns {reply, via, steps[]}.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMsgs
      .filter((m: unknown) => m && typeof m === "object")
      .map((m: { role?: unknown; content?: unknown }) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: String(m.content ?? "").slice(0, 12000),
      }))
      .filter((m: { content: string }) => m.content.trim().length > 0)
      .slice(-16);
    if (!messages.length) {
      return Response.json({ error: "messages[] required" }, { status: 400 });
    }
    const result = await runAssistant({
      messages,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
      keys: body.localOnly ? undefined : body.keys,
      localOnly: Boolean(body.localOnly),
    });
    return Response.json(result);
  } catch (e) {
    console.error(e);
    return Response.json({ error: "assistant turn failed" }, { status: 500 });
  }
}
