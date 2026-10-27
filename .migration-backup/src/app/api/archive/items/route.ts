import { addArchiveItems, archiveStats, listArchiveItems, updateArchiveItem } from "@/lib/archive";

export const dynamic = "force-dynamic";

// GET → list/search the archive index: ?q=&kind=&status=&collection=&limit=
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const [items, stats] = await Promise.all([
      listArchiveItems({
        q: url.searchParams.get("q") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        collection: url.searchParams.get("collection") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 100) || 100,
      }),
      archiveStats(),
    ]);
    return Response.json({ items, stats });
  } catch (e) {
    console.error(e);
    return Response.json({ items: [], stats: null });
  }
}

// POST → register files: {files: [{name, kind?, sizeBytes?, path?, contentHash?, collection?}]}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const files = Array.isArray(body.files) ? body.files : [];
    const cleaned = files
      .filter((f: unknown) => f && typeof f === "object" && String((f as { name?: unknown }).name ?? "").trim())
      .slice(0, 200);
    if (!cleaned.length) return Response.json({ error: "files[] with at least one name required" }, { status: 400 });
    const { added, duplicates } = await addArchiveItems(cleaned);
    return Response.json({ added, duplicates }, { status: 201 });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed to add items" }, { status: 500 });
  }
}

// PATCH → edit one item: {id, description?, tags?, collection?, status?, kind?}
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = String(body.id ?? "");
    if (!id) return Response.json({ error: "id required" }, { status: 400 });
    const item = await updateArchiveItem(id, {
      description: typeof body.description === "string" ? body.description : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      collection: typeof body.collection === "string" ? body.collection : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      kind: typeof body.kind === "string" ? body.kind : undefined,
    });
    if (!item) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ item });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "failed to update item" }, { status: 500 });
  }
}
