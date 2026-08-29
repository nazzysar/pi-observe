/**
 * P1 — Text diffing for system prompts and other large strings.
 *
 * Two levels, per the P1 design:
 * - `textDiffSummary`: cheap hash + length comparison, computed eagerly
 *   as part of a RequestDiff. Unchanged prompts are recognized by hash.
 * - `diffLines`: readable line-level diff, generated lazily when the
 *   user actually opens the SYSTEM diff view. Never part of capture.
 *
 * Line endings (CRLF/CR) are normalized to LF for comparison so a
 * line-ending-only change is detected and reported explicitly instead
 * of flooding the line diff. Pure functions; inputs are never mutated.
 */

import { hashText } from "../hash.ts";

export interface TextDiffSummary {
  equal: boolean;
  oldHash: string;
  newHash: string;
  oldLength: number;
  newLength: number;
}

export type LineDiffType = "same" | "added" | "removed";

export interface LineDiff {
  type: LineDiffType;
  text: string;
}

export interface LineDiffResult {
  lines: LineDiff[];
  /** Line-ending-only change: hashes differ but normalized lines match. */
  lineEndingOnly: boolean;
}

/** Hash-based summary of two texts; undefined is treated as absent (""). */
export function textDiffSummary(
  oldText: string | undefined,
  newText: string | undefined,
): TextDiffSummary {
  const old = oldText ?? "";
  const next = newText ?? "";
  const oldHash = hashText(old);
  const newHash = hashText(next);
  return {
    equal: oldHash === newHash,
    oldHash,
    newHash,
    oldLength: old.length,
    newLength: next.length,
  };
}

/** LCS middle-region cap: beyond this, fall back to whole-block replace. */
const MAX_LCS_LINES = 200;

/**
 * Line-level diff of two texts. Common prefix/suffix is trimmed first,
 * and an LCS runs only on the (bounded) middle region; larger middles
 * degrade to a removed-block + added-block representation.
 */
export function diffLines(oldText: string, newText: string): LineDiffResult {
  const oldNormalized = normalizeLineEndings(oldText);
  const newNormalized = normalizeLineEndings(newText);

  // Raw texts differ but only in line endings (e.g. CRLF → LF): the
  // normalized strings — and therefore the normalized line arrays — are
  // equal, so report without line markers instead of a diff whose lines
  // are all "same". (The gate must compare the raw texts: comparing the
  // normalized strings can never detect this case, because split is
  // bijective.)
  if (oldText !== newText && oldNormalized === newNormalized) {
    return { lines: [], lineEndingOnly: true };
  }

  // The empty string is zero lines (not one empty line), so "a" vs ""
  // diffs as a removal instead of a removal + phantom empty addition.
  const oldLines = oldNormalized === "" ? [] : oldNormalized.split("\n");
  const newLines = newNormalized === "" ? [] : newNormalized.split("\n");

  // Common prefix.
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  // Common suffix (not crossing the prefix).
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  const out: LineDiff[] = [];
  for (let i = 0; i < prefix; i++) out.push({ type: "same", text: oldLines[i]! });
  appendMiddle(oldMiddle, newMiddle, out);
  for (let i = 0; i < suffix; i++) {
    out.push({ type: "same", text: oldLines[oldLines.length - suffix + i]! });
  }
  return { lines: out, lineEndingOnly: false };
}

function appendMiddle(
  oldMiddle: string[],
  newMiddle: string[],
  out: LineDiff[],
): void {
  if (
    oldMiddle.length <= MAX_LCS_LINES &&
    newMiddle.length <= MAX_LCS_LINES
  ) {
    appendLcsMiddle(oldMiddle, newMiddle, out);
    return;
  }
  for (const text of oldMiddle) out.push({ type: "removed", text });
  for (const text of newMiddle) out.push({ type: "added", text });
}

/**
 * LCS-based middle diff. Standard O(n·m) DP over the (already trimmed
 * and capped) middle regions, emitting removed/added runs in order.
 */
function appendLcsMiddle(
  oldMiddle: string[],
  newMiddle: string[],
  out: LineDiff[],
): void {
  const n = oldMiddle.length;
  const m = newMiddle.length;
  // lcs[i][j] = length of LCS of oldMiddle[i..] and newMiddle[j..]
  const table: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) table[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        oldMiddle[i] === newMiddle[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMiddle[i] === newMiddle[j]) {
      out.push({ type: "same", text: oldMiddle[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push({ type: "removed", text: oldMiddle[i]! });
      i++;
    } else {
      out.push({ type: "added", text: newMiddle[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "removed", text: oldMiddle[i++]! });
  while (j < m) out.push({ type: "added", text: newMiddle[j++]! });
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
