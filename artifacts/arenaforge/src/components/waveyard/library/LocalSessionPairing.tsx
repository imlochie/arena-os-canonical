import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  createLocalSessionKey,
  decryptLocalSessionPayload,
  encryptLocalSessionPayload,
  type EncryptedLocalSessionPacket,
  type LocalRemoteCommand,
} from "./local-session-crypto";

export interface LocalSessionSnapshot {
  sessionName: string;
  trackId: string | null;
  title: string;
  artist: string;
  nextTitle: string | null;
  previousTitle: string | null;
  queue: Array<{ id: string; title: string; artist: string; durationSeconds: number }>;
  positionSeconds: number;
  durationSeconds: number;
  playing: boolean;
}

interface LocalSyncStartResponse {
  addresses: string[];
  port: number;
  pairingToken: string;
  hostToken: string;
  hostNoncePrefix: string;
  expiresAt: number;
  maxDevices: number;
  error?: string;
}

interface PairingState extends LocalSyncStartResponse {
  key: string;
}

interface Props {
  snapshot: LocalSessionSnapshot;
  onCommand: (command: LocalRemoteCommand) => void;
}

function makePairUrl(pairing: PairingState, address: string) {
  const url = new URL(`http://${address}:${pairing.port}/`);
  url.hash = new URLSearchParams({
    pair: pairing.pairingToken,
    key: pairing.key,
    host: pairing.hostNoncePrefix,
  }).toString();
  return url.toString();
}

