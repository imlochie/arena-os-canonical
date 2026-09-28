import { boolean, index, integer, pgTable, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
  platformRole: text("platform_role").notNull().default("member"),
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
  // SQL migration owns this forward foreign key because export_assets is declared
  // later in this module; application publication logic also verifies project scope.
  publishedExportAssetId: uuid("published_export_asset_id"),
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
  // Kept for backwards-compatible inspection. Canonical waveform metadata and
  // state live in waveform_assets, where source and stem assets share one model.
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

// Waveforms are derived assets. Their JSON payload is kept in private object
// storage; PostgreSQL records the authenticated relationship and validation
// metadata only.
export const waveformJobs = pgTable("waveform_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").references(() => sourceAssets.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").references(() => stemAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("waveform_jobs_idempotency_unique").on(table.idempotencyKey), index("waveform_jobs_project_id_idx").on(table.projectId), index("waveform_jobs_status_idx").on(table.status)]);

export const waveformAssets = pgTable("waveform_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").references(() => sourceAssets.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").references(() => stemAssets.id, { onDelete: "cascade" }),
  waveformJobId: uuid("waveform_job_id").notNull().references(() => waveformJobs.id, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  format: text("format").notNull().default("waveyard-peaks-v1"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("waveform_assets_storage_key_unique").on(table.storageKey), uniqueIndex("waveform_assets_job_unique").on(table.waveformJobId), index("waveform_assets_project_id_idx").on(table.projectId)]);

export const sourceAnalyses = pgTable("source_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  bpm: real("bpm"),
  bpmConfidence: real("bpm_confidence"),
  musicalKey: text("musical_key"),
  keyConfidence: real("key_confidence"),
  // Canonical JSON list of beat positions in source milliseconds. It is source
  // metadata, deliberately independent from RemixSession's timing model.
  beatGrid: text("beat_grid"),
  beatConfidence: real("beat_confidence"),
  analysisError: text("analysis_error"),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("source_analyses_source_asset_unique").on(table.sourceAssetId),
  uniqueIndex("source_analyses_idempotency_unique").on(table.idempotencyKey),
  index("source_analyses_project_id_idx").on(table.projectId),
  index("source_analyses_status_idx").on(table.status),
]);

export const sourceSectionAnalyses = pgTable("source_section_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  sourceAnalysisId: uuid("source_analysis_id").notNull().references(() => sourceAnalyses.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("source_section_analyses_source_asset_unique").on(table.sourceAssetId),
  uniqueIndex("source_section_analyses_idempotency_unique").on(table.idempotencyKey),
  index("source_section_analyses_project_id_idx").on(table.projectId),
  index("source_section_analyses_status_idx").on(table.status),
]);

// Structural metadata stays in source coordinates and deliberately references
// the existing analysis rather than duplicating BPM, key, or beat-grid values.
export const sourceSections = pgTable("source_sections", {
  id: text("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  sourceAnalysisId: uuid("source_analysis_id").notNull().references(() => sourceAnalyses.id, { onDelete: "cascade" }),
  sourceSectionAnalysisId: uuid("source_section_analysis_id").notNull().references(() => sourceSectionAnalyses.id, { onDelete: "cascade" }),
  sectionIndex: integer("section_index").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  startBeatIndex: integer("start_beat_index").notNull(),
  endBeatIndex: integer("end_beat_index").notNull(),
  startBar: integer("start_bar").notNull(),
  endBar: integer("end_bar").notNull(),
  label: text("label").notNull().default("section"),
  labelConfidence: real("label_confidence").notNull().default(0),
  structuralConfidence: real("structural_confidence").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("source_sections_source_index_unique").on(table.sourceAssetId, table.sectionIndex),
  index("source_sections_source_order_idx").on(table.sourceAssetId, table.sectionIndex),
  index("source_sections_project_id_idx").on(table.projectId),
]);

// Deterministic onset/event analysis is provenance-bound to a source identity.
export const sourceEventAnalyses = pgTable("source_event_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("source_event_analyses_source_asset_unique").on(table.sourceAssetId),
  uniqueIndex("source_event_analyses_idempotency_unique").on(table.idempotencyKey),
  index("source_event_analyses_project_id_idx").on(table.projectId),
]);

export const sourceEvents = pgTable("source_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  sourceEventAnalysisId: uuid("source_event_analysis_id").notNull().references(() => sourceEventAnalyses.id, { onDelete: "cascade" }),
  eventIndex: integer("event_index").notNull(),
  timestampMs: integer("timestamp_ms").notNull(),
  strength: real("strength").notNull(),
  confidence: real("confidence").notNull().default(0),
  rhythmicClass: text("rhythmic_class"),
  ...timestamps,
}, (table) => [
  uniqueIndex("source_events_analysis_index_unique").on(table.sourceEventAnalysisId, table.eventIndex),
  index("source_events_source_time_idx").on(table.sourceAssetId, table.timestampMs),
  index("source_events_project_id_idx").on(table.projectId),
]);

