CREATE TABLE "arena_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"device_type" text NOT NULL,
	"enrollment_provenance" text NOT NULL,
	"node_public_key" text,
	"last_activity_at" timestamp,
	"revoked_at" timestamp,
	"revocation_reason" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "arena_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"device_id" uuid,
	"kind" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authenticated_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"authentication_method" text DEFAULT 'webauthn' NOT NULL,
	"assurance" text DEFAULT 'user_verified' NOT NULL,
	"fresh_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "authenticated_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cognitive_session_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"requested_role" text NOT NULL,
	"workforce_role_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"execution_mode" text DEFAULT 'online' NOT NULL,
	"eligibility_decision" text DEFAULT 'eligible under default online policy' NOT NULL,
	"worker_availability" text DEFAULT 'unknown' NOT NULL,
	"capabilities_considered" text DEFAULT '[]' NOT NULL,
	"pinned_model_id" text,
	"assignment_sequence" integer DEFAULT 1 NOT NULL,
	"supersedes_assignment_id" uuid,
	"reassignment_reason" text,
	"status" text DEFAULT 'active' NOT NULL,
	"next_execution_attempt" integer DEFAULT 1 NOT NULL,
	"selection_reason" text NOT NULL,
	"capability_match" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cognitive_session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cognitive_session_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text DEFAULT 'primary' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "device_capability_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"effect_class" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_by_device_id" uuid
);
--> statement-breakpoint
CREATE TABLE "execution_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"mode" text NOT NULL,
	"execution_mode" text DEFAULT 'online' NOT NULL,
	"max_execution_attempts" integer DEFAULT 2 NOT NULL,
	"fallback_policy" text DEFAULT 'none' NOT NULL,
	"intent" text,
	"title" text DEFAULT 'Untitled cognitive session' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"current_stage" text,
	"next_event_sequence" integer DEFAULT 1 NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"completed_at" timestamp,
	"failed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "file_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"uploaded_by_device_id" uuid NOT NULL,
	"project_id" uuid,
	"session_id" uuid,
	"display_name" text NOT NULL,
	"media_type" text NOT NULL,
	"declared_media_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"privacy_classification" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_base64" text DEFAULT '' NOT NULL,
	"blob_key_version" integer,
	"blob_nonce" text,
	"blob_auth_tag" text,
	"encrypted_at" timestamp,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "file_artifacts_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_session_id" uuid,
	"target_session_id" uuid NOT NULL,
	"source_artifact_id" uuid,
	"source_project_id" uuid,
	"target_project_id" uuid,
	"type" text DEFAULT 'continue' NOT NULL,
	"intent" text,
	"payload" text DEFAULT '{}' NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "node_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_device_id" uuid NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"replaces_key_id" uuid,
	"enrollment_provenance" text NOT NULL,
	"activated_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"revocation_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "node_keys_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "node_protocol_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"control_device_id" uuid NOT NULL,
	"node_device_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"resource_id" text NOT NULL,
	"nonce" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"payload_digest" text NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "node_protocol_requests_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "node_protocol_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"node_device_id" uuid NOT NULL,
	"node_key_id" uuid NOT NULL,
	"response_nonce" text NOT NULL,
	"status" text NOT NULL,
	"result_digest" text NOT NULL,
	"issued_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"signature" text NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "node_protocol_responses_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "node_protocol_responses_response_nonce_unique" UNIQUE("response_nonce")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"device_id" uuid,
	"authenticated_session_id" uuid,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"capability" text NOT NULL,
	"canonical_scope" text NOT NULL,
	"target_path" text NOT NULL,
	"effect_class" text DEFAULT 'write_local' NOT NULL,
	"proposed_operation" text NOT NULL,
	"operation_digest" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"approved_by" text,
	"approved_digest" text,
	"preimage_digest" text,
	"preimage" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"applied_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text DEFAULT '[]' NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "worker_execution_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"next_attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "worker_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"operation_id" uuid,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"previous_execution_id" uuid,
	"retry_reason" text,
	"fallback_source_assignment_id" uuid,
	"fallback_policy" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"selected_provider" text NOT NULL,
	"selected_model_id" text NOT NULL,
	"actual_provider" text,
	"actual_model_id" text,
	"route" text,
	"output_contract" text DEFAULT 'text' NOT NULL,
	"error_code" text,
	"error_message" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "arena_devices" ADD CONSTRAINT "arena_devices_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_device_id_arena_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."arena_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticated_sessions" ADD CONSTRAINT "authenticated_sessions_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticated_sessions" ADD CONSTRAINT "authenticated_sessions_device_id_arena_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."arena_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticated_sessions" ADD CONSTRAINT "authenticated_sessions_credential_id_webauthn_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."webauthn_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cognitive_session_assignments" ADD CONSTRAINT "cognitive_session_assignments_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cognitive_session_events" ADD CONSTRAINT "cognitive_session_events_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cognitive_session_inputs" ADD CONSTRAINT "cognitive_session_inputs_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_capability_grants" ADD CONSTRAINT "device_capability_grants_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_capability_grants" ADD CONSTRAINT "device_capability_grants_device_id_arena_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."arena_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_capability_grants" ADD CONSTRAINT "device_capability_grants_created_by_device_id_arena_devices_id_fk" FOREIGN KEY ("created_by_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_uploaded_by_device_id_arena_devices_id_fk" FOREIGN KEY ("uploaded_by_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_artifacts" ADD CONSTRAINT "file_artifacts_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_source_session_id_execution_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_target_session_id_execution_sessions_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_keys" ADD CONSTRAINT "node_keys_node_device_id_arena_devices_id_fk" FOREIGN KEY ("node_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_requests" ADD CONSTRAINT "node_protocol_requests_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_requests" ADD CONSTRAINT "node_protocol_requests_control_device_id_arena_devices_id_fk" FOREIGN KEY ("control_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_requests" ADD CONSTRAINT "node_protocol_requests_node_device_id_arena_devices_id_fk" FOREIGN KEY ("node_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_responses" ADD CONSTRAINT "node_protocol_responses_request_id_node_protocol_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."node_protocol_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_responses" ADD CONSTRAINT "node_protocol_responses_node_device_id_arena_devices_id_fk" FOREIGN KEY ("node_device_id") REFERENCES "public"."arena_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_protocol_responses" ADD CONSTRAINT "node_protocol_responses_node_key_id_node_keys_id_fk" FOREIGN KEY ("node_key_id") REFERENCES "public"."node_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_device_id_arena_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."arena_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_authenticated_session_id_authenticated_sessions_id_fk" FOREIGN KEY ("authenticated_session_id") REFERENCES "public"."authenticated_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_effects" ADD CONSTRAINT "tool_effects_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_owner_id_arena_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."arena_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_device_id_arena_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."arena_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_execution_operations" ADD CONSTRAINT "worker_execution_operations_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_execution_operations" ADD CONSTRAINT "worker_execution_operations_assignment_id_cognitive_session_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."cognitive_session_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_executions" ADD CONSTRAINT "worker_executions_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_executions" ADD CONSTRAINT "worker_executions_assignment_id_cognitive_session_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."cognitive_session_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_executions" ADD CONSTRAINT "worker_executions_operation_id_worker_execution_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."worker_execution_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cognitive_session_assignments_session_slot_sequence_unique" ON "cognitive_session_assignments" USING btree ("session_id","slot","assignment_sequence");--> statement-breakpoint
CREATE INDEX "cognitive_session_assignments_session_id_idx" ON "cognitive_session_assignments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "cognitive_session_assignments_supersedes_id_idx" ON "cognitive_session_assignments" USING btree ("supersedes_assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cognitive_session_events_session_sequence_unique" ON "cognitive_session_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "cognitive_session_events_session_id_idx" ON "cognitive_session_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE INDEX "cognitive_session_inputs_session_id_idx" ON "cognitive_session_inputs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "handoffs_source_session_id_idx" ON "handoffs" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "handoffs_target_session_id_idx" ON "handoffs" USING btree ("target_session_id");--> statement-breakpoint
CREATE INDEX "tool_effects_session_idx" ON "tool_effects" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "worker_execution_operations_assignment_idx" ON "worker_execution_operations" USING btree ("assignment_id","created_at");--> statement-breakpoint
CREATE INDEX "worker_executions_session_id_idx" ON "worker_executions" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE INDEX "worker_executions_assignment_id_idx" ON "worker_executions" USING btree ("assignment_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_executions_operation_attempt_unique" ON "worker_executions" USING btree ("operation_id","attempt_number");