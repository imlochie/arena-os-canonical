/**
 * One smart collection: PATCH renames / switches match mode / replaces
 * rules; DELETE removes it. Both are owner-scoped.
 */

import { NextResponse } from "next/server";
import { isUuid } from "@/lib/api/ids";
import { requireUser } from "@/lib/waveyard/local-context";
import { deleteSmartCollection, updateSmartCollection } from "@/lib/waveyard/library/service";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
    }
    const { name, match, rules } = body as { name?: unknown; match?: unknown; rules?: unknown };
    if (name === undefined && match === undefined && rules === undefined) {
      return NextResponse.json({ error: "Provide name, match, and/or rules." }, { status: 400 });
    }
    if (name !== undefined && (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 64)) {
      return NextResponse.json({ error: "name must be 1..64 characters." }, { status: 400 });
    }
    if (match !== undefined && match !== "all" && match !== "any") {
      return NextResponse.json({ error: "match must be 'all' or 'any'." }, { status: 400 });
    }
    const collection = await updateSmartCollection(user.id, id, {
      name: typeof name === "string" ? name.replace(/\s+/g, " ").trim() : undefined,
      match: match === "all" || match === "any" ? match : undefined,
      rules,
    });
    if (collection === null) return NextResponse.json({ error: "Collection not found or invalid patch." }, { status: 404 });
    return NextResponse.json({ collection });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const removed = await deleteSmartCollection(user.id, id);
    if (!removed) return NextResponse.json({ error: "Collection not found." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
