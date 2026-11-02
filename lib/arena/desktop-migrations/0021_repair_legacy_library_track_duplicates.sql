-- Parse labels defensively so a malformed legacy curation value cannot block
-- migration of the whole listener library.
CREATE OR REPLACE FUNCTION waveyard_safe_track_labels(raw text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  parsed jsonb;
BEGIN
  IF raw IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  parsed := raw::jsonb;
  IF jsonb_typeof(parsed) = 'array' THEN
    RETURN parsed;
  END IF;
  RETURN '[]'::jsonb;
EXCEPTION WHEN others THEN
  RETURN '[]'::jsonb;
END
$$;
--> statement-breakpoint

-- Keep this as a reusable repair operation as well as a one-time migration:
-- it can be safely retried and uses the same owner/checksum advisory locks as
-- library uploads.
CREATE OR REPLACE FUNCTION repair_waveyard_library_track_duplicates()
RETURNS TABLE (tracks_merged integer, checksums_backfilled integer)
LANGUAGE plpgsql
AS $$
DECLARE
  lock_row record;
BEGIN
  tracks_merged := 0;
  checksums_backfilled := 0;

  FOR lock_row IN
    SELECT DISTINCT t.owner_id, lower(sa.checksum_sha256) AS checksum
    FROM wy_tracks t
    INNER JOIN source_assets sa ON sa.id = t.source_asset_id
    WHERE sa.checksum_sha256 ~ '^[0-9a-fA-F]{64}$'
    ORDER BY t.owner_id, lower(sa.checksum_sha256)
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'waveyard-library-upload:' || lock_row.owner_id::text || ':' || lock_row.checksum,
      0
    ));
  END LOOP;

  DROP TABLE IF EXISTS pg_temp.waveyard_duplicate_track_map;
  CREATE TEMP TABLE waveyard_duplicate_track_map ON COMMIT DROP AS
    SELECT
      t.id AS track_id,
      t.owner_id,
      lower(sa.checksum_sha256) AS checksum,
      first_value(t.id) OVER (
        PARTITION BY t.owner_id, lower(sa.checksum_sha256)
        ORDER BY t.created_at ASC, t.id ASC
      ) AS keeper_id
    FROM wy_tracks t
    INNER JOIN source_assets sa ON sa.id = t.source_asset_id
    WHERE sa.checksum_sha256 ~ '^[0-9a-fA-F]{64}$';

  -- Clear candidate identities first so a legacy stale value cannot collide
  -- with the correct checksum while duplicates are being consolidated.
  UPDATE wy_tracks t
  SET source_checksum_sha256 = NULL
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE t.id = m.track_id;

  UPDATE wy_queue_items ref
  SET track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.track_id = m.track_id AND m.track_id <> m.keeper_id;

  UPDATE wy_playlist_items ref
  SET track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.track_id = m.track_id AND m.track_id <> m.keeper_id;

  UPDATE wy_listen_session_tracks ref
  SET track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.track_id = m.track_id AND m.track_id <> m.keeper_id;

  UPDATE wy_playback_state ref
  SET current_track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.current_track_id = m.track_id AND m.track_id <> m.keeper_id;

  UPDATE wy_listen_session_swaps ref
  SET from_track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.from_track_id = m.track_id AND m.track_id <> m.keeper_id;

  UPDATE wy_listen_session_swaps ref
  SET to_track_id = m.keeper_id
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE ref.to_track_id = m.track_id AND m.track_id <> m.keeper_id;

  -- Preserve accumulated listening and curation on the surviving row.
  UPDATE wy_tracks keeper
  SET
    play_count = merged.play_count,
    rating = merged.rating,
    labels = merged.labels,
    last_played_at = merged.last_played_at,
    updated_at = now()
  FROM (
    SELECT
      m.keeper_id,
      sum(t.play_count)::integer AS play_count,
      max(t.rating)::integer AS rating,
      max(t.last_played_at) AS last_played_at,
      (
        SELECT COALESCE(jsonb_agg(DISTINCT label ORDER BY label), '[]'::jsonb)::text
        FROM pg_temp.waveyard_duplicate_track_map labels_map
        INNER JOIN wy_tracks label_track ON label_track.id = labels_map.track_id
        CROSS JOIN LATERAL jsonb_array_elements_text(waveyard_safe_track_labels(label_track.labels)) AS labels(label)
        WHERE labels_map.keeper_id = m.keeper_id
      ) AS labels
    FROM pg_temp.waveyard_duplicate_track_map m
    INNER JOIN wy_tracks t ON t.id = m.track_id
    GROUP BY m.keeper_id
  ) merged
  WHERE keeper.id = merged.keeper_id;

  DELETE FROM wy_tracks t
  USING pg_temp.waveyard_duplicate_track_map m
  WHERE t.id = m.track_id AND m.track_id <> m.keeper_id;
  GET DIAGNOSTICS tracks_merged = ROW_COUNT;

  UPDATE wy_tracks keeper
  SET source_checksum_sha256 = m.checksum
  FROM pg_temp.waveyard_duplicate_track_map m
  WHERE keeper.id = m.keeper_id AND m.track_id = m.keeper_id;
  GET DIAGNOSTICS checksums_backfilled = ROW_COUNT;

  RETURN NEXT;
END
$$;
--> statement-breakpoint

SELECT * FROM repair_waveyard_library_track_duplicates();
