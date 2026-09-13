import { db } from "@/db";
import {
  artifacts,
  councilArtifacts,
  councilRuns,
  projects,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { transitionSessionInTransaction } from "@/lib/sessionLifecycle";

export interface CompleteCouncilSessionInput {
  sessionId: string;
  projectId: string | null;
  run: typeof councilRuns.$inferInsert;
  artifact: {
    kind: string;
    title: string;
    body: string;
  };
}

/**
 * The authoritative Council completion boundary.
 *
 * Model execution and intermediate lifecycle events happen before this call.
 * Every durable record required to claim completion is committed together in a
 * short transaction. Any thrown error rolls the entire completion bundle back;
 * the caller is responsible for recording a separate failed transition.
 */
export async function completeCouncilSession(
  input: CompleteCouncilSessionInput,
  database: Pick<typeof db, "transaction"> = db
) {
  return database.transaction(async (tx) => {
    const [run] = await tx.insert(councilRuns).values({ ...input.run, sessionId: input.sessionId }).returning();
    if (!run) throw new Error("failed to persist Council run");

    const [councilArtifact] = await tx
      .insert(councilArtifacts)
      .values({
        runId: run.id,
        kind: input.artifact.kind,
        title: input.artifact.title,
        body: input.artifact.body,
      })
      .returning();
    if (!councilArtifact) throw new Error("failed to persist Council artifact");

    const [unifiedArtifact] = await tx
      .insert(artifacts)
      .values({
        projectId: input.projectId,
        kind: input.artifact.kind,
        title: input.artifact.title,
        body: input.artifact.body,
        sourceType: "council",
        sourceId: run.id,
      })
      .returning();
    if (!unifiedArtifact) throw new Error("failed to persist unified artifact");

    if (input.projectId) {
      const [project] = await tx
        .update(projects)
        .set({ updatedAt: new Date() })
        .where(eq(projects.id, input.projectId))
        .returning();
      if (!project) throw new Error("failed to update Council project");
    }

    const { session, event } = await transitionSessionInTransaction(
      tx,
      input.sessionId,
      "completed",
      {
        payload: {
          councilRunId: run.id,
          artifactId: councilArtifact.id,
          unifiedArtifactId: unifiedArtifact.id,
        },
      }
    );

    return { run, artifact: councilArtifact, unifiedArtifact, session, completionEvent: event };
  });
}
