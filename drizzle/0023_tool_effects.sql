CREATE TABLE "tool_effects" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
 "session_id" uuid NOT NULL REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE,
 "actor_id" text NOT NULL,"grant_id" text NOT NULL,"resource_id" text NOT NULL,
 "capability" text NOT NULL,"canonical_scope" text NOT NULL,"target_path" text NOT NULL,
 "effect_class" text DEFAULT 'write_local' NOT NULL,"proposed_operation" text NOT NULL,
 "operation_digest" text NOT NULL,"status" text DEFAULT 'proposed' NOT NULL,
 "approved_by" text,"approved_digest" text,"preimage_digest" text,"preimage" text,
 "error_code" text,"error_message" text,"created_at" timestamp DEFAULT now() NOT NULL,
 "approved_at" timestamp,"applied_at" timestamp
);
CREATE INDEX "tool_effects_session_idx" ON "tool_effects"("session_id","created_at");
