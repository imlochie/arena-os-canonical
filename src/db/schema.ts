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
  synthesis: text("synthesis").notNull().default(""),
  latencyMs: integer("latency_ms").notNull().default(0),
  projectId: uuid("project_id"),
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
  councilRunId: uuid("council_run_id"),
  title: text("title").notNull().default("Untitled cognitive session"),
  jobId: text("job_id").notNull().default("second_brain"),
  material: text("material").notNull(),
  modelAId: text("model_a_id").notNull(),
  modelBId: text("model_b_id").notNull(),
  synthesisModel: text("synthesis_model").notNull(),
  roleALabel: text("role_a_label").notNull().default(""),
  roleBLabel: text("role_b_label").notNull().default(""),
  status: text("status").notNull().default("completed"), // running|completed|failed|archived
  createdAt: timestamp("created_at").defaultNow(),
});

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

// ---- Direct chats ----
export const chats = pgTable("chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("New chat"),
  modelId: text("model_id").notNull().default("openai"),
  assistantId: uuid("assistant_id"),
  projectId: uuid("project_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatId: uuid("chat_id").notNull(),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---- Durable, private Stem Lab records ----
// These tables are additive. They attach real audio assets to the existing Arena
// project object without changing the legacy project's public API behavior.
export const arenaUsers = pgTable("arena_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("arena_users_username_unique").on(t.username),
  uniqueIndex("arena_users_email_unique").on(t.email),
]);

export const arenaSessions = pgTable("arena_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => arenaUsers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("arena_sessions_token_hash_unique").on(t.tokenHash),
  index("arena_sessions_user_id_idx").on(t.userId),
]);

export const arenaProjectMembers = pgTable("arena_project_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => arenaUsers.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // owner | editor | viewer
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("arena_project_members_project_user_unique").on(t.projectId, t.userId),
  index("arena_project_members_user_id_idx").on(t.userId),
]);

export const stemWorkerHeartbeats = pgTable("stem_worker_heartbeats", {
  id: text("id").primaryKey(),
  engine: text("engine").notNull(),
  model: text("model").notNull(),
  device: text("device").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
});

export const stemSourceAssets = pgTable("stem_source_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  storageKey: text("storage_key").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  channels: integer("channels").notNull(),
  codec: text("codec").notNull(),
  bitrate: integer("bitrate"),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("stem_source_assets_storage_key_unique").on(t.storageKey),
  index("stem_source_assets_project_id_idx").on(t.projectId),
]);

export const stemProcessingJobs = pgTable("stem_processing_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => stemSourceAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  model: text("model").notNull(),
  requestedDevice: text("requested_device").notNull(),
  resolvedDevice: text("resolved_device"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metadata: text("metadata").notNull().default("{}"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("stem_processing_jobs_idempotency_unique").on(t.idempotencyKey),
  index("stem_processing_jobs_project_id_idx").on(t.projectId),
  index("stem_processing_jobs_status_idx").on(t.status),
]);

export const stemAssets = pgTable("stem_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => stemSourceAssets.id, { onDelete: "cascade" }),
  separationJobId: uuid("separation_job_id").notNull().references(() => stemProcessingJobs.id, { onDelete: "cascade" }),
  stemType: text("stem_type").notNull(),
  engine: text("engine").notNull(),
  model: text("model").notNull(),
  modelVersion: text("model_version").notNull(),
  storageKey: text("storage_key").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  channels: integer("channels").notNull(),
  codec: text("codec").notNull(),
  format: text("format").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("stem_assets_job_stem_unique").on(t.separationJobId, t.stemType),
  uniqueIndex("stem_assets_storage_key_unique").on(t.storageKey),
  index("stem_assets_project_id_idx").on(t.projectId),
]);

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
export type ProjectRow = typeof projects.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ProjectMemoryRow = typeof projectMemory.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
