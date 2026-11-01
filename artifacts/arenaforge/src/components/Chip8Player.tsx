"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CHIP8_HEIGHT, CHIP8_KEYS, CHIP8_WIDTH, Chip8Runtime, chip8KeyFromKeyboard, chip8DialectLabel, type Chip8Dialect } from "../lib/chip8Runtime";
import Chip8ProgressBackup from "./Chip8ProgressBackup";
import { chip8StateKey as stateKey, validateChip8Progress, type Chip8ProgressState } from "../lib/chip8ProgressBackup";
import { browserChip8Adapter } from "../lib/arcadeRuntimeAdapters";

type Chip8PlayerProps = {
  gameId: string;
  name: string;
  rom: ArrayBuffer;
  dialect?: Chip8Dialect;
};

export default function Chip8Player({ gameId, name, rom, dialect = "chip8" }: Chip8PlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Chip8Runtime | null>(null);
  const [status, setStatus] = useState("Starting classic CHIP-8.");
  const [resolution, setResolution] = useState("64×32");
  const [restartVersion, setRestartVersion] = useState(0);
  const backupPausedRef = useRef(false);
  const [backupPaused, setBackupPaused] = useState(false);
  const profile = chip8DialectLabel(dialect);
  const pauseForBackup = useCallback((paused: boolean) => {
    backupPausedRef.current = paused;
    if (paused) runtimeRef.current?.keys.fill(0);
    setBackupPaused(paused);
  }, []);

  useEffect(() => {
    let active = true;
    let animation = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let runtime: Chip8Runtime;
    const key = stateKey(gameId, dialect);
    const saveProgress = () => {
      if (!runtimeRef.current) return;
      try {
        localStorage.setItem(key, JSON.stringify(runtimeRef.current.snapshot()));
        return true;
      } catch {
        if (active) setStatus("Running. Browser storage could not save CHIP-8 progress.");
        return false;
      }
    };
    try {
      let saved: unknown;
      try {
        const stored = localStorage.getItem(key);
        if (stored) saved = JSON.parse(stored);
      } catch {
        setStatus("Running fresh. This browser could not read saved CHIP-8 progress.");
      }
      runtime = browserChip8Adapter.launch({ rom: new Uint8Array(rom), snapshot: saved, dialect });
      runtimeRef.current = runtime;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      if (!canvas || !context) throw new Error("Canvas rendering is unavailable in this browser.");
      canvas.width = CHIP8_WIDTH;
      canvas.height = CHIP8_HEIGHT;
      let frame = context.createImageData(CHIP8_WIDTH, CHIP8_HEIGHT);
      const render = () => {
        if (canvas.width !== runtime.width || canvas.height !== runtime.height) {
          canvas.width = runtime.width;
          canvas.height = runtime.height;
          frame = context.createImageData(runtime.width, runtime.height);
        }
        const dimensions = `${runtime.width}×${runtime.height}`;
        if (canvas.dataset.resolution !== dimensions) {
          canvas.dataset.resolution = dimensions;
          setResolution(dimensions);
        }
        for (let index = 0; index < runtime.width * runtime.height; index += 1) {
          const offset = index * 4;
          const lit = runtime.display[index] !== 0;
          frame.data[offset] = lit ? 96 : 8;
          frame.data[offset + 1] = lit ? 245 : 12;
          frame.data[offset + 2] = lit ? 186 : 18;
          frame.data[offset + 3] = 255;
        }
        context.putImageData(frame, 0, 0);
      };
      const tick = (now: number) => {
        if (!active || runtimeRef.current !== runtime) return;
        if (backupPausedRef.current) {
          lastFrame = now;
          animation = window.requestAnimationFrame(tick);
          return;
        }
        if (lastFrame === 0) lastFrame = now;
        elapsed += Math.min(now - lastFrame, 100);
        lastFrame = now;
        try {
          while (elapsed >= 1000 / 60) {
            elapsed -= 1000 / 60;
            runtime.tickTimers();
            for (let cycle = 0; cycle < 8 && !runtime.halted; cycle += 1) runtime.step();
          }
        } catch (cause) {
          active = false;
          saveProgress();
          setStatus(cause instanceof Error ? `Program stopped: ${cause.message}` : "Program stopped on an unsupported instruction.");
          return;
        }
        render();
        if (runtime.halted) {
          const saved = saveProgress();
          setStatus(`Program exited normally. ${saved ? "Progress saved in this browser." : "Browser storage could not save progress."}`);
          return;
        }
        animation = window.requestAnimationFrame(tick);
      };
      render();
      animation = window.requestAnimationFrame(tick);
      const restored = saved !== undefined;
      setStatus(restored
        ? "Running. Progress restored from this browser and auto-saved every 4 seconds."
         : `Running ${dialect === "chip8" ? "classic CHIP-8" : profile}. Progress auto-saves in this browser every 4 seconds.`);
    } catch (cause) {
      runtimeRef.current = null;
      setStatus(cause instanceof Error ? `Could not start this CHIP-8 program: ${cause.message}` : "Could not start this CHIP-8 program.");
    }

    const interval = window.setInterval(saveProgress, 4000);
    const onVisibility = () => { if (document.visibilityState === "hidden") saveProgress(); };
    window.addEventListener("pagehide", saveProgress);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.cancelAnimationFrame(animation);
      window.clearInterval(interval);
      window.removeEventListener("pagehide", saveProgress);
      document.removeEventListener("visibilitychange", onVisibility);
      saveProgress();
      if (runtimeRef.current) browserChip8Adapter.cleanup(runtimeRef.current);
      runtimeRef.current = null;
    };
   }, [gameId, rom, dialect, profile, restartVersion]);

  const restartProgram = () => {
    if (!window.confirm("Restart this program and replace its saved progress? Super-CHIP RPL flags will be retained.")) return;
    try {
      const fresh = browserChip8Adapter.launch({ rom: new Uint8Array(rom), dialect });
      if (dialect === "schip" && runtimeRef.current) fresh.rpl.set(runtimeRef.current.rpl);
      localStorage.setItem(stateKey(gameId, dialect), JSON.stringify(fresh.snapshot()));
      // Effect cleanup must not overwrite the newly committed reset with the old run.
      runtimeRef.current = null;
      setRestartVersion(version => version + 1);
    } catch {
      setStatus("Could not restart: browser storage is unavailable. Existing progress has been retained.");
    }
  };

  const restoreSnapshot = (snapshot: Chip8ProgressState) => {
    const checked = validateChip8Progress({ gameId, name, rom, dialect }, snapshot);
    localStorage.setItem(stateKey(gameId, dialect), JSON.stringify(checked));
    // Retire the old runtime before effect cleanup can auto-save over restore.
    runtimeRef.current = null;
    setRestartVersion(version => version + 1);
  };
  const changeKey = (index: number, pressed: boolean) => {
    if (!pressed || !backupPausedRef.current) runtimeRef.current?.setKey(index, pressed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = chip8KeyFromKeyboard(event.key);
    if (key === null) return;
    event.preventDefault();
    changeKey(key, true);
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = chip8KeyFromKeyboard(event.key);
    if (key === null) return;
    event.preventDefault();
    changeKey(key, false);
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, key: number) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    changeKey(key, true);
  };

  return (
    <div
      className="space-y-3 bg-black/30 p-3"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        for (let key = 0; key < 16; key += 1) changeKey(key, false);
      }}
       aria-label={`${profile} player for ${name}`}
      data-testid="chip8-player"
       data-dialect={dialect}
    >
      <canvas
        ref={canvasRef}
        width={CHIP8_WIDTH}
        height={CHIP8_HEIGHT}
         aria-label={`${dialect === "schip" ? "Super-CHIP" : "CHIP-8"} screen for ${name}`}
        className="mx-auto block w-full max-w-[640px] border border-emerald-300/20 bg-[#080c12] [image-rendering:pixelated]"
        style={{ aspectRatio: "2 / 1" }}
        onClick={(event) => event.currentTarget.parentElement?.focus()}
      />
      <p className="text-center text-[10px] leading-relaxed text-slate-400">
         {resolution} · {status} · Click the screen, then use 1–4 / Q–R / A–F / Z–V, or touch the keypad.
      </p>
       <div className="text-center">
         <button type="button" disabled={backupPaused} onClick={restartProgram} className="rounded-md border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40">
           Restart program
         </button>
       </div>
      <div className="mx-auto grid max-w-[360px] grid-cols-4 gap-1.5" aria-label="CHIP-8 touch keypad">
        {CHIP8_KEYS.flat().map((label) => (
          <button
            key={label}
            type="button"
             onPointerDown={(event) => onPointerDown(event, parseInt(label, 16))}
             onPointerUp={() => changeKey(parseInt(label, 16), false)}
             onPointerCancel={() => changeKey(parseInt(label, 16), false)}
             onLostPointerCapture={() => changeKey(parseInt(label, 16), false)}
            className="touch-none rounded-md border border-white/10 bg-white/5 px-2 py-2 font-mono text-xs font-bold text-slate-200 active:bg-emerald-300/20"
            aria-label={`CHIP-8 key ${label}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div onFocusCapture={() => runtimeRef.current?.keys.fill(0)}>
      <Chip8ProgressBackup target={{ gameId, name, rom, dialect }} onPause={pauseForBackup} onRestore={restoreSnapshot} getSnapshot={() => {
        if (!runtimeRef.current) throw new Error("This program has no active runtime snapshot.");
        return runtimeRef.current.snapshot();
      }} />
      </div>
    </div>
  );
}
