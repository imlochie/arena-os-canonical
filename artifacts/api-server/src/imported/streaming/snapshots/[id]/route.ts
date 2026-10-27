/**
 * GET /api/streaming/snapshots/[id] — a snapshot + its diff against the
 * previous backup of the same account ("what changed since last sync").
 */


import { and, desc, eq, lt } from "drizzle-orm";

import { db } from "@workspace/db";
import { librarySnapshots } from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { diffSnapshots, parseBackup } from "@workspace/arena/lib/waveyard/streaming/library-sync";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const [snapshot] = await db
      .select()
      .from(librarySnapshots)
      .where(and(eq(librarySnapshots.id, id), eq(librarySnapshots.ownerId, user.id)))
      .limit(1);
    if (snapshot === undefined) return Response.json({ error: "No such snapshot." }, { status: 404 });

    const current = parseBackup(snapshot.snapshotJson);
    if (current === null) {
      return Response.json({ error: "This snapshot failed validation on read — it is corrupt." }, { status: 500 });
    }

    // The previous backup of the same account (strictly older).
    const [previousRow] = await db
      .select({ id: librarySnapshots.id, snapshotJson: librarySnapshots.snapshotJson })
      .from(librarySnapshots)
      .where(and(eq(librarySnapshots.accountId, snapshot.accountId), lt(librarySnapshots.takenAt, snapshot.takenAt)))
      .orderBy(desc(librarySnapshots.takenAt))
      .limit(1);
    const previous = previousRow === undefined ? null : parseBackup(previousRow.snapshotJson);

    return Response.json({
      snapshot: {
        id: snapshot.id,
        service: snapshot.service,
        takenAt: snapshot.takenAt,
        playlistCount: snapshot.playlistCount,
        trackCount: snapshot.trackCount,
        library: current,
      },
      previousSnapshotId: previousRow?.id ?? null,
      diff: previous !== null ? diffSnapshots(previous, current) : null,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("snapshot fetch failed", error);
    return Response.json({ error: "Could not load the snapshot." }, { status: 500 });
  }
}
