import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { cognitiveSessionAssignments, cognitiveSessionEvents, cognitiveSessionInputs, cognitiveSessions, workerExecutionOperations, workerExecutions } from "@/db/schema";
import { prepareExecutionSession } from "./executionSession";
import { executeWorker } from "./workerExecutor";
import { persistSessionWorkforceAssignments } from "./workforceRuntime";
import { appendSessionEvent } from "./sessionEvents";

async function fixture() {
  const client = new PGlite();
  await client.exec(`
    create table models (
      id text primary key, name text not null, provider text not null default 'pollinations', description text not null default '',
      is_free boolean not null default true, elo integer not null default 1200, battles integer not null default 0,
      wins integer not null default 0, ties integer not null default 0, avg_latency_ms integer not null default 0,
      availability text not null default 'unknown', supports_structured_output boolean not null default false,
      capabilities text not null default '[]', updated_at timestamp default now()
    );
    create table model_category_ratings (
      model_id text not null, category text not null, elo integer not null default 1200, battles integer not null default 0,
      wins integer not null default 0, ties integer not null default 0, updated_at timestamp default now(), primary key(model_id, category)
    );
    create table cognitive_sessions (
      id uuid primary key default gen_random_uuid(), project_id uuid, mode text not null,
      execution_mode text not null default 'online', title text not null, intent text, metadata text not null default '{}', status text not null default 'created',
      current_stage text, next_event_sequence integer not null default 1,
      max_execution_attempts integer not null default 2, fallback_policy text not null default 'none',
      error_code text, error_message text, started_at timestamp,
      completed_at timestamp, failed_at timestamp, created_at timestamp default now(), updated_at timestamp default now()
    );
    create table cognitive_session_inputs (
      id uuid primary key default gen_random_uuid(), session_id uuid not null references cognitive_sessions(id) on delete cascade,
      kind text not null, content text not null, source_artifact_id uuid, metadata text not null default '{}', created_at timestamp default now()
    );
    create table cognitive_session_events (
      id uuid primary key default gen_random_uuid(), session_id uuid not null references cognitive_sessions(id) on delete cascade,
      type text not null, sequence integer not null, payload text not null default '{}', created_at timestamp default now(), unique(session_id, sequence)
    );
    create table cognitive_session_assignments (
      id uuid primary key default gen_random_uuid(), session_id uuid not null references cognitive_sessions(id) on delete cascade,
      slot text not null, requested_role text not null, workforce_role_id text not null, worker_id text not null,
      provider text not null, model_id text not null, execution_mode text not null default 'online',
      eligibility_decision text not null default 'eligible under default online policy',
      worker_availability text not null default 'unknown', capabilities_considered text not null default '[]',
      pinned_model_id text, assignment_sequence integer not null default 1, supersedes_assignment_id uuid,
      reassignment_reason text, status text not null default 'active', next_execution_attempt integer not null default 1,
      selection_reason text not null, capability_match text not null default '[]',
      created_at timestamp default now(), unique(session_id, slot, assignment_sequence)
    );
    create table worker_execution_operations (
      id uuid primary key default gen_random_uuid(), session_id uuid not null references cognitive_sessions(id) on delete cascade,
      assignment_id uuid not null references cognitive_session_assignments(id) on delete cascade,
      next_attempt_number integer not null default 1, status text not null default 'running',
      created_at timestamp not null default now(), completed_at timestamp
    );
    create table worker_executions (
      id uuid primary key default gen_random_uuid(), session_id uuid not null references cognitive_sessions(id) on delete cascade,
      assignment_id uuid not null references cognitive_session_assignments(id) on delete cascade,
      operation_id uuid not null references worker_execution_operations(id) on delete cascade,
      attempt_number integer not null default 1, previous_execution_id uuid, retry_reason text,
      fallback_source_assignment_id uuid, fallback_policy text not null default 'none', status text not null default 'running',
      selected_provider text not null, selected_model_id text not null, actual_provider text, actual_model_id text,
      route text, output_contract text not null default 'text', error_code text, error_message text,
      metadata text not null default '{}', started_at timestamp not null default now(), completed_at timestamp,
      unique(operation_id, attempt_number)
    );
  `);
  return { client, database: drizzle(client) };
}

