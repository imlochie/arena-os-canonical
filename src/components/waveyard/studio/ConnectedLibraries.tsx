"use client";

/**
 * ConnectedLibraries — the streaming-library bridge (vision §V6: "connect
 * to an actual audio library... sync my streaming libraries automatically
 * and easily creating backups").
 *
 * THE HONEST WALL, printed on the panel itself: stem.fm streams its own
 * licensed catalog — that is a label deal, not an API. No third-party app
 * can pull full Spotify/Apple audio into a separation graph (and Spotify's
 * terms forbid syncing their content with video). So the personal edge is
 * built where the APIs are real:
 *
 *   • YOUR LIBRARY AS THE CATALOG — connect Spotify (PKCE, in-browser,
 *     read-only scopes; your client ID, your account), snapshot playlists
 *     + liked songs, browse and search them here.
 *   • DISPATCH, NOT RIP — "bring into studio" sends a track through the
 *     app's real intake (an authorized link or a file you drop); nothing
 *     is ever ripped from a stream.
 *   • SYNC + BACKUP — every snapshot is a stored backup with a diff
 *     against the previous one ("what changed since last sync"), JSON +
 *     CSV exports, and JSON import for any service (Apple/YouTube
 *     adapters are ready; their live connection flows arrive with your
 *     credentials — next wave).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assembleSpotifySnapshot,
  createPkceVerifier,
  mapSpotifyTrack,
  pageCount,
  pkceChallengeFromVerifier,
  spotifyAuthorizeUrl,
} from "@/lib/waveyard/streaming/adapters";
import {
  parseBackup,
  snapshotStats,
  type ExternalTrack,
  type LibrarySnapshot,
  type SnapshotDiff,
  type StreamingService,
} from "@/lib/waveyard/streaming/library-sync";

type AccountSummary = {
  id: string;
  service: StreamingService;
  displayName: string;
  snapshotCount: number;
  lastSyncAt: string | null;
  trackCount: number | null;
};

type SnapshotView = {
  id: string;
  service: StreamingService;
  takenAt: string;
  playlistCount: number;
  trackCount: number;
  library: LibrarySnapshot;
};

const SPOTIFY_CLIENT_KEY = "waveyard:spotify-client-id";
const PKCE_KEY = "waveyard:spotify-pkce";

const SERVICE_LABELS: Record<StreamingService, string> = {
  spotify: "Spotify",
  apple: "Apple Music",
  youtube: "YouTube",
};

export function ConnectedLibraries({ projectId }: { projectId: string }) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [spotifyClientId, setSpotifyClientId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<string>("liked");
  const [search, setSearch] = useState("");
  const [dispatchTrack, setDispatchTrack] = useState<ExternalTrack | null>(null);
  const [dispatchUrl, setDispatchUrl] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const bootstrappedRef = useRef(false);

  const loadAccounts = useCallback(async () => {
    const response = await fetch("/api/streaming/accounts", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json().catch(() => ({}));
    setAccounts(body.accounts ?? []);
  }, []);

  const openSnapshot = useCallback(async (snapshotId: string) => {
    const response = await fetch(`/api/streaming/snapshots/${snapshotId}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body.error ?? "Could not open that snapshot.");
      return;
    }
    setSnapshot(body.snapshot ?? null);
    setDiff(body.diff ?? null);
    setSelectedPlaylist("liked");
  }, []);

  // Bootstrap + the PKCE callback (Spotify redirects back with ?code&state).
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void loadAccounts();
    setSpotifyClientId(window.localStorage.getItem(SPOTIFY_CLIENT_KEY) ?? "");
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null) return;
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    url.searchParams.delete("error");
    window.history.replaceState({}, "", url.toString());
    void completeSpotifyCallback(code, state, {
      openSnapshot,
      reload: loadAccounts,
      setStatus: (message) => setNotice(message),
      fail: (message) => setError(message),
    });
  }, [loadAccounts, openSnapshot]);

  const connectAccount = useCallback(async (service: StreamingService, displayName: string) => {
    setBusy(`connect-${service}`);
    setError(null);
    try {
      const response = await fetch("/api/streaming/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, displayName }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Could not connect that library.");
        return null;
      }
      await loadAccounts();
      return body.account?.id as string | undefined ?? null;
    } finally {
      setBusy(null);
    }
  }, [loadAccounts]);

  const startSpotifySync = useCallback(async () => {
    setError(null);
    setNotice(null);
    const clientId = spotifyClientId.trim();
    if (clientId.length === 0) {
      setError("Paste your Spotify app&apos;s Client ID first (developer.spotify.com → create app, 5 minutes, add this page's URL as a redirect).");
      return;
    }
    window.localStorage.setItem(SPOTIFY_CLIENT_KEY, clientId);
    const accountId = accounts?.find((account) => account.service === "spotify")?.id ?? (await connectAccount("spotify", "My Spotify"));
    if (accountId === null) return;
    const verifier = createPkceVerifier(crypto.getRandomValues(new Uint8Array(64)));
    const state = crypto.randomUUID().replace(/-/g, "");
    window.localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, accountId, clientId }));
    const challenge = await pkceChallengeFromVerifier(verifier, async (algorithm, data) =>
      new Uint8Array(await crypto.subtle.digest(algorithm, data as BufferSource)));
    window.location.assign(spotifyAuthorizeUrl({
      clientId,
      redirectUri: `${window.location.origin}${window.location.pathname}`,
      state,
      codeChallenge: challenge,
    }));
  }, [accounts, connectAccount, spotifyClientId]);

  const importBackupFile = useCallback(async (service: StreamingService, file: File) => {
    setBusy(`import-${service}`);
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const parsed = parseBackup(text);
      if (parsed === null) {
        setError("That file is not a waveyard-library-backup JSON (format/version validation failed).");
        return;
      }
      if (parsed.service !== service) {
        setError(`That backup is a ${SERVICE_LABELS[parsed.service]} backup — import it under ${SERVICE_LABELS[parsed.service]}.`);
        return;
      }
      const accountId = accounts?.find((account) => account.service === service)?.id ?? (await connectAccount(service, `My ${SERVICE_LABELS[service]}`));
      if (accountId === null) return;
      const response = await fetch(`/api/streaming/accounts/${accountId}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot: parsed }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Could not store that backup.");
        return;
      }
      await loadAccounts();
      await openSnapshot(body.snapshot.id);
      const stats = snapshotStats(parsed);
      setNotice(`Imported your ${SERVICE_LABELS[service]} backup — ${stats.playlists} playlists, ${stats.tracks} tracks.`);
    } finally {
      setBusy(null);
    }
  }, [accounts, connectAccount, loadAccounts, openSnapshot]);

  const disconnect = useCallback(async (accountId: string) => {
    setBusy(`disconnect-${accountId}`);
    try {
      await fetch(`/api/streaming/accounts/${accountId}`, { method: "DELETE" });
      if (snapshot !== null && accounts?.find((account) => account.id === accountId)?.service === snapshot.service) {
        setSnapshot(null);
        setDiff(null);
      }
      await loadAccounts();
    } finally {
      setBusy(null);
    }
  }, [accounts, loadAccounts, snapshot]);

  const dispatch = useCallback(async () => {
    if (dispatchTrack === null) return;
    const url = dispatchUrl.trim();
    if (url.length === 0) {
      setError("Paste an http(s) link to audio you are authorized to use, or drop the file onto the palette above.");
      return;
    }
    setDispatching(true);
    setError(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/source-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "The authorized intake refused that link.");
        return;
      }
      setNotice(`"${dispatchTrack.title}" dispatched to the studio — the palette picks it up as processing lands.`);
      setDispatchTrack(null);
      setDispatchUrl("");
    } finally {
      setDispatching(false);
    }
  }, [dispatchTrack, dispatchUrl, projectId]);

  const accountFor = (service: StreamingService) => accounts?.find((account) => account.service === service) ?? null;
  const spotifyAccount = accountFor("spotify");

  const tracksShown = useMemo(() => {
    if (snapshot === null) return [];
    const pool = selectedPlaylist === "liked"
      ? snapshot.library.likedTracks
      : snapshot.library.playlists.find((playlist) => playlist.externalId === selectedPlaylist)?.tracks ?? [];
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return pool.slice(0, 200);
    return pool.filter((track) => `${track.title} ${track.artists.join(" ")} ${track.album ?? ""}`.toLowerCase().includes(needle)).slice(0, 200);
  }, [search, selectedPlaylist, snapshot]);

  return (
    <section className="stream-lib" data-testid="connected-libraries" aria-label="Connected streaming libraries">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Your libraries, the catalog</span>
          <h3>Connected libraries</h3>
        </div>
        <small>sync · backup · diff · export</small>
      </div>
      <p className="stream-lib-wall" role="note">
        Streaming services license their audio to their own apps (that is stem.fm&apos;s catalog deal — not an API any third party gets).
        The APIs that ARE real give us your library: playlists, likes, identity. So Waveyard treats your libraries as the catalog,
        dispatches tracks into the stem pipeline through real intake (authorized link or your file — never a rip), and keeps every
        snapshot as a backup. The personal edge, honestly built.
      </p>

      <div className="stream-lib-grid">
        {/* Spotify — the live connection */}
        <article className={`stream-card ${spotifyAccount !== null ? "connected" : ""}`}>
          <header><b>Spotify</b>{spotifyAccount !== null && <span>{spotifyAccount.snapshotCount} backups{spotifyAccount.trackCount !== null ? ` · ${spotifyAccount.trackCount} tracks` : ""}</span>}</header>
          <label className="stream-client">
            <span>Client ID (your Spotify app)</span>
            <input
              aria-label="Spotify client ID"
              type="text"
              placeholder="paste your app&apos;s client id"
              value={spotifyClientId}
              onChange={(event) => setSpotifyClientId(event.target.value)}
            />
          </label>
          <div className="stream-card-actions">
            <button className="button secondary" disabled={busy !== null} onClick={() => void startSpotifySync()}>
              {busy === "connect-spotify" ? "Connecting…" : spotifyAccount !== null ? "⟳ Sync now" : "Connect + sync"}
            </button>
            {spotifyAccount?.lastSyncAt != null && <small>last sync {new Date(spotifyAccount.lastSyncAt).toLocaleString()}</small>}
          </div>
          <small className="stream-hint">Read-only scopes (playlists + liked). Create the app at developer.spotify.com, add this page&apos;s URL as a redirect URI. Your ID lives in this browser; the server never sees credentials.</small>
        </article>

        {/* Apple + YouTube — import today, live flows with credentials */}
        {(["apple", "youtube"] as const).map((service) => {
          const account = accountFor(service);
          return (
            <article key={service} className={`stream-card ${account !== null ? "connected" : ""}`}>
              <header><b>{SERVICE_LABELS[service]}</b>{account !== null && <span>{account.snapshotCount} backups{account.trackCount !== null ? ` · ${account.trackCount} tracks` : ""}</span>}</header>
              <div className="stream-card-actions">
                <label className="button secondary file-button">
                  Import backup JSON
                  <input
                    aria-label={`Import ${SERVICE_LABELS[service]} backup`}
                    type="file"
                    accept="application/json"
                    disabled={busy !== null}
                    onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void importBackupFile(service, file); event.target.value = ""; }}
                  />
                </label>
                {busy === `import-${service}` && <small>importing…</small>}
              </div>
              <small className="stream-hint">
                {service === "apple"
                  ? "Adapter ready (library playlists + songs, durations; no isrc in library data). Live MusicKit sync arrives with your Apple developer token — next wave."
                  : "Adapter ready (YouTube Data API: your playlists/likes; channel stands in for artist, no durations at item level). Live sync arrives with your Google OAuth client — next wave. No official YouTube Music API exists."}
              </small>
            </article>
          );
        })}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="stem-layer-notice" role="status">{notice}</p>}

      {/* The library browser + sync diff */}
      {snapshot !== null && (
        <div className="stream-browser">
          <div className="stream-browser-bar">
            <b>{SERVICE_LABELS[snapshot.service]} · {snapshot.library.accountName ?? "library"}</b>
            <small>{snapshot.playlistCount} playlists · {snapshot.trackCount} tracks · snapshot {new Date(snapshot.takenAt).toLocaleString()}</small>
            <div className="stream-browser-actions">
              <a className="button secondary" href={`/api/streaming/snapshots/${snapshot.id}/export?format=json`}>Download JSON</a>
              <a className="button secondary" href={`/api/streaming/snapshots/${snapshot.id}/export?format=csv`}>Download CSV</a>
            </div>
          </div>
          {diff !== null && (
            <p className={`stream-diff ${diffIsEmptyLocal(diff) ? "quiet" : ""}`} role="status">
              {diffIsEmptyLocal(diff)
                ? "No changes since the previous backup — your library is already safe."
                : `Since last backup: +${diff.tracksAdded.length} tracks, −${diff.tracksRemoved.length}, ${diff.playlistsAdded.length} playlists added, ${diff.playlistsRemoved.length} removed${diff.reordered.length > 0 ? `, ${diff.reordered.length} reordered` : ""}.`}
            </p>
          )}
          <div className="stream-browser-body">
            <div className="stream-playlists" role="listbox" aria-label="Playlists">
              <button className={selectedPlaylist === "liked" ? "on" : ""} onClick={() => setSelectedPlaylist("liked")}>
                ♥ Liked songs <span>{snapshot.library.likedTracks.length}</span>
              </button>
              {snapshot.library.playlists.map((playlist) => (
                <button key={playlist.externalId} className={selectedPlaylist === playlist.externalId ? "on" : ""} onClick={() => setSelectedPlaylist(playlist.externalId)}>
                  {playlist.name} <span>{playlist.tracks.length}</span>
                </button>
              ))}
            </div>
            <div className="stream-tracks">
              <input aria-label="Search tracks" type="search" placeholder="search title, artist, album…" value={search} onChange={(event) => setSearch(event.target.value)} />
              <div className="stream-track-rows">
                {tracksShown.map((track) => (
                  <div key={`${track.service}-${track.externalId}`} className="stream-track">
                    <div className="stream-track-meta">
                      <b>{track.title}</b>
                      <small>{track.artists.join(", ") || "unknown artist"}{track.album !== null ? ` · ${track.album}` : ""}{track.durationMs !== null ? ` · ${Math.round(track.durationMs / 1000)}s` : ""}</small>
                    </div>
                    <button className="deck-chip" onClick={() => { setDispatchTrack(track); setDispatchUrl(""); }}>Bring into studio</button>
                  </div>
                ))}
                {tracksShown.length === 0 && <small className="stream-hint">Nothing matches.</small>}
              </div>
            </div>
          </div>
          {dispatchTrack !== null && (
            <div className="stream-dispatch">
              <p>
                <b>{dispatchTrack.title}</b> — the studio ingests audio you are authorized to use: paste a link your deployment&apos;s
                resolver accepts, or drop the file onto the palette above. Nothing is ripped from {SERVICE_LABELS[dispatchTrack.service]}.
              </p>
              <div className="stream-dispatch-row">
                <input
                  aria-label="Authorized audio link"
                  type="url"
                  placeholder="https://… (an authorized audio link)"
                  value={dispatchUrl}
                  onChange={(event) => setDispatchUrl(event.target.value)}
                />
                <button className="button" disabled={dispatching} onClick={() => void dispatch()}>{dispatching ? "Dispatching…" : "Dispatch"}</button>
                <button className="deck-chip" onClick={() => setDispatchTrack(null)}>Cancel</button>
              </div>
            </div>
          )}
          {snapshot !== null && (
            <div className="stream-footer">
              {accountFor(snapshot.service) !== null && (
                <button className="deck-chip off" disabled={busy !== null} onClick={() => void disconnect(accountFor(snapshot.service)!.id)}>
                  Disconnect {SERVICE_LABELS[snapshot.service]}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function diffIsEmptyLocal(diff: SnapshotDiff): boolean {
  return diff.playlistsAdded.length === 0 && diff.playlistsRemoved.length === 0 && diff.tracksAdded.length === 0 && diff.tracksRemoved.length === 0 && diff.reordered.length === 0;
}

// --------------------------------------------------------- spotify client

type CallbackHandlers = {
  openSnapshot: (snapshotId: string) => Promise<void>;
  reload: () => Promise<void>;
  setStatus: (message: string) => void;
  fail: (message: string) => void;
};

/** Finish the PKCE round-trip the component started before the redirect. */
async function completeSpotifyCallback(code: string, state: string, handlers: CallbackHandlers): Promise<void> {
  const stored = window.localStorage.getItem(PKCE_KEY);
  window.localStorage.removeItem(PKCE_KEY);
  if (stored === null) {
    handlers.fail("The sync session expired — press Sync now again.");
    return;
  }
  const session = JSON.parse(stored) as { verifier: string; state: string; accountId: string; clientId: string };
  if (session.state !== state) {
    handlers.fail("Spotify returned an unexpected sync session — press Sync now again.");
    return;
  }
  handlers.setStatus("Pulling your Spotify library…");
  try {
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${window.location.origin}${window.location.pathname}`,
        client_id: session.clientId,
        code_verifier: session.verifier,
      }),
    });
    const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
    if (!tokenResponse.ok || tokenBody.access_token === undefined) {
      handlers.fail("Spotify refused the token exchange — check the app&apos;s redirect URI matches this page exactly.");
      return;
    }
    const token = tokenBody.access_token;
    const api = async (path: string) => {
      const response = await fetch(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Spotify API ${response.status} on ${path}`);
      return (await response.json()) as Record<string, unknown>;
    };

    const me = await api("/me");
    const accountName = typeof me.display_name === "string" ? me.display_name : null;

    // Playlists (paginate), then each playlist's tracks (paginate).
    const playlistPages: Array<Record<string, unknown>> = [];
    let next: string | null = "/me/playlists?limit=50";
    while (next !== null) {
      const page = await api(next.replace("https://api.spotify.com/v1", ""));
      const items = Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : [];
      playlistPages.push(...items);
      next = typeof page.next === "string" ? page.next : null;
    }

    const playlists: Array<{ playlist: unknown; trackPages: unknown[][] }> = [];
    for (const playlist of playlistPages) {
      const id = typeof playlist.id === "string" ? playlist.id : null;
      if (id === null) continue;
      const trackPages: unknown[][] = [];
      let trackNext: string | null = `/playlists/${id}/tracks?limit=100`;
      let guard = 0;
      while (trackNext !== null && guard < 120) {
        guard += 1;
        const page = await api(trackNext);
        const items = Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : [];
        trackPages.push(items.map((item) => item.track ?? null));
        trackNext = typeof page.next === "string" ? page.next : null;
      }
      playlists.push({ playlist, trackPages });
    }

    // Liked songs (paginate).
    const likedPages: unknown[][] = [];
    let likedNext: string | null = "/me/tracks?limit=50";
    let likedGuard = 0;
    while (likedNext !== null && likedGuard < 400) {
      likedGuard += 1;
      const page = await api(likedNext);
      const items = Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : [];
      likedPages.push(items.map((item) => item.track ?? null));
      likedNext = typeof page.next === "string" ? page.next : null;
    }

    const snapshot = assembleSpotifySnapshot({ accountName, playlists, likedPages });
    const response = await fetch(`/api/streaming/accounts/${session.accountId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot }),
    });
    const body = (await response.json().catch(() => ({}))) as { snapshot?: { id: string }; error?: string };
    if (!response.ok || body.snapshot === undefined) {
      handlers.fail(body.error ?? "The snapshot was pulled but could not be stored.");
      return;
    }
    await handlers.reload();
    await handlers.openSnapshot(body.snapshot.id);
    const stats = snapshotStats(snapshot);
    handlers.setStatus(`Spotify synced — ${stats.playlists} playlists, ${stats.tracks} tracks backed up. Export any time.`);
  } catch (error) {
    handlers.fail(error instanceof Error ? `Sync failed: ${error.message}` : "Sync failed.");
  }
}

// mapSpotifyTrack + pageCount are re-exported for consumers that build
// custom pulls (the callback above uses the assembler directly).
export { mapSpotifyTrack, pageCount };
