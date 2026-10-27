CREATE TABLE IF NOT EXISTS "archive_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "path" text,
  "kind" text DEFAULT 'other' NOT NULL,
  "size_bytes" integer,
  "content_hash" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'inbox' NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "tags" text DEFAULT '' NOT NULL,
  "collection" text DEFAULT '' NOT NULL,
  "possible_dup_of" uuid,
  "source" text DEFAULT 'manual' NOT NULL,
  "project_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_items_status_idx" ON "archive_items" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "archive_items_kind_idx" ON "archive_items" ("kind");
