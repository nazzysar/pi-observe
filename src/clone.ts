/**
 * P0.1 — Snapshot safety.
 *
 * `safeSnapshot` clones values for storage so later mutation of Pi's
 * event objects can never change what was observed. It prefers
 * `structuredClone`, falls back to a JSON round-trip, and on total
 * failure returns a placeholder instead of throwing. Every failure path
 * reports a warning through the optional callback — observation never
 * breaks the Pi lifecycle.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SafeSnapshotResult<T> {
  /** Best-effort clone of the original value. */
  value: T;
  /** False when a fallback or placeholder had to be used. */
  complete: boolean;
}

/**
 * Clone `value` for storage. Never throws. May call `warn` with a
 * human-readable reason when cloning was incomplete or failed.
 */
export function safeSnapshot<T>(value: T, warn?: (message: string) => void): T {
  return safeSnapshotResult(value, warn).value;
}

/** Clone `value` and report whether the clone was complete. Never throws. */
export function safeSnapshotResult<T>(
  value: T,
  warn?: (message: string) => void,
): SafeSnapshotResult<T> {
  if (value === undefined || value === null) {
    return { value, complete: true };
  }
  try {
    return { value: structuredClone(value), complete: true };
  } catch (cloneError) {
    const cloneMessage = errorMessage(cloneError);
    warn?.(`structuredClone failed (${cloneMessage}); falling back to JSON`);
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      warn?.("JSON fallback produced no output; returning placeholder");
      return { value: placeholderFor(value) as T, complete: false };
    }
    return { value: JSON.parse(json) as T, complete: false };
  } catch (jsonError) {
    const jsonMessage = errorMessage(jsonError);
    warn?.(`JSON fallback failed (${jsonMessage}); returning placeholder`);
    return { value: placeholderFor(value) as T, complete: false };
  }
}

function placeholderFor(value: unknown): { $uncloneable: true; type: string } {
  return { $uncloneable: true, type: typeof value };
}
