import assert from "node:assert/strict";
import test from "node:test";
import { installObserver, Recorder } from "../src/recorder.ts";
import { SessionStore } from "../src/store.ts";
import { REDACTED } from "../src/sanitize.ts";
import {
  agentEndEvent,
  agentSettledEvent,
  agentStartEvent,
  beforeAgentStartEvent,
  contextEvent,
  fakeCtx,
  fakeModel,
  invoke,
  providerRequestEvent,
  resetSeq,
  sessionStartEvent,
  turnEndEvent,
  turnStartEvent,
} from "./helpers.ts";

function makeRecorder(maxRequests = 100) {
  const store = new SessionStore({ maxRequests });
  const times: number[] = [];
  const now = () => {
    times.push(times.length);
    return times[times.length - 1];
  };
  const recorder = new Recorder({ store, now });
  return { store, recorder, now: () => times[times.length - 1] };
}

test("full lifecycle: one run, one turn, one context, one request", () => {
  const { store, recorder } = makeRecorder();
  const model = fakeModel({ id: "claude", provider: "anthropic" });
  const ctx = fakeCtx({ model, thinkingLevel: "medium", contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });
  const ctx2 = fakeCtx({ model, thinkingLevel: "medium", contextUsage: { tokens: 20, contextWindow: 100, percent: 20 } });

  recorder.beforeAgentStart(
    beforeAgentStartEvent({ prompt: "fix the bug", systemPrompt: "You are pi. Tools: read, bash", systemPromptOptions: { cwd: "/repo", selectedTools: ["read", "bash"], customPrompt: "custom" } }),
    ctx,
  );
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "fix the bug" }]), ctx);
  recorder.beforeProviderRequest(
    providerRequestEvent({ model: "claude", messages: [{ role: "user", content: "fix" }], max_tokens: 1024, apiKey: "sk-secret" }),
    ctx2,
  );
  recorder.agentEnd(agentEndEvent(), ctx2);
  recorder.agentSettled(agentSettledEvent(), ctx2);

  const state = store.getState();
  assert.equal(state.runCount, 1);
  assert.equal(state.requestCount, 1);
  assert.equal(state.currentRunId, undefined); // run inactive after end
  assert.equal(state.maxTurnIndex, 0);

  const [record] = state.requests;
  assert.equal(record.requestId, "req-1");
  assert.equal(record.requestSeq, 1);
  assert.equal(record.runId, "run-1");
  assert.equal(record.turnIndex, 0);
  assert.equal(record.model?.id, "claude");
  assert.equal(record.model?.provider, "anthropic");
  assert.equal(record.thinkingLevel, "medium");
  assert.equal(record.prompt?.systemPrompt, "You are pi. Tools: read, bash");
  assert.deepEqual(record.prompt?.systemPromptOptions, {
    cwd: "/repo",
    selectedTools: ["read", "bash"],
    customPrompt: "custom",
  });
  assert.deepEqual(record.logicalContext, [{ role: "user", content: "fix the bug" }]);
  assert.equal((record.sanitizedProviderPayload as Record<string, unknown>).apiKey, REDACTED);
  assert.deepEqual((record.sanitizedProviderPayload as Record<string, unknown>).messages, [
    { role: "user", content: "fix" },
  ]);
  assert.equal(record.contextUsage?.tokens, 20); // commit-time usage wins
  assert.deepEqual(record.warnings, []);
  assert.equal(state.pendingContext, undefined); // consumed
  assert.equal(store.getRequests().length, 1);
  assert.equal(store.getLatestRequest()?.requestId, "req-1");
  assert.deepEqual(store.getRequest("req-1"), record);
  assert.equal(store.getRequest("nope"), undefined);
});

