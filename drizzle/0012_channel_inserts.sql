ALTER TABLE "remix_tracks" ADD COLUMN IF NOT EXISTS "inserts" text NOT NULL DEFAULT '[]';
ALTER TABLE "remix_sessions" ADD COLUMN IF NOT EXISTS "master_inserts" text NOT NULL DEFAULT '[]';
