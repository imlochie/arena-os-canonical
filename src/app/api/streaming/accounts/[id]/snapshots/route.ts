/**
 * Library snapshots — the backup store (vision §V6).
 *
 * GET  /api/streaming/accounts/[id]/snapshots → metadata list (newest first)
 * POST /api/streaming/accounts/[id]/snapshots { snapshot } → store a backup
 *
 * The snapshot arrives from the CLIENT (pulled via that service's own
 * client-side authorization — PKCE / MusicKit). It is validated with the
 * total parser (shape, limits, ISRC form) and stored in the canonical
 * backup format. 8 MB is the honest ceiling: ~50k tracks.
 */

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { librarySnapshots, streamingAccounts } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { isUuid } from "@/lib/api/ids";
import { backupToJson, parseLibrarySnapshot, snapshotStats } from "@/lib/waveyard/streaming/library-sync";

export const dynamic = "force-dynamic";

const MAX_SNAPSHOT_JSON_BYTES = 8 * 1024 * 1024;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const [account] = await db
      .select()
      .from(streamingAccounts)
      .where(and(eq(streamingAccounts.id, id), eq(streamingAccounts.ownerId, user.id)))
      .limit(1);
    if (account === undefined) return NextResponse.json({ error: "No such connected library." }, { status: 404 });
    const snapshots = await db
      .select({
        id: librarySnapshots.id,
        takenAt: librarySnapshots.takenAt,
        playlistCount: librarySnapshots.playlistCount,
        trackCount: librarySnapshots.trackCount,
      })
      .from(librarySnapshots)
      .where(eq(librarySnapshots.accountId, id))
      .orderBy(desc(librarySnapshots.takenAt));
    return NextResponse.json({ snapshots });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("snapshot list failed", error);
    return NextResponse.json({ error: "Could not list snapshots." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter." }, { status: 400 });
    const [account] = await db
      .select()
      .from(streamingAccounts)
      .where(and(eq(streamingAccounts.id, id), eq(streamingAccounts.ownerId, user.id)))
      .limit(1);
    if (account === undefined) return NextResponse.json({ error: "No such connected library." }, { status: 404 });

    const body = (await request.json().catch(() => null)) as { snapshot?: unknown } | null;
    const snapshot = parseLibrarySnapshot(body?.snapshot);
    if (snapshot === null) {
      return NextResponse.json({ error: "That snapshot is not a valid library backup (shape, limits, or timestamps failed validation)." }, { status: 422 });
    }
    if (snapshot.service !== account.service) {
      return NextResponse.json({ error: `This connection expects a ${account.service} snapshot.` }, { status: 422 });
    }
    const json = backupToJson(snapshot);
    if (json.length > MAX_SNAPSHOT_JSON_BYTES) {
      return NextResponse.json({ error: "That library snapshot is too large to store (8 MB ceiling)." }, { status: 413 });
    }
    const stats = snapshotStats(snapshot);
    const [stored] = await db
      .insert(librarySnapshots)
      .values({
        ownerId: user.id,
        accountId: account.id,
        service: account.service,
        takenAt: new Date(snapshot.takenAt),
        playlistCount: stats.playlists,
        trackCount: stats.tracks,
        snapshotJson: json,
      })
      .returning({ id: librarySnapshots.id, takenAt: librarySnapshots.takenAt, playlistCount: librarySnapshots.playlistCount, trackCount: librarySnapshots.trackCount });
    return NextResponse.json({ snapshot: stored }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("snapshot store failed", error);
    return NextResponse.json({ error: "Could not store the snapshot." }, { status: 500 });
  }
}
