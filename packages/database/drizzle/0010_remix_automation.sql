-- Phase 15: isolated, versionable V1 arrangement automation points.
CREATE TABLE "remix_automation_points" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "remix_session_id" uuid NOT NULL REFERENCES "remix_sessions"("id") ON DELETE CASCADE,
  "remix_track_id" uuid NOT NULL REFERENCES "remix_tracks"("id") ON DELETE CASCADE,
  "parameter" text NOT NULL,
  "timeline_ms" integer NOT NULL,
  "value" real NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "remix_automation_points_parameter_valid" CHECK ("parameter" IN ('volume', 'pan')),
  CONSTRAINT "remix_automation_points_timeline_valid" CHECK ("timeline_ms" >= 0 AND "timeline_ms" <= 86400000),
  CONSTRAINT "remix_automation_points_value_valid" CHECK (("parameter" = 'volume' AND "value" >= 0 AND "value" <= 2) OR ("parameter" = 'pan' AND "value" >= -1 AND "value" <= 1)
);
CREATE UNIQUE INDEX "remix_automation_points_track_parameter_time_unique" ON "remix_automation_points" USING btree ("remix_track_id", "parameter", "timeline_ms");
CREATE INDEX "remix_automation_points_session_track_idx" ON "remix_automation_points" USING btree ("remix_session_id", "remix_track_id");
