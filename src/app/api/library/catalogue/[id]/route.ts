import { NextResponse } from "next/server";
import { requireApiAccess } from "@/lib/security/api-access";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  inspectArchiveAudio,
  importArchiveAudio,
} from "@/lib/waveyard/archive-audio";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  try {
    return NextResponse.json({
      item: await inspectArchiveAudio((await context.params).id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Item unavailable." },
      { status: 422 },
    );
  }
}
export async function POST(request: Request, context: Context) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const user = await requireUser();
    const result = await importArchiveAudio({
      ownerId: user.id,
      id: (await context.params).id,
      file: typeof body.file === "string" ? body.file : "",
      rightsReviewed: body.rightsReviewed === true,
      signal: request.signal,
    });
    return NextResponse.json(
      {
        ...result,
        separationCompleted: false,
        notice:
          "Original full audio imported. No stems inferred. Rights/attribution are retained with the source acquisition; preserve them and describe modifications on any export.",
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Import failed; no success claimed.",
      },
      { status: 422 },
    );
  }
}
