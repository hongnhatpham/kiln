// Typed engine errors. Messages are written for people; `code` is for the host and UI.
// The worker forwards `name` and `message`, so cancellations use the conventional `AbortError` name.
export type KilnErrorCode =
  | "cancelled"
  | "not-found"
  | "unsupported-format"
  | "blender-missing"
  | "blender-invalid"
  | "conversion-failed"
  | "unsafe-path"
  | "invalid-options"
  | "unknown-asset"
  | "source-changed"
  | "texture-failed"
  | "read-failed";

export class KilnError extends Error {
  readonly code: KilnErrorCode;
  constructor(code: KilnErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = code === "cancelled" ? "AbortError" : "KilnError";
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new KilnError("cancelled", "Cancelled.");
}

export const isKilnError = (value: unknown, code?: KilnErrorCode): value is KilnError =>
  value instanceof KilnError && (code === undefined || value.code === code);
