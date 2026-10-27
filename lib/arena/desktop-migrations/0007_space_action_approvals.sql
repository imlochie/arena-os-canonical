CREATE TABLE "space_action_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"mission_id" uuid,
	"signature" text NOT NULL,
	"action_class" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"executed_at" timestamp,
	"result" jsonb,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "space_action_approvals" ADD CONSTRAINT "space_action_approvals_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_action_approvals_sig_idx" ON "space_action_approvals" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "space_action_approvals_space_status_idx" ON "space_action_approvals" USING btree ("space_id","status");