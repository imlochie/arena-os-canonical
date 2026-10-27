/**
 * Mode-neutral execution sessions — the branch's redesigned cognitive
 * session (mode/executionMode/lifecycle/event-sequence). Renamed from the
 * branch's `cognitive_sessions` (a redesign, not an extension) so main's
 * council-flavored cognitive_sessions remains untouched; the branch's
 * execution machinery runs on this family instead.
 */
export const executionSessions = pgTable("execution_sessions", {
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

/**
 * Owner/device identity + security architecture schema — clean-room
 * preservation of arena/01a09640-arena-os-canonical (17 commits, Sep 2026),
 * extracted from that branch's schema additions. The October main squash
 * carried a different evolution of src/db/schema.ts; these tables are the
 * branch's own (all-new, no collisions — verified), wired here as a separate
 * schema file included by both drizzle configs.
 */

import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const cognitiveSessionInputs = pgTable("cognitive_session_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("primary"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("cognitive_session_inputs_session_id_idx").on(t.sessionId),
]);

export const cognitiveSessionAssignments = pgTable("cognitive_session_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
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
  id: uuid("id").primaryKey().defaultRandom(), sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
  actorId: text("actor_id").notNull(), grantId: text("grant_id").notNull(), resourceId: text("resource_id").notNull(), capability: text("capability").notNull(),
  canonicalScope: text("canonical_scope").notNull(), targetPath: text("target_path").notNull(), effectClass: text("effect_class").notNull().default("write_local"),
  proposedOperation: text("proposed_operation").notNull(), operationDigest: text("operation_digest").notNull(), status: text("status").notNull().default("proposed"),
  approvedBy: text("approved_by"), approvedDigest: text("approved_digest"), preimageDigest: text("preimage_digest"), preimage: text("preimage"),
  errorCode: text("error_code"), errorMessage: text("error_message"), createdAt: timestamp("created_at").defaultNow().notNull(), approvedAt: timestamp("approved_at"), appliedAt: timestamp("applied_at"),
}, (t) => [index("tool_effects_session_idx").on(t.sessionId, t.createdAt)]);

