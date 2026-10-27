ALTER TABLE "archive_items" ADD COLUMN "content" text;
--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "favorite" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "archive_items" ADD COLUMN "engine" text DEFAULT 'manual';
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"cadence" text DEFAULT 'monthly' NOT NULL,
	"next_charge" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
