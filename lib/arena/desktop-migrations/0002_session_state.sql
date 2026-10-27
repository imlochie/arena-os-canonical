CREATE TABLE "wy_listen_session_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"session_track_id" uuid NOT NULL,
	"stem_type" text NOT NULL,
	"from_track_id" uuid NOT NULL,
	"to_track_id" uuid NOT NULL,
	"at_seconds" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wy_listen_sessions" ADD COLUMN "current_track_id" uuid;--> statement-breakpoint
ALTER TABLE "wy_listen_sessions" ADD COLUMN "position_seconds" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wy_listen_session_swaps" ADD CONSTRAINT "wy_listen_session_swaps_session_id_wy_listen_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wy_listen_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_listen_session_swaps" ADD CONSTRAINT "wy_listen_session_swaps_session_track_id_wy_listen_session_tracks_id_fk" FOREIGN KEY ("session_track_id") REFERENCES "public"."wy_listen_session_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_listen_session_swaps" ADD CONSTRAINT "wy_listen_session_swaps_from_track_id_wy_tracks_id_fk" FOREIGN KEY ("from_track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_listen_session_swaps" ADD CONSTRAINT "wy_listen_session_swaps_to_track_id_wy_tracks_id_fk" FOREIGN KEY ("to_track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wy_listen_session_swaps_session_idx" ON "wy_listen_session_swaps" USING btree ("session_id","created_at");