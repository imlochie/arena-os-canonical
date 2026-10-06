CREATE TABLE IF NOT EXISTS "owner_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content" text NOT NULL,
  "kind" text DEFAULT 'preference' NOT NULL,
  "classification" text DEFAULT 'internal' NOT NULL,
  "source" text DEFAULT 'owner' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collaboration_relays" ADD COLUMN IF NOT EXISTS "tool_use" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "collaboration_relays" ADD COLUMN IF NOT EXISTS "steps" text DEFAULT '[]' NOT NULL;
