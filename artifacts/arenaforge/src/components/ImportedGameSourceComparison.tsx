import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { compareImportedGameSource } from "../lib/importedGameSourceComparison";

function ComparisonBody({ previous, current }: { previous: string; current: string }) {
  const comparison = useMemo(() => compareImportedGameSource(previous, current), [previous, current]);
  return (
    <>
      <p className="text-xs text-slate-300" data-testid="imported-source-comparison-summary">
        {comparison.identical ? "No source changes." : comparison.displayIdentical
          ? "Source bytes differ, but displayed text is unchanged (for example, line endings)."
          : `Displayed changes: +${comparison.added} added / −${comparison.removed} removed lines.`}
      </p>
      {comparison.embeddedAssets > 0 && <p className="text-xs text-slate-400">Embedded base64 data is replaced with local labels. Identical data shares a label; changed data has a different label. Original files are untouched.</p>}
      {(comparison.truncated || comparison.coarse) && (
        <p className="rounded-lg border border-amber-300/25 bg-amber-300/10 p-2 text-xs text-amber-100" role="status">
          {comparison.truncated && "Large source: this is a limited excerpt, not a complete comparison. "}
          {comparison.coarse && "Large edit: removed and added blocks are shown rather than a minimal line diff. "}
          Play the revised game before deciding whether to keep it.
        </p>
      )}
      {!comparison.identical && !comparison.displayIdentical && (
        <div className="max-h-[48dvh] overflow-auto rounded-lg border border-white/10 bg-black/40 font-mono text-[11px]" role="region" aria-label="Source changes" tabIndex={0}>
          <div className="sticky top-0 flex gap-3 border-b border-white/10 bg-slate-900 p-2 text-slate-300"><span>Before / After</span><span>− Removed · + Added · Unmarked = unchanged</span></div>
          {comparison.rows.map((row, index) => (
            <div key={index} data-change={row.kind} className={`flex items-start gap-2 px-2 py-0.5 ${row.kind === "added" ? "bg-emerald-500/15 text-emerald-100" : row.kind === "removed" ? "bg-rose-500/15 text-rose-100" : row.kind === "gap" ? "bg-slate-800/60 text-slate-400" : "text-slate-300"}`}>
              <span className="w-16 shrink-0 select-none text-right text-slate-400">{row.beforeLine ?? "·"} / {row.afterLine ?? "·"}</span>
              <span className="w-3 shrink-0" aria-label={row.kind}>{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : row.kind === "gap" ? "…" : " "}</span>
              <code className="min-w-0 whitespace-pre-wrap break-all">{row.text || " "}</code>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function ImportedGameSourceComparison({ previous, current, onBackToGame }: {
  previous: string;
  current: string;
  onBackToGame: () => void;
}) {
  const [open, setOpen] = useState(false);
  const focusGame = useRef(false);
  useEffect(() => setOpen(false), [previous, current]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="min-h-11 rounded-lg border border-sky-300/25 px-3 py-2 text-[11px] font-bold text-sky-100 hover:bg-sky-300/10" data-testid="button-compare-imported-source">
          What changed?
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-4xl overflow-y-auto border-white/15 bg-slate-950 text-slate-100" data-testid="imported-source-comparison" onCloseAutoFocus={event => {
        if (focusGame.current) { event.preventDefault(); focusGame.current = false; onBackToGame(); }
      }}>
        <DialogHeader>
          <DialogTitle>What changed in the source?</DialogTitle>
          <DialogDescription>Before is the previous source; After is the currently playable source. This comparison stays on this device. No model or server request is made.</DialogDescription>
        </DialogHeader>
        {open && <ComparisonBody previous={previous} current={current} />}
        <DialogFooter className="items-center gap-3">
          <p className="text-xs text-slate-400">Return to the game to keep or undo a pending revision.</p>
          <button type="button" className="min-h-11 rounded-lg bg-sky-300 px-4 py-2 text-sm font-bold text-slate-950" onClick={() => { focusGame.current = true; setOpen(false); }}>Back to game</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
