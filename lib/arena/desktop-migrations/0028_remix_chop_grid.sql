ALTER TABLE "remix_clips"
  ADD COLUMN IF NOT EXISTS "chop_step_index" integer,
  ADD COLUMN IF NOT EXISTS "chop_sample_duration_ms" integer;

-- Existing sequencer clips are already bounded to their creation-time step.
-- Preserve their best-known step and use the persisted clip length as the safe
-- legacy sample bound; new clips carry the original sample length explicitly.
UPDATE "remix_clips" AS clip
SET
  "chop_step_index" = ROUND(
    clip."timeline_start_ms"::numeric / (60000::numeric / remix."tempo_bpm" / 4)
  )::integer,
  "chop_sample_duration_ms" = clip."duration_ms"
FROM "remix_tracks" AS track
JOIN "remix_sessions" AS remix ON remix."id" = track."remix_session_id"
WHERE clip."remix_track_id" = track."id"
  AND track."name" = 'Vocal Chop Sequencer'
  AND remix."tempo_bpm" BETWEEN 20 AND 300
  AND clip."timeline_start_ms" >= 0
  AND ABS(
    clip."timeline_start_ms"::numeric
    - ROUND(clip."timeline_start_ms"::numeric / (60000::numeric / remix."tempo_bpm" / 4))
      * (60000::numeric / remix."tempo_bpm" / 4)
  ) <= GREATEST(2, (60000::numeric / remix."tempo_bpm" / 4) * 0.1);
