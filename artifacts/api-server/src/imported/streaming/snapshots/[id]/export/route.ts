/**
 * GET /api/streaming/snapshots/[id]/export?format=csv|json — download a
 * backup. JSON is the lossless waveyard-library-backup (re-importable);
 * CSV is the TuneMyMusic-parity spreadsheet (playlist, position, title,
 * artists, album, isrc, duration, service, id).
 */


import { and, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { librarySnapshots } from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { isUuid } from "@workspace/arena/lib/api/ids";
import { parseBackup, snapshotToCsv } from "@workspace/arena/lib/waveyard/streaming/library-sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter." }, { status: 400 });
    const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
    const [row] = await db
      .select()
      .from(librarySnapshots)
      .where(and(eq(librarySnapshots.id, id), eq(librarySnapshots.ownerId, user.id)))
      .limit(1);
    if (row === undefined) return Response.json({ error: "No such snapshot." }, { status: 404 });
    const snapshot = parseBackup(row.snapshotJson);
    if (snapshot === null) return Response.json({ error: "This snapshot is corrupt." }, { status: 500 });

    const stamp = snapshot.takenAt.slice(0, 10);
    if (format === "csv") {
      return new Response(snapshotToCsv(snapshot), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="waveyard-${row.service}-library-${stamp}.csv"`,
        },
      });
    }
    return new Response(row.snapshotJson, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="waveyard-${row.service}-library-${stamp}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("snapshot export failed", error);
    return Response.json({ error: "Could not export the snapshot." }, { status: 500 });
  }
}
