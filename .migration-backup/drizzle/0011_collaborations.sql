CREATE TABLE IF NOT EXISTS "collaborations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text DEFAULT 'Untitled collaboration' NOT NULL,
  "goal" text NOT NULL,
  "context" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "auto_route" integer DEFAULT 0 NOT NULL,
  "project_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "collaboration_id" uuid NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "emoji" text DEFAULT '🤖' NOT NULL,
  "kind" text DEFAULT 'model' NOT NULL,
  "model_id" text,
  "adapter_url" text,
  "adapter_model" text,
  "capabilities" text DEFAULT '' NOT NULL,
  "trust" text DEFAULT 'internal' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collaboration_relays" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "collaboration_id" uuid NOT NULL,
  "seq" integer DEFAULT 1 NOT NULL,
  "source_key" text DEFAULT 'owner' NOT NULL,
  "target_key" text NOT NULL,
  "purpose" text DEFAULT 'contribute' NOT NULL,
  "request" text NOT NULL,
  "context_refs" text DEFAULT '' NOT NULL,
  "classification" text DEFAULT 'internal' NOT NULL,
  "response_contract" text DEFAULT 'markdown text' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "response" text,
  "via" text DEFAULT '' NOT NULL,
  "note" text DEFAULT '' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
