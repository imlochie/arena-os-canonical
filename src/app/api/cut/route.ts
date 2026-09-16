import { listProjects, saveProject } from "@/lib/cut/projects";

export const dynamic = "force-dynamic";

// GET → saved Cut projects (most recent first)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  try {
    const projects = await listProjects(limit);
    return Response.json({ projects });
  } catch {
    return Response.json({ projects: [] });
  }
}

// POST → create or update a project {id?, title, aspect, clips}
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const clips = Array.isArray(body?.clips) ? body.clips : [];
  if (clips.length > 200) return Response.json({ error: "too many clips (max 200)" }, { status: 400 });
  try {
    const project = await saveProject({
      id: body?.id ? String(body.id) : null,
      title: String(body?.title ?? "Untitled cut"),
      aspect: String(body?.aspect ?? "16:9"),
      clips,
    });
    return Response.json({ project }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "save failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
