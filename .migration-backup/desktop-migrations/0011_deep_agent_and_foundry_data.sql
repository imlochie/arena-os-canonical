CREATE TABLE "foundry_app_data" (
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "foundry_app_data_app_id_key_pk" PRIMARY KEY ("app_id", "key")
);
--> statement-breakpoint
CREATE TABLE "deep_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"engine" text DEFAULT '' NOT NULL,
	"via" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"verdict" text DEFAULT 'pass' NOT NULL,
	"verdict_reason" text DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "foundry_app_data" ADD CONSTRAINT "foundry_app_data_app_id_foundry_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "foundry_apps"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "deep_agent_steps" ADD CONSTRAINT "deep_agent_steps_run_id_deep_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "deep_agent_runs"("id") ON DELETE cascade;
