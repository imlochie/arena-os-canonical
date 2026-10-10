/**
 * Streaming accounts — the connected-library registry (vision §V6).
 *
 * GET  /api/streaming/accounts → the owner's accounts + latest snapshot meta
 * POST /api/streaming/accounts { service, displayName } → connect (upsert:
 * one account per service per owner — the Songify model)
 *
 * The server NEVER holds streaming credentials: connections are authorized
 * client-side (Spotify PKCE / MusicKit / your YouTube OAuth client) and the
 * server stores only what the library APIs let us keep — snapshots.
 */

import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { librarySnapshots, streamingAccounts } from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { isStreamingService } from "@/lib/waveyard/streaming/library-sync";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    const accounts = await db
      .select({
        id: streamingAccounts.id,
        service: streamingAccounts.service,
        displayName: streamingAccounts.displayName,
        createdAt: streamingAccounts.createdAt,
        snapshotCount: sql<number>`(select count(*)::int from ${librarySnapshots} where ${librarySnapshots.accountId} = ${streamingAccounts.id})`,
        lastSyncAt: sql<string | null>`(select max(${librarySnapshots.takenAt})::text from ${librarySnapshots} where ${librarySnapshots.accountId} = ${streamingAccounts.id})`,
        trackCount: sql<number>`(select ${librarySnapshots.trackCount} from ${librarySnapshots} where ${librarySnapshots.accountId} = ${streamingAccounts.id} order by ${librarySnapshots.takenAt} desc limit 1)`,
      })
      .from(streamingAccounts)
      .where(eq(streamingAccounts.ownerId, user.id))
      .orderBy(desc(streamingAccounts.createdAt));
    return NextResponse.json({ accounts });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("streaming accounts list failed", error);
    return NextResponse.json({ error: "Could not list connected libraries." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json().catch(() => ({}))) as { service?: unknown; displayName?: unknown };
    const service = typeof body.service === "string" ? body.service : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim().slice(0, 200) : "";
    if (!isStreamingService(service)) {
      return NextResponse.json({ error: "Pick Spotify, Apple Music, or YouTube." }, { status: 400 });
    }
    if (displayName.length === 0) {
      return NextResponse.json({ error: "Name this connection (any label you like)." }, { status: 400 });
    }
    const [existing] = await db
      .select()
      .from(streamingAccounts)
      .where(and(eq(streamingAccounts.ownerId, user.id), eq(streamingAccounts.service, service)))
      .limit(1);
    if (existing !== undefined) {
      const [updated] = await db
        .update(streamingAccounts)
        .set({ displayName, updatedAt: new Date() })
        .where(eq(streamingAccounts.id, existing.id))
        .returning({ id: streamingAccounts.id, service: streamingAccounts.service, displayName: streamingAccounts.displayName });
      return NextResponse.json({ account: updated }, { status: 200 });
    }
    const [created] = await db
      .insert(streamingAccounts)
      .values({ ownerId: user.id, service, displayName })
      .returning({ id: streamingAccounts.id, service: streamingAccounts.service, displayName: streamingAccounts.displayName });
    return NextResponse.json({ account: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("streaming account connect failed", error);
    return NextResponse.json({ error: "Could not connect the library." }, { status: 500 });
  }
}
