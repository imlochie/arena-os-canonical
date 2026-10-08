CREATE TABLE "wy_listen_session_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"stem_mix" text DEFAULT '{}' NOT NULL,
	"transition" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_listen_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_playback_state" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"current_track_id" uuid,
	"position_seconds" real DEFAULT 0 NOT NULL,
	"stem_mix" text DEFAULT '{}' NOT NULL,
	"master_volume" real DEFAULT 1 NOT NULL,
	"repeat_mode" text DEFAULT 'off' NOT NULL,
	"shuffle" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_playlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wy_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"album" text DEFAULT '' NOT NULL,
	"artwork_key" text,
	"source_asset_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"duration_seconds" integer NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"last_played_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wy_projects" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "wy_listen_session_tracks" ADD CONSTRAINT "wy_listen_session_tracks_session_id_wy_listen_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."wy_listen_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_listen_session_tracks" ADD CONSTRAINT "wy_listen_session_tracks_track_id_wy_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_playback_state" ADD CONSTRAINT "wy_playback_state_current_track_id_wy_tracks_id_fk" FOREIGN KEY ("current_track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_playlist_items" ADD CONSTRAINT "wy_playlist_items_playlist_id_wy_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."wy_playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_playlist_items" ADD CONSTRAINT "wy_playlist_items_track_id_wy_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_queue_items" ADD CONSTRAINT "wy_queue_items_track_id_wy_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."wy_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_tracks" ADD CONSTRAINT "wy_tracks_source_asset_id_source_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."source_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wy_tracks" ADD CONSTRAINT "wy_tracks_project_id_wy_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."wy_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wy_listen_session_tracks_session_pos_idx" ON "wy_listen_session_tracks" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "wy_listen_session_tracks_track_id_idx" ON "wy_listen_session_tracks" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "wy_listen_sessions_owner_id_idx" ON "wy_listen_sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "wy_playlist_items_playlist_pos_idx" ON "wy_playlist_items" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "wy_playlist_items_track_id_idx" ON "wy_playlist_items" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "wy_playlists_owner_id_idx" ON "wy_playlists" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "wy_queue_items_owner_pos_idx" ON "wy_queue_items" USING btree ("owner_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "wy_tracks_source_asset_unique" ON "wy_tracks" USING btree ("source_asset_id");--> statement-breakpoint
CREATE INDEX "wy_tracks_owner_last_played_idx" ON "wy_tracks" USING btree ("owner_id","last_played_at");--> statement-breakpoint
CREATE INDEX "wy_tracks_project_id_idx" ON "wy_tracks" USING btree ("project_id");