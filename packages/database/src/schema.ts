import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  bio: text("bio").notNull().default(""),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("users_username_unique").on(table.username), uniqueIndex("users_email_unique").on(table.email)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("sessions_token_hash_unique").on(table.tokenHash), index("sessions_user_id_idx").on(table.userId)]);

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  artworkKey: text("artwork_key"),
  genre: text("genre"),
  tags: text("tags").notNull().default("[]"),
  licenseCode: text("license_code").notNull().default("all-rights-reserved"),
  remixPermission: text("remix_permission").notNull().default("owner-only"),
  downloadPermission: text("download_permission").notNull().default("owner-only"),
  visibility: text("visibility").notNull().default("private"),
  publicationStatus: text("publication_status").notNull().default("draft"),
  moderationStatus: text("moderation_status").notNull().default("active"),
  ...timestamps,
}, (table) => [index("projects_owner_id_idx").on(table.ownerId), index("projects_visibility_idx").on(table.visibility)]);

export const projectMembers = pgTable("project_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("project_members_project_user_unique").on(table.projectId, table.userId), index("project_members_user_id_idx").on(table.userId)]);

export const sourceAssets = pgTable("source_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("source_assets_storage_key_unique").on(table.storageKey), index("source_assets_project_id_idx").on(table.projectId)]);

export const processingJobs = pgTable("processing_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  stage: text("stage").notNull().default("queued"),
  idempotencyKey: text("idempotency_key").notNull(),
  model: text("model").notNull(),
  requestedDevice: text("requested_device").notNull(),
  resolvedDevice: text("resolved_device"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metadata: text("metadata").notNull().default("{}"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("processing_jobs_idempotency_unique").on(table.idempotencyKey), index("processing_jobs_project_id_idx").on(table.projectId), index("processing_jobs_status_idx").on(table.status)]);

export const stemAssets = pgTable("stem_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  separationJobId: uuid("separation_job_id").notNull().references(() => processingJobs.id, { onDelete: "cascade" }),
  stemType: text("stem_type").notNull(),
  engine: text("engine").notNull(),
  model: text("model").notNull(),
  modelVersion: text("model_version").notNull(),
  storageKey: text("storage_key").notNull(),
  waveformKey: text("waveform_key"),
  checksumSha256: text("checksum_sha256").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  channels: integer("channels").notNull(),
  codec: text("codec").notNull(),
  format: text("format").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("stem_assets_job_stem_unique").on(table.separationJobId, table.stemType), uniqueIndex("stem_assets_storage_key_unique").on(table.storageKey), index("stem_assets_project_id_idx").on(table.projectId)]);
