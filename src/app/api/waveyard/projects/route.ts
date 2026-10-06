import { createWaveyardProject, listWaveyardProjects } from "@/lib/waveyard";

export const dynamic = "force-dynamic";

// GET → list projects · POST → create project
export async function GET() {
  try {
    return Response.json({ projects: await listWaveyardProjects() });
  } catch {
    return Response.json({ projects: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const project = await createWaveyardProject({
      title: body.title,
      notes: body.notes,
      bpm: body.bpm != null ? Number(body.bpm) : null,
      musicalKey: body.musicalKey,
    });
    return Response.json({ project }, { status: 201 });
  } catch {
    return Response.json({ error: "could not create project" }, { status: 500 });
  }
}