for (const mode of ["arena", "collab"] as const) {
  test(`direct ${mode} execution creates and starts one Cognitive Session`, async () => {
    const { client, database } = await fixture();
    const executionMode = mode === "arena" ? "offline" : "online";
    const id = await prepareExecutionSession({ mode, executionMode, projectId: null, title: mode, content: "input" }, database as never);
    await persistSessionWorkforceAssignments(id, [{
      slot: mode === "arena" ? "fighter_a" : "collaborator_1",
      requestedRole: "test role", workforceRoleId: "strategist", workerId: "model:test",
      provider: "test", modelId: "test", workerName: "Test Worker", promptFragment: "Test",
      executionMode, eligibilityDecision: `${executionMode} permits test worker`,
      workerAvailability: "available", capabilitiesConsidered: ["analysis"],
      selectionReason: "test allocation", capabilityMatch: ["analysis"],
    }], database as never);
    const sessions = await database.select().from(cognitiveSessions);
    const inputs = await database.select().from(cognitiveSessionInputs);
    const events = await database.select().from(cognitiveSessionEvents).orderBy(cognitiveSessionEvents.sequence);
    const assignments = await database.select().from(cognitiveSessionAssignments);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, id);
    assert.equal(sessions[0].status, "running");
    assert.equal(inputs[0].sessionId, id);
    assert.equal(assignments[0].sessionId, id);
    assert.equal(sessions[0].executionMode, executionMode);
    assert.equal(assignments[0].executionMode, executionMode);
    assert.equal(assignments[0].eligibilityDecision, `${executionMode} permits test worker`);
    assert.equal(assignments[0].workerAvailability, "available");
    assert.deepEqual(JSON.parse(assignments[0].capabilitiesConsidered), ["analysis"]);
    assert.deepEqual(events.map((event) => event.type), ["created", "running", "workforce_assigned"]);
    await client.close();
  });

  test(`handoff-created ${mode} session is continued without duplication`, async () => {
    const { client, database } = await fixture();
    const [target] = await database.insert(cognitiveSessions).values({
      mode, title: "handoff", metadata: JSON.stringify({ handoffId: "h-1" }), status: "created", nextEventSequence: 2,
    }).returning();
    await database.insert(cognitiveSessionInputs).values({ sessionId: target.id, kind: "handoff", content: "inherited" });
    await database.insert(cognitiveSessionEvents).values({ sessionId: target.id, type: "created", sequence: 1 });

    const id = await prepareExecutionSession({ sessionId: target.id, mode, projectId: null, title: "execution", content: "ignored", metadata: { category: "general" } }, database as never);
    const sessions = await database.select().from(cognitiveSessions);
    assert.equal(id, target.id);
    assert.equal(sessions.length, 1);
    assert.deepEqual(JSON.parse(sessions[0].metadata), { handoffId: "h-1", category: "general" });
    await assert.rejects(() => prepareExecutionSession({ sessionId: target.id, mode, projectId: null, title: "duplicate", content: "input" }, database as never), /already started/);
    await client.close();
  });
}

test("concurrent event writers reserve unique gapless per-session sequences", async () => {
  const { client, database } = await fixture();
  const [session] = await database.insert(cognitiveSessions).values({ mode: "arena", title: "concurrency" }).returning();
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    database.transaction((tx) => appendSessionEvent(tx as never, session.id, "concurrent", { index }))
  ));
  const events = await database.select().from(cognitiveSessionEvents)
    .where(eq(cognitiveSessionEvents.sessionId, session.id))
    .orderBy(cognitiveSessionEvents.sequence);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.sequence)).size, 20);
  const [updated] = await database.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, session.id));
  assert.equal(updated.nextEventSequence, 21);
  await client.close();
});

