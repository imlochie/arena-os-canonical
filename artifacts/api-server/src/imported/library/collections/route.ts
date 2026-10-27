/**
 * Smart collections (lightcraft-style saved searches over the library).
 * GET lists the owner's collections; POST creates one from a validated
 * {name, match, rules} body.
 */


import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { createSmartCollection, listSmartCollections } from "@workspace/arena/lib/waveyard/library/service";
import { normaliseSmartCollectionInput } from "@workspace/arena/lib/waveyard/library/collections";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const collections = await listSmartCollections(user.id);
    return Response.json({ collections });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Body must be JSON." }, { status: 400 });
    }
    const input = normaliseSmartCollectionInput(body);
    if (input === null) {
      return Response.json(
        { error: "Collection must have a name (1..64 chars), match 'all'|'any', and up to 16 valid rules." },
        { status: 400 },
      );
    }
    const collection = await createSmartCollection(user.id, input);
    if (collection === null) return Response.json({ error: "Could not create collection." }, { status: 400 });
    return Response.json({ collection }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
