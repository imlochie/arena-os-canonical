/**
 * DELETE /api/streaming/accounts/[id] — disconnect a streaming library.
 * Snapshots cascade away with the account (they are that account's
 * backups); exported files already on your disk are yours.
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { streamingAccounts } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { isUuid } from "@/lib/api/ids";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const deleted = await db
      .delete(streamingAccounts)
      .where(and(eq(streamingAccounts.id, id), eq(streamingAccounts.ownerId, user.id)))
      .returning({ id: streamingAccounts.id });
    if (deleted.length === 0) return NextResponse.json({ error: "No such connected library." }, { status: 404 });
    return NextResponse.json({ disconnected: deleted[0].id });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("streaming account disconnect failed", error);
    return NextResponse.json({ error: "Could not disconnect the library." }, { status: 500 });
  }
}
