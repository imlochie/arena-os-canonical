"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/lib/luma/state/editorStore";
import { getEngine, loadImage } from "@/lib/luma/engine/CanvasProcessingEngine";
import { BUILT_IN_PRESETS, getBuiltInPreset } from "@/lib/luma/presets/library";
import { CAMERAS, cameraForPresetId } from "@/lib/luma/cameras/catalog";
import { ADJUSTMENT_KEYS, ADJUSTMENT_SPECS, type Adjustments, type Preset, type SourceAsset } from "@/lib/luma/engine/types";
import { ProjectRepository } from "@/lib/luma/storage/projectRepository";
import type { Project } from "@/lib/luma/engine/types";

const repo = new ProjectRepository();

/**
 * LUMA — the web workspace for the LUMA photography engine.
 *
 * LUMA IS PHOTOGRAPHY: every image starts as YOUR photo (camera capture where
 * the browser allows it, or file import). Looks are non-destructive recipes
 * (preset + intensity + manual offsets) rendered through the same pure color
 * pipeline as the native app. There is no text-to-image here — that is the
 * separate Image surface.
 */

const PREVIEW_MAX = 900;

export default function LumaStudio() {
  const store = useEditorStore();
  const present = store.present();
  const activePreset = store.activePreset();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const objectUrlRef = useRef<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [source, setSource] = useState<SourceAsset | null>(null);
  const [renderMs, setRenderMs] = useState(0);

  useEffect(() => {
    store.registerPresets(BUILT_IN_PRESETS);
    repo.list().then(setProjects).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Never leak the camera or the imported image blob: stop tracks and revoke
  // the object URL when the studio unmounts (navigation away mid-session).
  useEffect(() => {
    // Capture the element at setup (React lint rule): the cleanup must not
    // read a possibly-stale ref.
    const video = videoRef.current;
    return () => {
      const stream = video?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // ---- preview render (derives from source + recipe, never mutates) ----
  const render = useCallback(() => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !source) return;
    const t0 = performance.now();
    const scale = Math.min(1, PREVIEW_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    if (showOriginal) {
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.clearRect(0, 0, w, h);
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    } else {
      getEngine().renderToCanvas(img, w, h, present.recipe, activePreset, canvas);
    }
    setRenderMs(Math.round(performance.now() - t0));
  }, [source, present, activePreset, showOriginal]);

  useEffect(() => {
    render();
  }, [render]);

  // ---- import / capture ----
  async function adoptImage(uri: string, w: number, h: number) {
    const img = await loadImage(uri);
    imgRef.current = img;
    const asset: SourceAsset = { uri, width: w || img.naturalWidth, height: h || img.naturalHeight };
    setSource(asset);
    store.beginSession(asset);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    const uri = URL.createObjectURL(file);
    // One live object URL at a time; the previous one is revoked on replace
    // and the last one on unmount (see the cleanup effect above).
    if (objectUrlRef.current !== null) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = uri;
    e.target.value = ""; // allow re-importing the same file after undo, etc.
    await adoptImage(uri, 0, 0);
  }

  async function startCamera() {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraOn(true);
      }
    } catch (err: any) {
      setCameraError(
        err?.name === "NotAllowedError"
          ? "Camera permission denied — import a photo instead."
          : `Camera unavailable in this browser (${err?.message ?? err?.name ?? "unknown"}) — import a photo instead.`,
      );
      setCameraOn(false);
    }
  }

  function stopCamera() {
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setCameraOn(false);
  }

  async function captureFrame() {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")!.drawImage(v, 0, 0);
    const uri = canvas.toDataURL("image/jpeg", 0.95);
    stopCamera();
    await adoptImage(uri, canvas.width, canvas.height);
  }

  // ---- export (real artifact) ----
  async function exportImage(format: "jpeg" | "png") {
    if (!source) return;
    setBusy("exporting");
    try {
      const result = await getEngine().exportImage(source, present.recipe, activePreset, {
        format,
        quality: 0.92,
        maxDimension: 2400,
      });
      const a = document.createElement("a");
      a.href = result.uri;
      a.download = `luma-${activePreset?.id ?? "original"}-${Date.now()}.${format === "png" ? "png" : "jpg"}`;
      a.click();
    } finally {
      setBusy(null);
    }
  }

  // ---- projects (localStorage-backed; original downscaled + inlined) ----
  async function persistProject() {
    if (!source) return;
    setBusy("saving");
    try {
      // Inline a downscaled copy of the original so the project survives reload
      // (blob: URLs die with the session). Honest trade-off, stated in the UI.
      const img = imgRef.current!;
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const inlineUri = c.toDataURL("image/jpeg", 0.9);
      const now = Date.now();
      await repo.save({
        id: `proj_${now.toString(36)}`,
        name: activePreset ? `${activePreset.name} · ${new Date().toLocaleDateString()}` : `Photo · ${new Date().toLocaleDateString()}`,
        createdAt: now,
        updatedAt: now,
        source: { ...source, uri: inlineUri, width: c.width, height: c.height },
        recipe: present.recipe,
        canvas: present.canvas,
      });
      setProjects(await repo.list());
    } finally {
      setBusy(null);
    }
  }

  async function openProject(p: Project) {
    await adoptImage(p.source.uri, p.source.width, p.source.height);
    store.beginSession(p.source, { recipe: p.recipe, canvas: p.canvas });
  }

  const camera = activePreset ? cameraForPresetId(activePreset.id) : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      {/* ── stage ─────────────────────────────────────────────────────── */}
      <div className="glass rounded-2xl p-4">
        {cameraOn ? (
          <div className="relative overflow-hidden rounded-xl bg-black" style={{ minHeight: 320 }}>
            <video ref={videoRef} playsInline muted className="max-h-[62vh] w-full object-contain" />
            {camera && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: camera.hint.tint, boxShadow: `inset 0 0 120px rgba(0,0,0,${camera.hint.vignette})` }}
              />
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/50 p-3">
              <span className="text-xs font-bold text-amber-200">
                {camera ? `${camera.number} ${camera.name}` : "Viewfinder"}
                {camera?.hint.mono ? " · mono look" : ""}
              </span>
              <div className="flex gap-2">
                <button onClick={stopCamera} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/20">
                  Cancel
                </button>
                <button onClick={captureFrame} className="rounded-lg bg-amber-300 px-4 py-1.5 text-xs font-black text-black hover:bg-amber-200">
                  ⦿ Capture
                </button>
              </div>
            </div>
          </div>
        ) : source ? (
          <div className="relative">
            <canvas ref={canvasRef} className="max-h-[62vh] w-full rounded-xl bg-black object-contain" />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>
                {showOriginal ? "ORIGINAL (unprocessed)" : `${activePreset?.name ?? "Original"} · intensity ${Math.round(present.recipe.presetIntensity * 100)}%`}
                {renderMs > 0 && ` · rendered in ${renderMs}ms`}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 font-bold text-slate-300">
                <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} />
                hold original
              </label>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-amber-300/25 bg-amber-300/[0.03] p-8 text-center">
            <p className="text-4xl">📷</p>
            <p className="text-sm font-extrabold text-white">LUMA starts from YOUR photo</p>
            <p className="max-w-sm text-xs leading-5 text-slate-400">
              Capture with your camera (where the browser allows) or import an image. LUMA is photography —
              non-destructive looks, real export. No text-to-image here.
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <button onClick={startCamera} className="rounded-xl bg-amber-300 px-4 py-2 text-sm font-black text-black hover:bg-amber-200">
                ⦿ Open camera
              </button>
              <button onClick={() => fileRef.current?.click()} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-bold text-white hover:bg-white/10">
                🖼 Import photo
              </button>
            </div>
            {cameraError && <p className="text-xs text-amber-300">{cameraError}</p>}
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />

        {source && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => exportImage("jpeg")} disabled={!!busy} className="rounded-xl bg-amber-300 px-4 py-2 text-xs font-black text-black hover:bg-amber-200 disabled:opacity-40">
              ⬇ Export JPEG
            </button>
            <button onClick={() => exportImage("png")} disabled={!!busy} className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-xs font-bold text-amber-200 hover:bg-amber-300/20 disabled:opacity-40">
              ⬇ Export PNG
            </button>
            <button onClick={persistProject} disabled={!!busy} className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-white hover:bg-white/10 disabled:opacity-40">
              💾 Save project
            </button>
            <button onClick={() => { setSource(null); imgRef.current = null; store.beginSession({ uri: "", width: 0, height: 0 }); }} className="rounded-xl border border-white/10 px-4 py-2 text-xs font-bold text-slate-300 hover:bg-white/10">
              ✕ New photo
            </button>
            {busy && <span className="text-xs text-amber-300">{busy}…</span>}
          </div>
        )}
      </div>

      {/* ── editor rail ───────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-black uppercase tracking-wider text-slate-400">Looks</p>
            <div className="flex gap-1">
              <button onClick={store.undo} disabled={!store.canUndo()} className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-bold text-white hover:bg-white/15 disabled:opacity-30" title="Undo">↩</button>
              <button onClick={store.redo} disabled={!store.canRedo()} className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-bold text-white hover:bg-white/15 disabled:opacity-30" title="Redo">↪</button>
            </div>
          </div>
          {!source && <p className="mt-2 text-xs text-slate-500">Import or capture a photo to start editing.</p>}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={() => store.applyPreset(null)}
              className={`rounded-lg px-2.5 py-2 text-left text-xs font-bold ring-1 ${
                !present.recipe.presetId ? "bg-amber-300/20 text-amber-100 ring-amber-300/40" : "bg-white/[0.03] text-slate-200 ring-white/10 hover:bg-white/[0.07]"
              }`}
            >
              ○ Original
            </button>
            {CAMERAS.map((cam) => {
              const look = getBuiltInPreset(cam.defaultLookId);
              const active = present.recipe.presetId === cam.defaultLookId;
              return (
                <button
                  key={cam.id}
                  disabled={!source}
                  onClick={() => store.applyPreset(cam.defaultLookId)}
                  className={`rounded-lg px-2.5 py-2 text-left text-xs font-bold ring-1 disabled:opacity-30 ${
                    active ? "bg-amber-300/20 text-amber-100 ring-amber-300/40" : "bg-white/[0.03] text-slate-200 ring-white/10 hover:bg-white/[0.07]"
                  }`}
                >
                  <span className="text-slate-500">{cam.number}</span> {cam.name}
                  <span className="block text-[10px] font-normal text-slate-500">{cam.tagline}</span>
                  {look && <span className="block text-[10px] text-slate-600">{look.name}</span>}
                </button>
              );
            })}
          </div>
          {activePreset && (
            <div className="mt-3">
              <p className="mb-1 flex justify-between text-[11px] font-bold text-slate-400">
                <span>Intensity</span>
                <span>{Math.round(present.recipe.presetIntensity * 100)}%</span>
              </p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={present.recipe.presetIntensity}
                disabled={!source}
                onChange={(e) => store.previewPresetIntensity(Number(e.target.value))}
                onPointerUp={store.commitEdit}
                onKeyUp={store.commitEdit}
                className="w-full accent-amber-300"
              />
            </div>
          )}
        </div>

        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-black uppercase tracking-wider text-slate-400">Adjust</p>
            <button onClick={store.resetAdjustments} disabled={!source} className="text-[11px] font-bold text-cyan-300 hover:underline disabled:opacity-30">
              reset
            </button>
          </div>
          <div className="mt-2 space-y-2.5">
            {ADJUSTMENT_KEYS.map((key) => {
              const spec = ADJUSTMENT_SPECS[key];
              const v = present.recipe.adjustments[key];
              return (
                <div key={key}>
                  <p className="flex justify-between text-[11px] font-bold text-slate-400">
                    <span>{spec.label}</span>
                    <span className={v !== 0 ? "text-amber-300" : "text-slate-600"}>{v.toFixed(2)}</span>
                  </p>
                  <input
                    type="range"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={v}
                    disabled={!source}
                    onChange={(e) => store.previewAdjustment(key as keyof Adjustments, Number(e.target.value))}
                    onPointerUp={store.commitEdit}
                    onKeyUp={store.commitEdit}
                    className="w-full accent-violet-400"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="glass rounded-2xl p-4">
          <p className="text-xs font-black uppercase tracking-wider text-slate-400">Projects (this browser)</p>
          {projects.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">
              No saved projects. Saving stores the recipe plus a downscaled copy of the original in this
              browser&apos;s local storage — nothing is uploaded anywhere.
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5">
                  <button onClick={() => openProject(p)} className="min-w-0 flex-1 truncate text-left text-xs font-bold text-white hover:text-amber-200">
                    {p.name}
                  </button>
                  <button
                    onClick={async () => { await repo.remove(p.id); setProjects(await repo.list()); }}
                    className="text-[11px] text-slate-500 hover:text-red-300"
                    title="Delete project"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="px-1 text-[10px] leading-4 text-slate-600">
          LUMA engine: pure color-pipeline math (color matrix + grain/vignette/fade), the same recipes as the
          native app, rendered here via Canvas2D. Edits are non-destructive — the original is never modified.
        </p>
      </div>
    </div>
  );
}
