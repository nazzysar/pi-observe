/**
 * P1 — logical message fingerprinting and sequence diffing.
 * Covers prefix/suffix matching, middle hash matching, volatile
 * envelope exclusion from the content hash, and unknown contexts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  diffMessages,
  fingerprintMessage,
} from "../../src/diff/message-diff.ts";

function msg(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, content: text, ...extra };
}

test("diffMessages: both sides undefined → unknown", () => {
  const result = diffMessages(undefined, undefined);
  assert.equal(result.unknown, true);
  assert.equal(result.oldCount, 0);
  assert.equal(result.newCount, 0);
});

test("diffMessages: one side undefined → unknown", () => {
  assert.equal(diffMessages([msg("user", "a")], undefined).unknown, true);
  assert.equal(diffMessages(undefined, [msg("user", "a")]).unknown, true);
});

test("diffMessages: identical sequences", () => {
  const messages = [msg("user", "a"), msg("assistant", "b")];
  const result = diffMessages(messages, messages);
  assert.equal(result.unknown, false);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.changed.length, 0);
  assert.equal(result.commonPrefix, 2);
  assert.equal(result.oldCount, 2);
  assert.equal(result.newCount, 2);
});

test("diffMessages: append-heavy (common prefix)", () => {
  const result = diffMessages([msg("user", "a")], [msg("user", "a"), msg("assistant", "b")]);
  assert.equal(result.commonPrefix, 1);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0]!.index, 1);
  assert.equal(result.added[0]!.summary, "assistant");
  assert.equal(result.removed.length, 0);
  assert.equal(result.changed.length, 0);
});

test("diffMessages: removal in the middle", () => {
  const result = diffMessages(
    [msg("user", "a"), msg("assistant", "b"), msg("toolResult", "c", { toolName: "bash" })],
    [msg("user", "a"), msg("toolResult", "c", { toolName: "bash" })],
  );
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0]!.index, 1);
  assert.equal(result.removed[0]!.summary, "assistant");
  assert.equal(result.added.length, 0);
});

test("diffMessages: changed message at the same position", () => {
  const result = diffMessages(
    [msg("user", "v1"), msg("assistant", "b")],
    [msg("user", "v2"), msg("assistant", "b")],
  );
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0]!.index, 0);
  assert.notEqual(result.changed[0]!.old.hash, result.changed[0]!.new.hash);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

test("diffMessages: reordering is matched by content hash (no add/remove)", () => {
  const result = diffMessages(
    [msg("user", "a"), msg("user", "b"), msg("assistant", "c")],
    [msg("user", "b"), msg("user", "a"), msg("assistant", "c")],
  );
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.changed.length, 0);
  assert.equal(result.commonSuffix, 1);
});

test("volatile envelope fields do not register as changes", () => {
  const old = [
    msg("assistant", "hi", {
      timestamp: 1,
      usage: { tokens: 5 },
      stopReason: "end",
      responseId: "resp-1",
      details: { nested: true },
    }),
  ];
  const next = [
    msg("assistant", "hi", {
      timestamp: 2,
      usage: { tokens: 99 },
      stopReason: "end_turn",
      responseId: "resp-2",
      details: { other: true },
    }),
  ];
  const result = diffMessages(old, next);
  assert.equal(result.changed.length, 0, "envelope-only differences are ignored");
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

test("content core changes do register as changes", () => {
  const result = diffMessages(
    [msg("assistant", "hi", { timestamp: 1 })],
    [msg("assistant", "bye", { timestamp: 1 })],
  );
  assert.equal(result.changed.length, 1);
});

test("non-object (string) messages are diffed by value", () => {
  const result = diffMessages(["old", "keep"], ["new", "keep"]);
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0]!.old.summary, "unknown");
  assert.equal(result.commonSuffix, 1);
});

test("fingerprintMessage: content vs structural hash", () => {
  const old = fingerprintMessage(
    { role: "assistant", content: "hi", timestamp: 1, usage: { tokens: 1 } },
    0,
  );
  const next = fingerprintMessage(
    { role: "assistant", content: "hi", timestamp: 2, usage: { tokens: 2 } },
    0,
  );
  assert.equal(old.contentHash, next.contentHash);
  assert.notEqual(old.structuralHash, next.structuralHash);
  assert.equal(old.role, "assistant");
  assert.equal(old.length, 2);
});

test("fingerprintMessage: toolResult kind and summary label", () => {
  const fp = fingerprintMessage(
    { role: "toolResult", content: "out", toolName: "bash", toolCallId: "t1" },
    0,
  );
  assert.equal(fp.kind, "bash");
  assert.equal(fp.summary, "toolResult:bash");
  assert.equal(fp.toolCallId, "t1");
});

test("fingerprintMessage: custom role label and non-record fallback", () => {
  assert.equal(fingerprintMessage({ role: "system2", content: "x" }, 0).summary, "custom:system2");
  assert.equal(fingerprintMessage("plain", 0).summary, "unknown");
});
