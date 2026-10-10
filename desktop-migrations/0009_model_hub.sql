CREATE TABLE "model_hub_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"last_checked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "model_hub_bindings" (
	"model_id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"remote_model" text NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_hub_bindings" ADD CONSTRAINT "model_hub_bindings_connection_id_model_hub_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "model_hub_connections"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE TABLE "agent_bridge_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"messages_json" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_text" text,
	"requested_model_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"taken_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "agent_bridge_state" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"last_polled_at" timestamp
);
