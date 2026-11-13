type Props = {
  warning: string | null;
  canRetry: boolean;
  onRetry: () => void;
  conflict?: boolean;
  onReload?: () => void;
  onReconcile?: () => void;
};

export function ArcadeSaveWarning({ warning, canRetry, onRetry, conflict = false, onReload, onReconcile }: Props) {
  if (!warning) return null;
  return (
    <div role="alert" data-testid="arcade-save-warning" className="mt-2 rounded-lg border border-amber-400/40 bg-amber-950/40 p-3 text-xs text-amber-100">
      <strong>Progress is not safely saved.</strong>
      <p className="mt-1">{warning}</p>
      {conflict ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onReload} className="rounded border border-amber-300/50 px-3 py-2 font-bold hover:bg-amber-800/40" data-testid="button-reload-latest-progress">
            Reload latest progress
          </button>
          <button type="button" onClick={onReconcile} className="rounded border border-amber-300/50 px-3 py-2 font-bold hover:bg-amber-800/40" data-testid="button-reconcile-tab-progress">
            Keep this tab’s progress
          </button>
        </div>
      ) : canRetry && (
        <button type="button" onClick={onRetry} className="mt-2 rounded border border-amber-300/50 px-3 py-2 font-bold hover:bg-amber-800/40">
          Retry saving live progress
        </button>
      )}
    </div>
  );
}

type LeaveDialogProps = {
  destination: string | null;
  canRetry: boolean;
  onRetry: () => void;
  onStay: () => void;
  onDiscard: () => void;
};

export function UnsavedProgressLeaveDialog({ destination, canRetry, onRetry, onStay, onDiscard }: LeaveDialogProps) {
  if (!destination) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4" data-testid="unsaved-progress-leave-backdrop">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-progress-leave-title"
        className="w-full max-w-md rounded-2xl border border-amber-300/30 bg-slate-950 p-5 shadow-2xl"
        data-testid="unsaved-progress-leave-dialog"
      >
        <h2 id="unsaved-progress-leave-title" className="text-base font-extrabold text-white">Unsaved game progress</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          This game has live progress that is not saved on this device. Retry saving before you {destination}, stay in the game, or discard this live progress. Discarding does not change saved progress for this or other games.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onStay} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10">
            Stay in game
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-lg border border-red-300/30 bg-red-400/10 px-3 py-2 text-xs font-bold text-red-100 hover:bg-red-400/20"
          >
            Discard and {destination}
          </button>
          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-amber-300 px-3 py-2 text-xs font-extrabold text-slate-950 hover:bg-amber-200"
            >
              Retry save and {destination}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
