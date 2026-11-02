import { desc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { libraryConversionJobs } from "@workspace/db/waveyardSchema";
import { ListLibraryConversionJobsResponse } from "@workspace/api-zod";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { serializeLibraryConversionJob } from "../job-response";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await db.select().from(libraryConversionJobs)
      .where(eq(libraryConversionJobs.ownerId, user.id))
      .orderBy(desc(libraryConversionJobs.updatedAt))
      .limit(50);
    return Response.json(ListLibraryConversionJobsResponse.parse({
      jobs: rows.map(serializeLibraryConversionJob),
    }));
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}
