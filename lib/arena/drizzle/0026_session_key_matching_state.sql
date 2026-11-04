ALTER TABLE "wy_listen_sessions"
  ADD COLUMN IF NOT EXISTS "key_match_mode" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "wy_listen_sessions"
  ADD COLUMN IF NOT EXISTS "key_shifts" text DEFAULT '{}' NOT NULL;
