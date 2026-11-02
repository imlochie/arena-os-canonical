import { GetLibraryConversionJobResponse } from "@workspace/api-zod";
import type { libraryConversionJobs } from "@workspace/db/waveyardSchema";

export function serializeLibraryConversionJob(job: typeof libraryConversionJobs.$inferSelect) {
  return GetLibraryConversionJobResponse.parse({
    ...job,
    verification: job.verification ? JSON.parse(job.verification) : null,
  });
}
