import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateRequestId,
  allocateRunId,
  assembleRequestRecord,
  buildContextUsageSnapshot,
  buildModelIdentity,
  buildPendingContext,
  buildPromptSnapshot,
  missingContextWarning,
} from "../src/correlation.ts";
import { REDACTED, sanitizeProviderPayload } from "../src/sanitize.ts";

test("run/request ids are monotonic and unique", () => {
  const a = [allocateRunId(1), allocateRunId(2), allocateRunId(3)];
  assert.deepEqual(a, ["run-1", "run-2", "run-3"]);
  const b = [allocateRequestId(1), allocateRequestId(2)];
  assert.deepEqual(b, ["req-1", "req-2"]);
  assert.notDeepEqual(a, b);
});

test("buildModelIdentity extracts structural fields", () => {
  const identity = buildModelIdentity({
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 64000,
  });
  assert.deepEqual(identity, {
    id: "claude-sonnet-4-5",
    name: "Sonnet",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 64000,
  });
});

test("buildModelIdentity is tolerant of junk and undefined", () => {
  assert.equal(buildModelIdentity(undefined), undefined);
  assert.equal(buildModelIdentity(null), undefined);
  assert.equal(buildModelIdentity({ id: "x" }), undefined); // no provider
  assert.equal(buildModelIdentity({ id: 5, provider: "p" }), undefined); // wrong types
  const identity = buildModelIdentity({ id: "m", provider: "p" });
  assert.equal(identity?.name, "m"); // name falls back to id
  assert.equal(identity?.api, "unknown");
  assert.equal(identity?.reasoning, false);
  assert.equal(identity?.contextWindow, 0);
});

test("buildContextUsageSnapshot maps Pi usage", () => {
  assert.equal(buildContextUsageSnapshot(undefined), undefined);
  assert.equal(buildContextUsageSnapshot(null), undefined);
  assert.deepEqual(buildContextUsageSnapshot({ contextWindow: 1 }), {
    tokens: null,
    contextWindow: 1,
    percent: null,
  });
  assert.deepEqual(buildContextUsageSnapshot({ tokens: 10, contextWindow: 100, percent: 10 }), {
    tokens: 10,
    contextWindow: 100,
    percent: 10,
  });
  assert.deepEqual(buildContextUsageSnapshot({ tokens: null, contextWindow: 100, percent: null }), {
    tokens: null,
    contextWindow: 100,
    percent: null,
  });
});

test("buildPromptSnapshot captures prompt + model + thinking", () => {
  const model = { id: "m1", provider: "p1" };
  const snapshot = buildPromptSnapshot({
    systemPrompt: "You are...",
    systemPromptOptions: { cwd: "/tmp", selectedTools: ["read"] },
    model,
    thinkingLevel: "medium",
    timestamp: 42,
  });
  assert.equal(snapshot.systemPrompt, "You are...");
  assert.deepEqual(snapshot.systemPromptOptions, { cwd: "/tmp", selectedTools: ["read"] });
  assert.equal(snapshot.model?.id, "m1");
  assert.equal(snapshot.thinkingLevel, "medium");
  assert.equal(snapshot.timestamp, 42);
});

test("buildPendingContext associates run/turn and usage", () => {
  const pending = buildPendingContext({
    messages: [{ role: "user", content: "hi" }],
    contextUsage: { tokens: 5, contextWindow: 100, percent: 5 },
    runId: "run-1",
    turnIndex: 2,
    timestamp: 7,
  });
  assert.equal(pending.runId, "run-1");
  assert.equal(pending.turnIndex, 2);
  assert.equal(pending.timestamp, 7);
  assert.equal(pending.contextUsage?.tokens, 5);
  assert.deepEqual(pending.messages, [{ role: "user", content: "hi" }]);
});

test("assembleRequestRecord is the canonical shape", () => {
  const record = assembleRequestRecord({
    requestId: "req-1",
    requestSeq: 1,
    runId: "run-1",
    turnIndex: 0,
    timestamp: 10,
    model: { id: "m", provider: "p" },
    thinkingLevel: "high",
    prompt: undefined,
    logicalContext: [{ role: "user", content: "hi" }],
    sanitizedProviderPayload: { messages: [] },
    providerEnvelope: undefined,
    providerTools: undefined,
    contextUsage: { tokens: 3, contextWindow: 100, percent: 3 },
    warnings: [],
  });
  assert.equal(record.requestId, "req-1");
  assert.equal(record.requestSeq, 1);
  assert.equal(record.runId, "run-1");
  assert.equal(record.turnIndex, 0);
  assert.equal(record.timestamp, 10);
  assert.equal(record.model?.id, "m");
  assert.equal(record.thinkingLevel, "high");
  assert.equal((record.logicalContext?.[0] as { role: string } | undefined)?.role, "user");
  assert.equal(
    (record.sanitizedProviderPayload as { messages: unknown[] }).messages.length,
    0,
  );
  assert.equal(record.providerEnvelope, undefined);
  assert.equal(record.contextUsage?.tokens, 3);
  assert.deepEqual(record.warnings, []);
});

test("assembleRequestRecord stores sanitized payload verbatim", () => {
  const sanitized = sanitizeProviderPayload({
    apiKey: "sk-123",
    messages: [{ text: "keep token" }],
  });
  const record = assembleRequestRecord({
    requestId: "req-1",
    requestSeq: 1,
    runId: undefined,
    turnIndex: undefined,
    timestamp: 10,
    model: undefined,
    thinkingLevel: undefined,
    prompt: undefined,
    logicalContext: undefined,
    sanitizedProviderPayload: sanitized,
    providerEnvelope: undefined,
    providerTools: undefined,
    contextUsage: undefined,
    warnings: [],
  });
  assert.equal(
    (record.sanitizedProviderPayload as Record<string, unknown>).apiKey,
    REDACTED,
  );
  assert.deepEqual(
    (record.sanitizedProviderPayload as Record<string, unknown>).messages,
    [{ text: "keep token" }],
  );
});

test("missingContextWarning has the right code", () => {
  const w = missingContextWarning(5);
  assert.equal(w.code, "missing-logical-context");
  assert.equal(w.timestamp, 5);
});
