CREATE TABLE IF NOT EXISTS "class_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "date" text NOT NULL,
  "classroom_key" text NOT NULL,
  "week_number" integer NOT NULL,
  "phase" text DEFAULT 'waiting' NOT NULL,
  "status" text DEFAULT 'waiting' NOT NULL,
  "collaboration_id" uuid,
  "opened_at" timestamp,
  "closed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "class_occurrences_date_idx" ON "class_occurrences" ("date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "edu_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "classroom_key" text NOT NULL,
  "week_number" integer,
  "kind" text DEFAULT 'observation' NOT NULL,
  "content" text NOT NULL,
  "source_occurrence_id" uuid,
  "collaboration_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL
);
