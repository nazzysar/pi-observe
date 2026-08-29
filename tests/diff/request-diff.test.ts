/**
 * P1 — DiffService: order normalization, memoization, clear(), and the
 * cross-session regression — after store.reset() the request sequence
 * restarts at 1, so the service must be cleared (via the recorder's
 * onReset hook, as index.ts wires it) or a new session is served the
 * previous session's cached diffs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DiffService,
  type ObservationStore,
} from "../../src/diff/request-diff.ts";
import type { RequestRecord } from "../../src/model.ts";
import { Recorder } from "../../src/recorder.ts";
import { SessionStore } from "../../src/store.ts";
import { fakeCtx, sessionStartEvent } from "../helpers.ts";

// ---------------------------------------------------------------------------
// Record factory (full RequestRecord shape, minimal content)
// ---------------------------------------------------------------------------

interface RecordOverrides {
  systemPrompt?: string;
  messages?: unknown[];
  tools?: RequestRecord["providerTools"];
  modelId?: string;
  thinkingLevel?: RequestRecord["thinkingLevel"];
  tokens?: number;
  payload?: unknown;
}

function makeRecord(seq: number, overrides: RecordOverrides = {}): RequestRecord {
  return {
    requestId: `req-${seq}`,
    requestSeq: seq,
    runId: "run-1",
    turnIndex: 0,
    timestamp: seq,
    model: {
      id: overrides.modelId ?? "model-a",
      name: "Model A",
      provider: "fake",
      api: "openai-completions",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
    },
    thinkingLevel: overrides.thinkingLevel ?? "high",
    prompt: {
      systemPrompt: overrides.systemPrompt ?? "you are pi",
      systemPromptOptions: { cwd: "/tmp" },
      model: undefined,
      thinkingLevel: undefined,
      timestamp: 1,
    },
    logicalContext: overrides.messages ?? [],
    sanitizedProviderPayload: overrides.payload ?? { model: "model-a", messages: [] },
    providerEnvelope: undefined,
    providerTools: overrides.tools,
    contextUsage:
      overrides.tokens === undefined
        ? undefined
        : { tokens: overrides.tokens, contextWindow: 128000, percent: 1 },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// diff(): order, memoization, clear
// ---------------------------------------------------------------------------

test("diff normalizes order (from = older)", () => {
  const service = new DiffService();
  const forward = service.diff(makeRecord(1), makeRecord(2));
  const backward = service.diff(makeRecord(2), makeRecord(1));
  assert.deepEqual(backward, forward);
  assert.equal(forward.fromRequestId, 1);
  assert.equal(forward.toRequestId, 2);
});

test("diff is memoized per (from, to, mode)", () => {
  const service = new DiffService();
  const a = makeRecord(1);
  const b = makeRecord(2);
  const first = service.diff(a, b);
  const second = service.diff(a, b);
  assert.equal(first, second, "same mode returns the cached object");
  // Different mode is a different cache entry.
  const light = service.diff(a, b, { payloadPaths: false });
  assert.notEqual(light, first);
  assert.equal(service.diff(a, b, { payloadPaths: false }), light);
});

test("clear() drops memoized diffs", () => {
  const service = new DiffService();
  const a = makeRecord(1);
  const b = makeRecord(2);
  const before = service.diff(a, b);
  service.clear();
  const after = service.diff(a, b);
  assert.notEqual(before, after);
  assert.deepEqual(before, after);
});

test("cache eviction bounds the cache (FIFO past MAX_CACHE)", () => {
  const service = new DiffService();
  const first = service.diff(makeRecord(1), makeRecord(2));
  // 201 more distinct pairs push the first entry out (MAX_CACHE = 200).
  for (let i = 3; i <= 203; i++) service.diff(makeRecord(i), makeRecord(i + 1));
  const recomputed = service.diff(makeRecord(1), makeRecord(2));
  assert.notEqual(first, recomputed, "oldest entry was evicted");
  assert.deepEqual(first, recomputed);
});

test("summary reflects real differences", () => {
  const service = new DiffService();
  const from = makeRecord(1, {
    systemPrompt: "v1",
    messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    tools: [
      { index: 0, name: "read", description: "read", raw: { name: "read" } },
    ],
    tokens: 1000,
    thinkingLevel: "low",
  });
  const to = makeRecord(2, {
    systemPrompt: "v2",
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: "changed" },
      { role: "user", content: "c" },
    ],
    tools: [
      { index: 0, name: "read", description: "read v2", raw: { name: "read", description: "read v2" } },
    ],
    tokens: 6000,
    thinkingLevel: "high",
  });
  const diff = service.diff(from, to);
  assert.equal(diff.summary.systemChanged, true);
  assert.equal(diff.summary.messagesChanged, 1);
  assert.equal(diff.summary.messagesAdded, 1);
  assert.equal(diff.summary.messagesRemoved, 0);
  assert.equal(diff.summary.toolsChanged, 1);
  assert.equal(diff.summary.modelChanged, true, "thinking level change counts");
  assert.equal(typeof diff.contextUsage, "object");
  if (typeof diff.contextUsage === "object") {
    assert.equal(diff.contextUsage.delta, 5000);
  }
  assert.equal(diff.model.thinkingLevelFrom, "low");
  assert.equal(diff.model.thinkingLevelTo, "high");
});

test("contextUsage is 'unknown' when not reported", () => {
  const service = new DiffService();
  const diff = service.diff(makeRecord(1), makeRecord(2));
  assert.equal(diff.contextUsage, "unknown");
});

test("light mode skips raw-payload path detection, keeps hashes", () => {
  const service = new DiffService();
  const from = makeRecord(1, { payload: { temperature: 1, messages: [1] } });
  const to = makeRecord(2, { payload: { temperature: 2, messages: [1] } });
  const light = service.diff(from, to, { payloadPaths: false });
  assert.equal(light.providerPayload.equal, false);
  assert.deepEqual(light.providerPayload.changedPaths, []);
  assert.equal(light.providerPayload.truncated, false);
  const full = service.diff(from, to);
  assert.ok(full.providerPayload.changedPaths.includes("$.temperature"));
});

test("provider message arrays are elided when the message diff explains them", () => {
  const service = new DiffService();
  const from = makeRecord(1, {
    messages: [{ role: "user", content: "a" }],
    payload: { model: "m", messages: [{ role: "user", content: "a" }] },
  });
  const to = makeRecord(2, {
    messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }],
    payload: { model: "m", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] },
  });
  const diff = service.diff(from, to);
  assert.ok(diff.providerPayload.changedPaths.includes("$.messages"));
  assert.ok(
    !diff.providerPayload.changedPaths.some((p) => p.startsWith("$.messages[") ),
    "message content paths are elided",
  );
});

test("getAdjacentDiff: predecessor pair, undefined at the first request", () => {
  const service = new DiffService();
  const store: ObservationStore = {
    getRequests: () => [makeRecord(1), makeRecord(2), makeRecord(3)],
  };
  const adjacent = service.getAdjacentDiff(store, 2);
  assert.ok(adjacent);
  assert.equal(adjacent!.fromRequestId, 1);
  assert.equal(adjacent!.toRequestId, 2);
  assert.equal(service.getAdjacentDiff(store, 1), undefined);
  assert.equal(service.getAdjacentDiff(store, 99), undefined);
});

// ---------------------------------------------------------------------------
// Cross-session regression: seq numbers restart after reset
// ---------------------------------------------------------------------------

function seedRequest(
  store: SessionStore,
  timestamp: number,
  systemPrompt: string,
): void {
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt,
    systemPromptOptions: { cwd: "/tmp" },
    model: { id: "m", name: "M", provider: "fake", api: "openai", reasoning: false, contextWindow: 1000, maxTokens: 100 },
    thinkingLevel: undefined,
    timestamp,
  });
  store.onAgentStart();
  store.onContext([{ role: "user", content: "hi" }], undefined, timestamp);
  store.onBeforeProviderRequest({
    payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "fake" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp,
  });
}

test("recorder onReset is called on session change, not startup", () => {
  const store = new SessionStore();
  const resets: string[] = [];
  const recorder = new Recorder({
    store,
    onReset: () => resets.push("reset"),
  });
  const ctx = fakeCtx();
  recorder.sessionStart(sessionStartEvent("new"), ctx);
  assert.deepEqual(resets, ["reset"]);
  // Counters were actually reset.
  seedRequest(store, 1, "s1");
  recorder.sessionStart(sessionStartEvent("startup"), ctx);
  assert.equal(resets.length, 1, "startup does not reset");
});

test("regression: no stale diffs served after a session reset", () => {
  // Wire the service exactly as index.ts does: one shared DiffService,
  // cleared by the recorder on session reset.
  const store = new SessionStore();
  const diffService = new DiffService();
  const recorder = new Recorder({ store, onReset: () => diffService.clear() });
  const ctx = fakeCtx();

  // Session A: system prompt changes between its two requests.
  seedRequest(store, 1, "session-a prompt");
  seedRequest(store, 2, "session-a prompt v2");
  const sessionA = diffService.diff(
    store.getState().requests[0]!,
    store.getState().requests[1]!,
  );
  assert.equal(sessionA.summary.systemChanged, true);
  assert.equal(sessionA.systemPrompt.oldLength, "session-a prompt".length);

  // Session B: requestSeq restarts at 1, 2 — same cache keys — but the
  // system prompt is identical across its requests.
  recorder.sessionStart(sessionStartEvent("new"), ctx);
  seedRequest(store, 3, "session-b prompt");
  seedRequest(store, 4, "session-b prompt");
  const sessionB = diffService.diff(
    store.getState().requests[0]!,
    store.getState().requests[1]!,
  );
  assert.equal(
    sessionB.summary.systemChanged,
    false,
    "without clear() the cache would serve session A's diff",
  );
  assert.equal(sessionB.systemPrompt.oldLength, "session-b prompt".length);
  assert.equal(sessionB.fromRequestId, 1);
  assert.equal(sessionB.toRequestId, 2);
});

test("without clear() the stale cache reproduces the bug (sanity)", () => {
  // Documents the pre-fix behavior: same cache keys, wrong records.
  const store = new SessionStore();
  const diffService = new DiffService();
  const recorder = new Recorder({ store }); // no onReset — the old wiring
  seedRequest(store, 1, "session-a prompt");
  seedRequest(store, 2, "session-a prompt v2");
  const stale = diffService.diff(
    store.getState().requests[0]!,
    store.getState().requests[1]!,
  );
  assert.equal(stale.summary.systemChanged, true);

  recorder.sessionStart(sessionStartEvent("new"), fakeCtx());
  seedRequest(store, 3, "session-b prompt");
  seedRequest(store, 4, "session-b prompt");
  const served = diffService.diff(
    store.getState().requests[0]!,
    store.getState().requests[1]!,
  );
  assert.equal(
    served.summary.systemChanged,
    true,
    "stale cache: session B is served session A's diff",
  );
  assert.equal(served.systemPrompt.oldLength, "session-a prompt".length);
});
