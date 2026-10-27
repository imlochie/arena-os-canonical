CREATE TABLE IF NOT EXISTS "congress_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text DEFAULT 'Untitled congress' NOT NULL,
  "topic" text NOT NULL,
  "project_id" uuid,
  "status" text DEFAULT 'sitting' NOT NULL,
  "seats" text DEFAULT '[]' NOT NULL,
  "synthesis_model" text DEFAULT 'openai' NOT NULL,
  "duration_ms" integer DEFAULT 600000 NOT NULL,
  "remaining_ms" integer,
  "ends_at" timestamp,
  "turn_count" integer DEFAULT 0 NOT NULL,
  "next_seat" integer DEFAULT 0 NOT NULL,
  "max_turns" integer DEFAULT 50 NOT NULL,
  "act" text,
  "parent_session_id" uuid,
  "sitting" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "congress_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "seat_index" integer DEFAULT -1 NOT NULL,
  "role" text DEFAULT '' NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "model_id" text DEFAULT '' NOT NULL,
  "content" text NOT NULL,
  "kind" text DEFAULT 'speech' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "congress_turns_session_idx" ON "congress_turns" ("session_id");
