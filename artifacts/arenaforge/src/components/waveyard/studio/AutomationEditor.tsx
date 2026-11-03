import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AutomationParameter } from "@workspace/arena/lib/waveyard/types";
import type { Remix } from "./types";

export type AutomationTarget = { trackId: string; parameter: AutomationParameter; timelineMs: number | null };
type EditAutomation = (before: Remix, operation: "upsert" | "delete", payload: Record<string, unknown>) => Promise<string | null>;

export function AutomationEditor({ remix, positionMs, target, onTarget, onEdit }: {
  remix: Remix;
  positionMs: number;
  target: AutomationTarget;
  onTarget: (target: AutomationTarget) => void;
  onEdit: EditAutomation;
}) {
  const track = remix.tracks.find((item) => item.id === target.trackId) ?? remix.tracks[0];
  const points = remix.automation.find((lane) => lane.remixTrackId === track?.id && lane.parameter === target.parameter)?.points ?? [];
  const point = points.find((item) => item.timelineMs === target.timelineMs);
  const [time, setTime] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState("");
  const timeInput = useRef<HTMLInputElement>(null);
  const pointSelect = useRef<HTMLSelectElement>(null);
  const focusAfterSave = useRef<"point" | "time" | null>(null);
  const helpId = useId();
  const minValue = target.parameter === "volume" ? 0 : -1;
  useLayoutEffect(() => {
    if (busy || !focusAfterSave.current) return;
    (focusAfterSave.current === "point" ? pointSelect.current : timeInput.current)?.focus();
    focusAfterSave.current = null;
  }, [busy]);

  useEffect(() => {
    setTime(String(point?.timelineMs ?? Math.max(0, Math.min(86_400_000, Math.round(positionMs)))));
    setValue(String(point?.value ?? (target.parameter === "volume" ? track?.volume ?? 1 : track?.pan ?? 0)));
    // The playhead must not overwrite an in-progress numeric edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id, target.parameter, target.timelineMs, point?.timelineMs, point?.value]);

  if (!track) return null;
  const choose = (next: AutomationTarget) => {
    setMessage("");
    onTarget(next);
  };
  const apply = async (operation: "upsert" | "delete") => {
    if (pending.current) return;
    const timelineMs = Number(time);
    const numericValue = Number(value);
    if (operation === "upsert" && (!time.trim() || !value.trim() || !Number.isInteger(timelineMs)
      || timelineMs < 0 || timelineMs > 86_400_000 || !Number.isFinite(numericValue)
      || numericValue < minValue || numericValue > (target.parameter === "volume" ? 2 : 1))) {
      setMessage(`Enter a whole time from 0 to 86400000 ms and a ${target.parameter} value from ${minValue} to ${target.parameter === "volume" ? 2 : 1}.`);
      (Number.isInteger(timelineMs) && time.trim() && timelineMs >= 0 && timelineMs <= 86_400_000
        ? timeInput.current?.form?.querySelector<HTMLInputElement>('[name="automationValue"]')
        : timeInput.current)?.focus();
      return;
    }
    if (operation === "delete" && !point?.id) return;
    pending.current = true;
    setBusy(true);
    setMessage("");
    let succeeded = false;
    try {
      const error = await onEdit(remix, operation, {
        remixTrackId: track.id, parameter: target.parameter,
        ...(point?.id ? { pointId: point.id } : {}),
        ...(operation === "upsert" ? { timelineMs, value: numericValue } : {}),
      });
      if (error) setMessage(error);
      else {
        succeeded = true;
        onTarget({ trackId: track.id, parameter: target.parameter, timelineMs: operation === "delete" ? null : timelineMs });
        setMessage(operation === "delete" ? `${target.parameter} point deleted. Choose another point or create a new one.` : `${target.parameter} point saved at ${timelineMs} ms.`);
      }
    } catch {
      setMessage("Could not save the automation change. Your entries are kept; try again.");
    } finally {
      pending.current = false;
      focusAfterSave.current = succeeded && operation === "delete" ? "point" : "time";
      setBusy(false);
      // Controls stay mounted so focus never depends on a removed timeline dot.
    }
  };

  return <form className="automation-editor" aria-label="Automation point editor" aria-describedby={helpId}
    onSubmit={(event) => { event.preventDefault(); void apply("upsert"); }}>
    <fieldset aria-busy={busy}>
      <legend>Automation points</legend>
      <p id={helpId}>Choose a track, volume or pan, then a point or New point. Time is in milliseconds (0–86400000). Volume: 0–2 (1 = original). Pan: −1 left, 0 centre, 1 right.</p>
      <div className="automation-editor-controls">
        <label>Track <select aria-label="Automation track" disabled={busy} value={track.id} onChange={(event) => choose({ ...target, trackId: event.target.value, timelineMs: null })}>
          {remix.tracks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Parameter <select aria-label="Automation parameter" disabled={busy} value={target.parameter} onChange={(event) => choose({ ...target, parameter: event.target.value as AutomationParameter, timelineMs: null })}>
          <option value="volume">Volume</option><option value="pan">Pan</option>
        </select></label>
        <label>Point <select ref={pointSelect} aria-label="Automation point" disabled={busy} value={point ? String(point.timelineMs) : "new"} onChange={(event) => choose({ ...target, timelineMs: event.target.value === "new" ? null : Number(event.target.value) })}>
          <option value="new">New point</option>
          {[...points].sort((a, b) => a.timelineMs - b.timelineMs).map((item) => <option key={item.id ?? item.timelineMs} value={item.timelineMs}>{item.timelineMs} ms · {item.value}</option>)}
        </select></label>
        <label>Time (ms) <input ref={timeInput} aria-label="Automation time in milliseconds" type="number" min="0" max="86400000" step="1" required readOnly={busy} value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <label>{target.parameter === "volume" ? "Volume" : "Pan"} <input name="automationValue" aria-label="Automation value" type="number" min={minValue} max={target.parameter === "volume" ? 2 : 1} step="any" required readOnly={busy} value={value} onChange={(event) => setValue(event.target.value)} /></label>
        <button type="submit" className="button secondary" disabled={busy}>{busy ? "Saving…" : point ? "Save point" : "Create point"}</button>
        <button type="button" className="button danger" disabled={busy || !point?.id} onClick={() => void apply("delete")}>Delete point</button>
      </div>
    </fieldset>
    <p role="status" aria-live="polite" aria-atomic="true">{message}</p>
  </form>;
}
