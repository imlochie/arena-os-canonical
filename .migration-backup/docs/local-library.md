# The local media library — Plex-independence groundwork

Wave 6, the third leg. The Toolbox made conversion local; this makes **the
library itself** local. Arena can now index a folder of video files with no
Plex, no Jellyfin, no third-party server anywhere in the loop — and play it
back in the browser with Arena's own streaming, watch progress, and
transcode-on-demand.

If Plex shut down tomorrow, nothing on this page would notice.

## The pieces

```
src/lib/mediaArchive/local.ts             scanner, playability, transcode cache, watch state
src/lib/mediaArchive/sync.ts              'local' as a first-class provider kind
src/lib/mediaArchive/reconcile.ts         local items reconcile like any provider
src/app/api/library/route.ts              GET shelf/item info · POST progress | transcode
src/app/api/library/stream/[id]/route.ts  Range-capable streaming (206/416/HEAD)
src/app/watch/[id]/page.tsx               the player
src/components/ArchiveAssistantBridge.tsx "Local folder" connect option + the shelf
```

Scratch space: `.arena-data/library-cache/` (playable copies, keyed by item
id — stale the moment the source file changes, by mtime).

## How it works

1. **Connect a folder, not a server.** In the Archive Assistant panel
   (`/rooms/archive-assistant`), the connect form now has **Local folder
   (no server)**. The "connection test" is honest: it checks the folder
   exists and lists its top-level subfolders. No token — it's your own disk.

2. **Sync = scan.** The local provider's sync walks the folder (bounded:
   2000 files, depth 8), probes every video file with the real ffprobe, and
   upserts `media_library_items` rows through the **same sync machinery**
   Plex and Jellyfin use — refresh history, honest completeness (a file
   ffprobe can't read makes the snapshot *partial*, naming the file),
   authority pinned to the last complete snapshot. Relative paths are the
   rating keys; filenames are parsed for title/year/episode
   (`Show.Name.S01E01.mkv` → episode "Show Name").

3. **Watch state is ours.** The player posts progress to `/api/library`,
   which writes `view_offset_ms` / `view_count` / `last_viewed_at` on the
   item — Arena's database, not a media server's. **Rescans carry watch
   state forward**; re-syncing never forgets where you were.

4. **Streaming is a plain HTTP file server done right.**
   `/api/library/stream/[id]` serves the source file with `Accept-Ranges`,
   real `206 Partial Content` (start-end and suffix ranges), `416` for
   unsatisfiable ranges, `HEAD` support, correct MIME types — what a
   `<video>` element needs to seek natively. Only files inside the
   configured library root can ever be served (realpath-checked); a tampered
   row pointing elsewhere returns 404. Delete the provider and streaming
   dies with it, even though the rows remain as inert history.

5. **Transcode-on-demand rides the Toolbox engine.** When a file's codecs or
   container aren't browser-safe (HEVC, MKV…), the watch page says exactly
   why and offers **Make browser-playable (1080p H.264)** — one job through
   the same `buildPresetArgs` maps, the same hardware-encoder detection, the
   same honest progress. The copy lands in the library cache, the stream
   endpoint prefers it while it's fresh (source mtime check), and **the
   source file is never touched**. Direct-play files stream as-is — zero
   copies, zero waste.

6. **Reconciliation sees the disk as a provider.** Point the local library
   at the same folder Plex serves and reconcile: the archive index vs. what
   is physically on disk, with the same review workflow. The review payload
   labels the provider honestly as `local` now, not coerced to `plex`.

## Honest limits (groundwork, by design)

- One local library root (the provider model is one-per-kind).
- The scanner walks a folder; it doesn't watch for changes — sync again.
- The cache is per-item 1080p H.264; there's no adaptive bitrate/HLS yet.
- Episode grouping is filename-based (no season/episode columns yet).
- The remaining Archive-Assistant gaps (acquisition jobs, executable file
  operations, discovery endpoints) are still open — see
  `docs/archive-assistant-merge.md`.

## Tests — all real, no fixtures at all

`src/lib/mediaArchive/local.test.ts` (8, PG-gated): real video files
generated with the real ffmpeg (h264-MP4, h264-MKV, HEVC episode, junk,
non-video), really probed and synced; honest partial snapshots; playability
classification; watch progress that survives rescans; a real transcode whose
output is re-probed as h264/MP4; full HTTP Range semantics (206 slices
byte-identical to the file, suffix ranges, 416, HEAD); the outside-root
guard; the shelf + progress routes; reconciliation with local items as a
first-class provider; provider deletion killing streaming.

Live-proven over HTTP against the dev server: test → save → sync (2 items) →
direct play (206 range) → HEVC transcode (running → done, cached stream as
`video/mp4` from the cache) → progress recorded in Arena's own tables →
panel renders the Local folder option.
