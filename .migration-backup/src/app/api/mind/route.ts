import { NextResponse } from "next/server";

import { createMindItem, deleteMindItem, listMindItems, toggleFavorite, updateItemTags } from "@/lib/mind";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET ?q=&kind=&tag=&favorites=1 — the wall's data. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  try {
    const items = await listMindItems({
      q: params.get("q") ?? undefined,
      kind: params.get("kind") ?? undefined,
      tag: params.get("tag") ?? undefined,
      favoritesOnly: params.get("favorites") === "1",
    });
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [], error: "mind unavailable (database)" }, { status: 200 });
  }
}

/** POST {text, kind?, color?, name?, path?, keys?} — capture anything. */
export async function POST(req: Request) {
  let body: { text?: string; kind?: string; color?: string; name?: string; path?: string; favorite?: boolean; keys?: Record<string, string> } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text && !body.path) return NextResponse.json({ error: "text (or a file path) is required" }, { status: 400 });
  try {
    const item = await createMindItem(
      {
        text: text || body.name || "saved file",
        kind: body.kind as never,
        color: body.color,
        name: body.name,
        path: body.path,
        favorite: body.favorite,
      },
      { keys: body.keys },
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "capture failed" }, { status: 500 });
  }
}

/** PATCH {id, favorite?|tags?} — star or retag. */
export async function PATCH(req: Request) {
  let body: { id?: string; favorite?: boolean; tags?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    if (Array.isArray(body.tags)) {
      const item = await updateItemTags(body.id, body.tags);
      if (!item) return NextResponse.json({ error: "item not found" }, { status: 404 });
      return NextResponse.json({ item });
    }
    const favorite = await toggleFavorite(body.id);
    if (favorite === null) return NextResponse.json({ error: "item not found" }, { status: 404 });
    return NextResponse.json({ favorite });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "update failed" }, { status: 500 });
  }
}

/** DELETE ?id= */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return NextResponse.json({ removed: await deleteMindItem(id) });
}
