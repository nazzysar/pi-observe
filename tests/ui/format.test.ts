/**
 * P0.3 — Formatting helper tests: token/context formatting, timestamps,
 * model-id truncation, message summaries, safe JSON, shape labels,
 * warning display. Every helper must degrade to "?" / inspectable text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ELLIPSIS,
  formatContextUsage,
  formatCount,
  formatThinkingLevel,
  formatTimestamp,
  formatTokens,
  formatWarning,
  providerShapeLabel,
  safePrettyJson,
  summarizeMessage,
  truncateModelId,
  truncateUtf8,
} from "../../src/format.ts";

test("formatTokens renders k/m suffixes and unknown", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(41800), "41.8k");
  assert.equal(formatTokens(128000), "128k");
  assert.equal(formatTokens(1_250_000), "1.3m");
  assert.equal(formatTokens(null), "?");
  assert.equal(formatTokens(undefined), "?");
  assert.equal(formatTokens(Number.NaN), "?");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "?");
});

test("formatContextUsage renders tokens/window with unknown sides", () => {
  assert.equal(
    formatContextUsage({ tokens: 41800, contextWindow: 128000, percent: 32 }),
    "41.8k / 128k",
  );
  assert.equal(
    formatContextUsage({ tokens: null, contextWindow: 128000, percent: null }),
    "? / 128k",
  );
  assert.equal(
    formatContextUsage({ tokens: 100, contextWindow: 0, percent: null }),
    "100 / 0",
  );
  assert.equal(formatContextUsage(undefined), "?");
});

test("formatCount and formatThinkingLevel", () => {
  assert.equal(formatCount(17), "17");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(undefined), "?");
  assert.equal(formatCount(Number.NaN), "?");
  assert.equal(formatThinkingLevel("max"), "max");
  assert.equal(formatThinkingLevel(undefined), "?");
});

test("formatTimestamp renders compact local time and unknown", () => {
  const ms = new Date(2026, 7, 26, 9, 5, 7).getTime();
  assert.equal(formatTimestamp(ms), "2026-08-26 09:05:07");
  assert.equal(formatTimestamp(undefined), "?");
  assert.equal(formatTimestamp(Number.NaN), "?");
});

test("truncateModelId truncates long ids and shows ? for unknown", () => {
  assert.equal(truncateModelId(undefined, 10), "?");
  assert.equal(truncateModelId("", 10), "?");
  const id = "openrouter/deepseek-v4-0123456789";
  assert.equal(truncateModelId(id, 40), id);
  const short = truncateModelId(id, 12);
  assert.equal(short.length, 12);
  assert.ok(short.endsWith(ELLIPSIS));
  assert.ok(short.startsWith("openrouter/"));
  assert.equal(truncateModelId(id, 1), ELLIPSIS);
  assert.equal(truncateModelId(id, 0), "");
});

test("summarizeMessage handles string, blocks, and unknown shapes", () => {
  assert.equal(
    summarizeMessage({ role: "user", content: "fix the build" }),
    "user: fix the build",
  );
  const blocks = summarizeMessage({
    role: "assistant",
    content: [
      { type: "text", text: "sure" },
      { type: "toolCall", name: "read" },
    ],
  });
  assert.ok(blocks.startsWith("assistant: 2 blocks"));
  assert.ok(blocks.includes("text \"sure\""));
  assert.ok(blocks.includes("toolCall read"));
  assert.equal(summarizeMessage({ role: "tool", result: "ok" }).startsWith("tool:"), true);
  assert.equal(summarizeMessage("plain string"), "plain string");
  assert.equal(summarizeMessage(undefined), "?");
  // Long content is truncated with an ellipsis.
  const long = summarizeMessage({ role: "user", content: "x".repeat(200) }, 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith(ELLIPSIS));
});

test("truncateUtf8 keeps code points and appends ellipsis", () => {
  assert.equal(truncateUtf8("hello world", 20), "hello world");
  assert.equal(truncateUtf8("héllo", 4), "hél" + ELLIPSIS);
  assert.equal(truncateUtf8("abc", 1), ELLIPSIS);
});

test("safePrettyJson pretty-prints, falls back to String", () => {
  assert.equal(safePrettyJson({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(safePrettyJson("text"), '"text"');
  assert.equal(safePrettyJson(undefined), "undefined");
  // A circular value must not throw.
  const circular: Record<string, unknown> = { name: "x" };
  circular.self = circular;
  const text = safePrettyJson(circular);
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
});

test("providerShapeLabel and formatWarning", () => {
  assert.equal(providerShapeLabel("openai-like"), "OpenAI-like");
  assert.equal(providerShapeLabel("anthropic-like"), "Anthropic-like");
  assert.equal(providerShapeLabel("google-like"), "Google-like");
  assert.equal(providerShapeLabel("bedrock-like"), "Bedrock-like");
  assert.equal(providerShapeLabel("unknown"), "Unknown");
  assert.equal(providerShapeLabel(undefined), "?");
  assert.equal(
    formatWarning({ code: "missing-logical-context", message: "no pending context", timestamp: 1 }),
    "missing-logical-context: no pending context",
  );
});
