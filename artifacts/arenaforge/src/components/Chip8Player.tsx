"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CHIP8_HEIGHT, CHIP8_KEYS, CHIP8_WIDTH, Chip8Runtime, chip8KeyFromKeyboard } from "../lib/chip8Runtime";

type Chip8PlayerProps = {
  gameId: string;
  name: string;
  rom: ArrayBuffer;
};

const stateKey = (id: string) => `arenaforge.chip8-state.v1:${id}`;

export default function Chip8Player({ gameId, name, rom }: Chip8PlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Chip8Runtime | null>(null);
  const [status, setStatus] = useState("Starting classic CHIP-8.");

  useEffect(() => {
    let active = true;
    let animation = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let runtime: Chip8Runtime;
    const key = stateKey(gameId);
    const saveProgress = () => {
      if (!runtimeRef.current) return;
      try {
        localStorage.setItem(key, JSON.stringify(runtimeRef.current.snapshot()));
      } catch {
        if (active) setStatus("Running. Browser storage could not save CHIP-8 progress.");
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
      runtime = new Chip8Runtime(new Uint8Array(rom), saved);
      runtimeRef.current = runtime;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d", { alpha: false });
      if (!canvas || !context) throw new Error("Canvas rendering is unavailable in this browser.");
      canvas.width = CHIP8_WIDTH;
      canvas.height = CHIP8_HEIGHT;
      const frame = context.createImageData(CHIP8_WIDTH, CHIP8_HEIGHT);
      const render = () => {
        for (let index = 0; index < runtime.display.length; index += 1) {
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
        if (!active) return;
        if (lastFrame === 0) lastFrame = now;
        elapsed += Math.min(now - lastFrame, 100);
        lastFrame = now;
        try {
          while (elapsed >= 1000 / 60) {
            elapsed -= 1000 / 60;
            runtime.tickTimers();
            for (let cycle = 0; cycle < 8; cycle += 1) runtime.step();
          }
        } catch (cause) {
          active = false;
          saveProgress();
          setStatus(cause instanceof Error ? `Program stopped: ${cause.message}` : "Program stopped on an unsupported instruction.");
          return;
        }
        render();
        animation = window.requestAnimationFrame(tick);
      };
      render();
      animation = window.requestAnimationFrame(tick);
      const restored = saved !== undefined;
      setStatus(restored
        ? "Running. Progress restored from this browser and auto-saved every 4 seconds."
        : "Running classic CHIP-8. Progress auto-saves in this browser every 4 seconds.");
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
      runtimeRef.current = null;
    };
  }, [gameId, rom]);

  const changeKey = (index: number, pressed: boolean) => runtimeRef.current?.setKey(index, pressed);
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
      aria-label={`Classic CHIP-8 player for ${name}`}
      data-testid="chip8-player"
    >
      <canvas
        ref={canvasRef}
        width={CHIP8_WIDTH}
        height={CHIP8_HEIGHT}
        aria-label={`CHIP-8 screen for ${name}`}
        className="mx-auto block w-full max-w-[640px] border border-emerald-300/20 bg-[#080c12] [image-rendering:pixelated]"
        style={{ aspectRatio: "2 / 1" }}
        onClick={(event) => event.currentTarget.parentElement?.focus()}
      />
      <p className="text-center text-[10px] leading-relaxed text-slate-400">
        {status} · Click the screen, then use 1–4 / Q–R / A–F / Z–V, or touch the keypad.
      </p>
      <div className="mx-auto grid max-w-[360px] grid-cols-4 gap-1.5" aria-label="CHIP-8 touch keypad">
        {CHIP8_KEYS.flat().map((label, index) => (
          <button
            key={label}
            type="button"
            onPointerDown={(event) => onPointerDown(event, index)}
            onPointerUp={() => changeKey(index, false)}
            onPointerCancel={() => changeKey(index, false)}
            onLostPointerCapture={() => changeKey(index, false)}
            className="touch-none rounded-md border border-white/10 bg-white/5 px-2 py-2 font-mono text-xs font-bold text-slate-200 active:bg-emerald-300/20"
            aria-label={`CHIP-8 key ${label}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