// Stem-scoped V1 vocal evidence never claims that the original mixed source is vocal.
// Stem-scoped deterministic drum/percussion transient evidence. This preserves
// generic source events while enforcing the exact separated stem provenance.
export const drumAnalyses = pgTable("drum_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").notNull().references(() => stemAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  stemChecksumSha256: text("stem_checksum_sha256").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("drum_analyses_stem_asset_unique").on(table.stemAssetId),
  uniqueIndex("drum_analyses_idempotency_unique").on(table.idempotencyKey),
  index("drum_analyses_project_id_idx").on(table.projectId),
  index("drum_analyses_source_stem_idx").on(table.sourceAssetId, table.stemAssetId),
]);

export const drumEvents = pgTable("drum_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  drumAnalysisId: uuid("drum_analysis_id").notNull().references(() => drumAnalyses.id, { onDelete: "cascade" }),
  eventIndex: integer("event_index").notNull(),
  timestampMs: integer("timestamp_ms").notNull(),
  strength: real("strength").notNull(),
  confidence: real("confidence").notNull(),
  rhythmicClass: text("rhythmic_class"),
  nearestBeatIndex: integer("nearest_beat_index"),
  beatOffsetMs: integer("beat_offset_ms"),
  ...timestamps,
}, (table) => [
  uniqueIndex("drum_events_analysis_index_unique").on(table.drumAnalysisId, table.eventIndex),
  index("drum_events_analysis_time_idx").on(table.drumAnalysisId, table.timestampMs),
]);

export const vocalAnalyses = pgTable("vocal_analyses", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => sourceAssets.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").notNull().references(() => stemAssets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  analysisEngine: text("analysis_engine").notNull(),
  analysisEngineVersion: text("analysis_engine_version").notNull(),
  sourceChecksumSha256: text("source_checksum_sha256").notNull(),
  stemChecksumSha256: text("stem_checksum_sha256").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("vocal_analyses_stem_asset_unique").on(table.stemAssetId),
  uniqueIndex("vocal_analyses_idempotency_unique").on(table.idempotencyKey),
  index("vocal_analyses_project_id_idx").on(table.projectId),
  index("vocal_analyses_source_stem_idx").on(table.sourceAssetId, table.stemAssetId),
]);

export const vocalPitchFrames = pgTable("vocal_pitch_frames", {
  id: uuid("id").defaultRandom().primaryKey(),
  vocalAnalysisId: uuid("vocal_analysis_id").notNull().references(() => vocalAnalyses.id, { onDelete: "cascade" }),
  frameIndex: integer("frame_index").notNull(),
  timestampMs: integer("timestamp_ms").notNull(),
  frequencyHz: real("frequency_hz"),
  midiFloat: real("midi_float"),
  nearestMidiNote: integer("nearest_midi_note"),
  confidence: real("confidence").notNull(),
  voiced: boolean("voiced").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("vocal_pitch_frames_analysis_index_unique").on(table.vocalAnalysisId, table.frameIndex),
  index("vocal_pitch_frames_analysis_time_idx").on(table.vocalAnalysisId, table.timestampMs),
]);

export const vocalPhrases = pgTable("vocal_phrases", {
  id: uuid("id").defaultRandom().primaryKey(),
  vocalAnalysisId: uuid("vocal_analysis_id").notNull().references(() => vocalAnalyses.id, { onDelete: "cascade" }),
  phraseIndex: integer("phrase_index").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  confidence: real("confidence").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("vocal_phrases_analysis_index_unique").on(table.vocalAnalysisId, table.phraseIndex),
  index("vocal_phrases_analysis_start_idx").on(table.vocalAnalysisId, table.startMs),
]);

// A remix is non-destructive arrangement metadata over existing stems. No clip
// operation copies or mutates original separated audio.
export const remixSessions = pgTable("remix_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  masterVolume: real("master_volume").notNull().default(1),
  loopStartMs: integer("loop_start_ms").notNull().default(0),
  loopEndMs: integer("loop_end_ms"),
  tempoBpm: real("tempo_bpm").notNull().default(120),
  timeSignatureNumerator: integer("time_signature_numerator").notNull().default(4),
  timeSignatureDenominator: integer("time_signature_denominator").notNull().default(4),
  gridDivision: text("grid_division").notNull().default("beat"),
  snapEnabled: boolean("snap_enabled").notNull().default(true),
  // A user-selected canonical key; source keys remain authoritative analyses.
  targetKey: text("target_key"),
  version: integer("version").notNull().default(1),
  ...timestamps,
}, (table) => [index("remix_sessions_project_id_idx").on(table.projectId), index("remix_sessions_owner_id_idx").on(table.ownerId)]);

