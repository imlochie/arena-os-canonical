CREATE TABLE "wy_smart_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"rules_json" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wy_tracks" ADD COLUMN "rating" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wy_tracks" ADD COLUMN "labels" text;--> statement-breakpoint
CREATE INDEX "wy_smart_collections_owner_id_idx" ON "wy_smart_collections" USING btree ("owner_id");