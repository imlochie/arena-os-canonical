/**
 * DELETE /api/streaming/accounts/[id] — disconnect a streaming library.
 * Snapshots cascade away with the account (they are that account's
 * backups); exported files already on your disk are yours.
 */


import { and, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { streamingAccounts } from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { isUuid } from "@workspace/arena/lib/api/ids";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const deleted = await db
      .delete(streamingAccounts)
      .where(and(eq(streamingAccounts.id, id), eq(streamingAccounts.ownerId, user.id)))
      .returning({ id: streamingAccounts.id });
    if (deleted.length === 0) return Response.json({ error: "No such connected library." }, { status: 404 });
    return Response.json({ disconnected: deleted[0].id });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("streaming account disconnect failed", error);
    return Response.json({ error: "Could not disconnect the library." }, { status: 500 });
  }
}