test("multiple turns and requests correlate per run", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel(), thinkingLevel: "high" });

  recorder.beforeAgentStart(beforeAgentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "a" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 1 }), ctx);
  recorder.turnEnd(turnEndEvent(0), ctx);
  recorder.turnStart(turnStartEvent(1), ctx);
  recorder.context(contextEvent([{ role: "assistant", content: "b" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 2 }), ctx);
  recorder.turnEnd(turnEndEvent(1), ctx);
  recorder.turnStart(turnStartEvent(2), ctx);
  recorder.context(contextEvent([{ role: "user", content: "c" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 3 }), ctx);
  recorder.turnEnd(turnEndEvent(2), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);
  recorder.agentSettled(agentSettledEvent(), ctx);

  const state = store.getState();
  assert.equal(state.runCount, 1);
  assert.equal(state.requestCount, 3);
  assert.equal(state.maxTurnIndex, 2);

  const [r1, r2, r3] = store.getRequests();
  assert.deepEqual(
    [r1.requestId, r2.requestId, r3.requestId],
    ["req-1", "req-2", "req-3"],
  );
  assert.deepEqual([r1.runId, r2.runId, r3.runId], ["run-1", "run-1", "run-1"]);
  assert.deepEqual([r1.turnIndex, r2.turnIndex, r3.turnIndex], [0, 1, 2]);
  assert.deepEqual(r1.logicalContext, [{ role: "user", content: "a" }]);
  assert.deepEqual(r2.logicalContext, [{ role: "assistant", content: "b" }]);
  assert.deepEqual(r3.logicalContext, [{ role: "user", content: "c" }]);
  assert.deepEqual(r1.sanitizedProviderPayload, { m: 1 });
  assert.deepEqual(r2.sanitizedProviderPayload, { m: 2 });
  assert.deepEqual(r3.sanitizedProviderPayload, { m: 3 });
  assert.deepEqual(r1.warnings, []);
  assert.equal(r1.thinkingLevel, "high");
});

test("missing context still records, with warning", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ temperature: 0.7 }), ctx);

  const state = store.getState();
  assert.equal(state.requestCount, 1);
  const [record] = store.getRequests();
  assert.equal(record.runId, "run-1");
  assert.equal(record.turnIndex, 0);
  assert.deepEqual(record.sanitizedProviderPayload, { temperature: 0.7 });
  assert.equal(record.logicalContext, undefined);
  assert.deepEqual(record.warnings.map((w) => w.code), ["missing-logical-context"]);
  assert.deepEqual(state.warnings.map((w) => w.code), ["missing-logical-context"]);
});

test("repeated context: latest wins; consumed after request", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "first" }]), ctx);
  recorder.context(contextEvent([{ role: "user", content: "second" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 1 }), ctx);

  const [record] = store.getRequests();
  assert.deepEqual(record.logicalContext, [{ role: "user", content: "second" }]);
  assert.equal(store.getState().pendingContext, undefined);

  // A request after context consumption has no pending context again.
  recorder.beforeProviderRequest(providerRequestEvent({ m: 2 }), ctx);
  const [r1, r2] = store.getRequests();
  assert.equal(r2.runId, "run-1");
  assert.equal(r2.turnIndex, 0);
  assert.equal(r2.logicalContext, undefined);
  assert.deepEqual(r2.warnings.map((w) => w.code), ["missing-logical-context"]);
  assert.deepEqual(r1.warnings, []);
});

test("turn without request produces no record", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.beforeAgentStart(beforeAgentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "hi" }]), ctx);
  recorder.turnEnd(turnEndEvent(0), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);
  recorder.agentSettled(agentSettledEvent(), ctx);

  const state = store.getState();
  assert.equal(state.runCount, 1);
  assert.equal(state.requestCount, 0);
  assert.equal(state.requests.length, 0);
  assert.equal(state.maxTurnIndex, 0);
});

test("session reset clears state; counters restart", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.beforeAgentStart(beforeAgentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "first session" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 1 }), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);

  recorder.sessionStart(sessionStartEvent("new"), ctx);
  const empty = store.getState();
  assert.equal(empty.runCount, 0);
  assert.equal(empty.requestCount, 0);
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.currentRunId, undefined);
  assert.equal(empty.maxTurnIndex, undefined);

  recorder.beforeAgentStart(beforeAgentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "second session" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 2 }), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);

  const state = store.getState();
  assert.equal(state.runCount, 1);
  assert.equal(state.requestCount, 1);
  const [record] = store.getRequests();
  assert.equal(record.requestId, "req-1"); // ids restart per session
  assert.equal(record.runId, "run-1");
  assert.deepEqual(record.logicalContext, [{ role: "user", content: "second session" }]);
});

