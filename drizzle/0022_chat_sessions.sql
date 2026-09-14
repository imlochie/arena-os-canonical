ALTER TABLE "chats" ADD COLUMN "session_id" uuid REFERENCES "cognitive_sessions"("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "chats_session_id_unique" ON "chats" ("session_id");
