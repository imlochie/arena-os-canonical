import { requireApiAccess } from "@workspace/arena/lib/security/api-access";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { gameCatalog } from "./game-catalog";
import { RepositoryImportError } from "./repository-source";

let active = 0;
export async function catalogRequest(req: Request, resolve: boolean) {
  const denied = await requireApiAccess(req); if (denied) return denied;
  try { await requireUser(); } catch { return Response.json({ error: "Sign in to browse the game catalogs." }, { status: 401 }); }
  if (active >= 4) return Response.json({ error: "Catalog requests are busy. Try again shortly." }, { status: 429 });
  active++;
  try {
    const input = await req.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new RepositoryImportError("Invalid catalog request.", 400);
    const result = resolve ? await gameCatalog.resolve(input.id) : await gameCatalog.search(input.query, input.catalog, input.offset);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof RepositoryImportError ? error.message : "Catalog request failed; no game has been installed." },
      { status: error instanceof SyntaxError ? 400 : error instanceof RepositoryImportError ? error.status : 502 });
  } finally { active--; }
}
