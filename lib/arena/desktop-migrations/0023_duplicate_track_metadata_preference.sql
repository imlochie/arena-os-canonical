-- Migration 0021 is already applied on existing desktops and must remain
-- immutable. Replace its repair function in a forward migration so upgrades
-- receive the metadata merge rule too.
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

  -- Keep the oldest track ID, but rank metadata sources by the number of
  -- nonblank fields (title, artist, album). For a tie, prefer that keeper,
  -- then the oldest candidate and ID. Select each field independently from
  -- the highest-ranked candidate that has a value, so blanks never erase
  -- populated metadata. If every candidate is blank for a field, retain the
  -- keeper's original value.
  UPDATE wy_tracks keeper
  SET
    title = COALESCE((
      SELECT NULLIF(BTRIM(candidate.title), '')
      FROM pg_temp.waveyard_duplicate_track_map candidates
      INNER JOIN wy_tracks candidate ON candidate.id = candidates.track_id
      WHERE candidates.keeper_id = keeper.id
        AND NULLIF(BTRIM(candidate.title), '') IS NOT NULL
      ORDER BY
        (
          (NULLIF(BTRIM(candidate.title), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.artist), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.album), '') IS NOT NULL)::integer
        ) DESC,
        (candidate.id = keeper.id) DESC,
        candidate.created_at ASC,
        candidate.id ASC
      LIMIT 1
    ), keeper.title),
    artist = COALESCE((
      SELECT NULLIF(BTRIM(candidate.artist), '')
      FROM pg_temp.waveyard_duplicate_track_map candidates
      INNER JOIN wy_tracks candidate ON candidate.id = candidates.track_id
      WHERE candidates.keeper_id = keeper.id
        AND NULLIF(BTRIM(candidate.artist), '') IS NOT NULL
      ORDER BY
        (
          (NULLIF(BTRIM(candidate.title), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.artist), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.album), '') IS NOT NULL)::integer
        ) DESC,
        (candidate.id = keeper.id) DESC,
        candidate.created_at ASC,
        candidate.id ASC
      LIMIT 1
    ), keeper.artist),
    album = COALESCE((
      SELECT NULLIF(BTRIM(candidate.album), '')
      FROM pg_temp.waveyard_duplicate_track_map candidates
      INNER JOIN wy_tracks candidate ON candidate.id = candidates.track_id
      WHERE candidates.keeper_id = keeper.id
        AND NULLIF(BTRIM(candidate.album), '') IS NOT NULL
      ORDER BY
        (
          (NULLIF(BTRIM(candidate.title), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.artist), '') IS NOT NULL)::integer
          + (NULLIF(BTRIM(candidate.album), '') IS NOT NULL)::integer
        ) DESC,
        (candidate.id = keeper.id) DESC,
        candidate.created_at ASC,
        candidate.id ASC
      LIMIT 1
    ), keeper.album),
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

-- Apply the updated rule to any checksum duplicates that appeared after 0021.
SELECT * FROM repair_waveyard_library_track_duplicates();
