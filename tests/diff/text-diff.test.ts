/**
 * P1 — text diffing: hash-based summaries and line-level diffs.
 * Includes the line-ending-only regression: raw texts that differ only
 * in CRLF/CR vs LF must be detected as lineEndingOnly instead of a
 * fully-"same" line diff.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, textDiffSummary } from "../../src/diff/text-diff.ts";

test("textDiffSummary: equal texts", () => {
  const summary = textDiffSummary("abc", "abc");
  assert.equal(summary.equal, true);
  assert.equal(summary.oldHash, summary.newHash);
  assert.equal(summary.oldLength, 3);
  assert.equal(summary.newLength, 3);
});

test("textDiffSummary: changed texts", () => {
  const summary = textDiffSummary("abc", "abd");
  assert.equal(summary.equal, false);
  assert.notEqual(summary.oldHash, summary.newHash);
});

test("textDiffSummary: undefined is treated as empty string", () => {
  assert.equal(textDiffSummary(undefined, undefined).equal, true);
  assert.equal(textDiffSummary(undefined, "").equal, true);
  assert.equal(textDiffSummary("x", undefined).equal, false);
});

test("diffLines: identical texts are all same lines", () => {
  const result = diffLines("a\nb\nc", "a\nb\nc");
  assert.equal(result.lineEndingOnly, false);
  assert.deepEqual(result.lines, [
    { type: "same", text: "a" },
    { type: "same", text: "b" },
    { type: "same", text: "c" },
  ]);
});

test("diffLines: added and removed lines in the middle", () => {
  const result = diffLines("one\ntwo\nthree", "one\ntwo\ndiff\nthree");
  assert.equal(result.lineEndingOnly, false);
  assert.deepEqual(result.lines, [
    { type: "same", text: "one" },
    { type: "same", text: "two" },
    { type: "added", text: "diff" },
    { type: "same", text: "three" },
  ]);
});

test("diffLines: replacement in the middle (removed + added)", () => {
  const result = diffLines("one\ntwo\nthree", "one\nTWO\nthree");
  assert.deepEqual(result.lines, [
    { type: "same", text: "one" },
    { type: "removed", text: "two" },
    { type: "added", text: "TWO" },
    { type: "same", text: "three" },
  ]);
});

test("diffLines: prefix and suffix trimming", () => {
  const oldText = "h\n1\n2\n3\nf";
  const newText = "h\n1\n9\n3\nf";
  const result = diffLines(oldText, newText);
  assert.deepEqual(result.lines, [
    { type: "same", text: "h" },
    { type: "same", text: "1" },
    { type: "removed", text: "2" },
    { type: "added", text: "9" },
    { type: "same", text: "3" },
    { type: "same", text: "f" },
  ]);
});

test("diffLines: one side empty", () => {
  assert.deepEqual(diffLines("a", "").lines, [{ type: "removed", text: "a" }]);
  assert.deepEqual(diffLines("", "a").lines, [{ type: "added", text: "a" }]);
  assert.deepEqual(diffLines("", "").lines, []);
  // A trailing newline is a real line difference.
  assert.deepEqual(diffLines("a\n", "a").lines, [
    { type: "same", text: "a" },
    { type: "removed", text: "" },
  ]);
});

test("diffLines: multi-line LCS middle keeps shared middle lines", () => {
  // "keep2" appears in both middles and must be recognized as same.
  const oldText = "p\nx\nkeep2\ny\ns";
  const newText = "p\nq\nkeep2\nz\ns";
  const result = diffLines(oldText, newText);
  assert.equal(result.lines.find((l) => l.text === "keep2")!.type, "same");
});

test("lineEndingOnly: CRLF vs LF with identical content", () => {
  const result = diffLines("a\r\nb\r\nc\r\n", "a\nb\nc\n");
  assert.equal(result.lineEndingOnly, true);
  assert.deepEqual(result.lines, []);
});

test("lineEndingOnly: CR-only endings", () => {
  const result = diffLines("a\rb\rc", "a\nb\nc");
  assert.equal(result.lineEndingOnly, true);
  assert.deepEqual(result.lines, []);
});

test("lineEndingOnly: mixed endings in one text", () => {
  const result = diffLines("a\r\nb\rc", "a\nb\nc");
  assert.equal(result.lineEndingOnly, true);
});

test("identical raw texts are not lineEndingOnly even if normalized", () => {
  const result = diffLines("a\nb", "a\nb");
  assert.equal(result.lineEndingOnly, false);
});

test("content change plus line-ending change is a real diff", () => {
  const result = diffLines("a\r\nb", "a\nB\n");
  assert.equal(result.lineEndingOnly, false);
  assert.ok(result.lines.length > 0);
  assert.ok(result.lines.some((l) => l.type === "removed" && l.text === "b"));
  assert.ok(result.lines.some((l) => l.type === "added" && l.text === "B"));
});

test("line-ending-only change is not hidden by hash-equal raw texts", () => {
  // The confusing case from the review: raw hashes differ, normalized
  // content identical — must not render as a fully-"same" diff.
  const old = "line1\r\nline2\r\n";
  const next = "line1\nline2\n";
  const summary = textDiffSummary(old, next);
  assert.equal(summary.equal, false, "raw hashes differ");
  const result = diffLines(old, next);
  assert.equal(result.lineEndingOnly, true, "detected as line-ending-only");
  assert.equal(result.lines.length, 0);
});

test("large middle (> 200 lines) degrades to block replace", () => {
  const oldMiddle = Array.from({ length: 250 }, (_, i) => `o${i}`).join("\n");
  const newMiddle = Array.from({ length: 250 }, (_, i) => `n${i}`).join("\n");
  const result = diffLines(`head\n${oldMiddle}\ntail`, `head\n${newMiddle}\ntail`);
  const types = result.lines.map((l) => l.type);
  // No LCS: all old middle lines removed, then all new middle lines added.
  assert.equal(types.filter((t) => t === "removed").length, 250);
  assert.equal(types.filter((t) => t === "added").length, 250);
  assert.equal(types.filter((t) => t === "same").length, 2); // head + tail
});
