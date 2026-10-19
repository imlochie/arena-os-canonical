-- Stable create acknowledgements and retained execution receipts share the
-- existing sessions/relays; no alternate collaboration registry or memory mode.
ALTER TABLE collaborations ADD COLUMN IF NOT EXISTS request_hash text;
--> statement-breakpoint
ALTER TABLE collaboration_relays ADD COLUMN IF NOT EXISTS result_receipt jsonb;
