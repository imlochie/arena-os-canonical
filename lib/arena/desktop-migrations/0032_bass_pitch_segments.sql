-- Independent bass PITCH evidence, distinct from the onset-only bass_events.
--
-- bass_events records when the bass was struck and how strongly. It carries no
-- pitch, and its schema says so. Harmonic assessment needs sustained notes: the
-- pitch the bass held, for how long, and how confident the tracker was.
--
-- These rows hang off the same bass_analyses row as the attacks, so they inherit
-- exactly the same source/stem identity, checksum binding and engine version.
-- There is deliberately no parallel analysis table: one bass stem has one
-- versioned analysis, and both kinds of evidence belong to it.
CREATE TABLE IF NOT EXISTS "bass_pitch_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bass_analysis_id" uuid NOT NULL REFERENCES "bass_analyses"("id") ON DELETE CASCADE,
  "segment_index" integer NOT NULL,
  "start_ms" integer NOT NULL,
  "end_ms" integer NOT NULL,
  "midi_note" integer NOT NULL,
  "frequency_hz" real NOT NULL,
  "confidence" real NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "bass_pitch_segments_analysis_index_unique" UNIQUE("bass_analysis_id", "segment_index")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bass_pitch_segments_analysis_start_idx"
  ON "bass_pitch_segments" ("bass_analysis_id", "start_ms");