test("retryable failure creates distinct attempts on one assignment without terminal session state", async () => {
  const { client, database } = await fixture();
  const [session] = await database.insert(cognitiveSessions).values({
    mode: "arena", title: "retry", status: "running", nextEventSequence: 1,
  }).returning();
  const [assignment] = await database.insert(cognitiveSessionAssignments).values({
    sessionId: session.id, slot: "fighter_a", requestedRole: "Strategist", workforceRoleId: "strategist",
    workerId: "model:openai", provider: "pollinations", modelId: "openai", executionMode: "online",
    selectionReason: "test",
  }).returning();
  let calls = 0;
  const result = await executeWorker({
    sessionId: session.id,
    assignment: { slot: "fighter_a", requestedRole: "Strategist", provider: "pollinations", modelId: "openai", executionMode: "online" },
    messages: [{ role: "user", content: "work" }],
  }, {
    database: database as never,
    generate: async () => {
      calls += 1;
      if (calls === 1) throw new DOMException("timed out", "AbortError");
      return { text: "done", via: "pollinations:openai", ms: 1 };
    },
  });
  const attempts = await database.select().from(workerExecutions).orderBy(workerExecutions.attemptNumber);
  const events = await database.select().from(cognitiveSessionEvents).orderBy(cognitiveSessionEvents.sequence);
  const [unchangedSession] = await database.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, session.id));
  assert.equal(result.attemptNumber, 2);
  assert.equal(calls, 2);
  assert.equal(new Set(attempts.map((attempt) => attempt.assignmentId)).size, 1);
  assert.equal(attempts[0].assignmentId, assignment.id);
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["failed", "completed"]);
  assert.equal(attempts[1].previousExecutionId, attempts[0].id);
  assert.equal(attempts[1].retryReason, "WORKER_TIMEOUT");
  assert.equal(unchangedSession.status, "running");
  assert.deepEqual(events.map((event) => event.type), [
    "worker_execution_started", "worker_execution_failed", "worker_retry_scheduled",
    "worker_execution_started", "worker_execution_completed",
  ]);

  calls = 0;
  const secondOperation = await executeWorker({
    sessionId: session.id,
    assignment: { slot: "fighter_a", requestedRole: "Strategist", provider: "pollinations", modelId: "openai", executionMode: "online" },
    messages: [{ role: "user", content: "second logical operation" }],
  }, {
    database: database as never,
    generate: async () => {
      calls += 1;
      if (calls === 1) throw new DOMException("timed out", "AbortError");
      return { text: "done again", via: "pollinations:openai", ms: 1 };
    },
  });
  const operations = await database.select().from(workerExecutionOperations).orderBy(workerExecutionOperations.createdAt);
  const allAttempts = await database.select().from(workerExecutions).orderBy(workerExecutions.startedAt);
  assert.equal(secondOperation.attemptNumber, 2);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map((operation) =>
    allAttempts.filter((attempt) => attempt.operationId === operation.id).map((attempt) => attempt.attemptNumber)
  ), [[1, 2], [1, 2]]);
  await client.close();
});

test("eligible-worker fallback creates a linked assignment through policy and Workforce", async () => {
  const { client, database } = await fixture();
  await client.exec(`
    insert into models (id, name, provider, availability, capabilities) values
      ('openai', 'OpenAI', 'pollinations', 'available', '["text_generation"]'),
      ('mistral', 'Mistral', 'pollinations', 'available', '["text_generation"]');
  `);
  const [session] = await database.insert(cognitiveSessions).values({
    mode: "arena", title: "fallback", status: "running", maxExecutionAttempts: 1,
    fallbackPolicy: "eligible_worker",
  }).returning();
  const [original] = await database.insert(cognitiveSessionAssignments).values({
    sessionId: session.id, slot: "fighter_a", requestedRole: "Strategist", workforceRoleId: "strategist",
    workerId: "model:openai", provider: "pollinations", modelId: "openai", executionMode: "online",
    capabilitiesConsidered: '["text_generation"]', selectionReason: "test",
  }).returning();
  const modelsSeen: string[] = [];
  const result = await executeWorker({
    sessionId: session.id,
    assignment: { slot: "fighter_a", requestedRole: "Strategist", provider: "pollinations", modelId: "openai", executionMode: "online" },
    messages: [{ role: "user", content: "work" }],
  }, {
    database: database as never,
    generate: async (options) => {
      modelsSeen.push(options.modelId);
      if (options.modelId === "openai") throw new Error("provider route failed");
      return { text: "fallback complete", via: `pollinations:${options.modelId}`, ms: 1 };
    },
  });
  const assignments = await database.select().from(cognitiveSessionAssignments)
    .orderBy(cognitiveSessionAssignments.assignmentSequence);
  const attempts = await database.select().from(workerExecutions).orderBy(workerExecutions.startedAt);
  const events = await database.select().from(cognitiveSessionEvents).orderBy(cognitiveSessionEvents.sequence);
  assert.deepEqual(modelsSeen, ["openai", "mistral"]);
  assert.equal(result.actualModelId, "mistral");
  assert.equal(assignments.length, 2);
  assert.equal(assignments[0].status, "superseded");
  assert.equal(assignments[1].supersedesAssignmentId, original.id);
  assert.equal(assignments[1].status, "active");
  assert.equal(attempts[1].fallbackSourceAssignmentId, original.id);
  assert.deepEqual(events.map((event) => event.type), [
    "worker_execution_started", "worker_execution_failed", "fallback_triggered", "workforce_reassigned",
    "worker_execution_started", "worker_execution_completed",
  ]);
  await client.close();
});

test("a target session cannot be continued by the wrong mode", async () => {
  const { client, database } = await fixture();
  const [target] = await database.insert(cognitiveSessions).values({ mode: "arena", title: "handoff" }).returning();
  await assert.rejects(() => prepareExecutionSession({ sessionId: target.id, mode: "collab", projectId: null, title: "wrong", content: "input" }, database as never), /not found/);
  const [unchanged] = await database.select().from(cognitiveSessions).where(eq(cognitiveSessions.id, target.id));
  assert.equal(unchanged.status, "created");
  await client.close();
});
