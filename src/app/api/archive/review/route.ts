import { decideReviewItem, listReviewItems, type ReviewDecision } from "@/lib/mediaArchive/review";

export const dynamic = "force-dynamic";

// GET → the review workload (merged Archive Assistant's findings)
export async function GET() {
  try {
    const items = await listReviewItems();
    return Response.json({ items });
  } catch (e) {
    console.error(e);
    return Response.json({ items: [] });
  }
}

// POST {id, decision: approve|reject|reopen} — records the human's call;
// nothing is renamed, moved, deleted or downloaded.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "bad_input", message: "JSON body required." }, { status: 400 });
  }
  const id = Number(body.id ?? 0);
  const decision = String(body.decision ?? "") as ReviewDecision;
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ error: "bad_input", message: "id must be a positive integer." }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject" && decision !== "reopen") {
    return Response.json({ error: "bad_input", message: "decision must be approve, reject or reopen." }, { status: 400 });
  }
  const item = await decideReviewItem(id, decision);
  if (!item) {
    return Response.json({ error: "not_found", message: "Review item not found." }, { status: 404 });
  }
  return Response.json({ item });
}
