CREATE TABLE "foundry_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "foundry_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"code" text NOT NULL,
	"engine" text NOT NULL,
	"via" text NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foundry_versions" ADD CONSTRAINT "foundry_versions_app_id_foundry_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "foundry_apps"("id") ON DELETE cascade;
