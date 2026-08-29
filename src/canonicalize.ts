/**
 * P1 — Deterministic JSON canonicalization for local identity and diffing.
 *
 * Produces a stable string representation of an arbitrary observed value:
 * - object keys are sorted (UTF-16 code-unit order)
 * - array order is preserved (order is significant)
 * - primitives are preserved; `undefined`, functions, symbols, bigints,
 *   Dates, RegExps, Errors, and typed arrays get stable, `~`-tagged
 *   placeholders that cannot collide with JSON strings; Maps and Sets
 *   render as their ordered entries
 * - cycles are detected and cut with a `~circular` marker (objects and
 *   arrays are tracked as themselves; Map/Set containers are tracked in
 *   addition to their wrapper arrays, so self-referential Maps/Sets
 *   terminate instead of looping forever)
 * - the input is never mutated (read-only walk)
 *
 * The output exists only for local comparison (hashing, diffing); it is
 * never displayed verbatim or re-parsed. Same input always yields the
 * same string — required so equal snapshots hash identically.
 *
 * Implemented with an explicit work stack instead of recursion so very
 * deep payloads (the sanitizer's depth-3000 test shape) cannot overflow
 * the call stack.
 */

type Frame =
  | { kind: "emit"; text: string }
  | { kind: "value"; value: unknown }
  | { kind: "object"; entries: [string, unknown][]; index: number; source: object }
  | { kind: "array"; items: unknown[]; index: number; source: object; closers?: object[] };

export function canonicalize(value: unknown): string {
  const out: string[] = [];
  const inProgress = new Set<object>();
  const stack: Frame[] = [{ kind: "value", value }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    switch (frame.kind) {
      case "emit":
        out.push(frame.text);
        break;
      case "value":
        emitValue(frame.value, stack, inProgress);
        break;
      case "object":
        advanceObject(frame, stack, inProgress);
        break;
      case "array":
        advanceArray(frame, stack, inProgress);
        break;
    }
  }
  return out.join("");
}

function emitValue(value: unknown, stack: Frame[], inProgress: Set<object>): void {
  if (value === null) {
    stack.push({ kind: "emit", text: "null" });
    return;
  }
  switch (typeof value) {
    case "string":
      stack.push({ kind: "emit", text: JSON.stringify(value) });
      return;
    case "number":
      stack.push({
        kind: "emit",
        text: Number.isFinite(value) ? String(value) : `~num:${String(value)}`,
      });
      return;
    case "boolean":
      stack.push({ kind: "emit", text: value ? "true" : "false" });
      return;
    case "undefined":
      stack.push({ kind: "emit", text: "~undefined" });
      return;
    case "bigint":
      stack.push({ kind: "emit", text: `~bigint:${value}` });
      return;
    case "symbol":
      stack.push({ kind: "emit", text: `~symbol:${String(value)}` });
      return;
    case "function":
      stack.push({ kind: "emit", text: `~function:${value.name}` });
      return;
    case "object":
      break;
    default:
      // New exotic primitives fall back to their string form.
      stack.push({ kind: "emit", text: `~${String(value)}` });
      return;
  }

  // Object-ish values from here on.
  if (inProgress.has(value as object)) {
    stack.push({ kind: "emit", text: "~circular" });
    return;
  }
  if (value instanceof Date) {
    stack.push({
      kind: "emit",
      text: Number.isNaN(value.getTime()) ? "~date:invalid" : `~date:${value.toISOString()}`,
    });
    return;
  }
  if (value instanceof RegExp) {
    stack.push({ kind: "emit", text: `~re:${value.source}~${value.flags}` });
    return;
  }
  if (value instanceof Error) {
    stack.push({ kind: "emit", text: `~error:${value.name}:${value.message}` });
    return;
  }
  if (value instanceof Map) {
    const items: unknown[] = [];
    for (const [k, v] of value.entries()) items.push([k, v]);
    // Track the Map itself, not just the wrapper array: a self-
    // referential Map would otherwise loop forever.
    inProgress.add(value as object);
    openArray(items, stack, inProgress, [value as object]);
    return;
  }
  if (value instanceof Set) {
    inProgress.add(value as object);
    openArray([...value], stack, inProgress, [value as object]);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    openArray(Array.from(value as unknown as Iterable<unknown>), stack, inProgress);
    return;
  }
  if (Array.isArray(value)) {
    openArray(value, stack, inProgress);
    return;
  }
  // Plain object (or class instance): sorted own enumerable keys.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries: [string, unknown][] = keys.map((key) => [key, record[key]]);
  inProgress.add(value as object);
  stack.push({ kind: "object", entries, index: 0, source: value as object });
  stack.push({ kind: "emit", text: "{" });
}

function openArray(
  items: unknown[],
  stack: Frame[],
  inProgress: Set<object>,
  closers?: object[],
): void {
  const source: object = items;
  inProgress.add(source);
  stack.push({ kind: "array", items, index: 0, source, closers });
  stack.push({ kind: "emit", text: "[" });
}

function advanceArray(
  frame: Extract<Frame, { kind: "array" }>,
  stack: Frame[],
  inProgress: Set<object>,
): void {
  const { items, source, closers } = frame;
  if (frame.index >= items.length) {
    inProgress.delete(source);
    for (const closer of closers ?? []) inProgress.delete(closer);
    stack.push({ kind: "emit", text: "]" });
    return;
  }
  // Pop order must be: separator (index > 0), element, continuation.
  // (Pushed in reverse; the continuation frame keeps `closers`.)
  stack.push({ kind: "array", items, index: frame.index + 1, source, closers });
  stack.push({ kind: "value", value: items[frame.index] });
  if (frame.index > 0) stack.push({ kind: "emit", text: "," });
}

function advanceObject(
  frame: Extract<Frame, { kind: "object" }>,
  stack: Frame[],
  inProgress: Set<object>,
): void {
  const { entries, source } = frame;
  if (frame.index >= entries.length) {
    inProgress.delete(source);
    stack.push({ kind: "emit", text: "}" });
    return;
  }
  const [key, value] = entries[frame.index]!;
  // Pop order must be: separator (index > 0), key, value, continuation.
  // (Pushed in reverse.)
  stack.push({ kind: "object", entries, index: frame.index + 1, source });
  stack.push({ kind: "value", value });
  stack.push({ kind: "emit", text: JSON.stringify(key) + ":" });
  if (frame.index > 0) stack.push({ kind: "emit", text: "," });
}
