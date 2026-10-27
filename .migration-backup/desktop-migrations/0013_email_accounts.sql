CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"tls" boolean DEFAULT true NOT NULL,
	"username" text NOT NULL,
	"password_sealed" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_scan_at" timestamp,
	"last_scan_message_count" integer,
	"last_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_address_idx" ON "email_accounts" ("address");
