import { and, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { libraryConversionJobs } from "@workspace/db/waveyardSchema";
import { GetLibraryConversionJobParams } from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { serializeLibraryConversionJob } from "../../job-response";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const parsed = GetLibraryConversionJobParams.safeParse(await params);
    if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 });
    const [job] = await db.select().from(libraryConversionJobs).where(and(
      eq(libraryConversionJobs.id, parsed.data.id),
      eq(libraryConversionJobs.ownerId, user.id),
    )).limit(1);
    if (!job) return Response.json({ error: "Conversion job not found." }, { status: 404 });
    return Response.json(serializeLibraryConversionJob(job));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
