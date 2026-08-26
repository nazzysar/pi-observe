/**
 * P0.3 — Format helper tests, including the content-block truncation
 * boundary: exactly MAX_BLOCKS summarized blocks must never report
 * "+0 more".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeMessage } from "../src/format.ts";

function summarize(msg: unknown): string {
  // Generous cap so the content-block truncation branch (not the outer
  // 64-char summary truncation) is what the assertions exercise.
  return summarizeMessage(msg, 500);
}

function blocks(count: number): Array<{ type: string; text: string }> {
  return Array.from({ length: count }, (_, i) => ({
    type: "text",
    text: `block ${i}`,
  }));
}

test("summarizeMessage: few blocks list all without a +N more suffix", () => {
  const summary = summarize({ role: "assistant", content: blocks(3) });
  assert.equal(
    summary,
    'assistant: 3 blocks (text "block 0", text "block 1", text "block 2")',
  );
});

test("summarizeMessage: exactly eight blocks shows all, no +0 more", () => {
  const summary = summarize({ role: "assistant", content: blocks(8) });
  assert.ok(summary.startsWith("assistant: 8 blocks ("), summary);
  assert.ok(summary.includes('text "block 7"'), summary);
  assert.ok(!summary.includes("+0 more"), summary);
  assert.ok(!summary.includes("more"), summary);
});

test("summarizeMessage: nine blocks truncates with +1 more", () => {
  const summary = summarize({ role: "assistant", content: blocks(9) });
  assert.ok(summary.startsWith("assistant: 9 blocks ("), summary);
  assert.ok(summary.endsWith("+1 more)"), summary);
  assert.ok(!summary.includes('text "block 8"'), summary);
});

test("summarizeMessage: many blocks truncates with correct remainder", () => {
  const summary = summarize({ role: "assistant", content: blocks(20) });
  assert.ok(summary.startsWith("assistant: 20 blocks ("), summary);
  assert.ok(summary.endsWith("+12 more)"), summary);
});
