/**
 * P1 — Structural changed-path detection for JSON-ish values.
 *
 * Fallback/debug view behind the semantic diffs: walks two snapshots
 * in lockstep and reports the paths where they diverge, e.g.
 *
 *   $.model
 *   $.temperature
 *   $.reasoning.effort
 *   $.tools[4].parameters.properties.path
 *
 * Bounded by design: a path cap (maxPaths), a node budget (maxNodes) and
 * a depth cap (maxDepth) keep the walk cheap; hitting any bound sets
 * `truncated`. A `skipSubtree` predicate lets callers elide subtrees the
 * semantic diffs already explain (e.g. provider message arrays). The
 * walk is iterative — no recursion-depth surprises — and never mutates
 * its inputs.
 */

import { hashValue } from "../hash.ts";

export interface StructuralDiffSummary {
  equal: boolean;
  oldHash: string;
  newHash: string;
  changedPaths: string[];
  truncated: boolean;
}

export interface StructuralDiffOptions {
  /** Max reported paths before truncation. Default 50. */
  maxPaths?: number;
  /** Max nesting depth before a subtree is reported without descending. Default 64. */
  maxDepth?: number;
  /** Max visited node pairs; bounds work on huge payloads. Default 100_000. */
  maxNodes?: number;
  /**
   * When it returns true for a path whose values differ, that path is
   * reported once and the walker does not descend into it.
   */
  skipSubtree?: (segments: string[]) => boolean;
}

interface PairFrame {
  a: unknown;
  b: unknown;
  segments: string[];
  depth: number;
}

const DEFAULT_MAX_PATHS = 50;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;

/** Structural changed-path diff of two observed values. Never throws. */
export function structuralDiff(
  oldValue: unknown,
  newValue: unknown,
  options: StructuralDiffOptions = {},
): StructuralDiffSummary {
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const oldHash = hashValue(oldValue);
  const newHash = hashValue(newValue);
  const summary: StructuralDiffSummary = {
    equal: oldHash === newHash,
    oldHash,
    newHash,
    changedPaths: [],
    truncated: false,
  };
  if (summary.equal) return summary;

  try {
    walk(oldValue, newValue, summary, options, maxPaths, maxDepth, maxNodes);
  } catch {
    summary.truncated = true;
  }
  return summary;
}

function walk(
  oldValue: unknown,
  newValue: unknown,
  summary: StructuralDiffSummary,
  options: StructuralDiffOptions,
  maxPaths: number,
  maxDepth: number,
  maxNodes: number,
): void {
  const stack: PairFrame[] = [
    { a: oldValue, b: newValue, segments: [], depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    if (summary.changedPaths.length >= maxPaths || nodes >= maxNodes) {
      summary.truncated = true;
      return;
    }
    const frame = stack.pop()!;
    nodes++;
    const { a, b, segments, depth } = frame;

    if (a === b) continue; // strict-equality fast path
    if (options.skipSubtree?.(segments)) {
      summary.changedPaths.push(renderPath(segments));
      continue;
    }
    if (depth >= maxDepth) {
      summary.changedPaths.push(renderPath(segments));
      summary.truncated = true;
      continue;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const shared = Math.min(a.length, b.length);
      // Extra elements (appended/removed). Pushed first so they pop after
      // the shared-index frames, keeping paths in document order.
      for (let i = a.length - 1; i >= b.length; i--) {
        pushPath(summary, [...segments, `[${i}]`], maxPaths);
      }
      for (let i = b.length - 1; i >= a.length; i--) {
        pushPath(summary, [...segments, `[${i}]`], maxPaths);
      }
      // Shared indices, reversed so they pop in ascending order.
      for (let i = shared - 1; i >= 0; i--) {
        stack.push({
          a: a[i],
          b: b[i],
          segments: [...segments, `[${i}]`],
          depth: depth + 1,
        });
      }
      continue;
    }

    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = unionKeysSorted(a, b);
      for (let k = keys.length - 1; k >= 0; k--) {
        const key = keys[k]!;
        const inA = Object.prototype.hasOwnProperty.call(a, key);
        const inB = Object.prototype.hasOwnProperty.call(b, key);
        if (inA && inB) {
          stack.push({
            a: a[key],
            b: b[key],
            segments: [...segments, key],
            depth: depth + 1,
          });
        } else {
          // Added or removed key: report the child path directly.
          pushPath(summary, [...segments, key], maxPaths);
        }
      }
      continue;
    }

    // Primitives, type mismatches, or unsupported shapes.
    summary.changedPaths.push(renderPath(segments));
  }
}

function pushPath(
  summary: StructuralDiffSummary,
  segments: string[],
  maxPaths: number,
): void {
  if (summary.changedPaths.length >= maxPaths) {
    summary.truncated = true;
    return;
  }
  summary.changedPaths.push(renderPath(segments));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unionKeysSorted(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].sort();
}

/** Render path segments as "$.messages[4].content". */
export function renderPath(segments: string[]): string {
  let out = "$";
  for (const segment of segments) {
    if (segment.startsWith("[")) out += segment;
    else out += `.${segment}`;
  }
  return out;
}
