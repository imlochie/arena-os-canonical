import { getWaveyardProject, saveWaveyardVersion, type WaveyardArrangement } from "@/lib/waveyard";

export const dynamic = "force-dynamic";

// POST → save an arrangement version (project state persistence).
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const projectId = String(body.projectId ?? "");
    if (!projectId) return Response.json({ error: "projectId required" }, { status: 400 });
    const project = await getWaveyardProject(projectId);
    if (!project) return Response.json({ error: "project not found" }, { status: 404 });
    const arrangement = body.arrangement as WaveyardArrangement;
    if (!arrangement || !Array.isArray(arrangement.clips)) {
      return Response.json({ error: "arrangement {tracks[], clips[]} required" }, { status: 400 });
    }
    // Validate clip sources belong to the project
    const sourceIds = new Set(project.sources.map((s) => s.id));
    for (const c of arrangement.clips) {
      if (!sourceIds.has(c.sourceId)) {
        return Response.json({ error: `clip references unknown source ${c.sourceId}` }, { status: 400 });
      }
    }
    const version = await saveWaveyardVersion({ projectId, name: body.name, arrangement });
    return Response.json({ version }, { status: 201 });
  } catch (e) {
    console.error("waveyard version save failed", e);
    return Response.json({ error: "save failed" }, { status: 500 });
  }
}
