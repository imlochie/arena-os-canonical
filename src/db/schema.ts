import {
  pgTable,
  text,
  integer,
  boolean,
  real,
  timestamp,
  uuid,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---- Model registry (ELO tracked) ----
export const models = pgTable("models", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull().default("pollinations"),
  description: text("description").notNull().default(""),
  isFree: boolean("is_free").notNull().default(true),
  elo: integer("elo").notNull().default(1200),
  battles: integer("battles").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  ties: integer("ties").notNull().default(0),
  avgLatencyMs: integer("avg_latency_ms").notNull().default(0),
  availability: text("availability").notNull().default("unknown"), // available|unavailable|unknown
  supportsStructuredOutput: boolean("supports_structured_output").notNull().default(false),
  capabilities: text("capabilities").notNull().default("[]"), // declared worker capability ids, JSON string[]
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---- Per-category ratings (LMArena-style category leaderboards) ----
export const modelCategoryRatings = pgTable(
  "model_category_ratings",
  {
    modelId: text("model_id").notNull(),
    category: text("category").notNull(),
    elo: integer("elo").notNull().default(1200),
    battles: integer("battles").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    ties: integer("ties").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.category] })]
);

// ---- Personal assistants (user-created personas) ----
export const assistants = pgTable("assistants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  systemPrompt: text("system_prompt").notNull(),
  baseModel: text("base_model").notNull().default("openai"),
  temperature: real("temperature").notNull().default(0.7),
  avatar: text("avatar").notNull().default("🤖"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Arena battles ----
export const battles = pgTable("battles", {
  id: uuid("id").primaryKey().defaultRandom(),
  prompt: text("prompt").notNull(),
  category: text("category").notNull().default("general"),
  modelAId: text("model_a_id").notNull(),
  modelBId: text("model_b_id").notNull(),
  assistantAId: uuid("assistant_a_id"),
  assistantBId: uuid("assistant_b_id"),
  responseA: text("response_a").notNull().default(""),
  responseB: text("response_b").notNull().default(""),
  latencyA: integer("latency_a").notNull().default(0),
  latencyB: integer("latency_b").notNull().default(0),
  winner: text("winner"), // 'a' | 'b' | 'tie' | 'both-bad'
  judgeResult: text("judge_result"), // JSON: {suggestion, reasoning, raw, at}
  projectId: uuid("project_id"),
  sessionId: uuid("session_id").references(() => cognitiveSessions.id).unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Multi-turn battle threads (LMArena-style conversation voting) ----
export const battleMessages = pgTable("battle_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  battleId: uuid("battle_id").notNull(),
  role: text("role").notNull(), // 'user' | 'a' | 'b'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Prompt template library (DB-backed) ----
export const promptTemplates = pgTable("prompt_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  category: text("category").notNull().default("general"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Multi-collaboration challenges (cognitive-OS mode) ----
export const collabs = pgTable("collabs", {
  id: uuid("id").primaryKey().defaultRandom(),
  challenge: text("challenge").notNull(),
  category: text("category").notNull().default("general"),
  strategy: text("strategy").notNull().default("council"),
  collaborators: text("collaborators").notNull().default("[]"), // JSON: [{type,id,label,modelId}]
  synthesisModel: text("synthesis_model").notNull().default("openai"),
  synthesis: text("synthesis").notNull().default(""),
  rounds: integer("rounds").notNull().default(1),
  bestContributor: integer("best_contributor"), // index into collaborators
  projectId: uuid("project_id"),
  sessionId: uuid("session_id").references(() => cognitiveSessions.id).unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const collabContributions = pgTable("collab_contributions", {
  id: uuid("id").primaryKey().defaultRandom(),
  collabId: uuid("collab_id").notNull(),
  round: integer("round").notNull().default(1),
  contribIndex: integer("contrib_index").notNull().default(0),
  kind: text("kind").notNull().default("draft"), // 'draft' | 'critique' | 'synthesis' | 'user'
  label: text("label").notNull().default(""),
  modelId: text("model_id").notNull().default("openai"),
  assistantId: uuid("assistant_id"),
  content: text("content").notNull(),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Cognitive Council runs (Cognitive OS: job → perspectives → cross-critique → synthesis → artifact) ----
export const councilRuns = pgTable("council_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: text("job_id").notNull().default("second_brain"),
  material: text("material").notNull(),
  modelAId: text("model_a_id").notNull().default("openai"),
  modelBId: text("model_b_id").notNull().default("deepseek"),
  synthesisModel: text("synthesis_model").notNull().default("openai"),
  roleALabel: text("role_a_label").notNull().default(""),
  roleBLabel: text("role_b_label").notNull().default(""),
  perspectiveA: text("perspective_a").notNull().default(""),
  perspectiveB: text("perspective_b").notNull().default(""),
  critiqueA: text("critique_a").notNull().default(""), // A critiques B
  critiqueB: text("critique_b").notNull().default(""), // B critiques A
  synthesis: text("synthesis").notNull().default(""), // rendered structured synthesis
  structuredSynthesis: text("structured_synthesis"), // validated CouncilSynthesis JSON
  latencyMs: integer("latency_ms").notNull().default(0),
  projectId: uuid("project_id"),
  sessionId: uuid("session_id"), // mode execution points to generic session root
  createdAt: timestamp("created_at").defaultNow(),
});

export const councilArtifacts = pgTable("council_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  kind: text("kind").notNull().default("brief"),
  title: text("title").notNull().default("Untitled artifact"),
  body: text("body").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Cognitive sessions (canonical session abstraction) ----
// A Council run is an execution detail. A cognitive session is the reusable
// unit of work that can feed Arena, Collab, artifacts, and project memory.
export const cognitiveSessions = pgTable("cognitive_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"),
  mode: text("mode").notNull(), // council|arena|collab
  executionMode: text("execution_mode").notNull().default("online"), // online|offline|local_only
  maxExecutionAttempts: integer("max_execution_attempts").notNull().default(2),
  fallbackPolicy: text("fallback_policy").notNull().default("none"),
  intent: text("intent"),
  title: text("title").notNull().default("Untitled cognitive session"),
  status: text("status").notNull().default("created"), // created|running|completed|failed
  currentStage: text("current_stage"), // mode-owned stage; never a generic status
  nextEventSequence: integer("next_event_sequence").notNull().default(1),
  metadata: text("metadata").notNull().default("{}"), // bounded mode metadata, JSON
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
});

export const cognitiveSessionInputs = pgTable("cognitive_session_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("primary"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("cognitive_session_inputs_session_id_idx").on(t.sessionId),
]);

// Append-only operational history for every cognitive session mode. Generated
// content remains on mode/output records; event payloads contain metadata only.
export const cognitiveSessionAssignments = pgTable("cognitive_session_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  slot: text("slot").notNull(), // perspective_a|perspective_b|synthesis
  requestedRole: text("requested_role").notNull(),
  workforceRoleId: text("workforce_role_id").notNull(),
  workerId: text("worker_id").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  executionMode: text("execution_mode").notNull().default("online"),
  eligibilityDecision: text("eligibility_decision").notNull().default("eligible under default online policy"),
  workerAvailability: text("worker_availability").notNull().default("unknown"),
  capabilitiesConsidered: text("capabilities_considered").notNull().default("[]"), // JSON string[]
  pinnedModelId: text("pinned_model_id"),
  assignmentSequence: integer("assignment_sequence").notNull().default(1),
  supersedesAssignmentId: uuid("supersedes_assignment_id"),
  reassignmentReason: text("reassignment_reason"),
  status: text("status").notNull().default("active"), // active|superseded
  nextExecutionAttempt: integer("next_execution_attempt").notNull().default(1),
  selectionReason: text("selection_reason").notNull(),
  capabilityMatch: text("capability_match").notNull().default("[]"), // JSON string[]
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("cognitive_session_assignments_session_slot_sequence_unique").on(t.sessionId, t.slot, t.assignmentSequence),
  index("cognitive_session_assignments_session_id_idx").on(t.sessionId),
  index("cognitive_session_assignments_supersedes_id_idx").on(t.supersedesAssignmentId),
]);

export const toolEffects = pgTable("tool_effects", {
  id: uuid("id").primaryKey().defaultRandom(), sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(), grantId: text("grant_id").notNull(), resourceId: text("resource_id").notNull(), capability: text("capability").notNull(),
  canonicalScope: text("canonical_scope").notNull(), targetPath: text("target_path").notNull(), effectClass: text("effect_class").notNull().default("write_local"),
  proposedOperation: text("proposed_operation").notNull(), operationDigest: text("operation_digest").notNull(), status: text("status").notNull().default("proposed"),
  approvedBy: text("approved_by"), approvedDigest: text("approved_digest"), preimageDigest: text("preimage_digest"), preimage: text("preimage"),
  errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: timestamp("created_at").defaultNow().notNull(), approvedAt: timestamp("approved_at"), appliedAt: timestamp("applied_at"),
}, (t) => [index("tool_effects_session_idx").on(t.sessionId, t.createdAt)]);

export const workerExecutionOperations = pgTable("worker_execution_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => cognitiveSessionAssignments.id, { onDelete: "cascade" }),
  nextAttemptNumber: integer("next_attempt_number").notNull().default(1),
  status: text("status").notNull().default("running"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (t) => [index("worker_execution_operations_assignment_idx").on(t.assignmentId, t.createdAt)]);

export const workerExecutions = pgTable("worker_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => cognitiveSessionAssignments.id, { onDelete: "cascade" }),
  operationId: uuid("operation_id").references(() => workerExecutionOperations.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull().default(1),
  previousExecutionId: uuid("previous_execution_id"),
  retryReason: text("retry_reason"),
  fallbackSourceAssignmentId: uuid("fallback_source_assignment_id"),
  fallbackPolicy: text("fallback_policy").notNull().default("none"),
  status: text("status").notNull().default("running"), // running|completed|failed
  selectedProvider: text("selected_provider").notNull(),
  selectedModelId: text("selected_model_id").notNull(),
  actualProvider: text("actual_provider"),
  actualModelId: text("actual_model_id"),
  route: text("route"),
  outputContract: text("output_contract").notNull().default("text"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metadata: text("metadata").notNull().default("{}"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (t) => [
  index("worker_executions_session_id_idx").on(t.sessionId, t.startedAt),
  index("worker_executions_assignment_id_idx").on(t.assignmentId, t.startedAt),
  uniqueIndex("worker_executions_operation_attempt_unique").on(t.operationId, t.attemptNumber),
]);

export const handoffs = pgTable("handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceSessionId: uuid("source_session_id").references(() => cognitiveSessions.id, { onDelete: "set null" }),
  targetSessionId: uuid("target_session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  sourceArtifactId: uuid("source_artifact_id"),
  sourceProjectId: uuid("source_project_id"),
  targetProjectId: uuid("target_project_id"),
  type: text("type").notNull().default("continue"),
  intent: text("intent"),
  payload: text("payload").notNull().default("{}"), // references + digest, never transcript content
  metadata: text("metadata").notNull().default("{}"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("handoffs_source_session_id_idx").on(t.sourceSessionId),
  index("handoffs_target_session_id_idx").on(t.targetSessionId),
]);

export const cognitiveSessionEvents = pgTable("cognitive_session_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => cognitiveSessions.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  sequence: integer("sequence").notNull(),
  payload: text("payload").notNull().default("{}"), // structured JSON metadata
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("cognitive_session_events_session_sequence_unique").on(t.sessionId, t.sequence),
  index("cognitive_session_events_session_id_idx").on(t.sessionId, t.sequence),
]);

// ---- Canonical Work OS: Projects + Artifacts + Memory ----
// Projects are the first-class object above battles / collabs / council runs.
// Artifacts are reusable knowledge (not transcripts). Memory persists facts,
// decisions, preferences, open questions, rejected ideas, sources.
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  emoji: text("emoji").notNull().default("📁"),
  status: text("status").notNull().default("active"), // active | paused | archived
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id"),
  kind: text("kind").notNull().default("brief"), // brief|decision|research|concept|plan|critique|prompt|spec|comparison|answer
  title: text("title").notNull().default("Untitled artifact"),
  body: text("body").notNull().default(""),
  sourceType: text("source_type").notNull().default("manual"), // council|battle|collab|chat|arcade|manual
  sourceId: text("source_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const projectMemory = pgTable("project_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  kind: text("kind").notNull().default("fact"), // fact|decision|preference|open_question|rejected_idea|source
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Privacy audit log (metadata only — never content) ----
export const privacyEvents = pgTable("privacy_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Offline arcade games (verified cores / remix / on-device AI) ----
export const arcadeGames = pgTable("arcade_games", {
  id: uuid("id").primaryKey().defaultRandom(),
  prompt: text("prompt").notNull(),
  gameType: text("game_type").notNull().default("arena"),
  engine: text("engine").notNull().default("verified"), // verified | remix | on-device-ai
  code: text("code").notNull(),
  parentId: uuid("parent_id"),
  projectId: uuid("project_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Owner/device identity (single-owner, self-hosted control plane) ----
export const arenaOwners = pgTable("arena_owners", { id: uuid("id").primaryKey().defaultRandom(), displayName: text("display_name").notNull(), createdAt: timestamp("created_at").defaultNow().notNull() });
export const arenaDevices = pgTable("arena_devices", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), displayName:text("display_name").notNull(), deviceType:text("device_type").notNull(), enrollmentProvenance:text("enrollment_provenance").notNull(), nodePublicKey:text("node_public_key"), lastActivityAt:timestamp("last_activity_at"), revokedAt:timestamp("revoked_at"), revocationReason:text("revocation_reason"), state:text("state").notNull().default("active"), createdAt:timestamp("created_at").defaultNow().notNull() });
export const webauthnCredentials = pgTable("webauthn_credentials", { id:text("id").primaryKey(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), publicKey:text("public_key").notNull(), counter:integer("counter").notNull().default(0), transports:text("transports").notNull().default("[]"), deviceType:text("device_type"), backedUp:boolean("backed_up").notNull().default(false), revokedAt:timestamp("revoked_at"), createdAt:timestamp("created_at").defaultNow().notNull(), lastUsedAt:timestamp("last_used_at") });
export const authChallenges = pgTable("auth_challenges", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").references(()=>arenaDevices.id,{onDelete:"cascade"}), kind:text("kind").notNull(), challenge:text("challenge").notNull(), expiresAt:timestamp("expires_at").notNull(), consumedAt:timestamp("consumed_at"), createdAt:timestamp("created_at").defaultNow().notNull() });
export const authenticatedSessions = pgTable("authenticated_sessions", { id:uuid("id").primaryKey().defaultRandom(), tokenHash:text("token_hash").notNull().unique(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), credentialId:text("credential_id").notNull().references(()=>webauthnCredentials.id), authenticationMethod:text("authentication_method").notNull().default("webauthn"), assurance:text("assurance").notNull().default("user_verified"), freshVerifiedAt:timestamp("fresh_verified_at"), createdAt:timestamp("created_at").defaultNow().notNull(), expiresAt:timestamp("expires_at").notNull(), lastActivityAt:timestamp("last_activity_at").defaultNow().notNull(), revokedAt:timestamp("revoked_at") });
export const deviceCapabilityGrants = pgTable("device_capability_grants", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), capability:text("capability").notNull(), resource:text("resource").notNull(), scope:text("scope").notNull(), effectClass:text("effect_class"), createdAt:timestamp("created_at").defaultNow().notNull(), expiresAt:timestamp("expires_at"), revokedAt:timestamp("revoked_at"), createdByDeviceId:uuid("created_by_device_id").references(()=>arenaDevices.id) });
export const securityEvents = pgTable("security_events", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").references(()=>arenaOwners.id,{onDelete:"set null"}), deviceId:uuid("device_id").references(()=>arenaDevices.id,{onDelete:"set null"}), authenticatedSessionId:uuid("authenticated_session_id").references(()=>authenticatedSessions.id,{onDelete:"set null"}), type:text("type").notNull(), outcome:text("outcome").notNull(), metadata:text("metadata").notNull().default("{}"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const fileArtifacts = pgTable("file_artifacts", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), uploadedByDeviceId:uuid("uploaded_by_device_id").notNull().references(()=>arenaDevices.id), projectId:uuid("project_id"), sessionId:uuid("session_id").references(()=>cognitiveSessions.id,{onDelete:"set null"}), displayName:text("display_name").notNull(), mediaType:text("media_type").notNull(), declaredMediaType:text("declared_media_type").notNull(), byteSize:integer("byte_size").notNull(), contentHash:text("content_hash").notNull(), privacyClassification:text("privacy_classification").notNull(), storageKey:text("storage_key").notNull().unique(), contentBase64:text("content_base64").notNull(), status:text("status").notNull().default("available"), createdAt:timestamp("created_at").defaultNow().notNull() });
export const nodeProtocolRequests = pgTable("node_protocol_requests", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), controlDeviceId:uuid("control_device_id").notNull().references(()=>arenaDevices.id), nodeDeviceId:uuid("node_device_id").notNull().references(()=>arenaDevices.id), capability:text("capability").notNull(), resourceId:text("resource_id").notNull(), nonce:text("nonce").notNull().unique(), issuedAt:timestamp("issued_at").notNull(), expiresAt:timestamp("expires_at").notNull(), payloadDigest:text("payload_digest").notNull(), signature:text("signature").notNull(), status:text("status").notNull().default("issued"), consumedAt:timestamp("consumed_at"), createdAt:timestamp("created_at").defaultNow().notNull() });

// ---- Direct chats ----
export const chats = pgTable("chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New chat"),
  modelId: text("model_id").notNull().default("openai"),
  assistantId: uuid("assistant_id"),
  projectId: uuid("project_id"),
  sessionId: uuid("session_id").references(() => cognitiveSessions.id, { onDelete: "cascade" }).unique(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: uuid("chat_id").notNull(),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ModelCategoryRatingRow = typeof modelCategoryRatings.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type AssistantRow = typeof assistants.$inferSelect;
export type BattleRow = typeof battles.$inferSelect;
export type BattleMessageRow = typeof battleMessages.$inferSelect;
export type CollabRow = typeof collabs.$inferSelect;
export type CollabContributionRow = typeof collabContributions.$inferSelect;
export type PromptTemplateRow = typeof promptTemplates.$inferSelect;
export type ArcadeGameRow = typeof arcadeGames.$inferSelect;
export type PrivacyEventRow = typeof privacyEvents.$inferSelect;
export type CouncilRunRow = typeof councilRuns.$inferSelect;
export type CouncilArtifactRow = typeof councilArtifacts.$inferSelect;
export type CognitiveSessionRow = typeof cognitiveSessions.$inferSelect;
export type CognitiveSessionInputRow = typeof cognitiveSessionInputs.$inferSelect;
export type CognitiveSessionAssignmentRow = typeof cognitiveSessionAssignments.$inferSelect;
export type HandoffRow = typeof handoffs.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ProjectMemoryRow = typeof projectMemory.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
