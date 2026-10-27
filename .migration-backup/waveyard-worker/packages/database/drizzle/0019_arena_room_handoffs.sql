-- Arena owns cross-room handoff metadata. This table intentionally carries no
-- foreign keys into a room: room data/media stays independently owned and can
-- only be reached through a verified room integration.
CREATE TABLE "arena_room_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "arena_project_id" uuid NOT NULL,
  "room" text NOT NULL,
  "room_project_id" text NOT NULL,
  "source_id" text,
  "kind" text NOT NULL,
  "title" text DEFAULT 'Untitled room handoff' NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "payload" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX "arena_room_handoffs_project_created_idx"
  ON "arena_room_handoffs" USING btree ("arena_project_id", "created_at");
CREATE INDEX "arena_room_handoffs_room_project_idx"
  ON "arena_room_handoffs" USING btree ("room", "room_project_id");
CREATE UNIQUE INDEX "arena_room_handoffs_room_project_link_unique"
  ON "arena_room_handoffs" USING btree ("room", "room_project_id")
  WHERE "kind" = 'room-project';
