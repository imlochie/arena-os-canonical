CREATE TABLE IF NOT EXISTS "cut_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text DEFAULT 'Untitled cut' NOT NULL,
  "aspect" text DEFAULT '16:9' NOT NULL,
  "clips" text DEFAULT '[]' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