test("retention evicts oldest requests", () => {
  const { store, recorder } = makeRecorder(3);
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.agentStart(agentStartEvent(), ctx);
  for (let i = 0; i < 5; i += 1) {
    recorder.turnStart(turnStartEvent(i), ctx);
    recorder.context(contextEvent([{ role: "user", content: `msg ${i}` }]), ctx);
    recorder.beforeProviderRequest(providerRequestEvent({ i }), ctx);
    recorder.turnEnd(turnEndEvent(i), ctx);
  }
  recorder.agentEnd(agentEndEvent(), ctx);

  const state = store.getState();
  assert.equal(state.requestCount, 5); // observed, monotonic
  assert.equal(state.evictedRequestCount, 2);
  assert.equal(state.requests.length, 3); // retained
  assert.deepEqual(
    state.requests.map((r) => r.requestId),
    ["req-3", "req-4", "req-5"],
  );
  assert.deepEqual(
    state.requests.map((r) => r.turnIndex),
    [2, 3, 4],
  );
  assert.equal(store.getRequest("req-1"), undefined); // evicted
  assert.equal(store.getLatestRequest()?.requestSeq, 5);
});

test("snapshot isolation: later mutation of originals does not affect records", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });
  const payload: Record<string, unknown> = { messages: [{ role: "user", content: "fix" }] };
  const messages: unknown[] = [{ role: "user", content: "fix", extra: { n: 1 } }];

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent(messages), ctx);
  recorder.beforeProviderRequest(providerRequestEvent(payload), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);

  const [record] = store.getRequests();

  // Mutate originals after commit.
  ((payload.messages as unknown[])[0] as Record<string, unknown>).content = "changed";
  (messages[0] as Record<string, unknown>).extra = { n: 999 };
  (record.sanitizedProviderPayload as { messages: unknown[] }).messages[0] = "tampered";
  record.logicalContext!.push("tampered");

  const [stored] = store.getRequests();
  assert.deepEqual(stored.sanitizedProviderPayload, {
    messages: [{ role: "user", content: "fix" }],
  });
  assert.deepEqual(stored.logicalContext, [
    { role: "user", content: "fix", extra: { n: 1 } },
  ]);
});

test("all observer handlers return undefined", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  const results = [
    invoke(recorder, "beforeAgentStart", beforeAgentStartEvent(), ctx),
    invoke(recorder, "agentStart", agentStartEvent(), ctx),
    invoke(recorder, "turnStart", turnStartEvent(0), ctx),
    invoke(recorder, "context", contextEvent([{ role: "user", content: "x" }]), ctx),
    invoke(recorder, "beforeProviderRequest", providerRequestEvent({ a: 1 }), ctx),
    invoke(recorder, "turnEnd", turnEndEvent(0), ctx),
    invoke(recorder, "agentEnd", agentEndEvent(), ctx),
    invoke(recorder, "agentSettled", agentSettledEvent(), ctx),
    invoke(recorder, "sessionStart", sessionStartEvent("startup"), ctx),
  ];
  for (const result of results) {
    assert.equal(result.value, undefined, `${result.method} returned non-undefined`);
  }
});