export default function LocalSessionPairing({ snapshot, onCommand }: Props) {
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deviceCount, setDeviceCount] = useState(0);
  const [selectedAddress, setSelectedAddress] = useState("");
  const snapshotRef = useRef(snapshot);
  const commandRef = useRef(onCommand);
  const sequenceRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pairingRef = useRef<PairingState | null>(null);
  const lastReceivedCounterRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);
  const inviteUrl = useMemo(
    () => pairing && selectedAddress ? makePairUrl(pairing, selectedAddress) : "",
    [pairing, selectedAddress],
  );

  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  useEffect(() => { commandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { pairingRef.current = pairing; }, [pairing]);

  const stopSharing = useCallback(async (hostToken?: string) => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (hostToken) {
      await fetch("/api/waveyard/local-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop", hostToken }),
      }).catch(() => undefined);
    }
    if (mountedRef.current) {
      setPairing(null);
      setDeviceCount(0);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = eventSourceRef.current;
      current?.close();
      eventSourceRef.current = null;
      const hostToken = pairingRef.current?.hostToken;
      if (hostToken) {
        void fetch("/api/waveyard/local-sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop", hostToken }),
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    const origin = `http://127.0.0.1:${pairing.port}`;
    const source = new EventSource(`${origin}/host/events?token=${encodeURIComponent(pairing.hostToken)}`);
    eventSourceRef.current = source;
    source.addEventListener("device", (event) => {
      try {
        setDeviceCount((JSON.parse((event as MessageEvent<string>).data) as { count: number }).count);
      } catch {
        // Ignore malformed presence updates; session controls remain independent.
      }
    });
    source.addEventListener("control", (event) => {
      try {
        const packet = JSON.parse((event as MessageEvent<string>).data) as EncryptedLocalSessionPacket;
        const last = lastReceivedCounterRef.current.get(packet.senderId) ?? 0;
        if (packet.counter <= last) return;
        const command = decryptLocalSessionPayload<LocalRemoteCommand>(pairing.key, packet);
        if (!command || !["toggle-play", "next", "previous", "seek", "select-track"].includes(command.type)) return;
        if (command.type === "seek" && !Number.isFinite(command.positionSeconds)) return;
        if (command.type === "select-track" && typeof command.itemId !== "string") return;
        lastReceivedCounterRef.current.set(packet.senderId, packet.counter);
        commandRef.current(command);
      } catch {
        // Only authenticated, well-formed controls may reach the audio engine.
      }
    });
    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    const origin = `http://127.0.0.1:${pairing.port}`;
    let sending = false;
    const publish = async () => {
      if (sending) return;
      sending = true;
      try {
        sequenceRef.current += 1;
        const packet = encryptLocalSessionPayload(
          pairing.key,
          pairing.hostNoncePrefix,
          sequenceRef.current,
          { ...snapshotRef.current, updatedAt: Date.now() },
        );
        await fetch(`${origin}/host/state?token=${encodeURIComponent(pairing.hostToken)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ packet }),
        });
      } catch {
        // The remote shows a connection state; the next interval retries.
      } finally {
        sending = false;
      }
    };
    void publish();
    const timer = window.setInterval(() => void publish(), 750);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const startSharing = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const key = createLocalSessionKey();
      const response = await fetch("/api/waveyard/local-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const result = await response.json() as LocalSyncStartResponse;
      if (!response.ok) throw new Error(result.error ?? "Could not start local sharing.");
      if (!result.addresses.length) {
        throw new Error("No private network address is available. Connect both devices to the same Wi-Fi.");
      }
      sequenceRef.current = 0;
      lastReceivedCounterRef.current.clear();
      setSelectedAddress(result.addresses[0]);
      setPairing({ ...result, key });
      setDeviceCount(0);
      setOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start local sharing.");
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setError("");
    } catch {
      setError("Copy is unavailable here. Scan the QR from your phone’s camera instead.");
    }
  }, [inviteUrl]);

  return (
    <>
      <button
        type="button"
        className="wy-share-qr"
        onClick={() => pairing ? setOpen(true) : void startSharing()}
        disabled={busy}
        aria-label={pairing ? "Show phone pairing QR code" : "Share live session with a phone"}
        title={pairing ? "Show the private phone QR code" : "Share this live session over your private Wi-Fi"}
        data-testid="waveyard-share-phone"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h7v7H3zM5 5v3h3V5zM14 3h7v7h-7zM16 5v3h3V5zM3 14h7v7H3zM5 16v3h3v-3zM14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM18 18h3v3h-3zM19 16h2v2h-2z" /></svg>
        <span>{busy ? "Opening…" : pairing ? deviceCount > 0 ? "Phone paired" : "Share active" : "Share"}</span>
      </button>

      {open && (
        <div className="wy-sync-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section
            className="wy-sync-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wy-sync-title"
            onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
          >
            <button className="wy-sync-close" type="button" aria-label="Close pairing panel" onClick={() => setOpen(false)}>×</button>
            <div className="wy-sync-eyebrow">PRIVATE · LOCAL WI-FI</div>
            <h2 id="wy-sync-title">Bring your phone into this session</h2>
            <p className="wy-sync-description">
              Scan with your phone’s camera. Your laptop keeps playing; the phone gets live controls and session details.
              The link is end-to-end encrypted and never uses a cloud relay.
            </p>
            {pairing ? (
              <>
                {pairing.addresses.length > 1 && (
                  <label className="wy-sync-address">
                    Network address
                    <select value={selectedAddress} onChange={(event) => setSelectedAddress(event.target.value)}>
                      {pairing.addresses.map((address) => <option key={address} value={address}>{address}</option>)}
                    </select>
                  </label>
                )}
                <div className="wy-sync-qr">
                  <QRCodeSVG value={inviteUrl} size={232} level="H" includeMargin title="Scan to control this Waveyard session from your phone" />
                </div>
                <div className="wy-sync-status" role="status">
                  <span className={deviceCount > 0 ? "is-on" : ""} />
                  {deviceCount > 0 ? `${deviceCount} phone${deviceCount === 1 ? "" : "s"} paired` : "Waiting for your phone"}
                  <small>Same private Wi-Fi · invitation expires after 60 minutes</small>
                </div>
                <div className="wy-sync-actions">
                  <button type="button" onClick={() => void copyInvite()}>Copy private link</button>
                  <button className="danger" type="button" onClick={() => void stopSharing(pairing.hostToken)}>End sharing</button>
                </div>
              </>
            ) : (
              <div className="wy-sync-start">
                {error && <p className="wy-sync-error" role="alert">{error}</p>}
                <button type="button" disabled={busy} onClick={() => void startSharing()}>
                  {busy ? "Starting local connection…" : "Start private sharing"}
                </button>
                <small>Both devices need to be connected to the same private Wi-Fi network.</small>
              </div>
            )}
            {pairing && error && <p className="wy-sync-error" role="status">{error}</p>}
            <p className="wy-sync-privacy">Use a private Wi-Fi network, not a guest network. If the phone cannot connect, allow Arena through your laptop’s private-network firewall. Only track/queue labels, playhead and controls are shared; audio, recordings and library files stay on this laptop.</p>
          </section>
        </div>
      )}
    </>
  );
}
