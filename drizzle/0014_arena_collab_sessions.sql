ALTER TABLE "battles" ADD COLUMN IF NOT EXISTS "session_id" uuid;
ALTER TABLE "collabs" ADD COLUMN IF NOT EXISTS "session_id" uuid;

ALTER TABLE "battles" ADD CONSTRAINT "battles_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE SET NULL;
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "cognitive_sessions"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "battles_session_id_unique"
  ON "battles" ("session_id") WHERE "session_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "collabs_session_id_unique"
  ON "collabs" ("session_id") WHERE "session_id" IS NOT NULL;