test("deterministic mocked lifecycle: before_agent_start through agent_settled", () => {
  const { store, recorder, now } = makeRecorder();
  const model = fakeModel({ id: "gpt", provider: "openai", reasoning: true });
  const ctx = fakeCtx({ model, thinkingLevel: "max" });

  // Deterministic event sequence with a fake clock.
  const events: Array<() => void> = [
    () => recorder.beforeAgentStart(beforeAgentStartEvent(), ctx),
    () => recorder.agentStart(agentStartEvent(), ctx),
    () => recorder.turnStart(turnStartEvent(0), ctx),
    () => recorder.context(contextEvent([{ role: "user", content: "hello" }]), ctx),
    () => recorder.beforeProviderRequest(providerRequestEvent({ prompt: "hello" }), ctx),
    () => recorder.turnEnd(turnEndEvent(0), ctx),
    () => recorder.agentEnd(agentEndEvent(), ctx),
    () => recorder.agentSettled(agentSettledEvent(), ctx),
  ];
  for (const fire of events) fire();

  const state = store.getState();
  assert.equal(state.runCount, 1);
  assert.equal(state.requestCount, 1);
  assert.equal(state.maxTurnIndex, 0);
  assert.equal(state.currentRunId, undefined);
  assert.equal(state.currentTurnIndex, undefined);

  const record = store.getLatestRequest()!;
  assert.equal(record.requestId, "req-1");
  assert.equal(record.runId, "run-1");
  assert.equal(record.turnIndex, 0);
  assert.equal(record.timestamp, 2); // fake clock: 0=before_agent_start, 1=context, 2=commit
  assert.equal(record.model?.id, "gpt");
  assert.equal(record.thinkingLevel, "max");
  assert.equal(record.prompt?.systemPrompt, store.getState().currentPrompt?.systemPrompt ?? record.prompt?.systemPrompt);
  assert.deepEqual(record.logicalContext, [{ role: "user", content: "hello" }]);
  assert.deepEqual(record.sanitizedProviderPayload, { prompt: "hello" });
  assert.deepEqual(record.warnings, []);
  assert.equal(now(), 2);
});

test("prompt snapshot and model captured even when commit ctx is empty", () => {
  const { store, recorder } = makeRecorder();
  const model = fakeModel();
  const richCtx = fakeCtx({ model, thinkingLevel: "high" });
  const emptyCtx = fakeCtx({}); // no model/thinking at commit

  recorder.beforeAgentStart(beforeAgentStartEvent(), richCtx);
  recorder.agentStart(agentStartEvent(), richCtx);
  recorder.turnStart(turnStartEvent(0), richCtx);
  recorder.context(contextEvent([{ role: "user", content: "x" }]), richCtx);
  recorder.beforeProviderRequest(providerRequestEvent({ m: 1 }), emptyCtx);
  recorder.agentEnd(agentEndEvent(), emptyCtx);

  const [record] = store.getRequests();
  assert.equal(record.model?.id, model.id); // falls back to run-time snapshot
  assert.equal(record.thinkingLevel, "high");
  assert.equal(record.prompt?.model?.id, model.id);
});

test("installObserver subscribes exactly the passive hooks", () => {
  const registrations: Array<{ name: string; handler: (e: unknown, c: unknown) => unknown }> =
    [];
  const fakePi = {
    on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
      registrations.push({ name, handler });
    },
  } as unknown as Parameters<typeof installObserver>[0];
  const store = new SessionStore();
  installObserver(fakePi, { store });

  const names = registrations.map((r) => r.name).sort();
  assert.deepEqual(names, [
    "agent_end",
    "agent_settled",
    "agent_start",
    "before_agent_start",
    "before_provider_request",
    "context",
    "session_start",
    "turn_end",
    "turn_start",
  ]);
  // handlers are passive wrappers returning undefined
  for (const { handler } of registrations) {
    assert.equal(handler({}, {}), undefined);
  }
});

test("run count increments once per agent_start; request before any run", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  // Provider request with no run started at all.
  recorder.beforeProviderRequest(providerRequestEvent({ orphan: true }), ctx);
  let state = store.getState();
  assert.equal(state.requestCount, 1);
  assert.equal(state.runCount, 0);
  assert.equal(state.requests[0].runId, undefined);
  assert.deepEqual(state.requests[0].warnings.map((w) => w.code), [
    "missing-logical-context",
  ]);

  // A run with an extra agent_start: each event counts exactly once.
  recorder.beforeAgentStart(beforeAgentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx);
  recorder.agentStart(agentStartEvent(), ctx); // second agent_start
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "x" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ ok: 1 }), ctx);
  recorder.agentEnd(agentEndEvent(), ctx);

  state = store.getState();
  assert.equal(state.runCount, 2); // once per agent_start
  assert.equal(state.requestCount, 2);
  const [r1, r2] = store.getRequests();
  assert.equal(r1.runId, undefined);
  assert.equal(r2.runId, "run-2"); // correlates to the latest started run
  assert.equal(r2.turnIndex, 0);
});