export const remixTracks = pgTable("remix_tracks", {
  id: uuid("id").defaultRandom().primaryKey(),
  remixSessionId: uuid("remix_session_id").notNull().references(() => remixSessions.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").notNull().references(() => stemAssets.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  volume: real("volume").notNull().default(1),
  pan: real("pan").notNull().default(0),
  muted: boolean("muted").notNull().default(false),
  solo: boolean("solo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("remix_tracks_session_id_idx").on(table.remixSessionId), index("remix_tracks_session_stem_idx").on(table.remixSessionId, table.stemAssetId)]);

export const remixClips = pgTable("remix_clips", {
  id: uuid("id").defaultRandom().primaryKey(),
  remixTrackId: uuid("remix_track_id").notNull().references(() => remixTracks.id, { onDelete: "cascade" }),
  stemAssetId: uuid("stem_asset_id").notNull().references(() => stemAssets.id, { onDelete: "restrict" }),
  timelineStartMs: integer("timeline_start_ms").notNull().default(0),
  durationMs: integer("duration_ms").notNull(),
  sourceOffsetMs: integer("source_offset_ms").notNull().default(0),
  gain: real("gain").notNull().default(1),
  fadeInMs: integer("fade_in_ms").notNull().default(0),
  fadeOutMs: integer("fade_out_ms").notNull().default(0),
  // Intent only. The worker derives source BPM and the effective ratio at render time.
  tempoSyncEnabled: boolean("tempo_sync_enabled").notNull().default(false),
  // Intent only. The worker derives source/target semitones while rendering.
  keySyncEnabled: boolean("key_sync_enabled").notNull().default(false),
  // Source-editing intent; snapping resolves metadata only and adds no DSP.
  beatSnapEnabled: boolean("beat_snap_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("remix_clips_track_id_idx").on(table.remixTrackId), index("remix_clips_asset_id_idx").on(table.stemAssetId)]);

// V1 arrangement automation is deliberately limited to ordered volume/pan points.
// It is scoped through the remix and track rather than introducing groups or DSP state.
export const remixAutomationPoints = pgTable("remix_automation_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  remixSessionId: uuid("remix_session_id").notNull().references(() => remixSessions.id, { onDelete: "cascade" }),
  remixTrackId: uuid("remix_track_id").notNull().references(() => remixTracks.id, { onDelete: "cascade" }),
  parameter: text("parameter").notNull(),
  timelineMs: integer("timeline_ms").notNull(),
  value: real("value").notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("remix_automation_points_track_parameter_time_unique").on(table.remixTrackId, table.parameter, table.timelineMs),
  index("remix_automation_points_session_track_idx").on(table.remixSessionId, table.remixTrackId),
]);

export const remixVersions = pgTable("remix_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  remixSessionId: uuid("remix_session_id").notNull().references(() => remixSessions.id, { onDelete: "cascade" }),
  createdById: uuid("created_by_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  snapshot: text("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("remix_versions_session_id_idx").on(table.remixSessionId)]);

// An export request is immutable provenance over a named persisted remix
// version. The worker is the only process allowed to render its output.
export const exportJobs = pgTable("export_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  remixSessionId: uuid("remix_session_id").notNull().references(() => remixSessions.id, { onDelete: "restrict" }),
  remixVersionId: uuid("remix_version_id").notNull().references(() => remixVersions.id, { onDelete: "restrict" }),
  requestedById: uuid("requested_by_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  idempotencyKey: text("idempotency_key").notNull(),
  format: text("format").notNull().default("wav"),
  sampleRate: integer("sample_rate").notNull().default(44100),
  channels: integer("channels").notNull().default(2),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("export_jobs_idempotency_unique").on(table.idempotencyKey),
  index("export_jobs_project_id_idx").on(table.projectId),
  index("export_jobs_version_id_idx").on(table.remixVersionId),
  index("export_jobs_status_idx").on(table.status),
]);

// An export asset exists only after the worker stored and validated the exact
// output of its linked export job. It never contains a browser-only render.
export const exportAssets = pgTable("export_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  exportJobId: uuid("export_job_id").notNull().references(() => exportJobs.id, { onDelete: "cascade" }),
  remixVersionId: uuid("remix_version_id").notNull().references(() => remixVersions.id, { onDelete: "restrict" }),
  storageKey: text("storage_key").notNull(),
  filename: text("filename").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  channels: integer("channels").notNull(),
  codec: text("codec").notNull(),
  format: text("format").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("export_assets_job_unique").on(table.exportJobId),
  uniqueIndex("export_assets_storage_key_unique").on(table.storageKey),
  index("export_assets_project_id_idx").on(table.projectId),
  index("export_assets_version_id_idx").on(table.remixVersionId),
]);

// Publication history is append-only. Current public state remains canonical on
// projects; these events preserve the actor, reason, and normalized transition.
export const projectAuditEvents = pgTable("project_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  reason: text("reason"),
  metadata: text("metadata").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("project_audit_events_project_created_idx").on(table.projectId, table.createdAt),
  index("project_audit_events_type_created_idx").on(table.eventType, table.createdAt),
]);
