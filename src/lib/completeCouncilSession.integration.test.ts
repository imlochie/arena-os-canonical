import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { completeCouncilSession, type CompleteCouncilSessionInput } from "./completeCouncilSession";
import { transitionSession } from "./sessionLifecycle";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const ORIGINAL_PROJECT_TIME = "2020-01-01T00:00:00.000Z";

type FailurePoint =
  | "run"
  | "council_artifact"
  | "unified_artifact"
  | "session_link"
  | "project_update"
  | "completion_event";

for (const failurePoint of [
  "run",
  "council_artifact",
  "unified_artifact",
  "session_link",
  "project_update",
  "completion_event",
] as FailurePoint[]) {
  test(`completion rollback invariant: ${failurePoint} failure`, async (t) => {
    const { database, client } = await testDatabase(failurePoint);
    t.after(() => client.close());
    const input = completionInput(failurePoint);

    await assert.rejects(() => completeCouncilSession(input, database as never));

    // This mirrors the route's deliberately separate post-rollback failure path.
    await transitionSession(
      SESSION_ID,
      "failed",
      {
        errorCode: "COUNCIL_COMPLETION_PERSISTENCE_FAILED",
        errorMessage: "Completion bundle failed.",
        payload: { retryable: true, failurePhase: "completion_persistence" },
      },
      database as never
    );

    assert.equal(await count(database, "council_runs"), 0);
    assert.equal(await count(database, "council_artifacts"), 0);
    assert.equal(await count(database, "artifacts"), 0);

    const sessionResult = await database.execute(sql.raw(
      `select status, error_code from cognitive_sessions where id = '${SESSION_ID}'`
    ));
    const session = sessionResult.rows[0] as Record<string, unknown>;
    assert.equal(session.status, "failed");
    assert.equal(session.error_code, "COUNCIL_COMPLETION_PERSISTENCE_FAILED");

    const projectResult = await database.execute(sql.raw(
      `select updated_at from projects where id = '${PROJECT_ID}'`
    ));
    assert.equal(new Date(String(projectResult.rows[0].updated_at)).toISOString(), ORIGINAL_PROJECT_TIME);

    const eventResult = await database.execute(sql.raw(
      `select type from cognitive_session_events where session_id = '${SESSION_ID}' order by sequence`
    ));
    assert.deepEqual(eventResult.rows.map((row) => row.type), ["artifact_generation", "failed"]);
  });
}

