"use client";

/**
 * Insert rack — the real workflow over the DSP engine.
 *
 * Every parameter here drives the live Web Audio graph (via the transport's
 * applyInserts) AND the persisted chain (remix_tracks.inserts /
 * remix_sessions.masterInserts). Processors without a native live node
 * (gate) are labeled honestly "render path only" — they apply to cleanup
 * previews/renders, not live monitoring.
 */

import {
  INSERT_PARAM_RANGES,
  INSERT_PROCESSOR_LABELS,
  makeInsert,
  moveInsert,
  removeInsert,
  toggleInsert,
  type InsertChain,
  type InsertProcessorId,
} from "@/lib/waveyard/mixer/inserts";
import { MIX_PRESETS } from "@/lib/waveyard/mixer/presets";

const RENDER_ONLY = new Set<InsertProcessorId>(["gate"]);

export function InsertRack({
  channelLabel,
  chain,
  onChange,
}: {
  channelLabel: string;
  chain: InsertChain;
  onChange: (next: InsertChain) => void;
}) {
  const add = (processor: InsertProcessorId) => {
    const insert = makeInsert(processor);
    if (insert !== null) onChange([...chain, insert]);
  };
  const applyPreset = (presetId: keyof typeof MIX_PRESETS) => {
    const preset = MIX_PRESETS[presetId];
    let next = [...chain];
    for (const step of preset.chain) {
      const insert = makeInsert(step.processor, step.params);
      if (insert !== null) next = [...next, insert];
    }
    onChange(next);
  };

  return (
    <details className="insert-rack" data-testid={`insert-rack-${channelLabel}`}>
      <summary>
        FX <b>{chain.length}</b>
        <small>{chain.filter((insert) => insert.enabled).length} active</small>
      </summary>
      <div className="insert-controls">
        <label>
          Add processor
          <select
            aria-label={`Add processor to ${channelLabel}`}
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) add(event.target.value as InsertProcessorId);
              event.target.value = "";
            }}
          >
            <option value="" disabled>Choose…</option>
            {(Object.keys(INSERT_PARAM_RANGES) as InsertProcessorId[]).map((processor) => (
              <option key={processor} value={processor}>
                {INSERT_PROCESSOR_LABELS[processor]}{RENDER_ONLY.has(processor) ? " (render path only)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Preset
          <select
            aria-label={`Apply preset to ${channelLabel}`}
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) applyPreset(event.target.value as keyof typeof MIX_PRESETS);
              event.target.value = "";
            }}
          >
            <option value="" disabled>Append preset…</option>
            {Object.entries(MIX_PRESETS).map(([id, preset]) => (
              <option key={id} value={id}>{preset.label}</option>
            ))}
          </select>
        </label>
      </div>
      {chain.length === 0 && <p className="insert-empty">No processors. The channel is dry.</p>}
      <ol className="insert-list">
        {chain.map((insert, index) => {
          const ranges = INSERT_PARAM_RANGES[insert.processor as InsertProcessorId];
          return (
            <li key={insert.id} className={`insert-item ${insert.enabled ? "" : "bypassed"}`}>
              <div className="insert-head">
                <b>{index + 1}. {INSERT_PROCESSOR_LABELS[insert.processor as InsertProcessorId] ?? insert.processor}</b>
                {RENDER_ONLY.has(insert.processor as InsertProcessorId) && (
                  <small title="No native live node — applied on cleanup previews/renders">render path only</small>
                )}
                <div className="console-toggles">
                  <button
                    className={`toggle ${insert.enabled ? "on" : ""}`}
                    aria-label={`Bypass ${insert.processor}`}
                    aria-pressed={!insert.enabled}
                    title={insert.enabled ? "Bypass" : "Enable"}
                    onClick={() => onChange(toggleInsert(chain, insert.id))}
                  >B</button>
                  <button
                    className="toggle"
                    aria-label={`Move ${insert.processor} up`}
                    disabled={index === 0}
                    onClick={() => onChange(moveInsert(chain, index, index - 1))}
                  >↑</button>
                  <button
                    className="toggle"
                    aria-label={`Move ${insert.processor} down`}
                    disabled={index === chain.length - 1}
                    onClick={() => onChange(moveInsert(chain, index, index + 1))}
                  >↓</button>
                  <button
                    className="toggle"
                    aria-label={`Remove ${insert.processor}`}
                    onClick={() => onChange(removeInsert(chain, insert.id))}
                  >✕</button>
                </div>
              </div>
              {ranges !== undefined && (
                <div className="insert-params">
                  {Object.entries(ranges).map(([param, range]) => (
                    <label key={param}>
                      {param}
                      <input
                        aria-label={`${insert.processor} ${param}`}
                        type="range"
                        min={range.min}
                        max={range.max}
                        step={(range.max - range.min) / 200}
                        value={insert.params[param] ?? range.default}
                        onChange={(event) =>
                          onChange(
                            chain.map((candidate) =>
                              candidate.id === insert.id
                                ? { ...candidate, params: { ...candidate.params, [param]: Number(event.target.value) } }
                                : candidate,
                            ),
                          )
                        }
                      />
                      <output>{(insert.params[param] ?? range.default).toFixed(2)}</output>
                    </label>
                  ))}
                  <label>
                    wet
                    <input
                      aria-label={`${insert.processor} wet mix`}
                      type="range" min="0" max="1" step="0.01" value={insert.wet}
                      onChange={(event) =>
                        onChange(
                          chain.map((candidate) =>
                            candidate.id === insert.id
                              ? { ...candidate, wet: Number(event.target.value) }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <output>{insert.wet.toFixed(2)}</output>
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
