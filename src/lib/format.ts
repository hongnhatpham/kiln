const KB = 1024;

/** Human file size using binary units, labelled the way people expect (MB, GB). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / KB;
  let unit = 0;
  while (value >= KB && unit < units.length - 1) {
    value /= KB;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

/** Signed change from `before` to `after`, phrased as "62% smaller" or "8% larger". */
export function formatChange(
  before: number,
  after: number,
): { text: string; tone: "smaller" | "larger" | "same" } {
  if (before <= 0) return { text: "", tone: "same" };
  const ratio = (after - before) / before;
  if (Math.abs(ratio) < 0.005) return { text: "No change", tone: "same" };
  const percent = Math.round(Math.abs(ratio) * 100);
  return ratio < 0
    ? { text: `${percent < 1 ? "<1" : percent}% smaller`, tone: "smaller" }
    : { text: `${percent}% larger`, tone: "larger" };
}

/** "8K" for 8192, "2K" for 2048, otherwise the raw pixel count. */
export function formatPixels(size: number): string {
  if (size >= 1024 && size % 1024 === 0) return `${size / 1024}K`;
  return `${size}px`;
}

export function formatDimensions([x, y, z]: [number, number, number]): string {
  const max = Math.max(x, y, z);
  // glTF units are meters. Pick the unit that keeps numbers readable.
  const [scale, unit] = max < 1 ? [100, "cm"] : [1, "m"];
  const fmt = (v: number) => (v * scale).toFixed(v * scale >= 100 ? 0 : 1);
  return `${fmt(x)} × ${fmt(y)} × ${fmt(z)} ${unit}`;
}

/** Electron wraps IPC errors as "Error invoking remote method 'x': Error: message". Keep the message. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "").trim() ||
    "Something went wrong."
  );
}
