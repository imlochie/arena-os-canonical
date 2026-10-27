-- Phase 21: MIDI stays in the existing immutable-version export authority.
ALTER TABLE "export_jobs" ADD COLUMN "midi_kind" text;
ALTER TABLE "export_jobs" ADD COLUMN "midi_source_asset_id" uuid REFERENCES "source_assets"("id") ON DELETE RESTRICT;
ALTER TABLE "export_jobs" ADD COLUMN "midi_stem_asset_id" uuid REFERENCES "stem_assets"("id") ON DELETE RESTRICT;
ALTER TABLE "export_jobs" ADD COLUMN "midi_ppq" integer;
ALTER TABLE "export_jobs" ADD COLUMN "midi_analysis_id" text;
ALTER TABLE "export_jobs" ADD COLUMN "midi_source_checksum_sha256" text;
ALTER TABLE "export_jobs" ADD COLUMN "midi_analysis_engine" text;
ALTER TABLE "export_jobs" ADD COLUMN "midi_analysis_engine_version" text;
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_format_valid" CHECK ("format" IN ('wav', 'midi'));
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_midi_valid" CHECK (
  ("format" = 'wav' AND "midi_kind" IS NULL AND "midi_source_asset_id" IS NULL AND "midi_stem_asset_id" IS NULL AND "midi_ppq" IS NULL AND "midi_analysis_id" IS NULL AND "midi_source_checksum_sha256" IS NULL AND "midi_analysis_engine" IS NULL AND "midi_analysis_engine_version" IS NULL)
  OR
  ("format" = 'midi' AND "midi_kind" IN ('vocal', 'drums', 'harmony') AND "midi_source_asset_id" IS NOT NULL AND "midi_ppq" = 480 AND "midi_analysis_id" IS NOT NULL AND "midi_source_checksum_sha256" IS NOT NULL AND "midi_analysis_engine" IS NOT NULL AND "midi_analysis_engine_version" IS NOT NULL
    AND (("midi_kind" IN ('vocal', 'drums') AND "midi_stem_asset_id" IS NOT NULL) OR ("midi_kind" = 'harmony' AND "midi_stem_asset_id" IS NULL)))
);
CREATE INDEX "export_jobs_midi_source_idx" ON "export_jobs" USING btree ("midi_source_asset_id", "midi_stem_asset_id");