export const workerExecutionOperations = pgTable("worker_execution_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
  assignmentId: uuid("assignment_id").notNull().references(() => cognitiveSessionAssignments.id, { onDelete: "cascade" }),
  nextAttemptNumber: integer("next_attempt_number").notNull().default(1),
  status: text("status").notNull().default("running"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (t) => [index("worker_execution_operations_assignment_idx").on(t.assignmentId, t.createdAt)]);

export const workerExecutions = pgTable("worker_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
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
  sourceSessionId: uuid("source_session_id").references(() => executionSessions.id, { onDelete: "set null" }),
  targetSessionId: uuid("target_session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
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
  sessionId: uuid("session_id").notNull().references(() => executionSessions.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  sequence: integer("sequence").notNull(),
  payload: text("payload").notNull().default("{}"), // structured JSON metadata
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  uniqueIndex("cognitive_session_events_session_sequence_unique").on(t.sessionId, t.sequence),
  index("cognitive_session_events_session_id_idx").on(t.sessionId, t.sequence),
]);

export const arenaOwners = pgTable("arena_owners", { id: uuid("id").primaryKey().defaultRandom(), displayName: text("display_name").notNull(), createdAt: timestamp("created_at").defaultNow().notNull() });

export const arenaDevices = pgTable("arena_devices", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), displayName:text("display_name").notNull(), deviceType:text("device_type").notNull(), enrollmentProvenance:text("enrollment_provenance").notNull(), nodePublicKey:text("node_public_key"), lastActivityAt:timestamp("last_activity_at"), revokedAt:timestamp("revoked_at"), revocationReason:text("revocation_reason"), state:text("state").notNull().default("active"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const webauthnCredentials = pgTable("webauthn_credentials", { id:text("id").primaryKey(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), publicKey:text("public_key").notNull(), counter:integer("counter").notNull().default(0), transports:text("transports").notNull().default("[]"), deviceType:text("device_type"), backedUp:boolean("backed_up").notNull().default(false), revokedAt:timestamp("revoked_at"), createdAt:timestamp("created_at").defaultNow().notNull(), lastUsedAt:timestamp("last_used_at") });

export const authChallenges = pgTable("auth_challenges", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").references(()=>arenaDevices.id,{onDelete:"cascade"}), kind:text("kind").notNull(), challenge:text("challenge").notNull(), expiresAt:timestamp("expires_at").notNull(), consumedAt:timestamp("consumed_at"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const authenticatedSessions = pgTable("authenticated_sessions", { id:uuid("id").primaryKey().defaultRandom(), tokenHash:text("token_hash").notNull().unique(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), credentialId:text("credential_id").notNull().references(()=>webauthnCredentials.id), authenticationMethod:text("authentication_method").notNull().default("webauthn"), assurance:text("assurance").notNull().default("user_verified"), freshVerifiedAt:timestamp("fresh_verified_at"), createdAt:timestamp("created_at").defaultNow().notNull(), expiresAt:timestamp("expires_at").notNull(), lastActivityAt:timestamp("last_activity_at").defaultNow().notNull(), revokedAt:timestamp("revoked_at") });

export const deviceCapabilityGrants = pgTable("device_capability_grants", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), deviceId:uuid("device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), capability:text("capability").notNull(), resource:text("resource").notNull(), scope:text("scope").notNull(), effectClass:text("effect_class"), createdAt:timestamp("created_at").defaultNow().notNull(), expiresAt:timestamp("expires_at"), revokedAt:timestamp("revoked_at"), createdByDeviceId:uuid("created_by_device_id").references(()=>arenaDevices.id) });

export const securityEvents = pgTable("security_events", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").references(()=>arenaOwners.id,{onDelete:"set null"}), deviceId:uuid("device_id").references(()=>arenaDevices.id,{onDelete:"set null"}), authenticatedSessionId:uuid("authenticated_session_id").references(()=>authenticatedSessions.id,{onDelete:"set null"}), type:text("type").notNull(), outcome:text("outcome").notNull(), metadata:text("metadata").notNull().default("{}"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const fileArtifacts = pgTable("file_artifacts", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), uploadedByDeviceId:uuid("uploaded_by_device_id").notNull().references(()=>arenaDevices.id), projectId:uuid("project_id"), sessionId:uuid("session_id").references(()=>executionSessions.id,{onDelete:"set null"}), displayName:text("display_name").notNull(), mediaType:text("media_type").notNull(), declaredMediaType:text("declared_media_type").notNull(), byteSize:integer("byte_size").notNull(), contentHash:text("content_hash").notNull(), privacyClassification:text("privacy_classification").notNull(), storageKey:text("storage_key").notNull().unique(), contentBase64:text("content_base64").notNull().default(""), blobKeyVersion:integer("blob_key_version"), blobNonce:text("blob_nonce"), blobAuthTag:text("blob_auth_tag"), encryptedAt:timestamp("encrypted_at"), status:text("status").notNull().default("available"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const nodeProtocolRequests = pgTable("node_protocol_requests", { id:uuid("id").primaryKey().defaultRandom(), ownerId:uuid("owner_id").notNull().references(()=>arenaOwners.id,{onDelete:"cascade"}), controlDeviceId:uuid("control_device_id").notNull().references(()=>arenaDevices.id), nodeDeviceId:uuid("node_device_id").notNull().references(()=>arenaDevices.id), capability:text("capability").notNull(), resourceId:text("resource_id").notNull(), nonce:text("nonce").notNull().unique(), issuedAt:timestamp("issued_at").notNull(), expiresAt:timestamp("expires_at").notNull(), payloadDigest:text("payload_digest").notNull(), signature:text("signature").notNull(), status:text("status").notNull().default("issued"), consumedAt:timestamp("consumed_at"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const nodeKeys = pgTable("node_keys", { id:uuid("id").primaryKey().defaultRandom(), nodeDeviceId:uuid("node_device_id").notNull().references(()=>arenaDevices.id,{onDelete:"cascade"}), algorithm:text("algorithm").notNull().default("ed25519"), publicKey:text("public_key").notNull(), fingerprint:text("fingerprint").notNull().unique(), version:integer("version").notNull(), state:text("state").notNull().default("pending"), replacesKeyId:uuid("replaces_key_id"), enrollmentProvenance:text("enrollment_provenance").notNull(), activatedAt:timestamp("activated_at"), expiresAt:timestamp("expires_at"), revokedAt:timestamp("revoked_at"), revocationReason:text("revocation_reason"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const nodeProtocolResponses = pgTable("node_protocol_responses", { id:uuid("id").primaryKey().defaultRandom(), requestId:uuid("request_id").notNull().references(()=>nodeProtocolRequests.id,{onDelete:"cascade"}).unique(), nodeDeviceId:uuid("node_device_id").notNull().references(()=>arenaDevices.id), nodeKeyId:uuid("node_key_id").notNull().references(()=>nodeKeys.id), responseNonce:text("response_nonce").notNull().unique(), status:text("status").notNull(), resultDigest:text("result_digest").notNull(), issuedAt:timestamp("issued_at").notNull(), expiresAt:timestamp("expires_at").notNull(), signature:text("signature").notNull(), acceptedAt:timestamp("accepted_at"), createdAt:timestamp("created_at").defaultNow().notNull() });

export const rateLimitBuckets = pgTable("rate_limit_buckets", { key:text("key").primaryKey(), windowStartedAt:timestamp("window_started_at").notNull(), count:integer("count").notNull().default(0), bytes:integer("bytes").notNull().default(0), updatedAt:timestamp("updated_at").defaultNow().notNull() });
