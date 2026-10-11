/**
 * GET /api/streaming/snapshots/[id] — a snapshot + its diff against the
 * previous backup of the same account ("what changed since last sync").
 */

import { NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";

import { db } from "@/db";
import { librarySnapshots } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { isUuid } from "@/lib/api/ids";
import { diffSnapshots, parseBackup } from "@/lib/waveyard/streaming/library-sync";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const [snapshot] = await db
      .select()
      .from(librarySnapshots)
      .where(and(eq(librarySnapshots.id, id), eq(librarySnapshots.ownerId, user.id)))
      .limit(1);
    if (snapshot === undefined) return NextResponse.json({ error: "No such snapshot." }, { status: 404 });

    const current = parseBackup(snapshot.snapshotJson);
    if (current === null) {
      return NextResponse.json({ error: "This snapshot failed validation on read — it is corrupt." }, { status: 500 });
    }

    // The previous backup of the same account (strictly older).
    const [previousRow] = await db
      .select({ id: librarySnapshots.id, snapshotJson: librarySnapshots.snapshotJson })
      .from(librarySnapshots)
      .where(and(eq(librarySnapshots.accountId, snapshot.accountId), lt(librarySnapshots.takenAt, snapshot.takenAt)))
      .orderBy(desc(librarySnapshots.takenAt))
      .limit(1);
    const previous = previousRow === undefined ? null : parseBackup(previousRow.snapshotJson);

    return NextResponse.json({
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
    return NextResponse.json({ error: "Could not load the snapshot." }, { status: 500 });
  }
}
