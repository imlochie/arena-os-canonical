import { NextResponse } from "next/server";
import { publicProjectResolution, safePublicProject } from "@/lib/publication";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    return NextResponse.json(safePublicProject(await publicProjectResolution(id)), {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("public project read failed", error);
    return NextResponse.json({ error: "Public project could not be read." }, { status: 500 });
  }
}
