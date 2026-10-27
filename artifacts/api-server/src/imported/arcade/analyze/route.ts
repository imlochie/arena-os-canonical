import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { analyzeImportedHtmlGame, ReaAnalysisError } from "../rea-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

let activeAnalyses = 0;
const MAX_CONCURRENT_ANALYSES = 2;

export async function POST(req: Request) {
  const denied = await requireApiAccess(req);
  if (denied) return denied;

  try {
    await requireUser();
  } catch {
    return Response.json({ error: "Sign in to analyze an imported game." }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body?.authorized !== true) {
    return Response.json({ error: "Confirm you own this game or have permission to analyze it." }, { status: 400 });
  }
  if (typeof body?.source !== "string" || !body.source.trim()) {
    return Response.json({ error: "A complete imported HTML game is required." }, { status: 400 });
  }
  if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
    return Response.json({ error: "REA is busy with other analyses. Try again shortly." }, { status: 429 });
  }

  activeAnalyses += 1;
  try {
    const analysis = await analyzeImportedHtmlGame(body.source);
    return Response.json({ analysis });
  } catch (error) {
    if (error instanceof ReaAnalysisError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "REA analysis failed." }, { status: 422 });
  } finally {
    activeAnalyses -= 1;
  }
}
