ALTER TABLE "battles" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "collabs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "council_runs" ADD COLUMN "structured_synthesis" text;--> statement-breakpoint
ALTER TABLE "council_runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "availability" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "supports_structured_output" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "capabilities" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_session_id_execution_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."execution_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "battles" ADD CONSTRAINT "battles_session_id_unique" UNIQUE("session_id");--> statement-breakpoint
ALTER TABLE "collabs" ADD CONSTRAINT "collabs_session_id_unique" UNIQUE("session_id");