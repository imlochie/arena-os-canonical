CREATE TABLE "wy_streaming_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"service" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wy_streaming_accounts" ADD CONSTRAINT "wy_streaming_accounts_owner_service_unique" UNIQUE("owner_id", "service");
--> statement-breakpoint
CREATE TABLE "wy_library_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"service" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"playlist_count" integer NOT NULL,
	"track_count" integer NOT NULL,
	"snapshot_json" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wy_library_snapshots" ADD CONSTRAINT "wy_library_snapshots_account_id_wy_streaming_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "wy_streaming_accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "wy_library_snapshots_account_taken_idx" ON "wy_library_snapshots" USING btree ("account_id", "taken_at");
--> statement-breakpoint
CREATE INDEX "wy_library_snapshots_owner_idx" ON "wy_library_snapshots" USING btree ("owner_id");
