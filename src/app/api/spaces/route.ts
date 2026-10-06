import { createSpace, listSpaces } from "@/lib/spaces";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const spaces = await listSpaces();
    return Response.json({ spaces });
  } catch {
    return Response.json({ spaces: [] });
  }
}

// POST → create a space {title, emoji?, prompt, modelId?, intervalMinutes?, briefcase?, projectId?}
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const space = await createSpace({
      title: String(body?.title ?? "Untitled space"),
      emoji: body?.emoji ? String(body.emoji) : undefined,
      prompt: String(body?.prompt ?? ""),
      modelId: body?.modelId ? String(body.modelId) : undefined,
      intervalMinutes: body?.intervalMinutes ? Number(body.intervalMinutes) : undefined,
      briefcase: body?.briefcase ? String(body.briefcase) : "",
      projectId: body?.projectId ? String(body.projectId) : null,
    });
    return Response.json({ space }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "create failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
