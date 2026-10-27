-- Wave 5b: the Archive Assistant merge — native media-archive domain.
-- Providers (plex/jellyfin), refresh history, synced library items,
-- reconciliation review workflow with observations/lineage, and the
-- reconciliation run summaries the six native read-operations serve.

CREATE TABLE "media_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"base_url" text NOT NULL,
	"token_sealed" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_sync_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_providers_kind_idx" ON "media_providers" ("kind");
--> statement-breakpoint
CREATE TABLE "media_refreshes" (
	"id" serial PRIMARY KEY NOT NULL,
	"refresh_id" uuid NOT NULL DEFAULT gen_random_uuid(),
	"provider_kind" text NOT NULL,
	"status" text NOT NULL,
	"snapshot_completeness" text DEFAULT 'unknown' NOT NULL,
	"item_count" integer,
	"reason" text,
	"snapshot_reference" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "media_refreshes_provider_started_idx" ON "media_refreshes" ("provider_kind", "started_at");
--> statement-breakpoint
CREATE TABLE "media_library_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider_kind" text NOT NULL,
	"rating_key" text NOT NULL,
	"library_name" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"year" integer,
	"item_type" text DEFAULT 'unknown' NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"view_offset_ms" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"last_viewed_at" timestamp,
	"raw" jsonb,
	"first_seen_refresh_id" uuid,
	"last_seen_refresh_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_library_items_provider_key_idx" ON "media_library_items" ("provider_kind", "rating_key");
--> statement-breakpoint
CREATE TABLE "archive_review_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_key" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'needs_you' NOT NULL,
	"classification" text,
	"provider_kind" text,
	"refresh_id" uuid,
	"payload" jsonb,
	"evidence" jsonb,
	"decision" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "archive_review_items_subject_kind_idx" ON "archive_review_items" ("subject_key", "kind");
--> statement-breakpoint
CREATE TABLE "archive_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_item_id" integer NOT NULL,
	"evidence_key" text NOT NULL,
	"refresh_id" uuid,
	"payload" jsonb,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"superseded_by_id" integer
);
--> statement-breakpoint
CREATE INDEX "archive_observations_review_idx" ON "archive_observations" ("review_item_id", "observed_at");
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"summary" jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
