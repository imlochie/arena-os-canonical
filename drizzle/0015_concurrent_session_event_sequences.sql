ALTER TABLE "cognitive_sessions"
  ADD COLUMN "next_event_sequence" integer;

UPDATE "cognitive_sessions" AS session
SET "next_event_sequence" = COALESCE((
  SELECT MAX(event."sequence") + 1
  FROM "cognitive_session_events" AS event
  WHERE event."session_id" = session."id"
), 1);

ALTER TABLE "cognitive_sessions"
  ALTER COLUMN "next_event_sequence" SET DEFAULT 1,
  ALTER COLUMN "next_event_sequence" SET NOT NULL;
