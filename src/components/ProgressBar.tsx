/** Determinate when a fraction is known. Otherwise a static partial track, never a looping animation. */
export function ProgressBar({ value }: { value: number | null }) {
  const known = value !== null && Number.isFinite(value);
  const percent = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      data-indeterminate={!known || undefined}
    >
      <div className="progress-fill" style={{ width: known ? `${percent}%` : undefined }} />
    </div>
  );
}