async function testDatabase(failurePoint: FailurePoint) {
  // PGlite runs PostgreSQL in-process, giving this test real transaction and
  // constraint behavior without requiring an external database service.
  const client = new PGlite();
  const database = drizzle(client);

  const runCheck = failurePoint === "run" ? "CHECK (material <> '__FAIL_RUN__')" : "";
  const councilArtifactCheck = failurePoint === "council_artifact" ? "CHECK (kind <> '__FAIL_COUNCIL_ARTIFACT__')" : "";
  const unifiedCheck = failurePoint === "unified_artifact" ? "CHECK (title <> '__FAIL_UNIFIED_ARTIFACT__')" : "";
  const linkCheck = failurePoint === "session_link" ? `CHECK (session_id <> '${SESSION_ID}'::uuid)` : "";
  const projectCheck = failurePoint === "project_update"
    ? "CHECK (name <> '__FAIL_PROJECT__' OR updated_at = TIMESTAMP '2020-01-01 00:00:00')"
    : "";
  const eventCheck = failurePoint === "completion_event" ? "CHECK (type <> 'completed')" : "";

  await client.exec(`
    CREATE TABLE council_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id text NOT NULL, material text NOT NULL,
      model_a_id text NOT NULL, model_b_id text NOT NULL, synthesis_model text NOT NULL,
      role_a_label text NOT NULL, role_b_label text NOT NULL, perspective_a text NOT NULL,
      perspective_b text NOT NULL, critique_a text NOT NULL, critique_b text NOT NULL,
      synthesis text NOT NULL, structured_synthesis text, latency_ms integer NOT NULL,
      project_id uuid, session_id uuid, created_at timestamp DEFAULT now()
      ${runCheck ? `, ${runCheck}` : ""} ${linkCheck ? `, ${linkCheck}` : ""}
    );
    CREATE TABLE council_artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL, kind text NOT NULL,
      title text NOT NULL, body text NOT NULL, created_at timestamp DEFAULT now()
      ${councilArtifactCheck ? `, ${councilArtifactCheck}` : ""}
    );
    CREATE TABLE artifacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, kind text NOT NULL,
      title text NOT NULL, body text NOT NULL, source_type text NOT NULL, source_id text,
      created_at timestamp DEFAULT now() ${unifiedCheck ? `, ${unifiedCheck}` : ""}
    );
    CREATE TABLE cognitive_sessions (
      id uuid PRIMARY KEY, project_id uuid, mode text NOT NULL, execution_mode text NOT NULL DEFAULT 'online',
      intent text, title text NOT NULL,
      status text NOT NULL, current_stage text, next_event_sequence integer NOT NULL DEFAULT 1,
      max_execution_attempts integer NOT NULL DEFAULT 2, fallback_policy text NOT NULL DEFAULT 'none',
      metadata text NOT NULL DEFAULT '{}',
      error_code text, error_message text, created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now(), started_at timestamp, completed_at timestamp, failed_at timestamp
    );
    CREATE TABLE cognitive_session_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL, type text NOT NULL,
      sequence integer NOT NULL, payload text NOT NULL, created_at timestamp DEFAULT now(),
      UNIQUE(session_id, sequence) ${eventCheck ? `, ${eventCheck}` : ""}
    );
    CREATE TABLE projects (
      id uuid PRIMARY KEY, name text NOT NULL, description text NOT NULL, emoji text NOT NULL,
      status text NOT NULL, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
      ${projectCheck ? `, ${projectCheck}` : ""}
    );
  `);

  const projectName = failurePoint === "project_update" ? "__FAIL_PROJECT__" : "Project";
  await client.exec(`
    INSERT INTO projects (id, name, description, emoji, status, updated_at)
    VALUES ('${PROJECT_ID}', '${projectName}', '', 'P', 'active', TIMESTAMP '2020-01-01 00:00:00');
    INSERT INTO cognitive_sessions (id, project_id, mode, title, status, current_stage, next_event_sequence, metadata)
    VALUES ('${SESSION_ID}', '${PROJECT_ID}', 'council', 'Test', 'running', 'artifact_generation', 2, '{"jobId":"test"}');
    INSERT INTO cognitive_session_events (session_id, type, sequence, payload)
    VALUES ('${SESSION_ID}', 'artifact_generation', 1, '{}');
  `);
  return { database, client };
}

function completionInput(failurePoint: FailurePoint): CompleteCouncilSessionInput {
  return {
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    run: {
      jobId: "test",
      material: failurePoint === "run" ? "__FAIL_RUN__" : "input",
      modelAId: "a",
      modelBId: "b",
      synthesisModel: "s",
      roleALabel: "A",
      roleBLabel: "B",
      perspectiveA: "A",
      perspectiveB: "B",
      critiqueA: "A critiques B",
      critiqueB: "B critiques A",
      synthesis: "Synthesis",
      structuredSynthesis: "{}",
      latencyMs: 1,
      projectId: PROJECT_ID,
    },
    artifact: {
      kind: failurePoint === "council_artifact" ? "__FAIL_COUNCIL_ARTIFACT__" : "brief",
      title: failurePoint === "unified_artifact" ? "__FAIL_UNIFIED_ARTIFACT__" : "Artifact",
      body: "Body",
    },
  };
}

async function count(
  database: Awaited<ReturnType<typeof testDatabase>>["database"],
  table: string
): Promise<number> {
  const result = await database.execute(sql.raw(`select count(*)::int as count from ${table}`));
  return Number(result.rows[0].count);
}
