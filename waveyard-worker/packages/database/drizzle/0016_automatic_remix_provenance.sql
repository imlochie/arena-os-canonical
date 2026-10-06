-- Deterministic Automatic Remix Engine provenance. This records explanation only;
-- editable musical authority remains remix_sessions, remix_tracks, and remix_clips.
CREATE TABLE "automatic_remix_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "remix_session_id" uuid NOT NULL REFERENCES "remix_sessions"("id") ON DELETE CASCADE,
  "engine" text NOT NULL,
  "engine_version" text NOT NULL,
  "variant" text NOT NULL,
  "constraints" text NOT NULL,
  "provenance" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "automatic_remix_generations_variant_valid" CHECK ("variant" IN ('original', 'hybrid'))
);
CREATE UNIQUE INDEX "automatic_remix_generations_session_unique" ON "automatic_remix_generations" USING btree ("remix_session_id");
CREATE INDEX "automatic_remix_generations_session_idx" ON "automatic_remix_generations" USING btree ("remix_session_id");
