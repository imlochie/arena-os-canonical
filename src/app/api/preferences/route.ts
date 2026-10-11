import { addPreference, listPreferences } from "@/lib/preferences";

export const dynamic = "force-dynamic";

// GET → all owner preferences & boundaries (newest first)
export async function GET() {
  try {
    const preferences = await listPreferences();
    return Response.json({ preferences });
  } catch (e) {
    console.error(e);
    return Response.json({ preferences: [] });
  }
}

// POST → remember a preference/boundary/goal
// {content (required), kind? preference|boundary|goal, classification? public|internal|private}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const content = String(body.content ?? "").trim();
    if (!content) return Response.json({ error: "a preference needs content" }, { status: 400 });
    const preference = await addPreference({
      content,
      kind: typeof body.kind === "string" ? body.kind : undefined,
      classification: typeof body.classification === "string" ? body.classification : undefined,
      source: body.source === "assistant" ? "assistant" : "owner",
    });
    return Response.json({ preference }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "failed to remember preference" }, { status: 400 });
  }
}
