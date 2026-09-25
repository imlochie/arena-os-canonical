import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { exportAssets, exportJobs, getDb } from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [job] = await db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.id, id))
      .limit(1);
    if (!job)
      return NextResponse.json({ error: "Export job not found." }, { status: 404 });
    await requireProjectRole(user.id, job.projectId, "viewer");
    const [asset] = await db
      .select()
      .from(exportAssets)
      .where(eq(exportAssets.exportJobId, job.id))
      .limit(1);
    const safeAsset = asset
      ? (({ storageKey: _storageKey, ...value }) => value)(asset)
      : null;
    return NextResponse.json({ job, asset: safeAsset });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
