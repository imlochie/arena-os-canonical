type Props = {
  warning: string | null;
  canRetry: boolean;
  onRetry: () => void;
};

export function ArcadeSaveWarning({ warning, canRetry, onRetry }: Props) {
  if (!warning) return null;
  return (
    <div role="alert" data-testid="arcade-save-warning" className="mt-2 rounded-lg border border-amber-400/40 bg-amber-950/40 p-3 text-xs text-amber-100">
      <strong>Progress is not safely saved.</strong>
      <p className="mt-1">{warning}</p>
      {canRetry && (
        <button type="button" onClick={onRetry} className="mt-2 rounded border border-amber-300/50 px-3 py-2 font-bold hover:bg-amber-800/40">
          Retry saving live progress
        </button>
      )}
    </div>
  );
}
