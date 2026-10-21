import { NextResponse } from "next/server";
import { requireApiAccess } from "@/lib/security/api-access";
import {
  searchArchiveAudio,
  ARCHIVE_RIGHTS_NOTICE,
} from "@/lib/waveyard/archive-audio";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = await requireApiAccess(request);
  if (denied) return denied;
  try {
    return NextResponse.json({
      provider: "Internet Archive public audio",
      rightsNotice: ARCHIVE_RIGHTS_NOTICE,
      items: await searchArchiveAudio(
        new URL(request.url).searchParams.get("q") ?? "",
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Catalogue unavailable. No audio acquired.",
      },
      { status: 422 },
    );
  }
}
