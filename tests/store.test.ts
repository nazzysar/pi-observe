/**
 * SessionStore regression tests for sanitize-failure and stale pending
 * context handling. Uses the store directly (no recorder).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SANITIZE_FAILED } from "../src/sanitize.ts";
import { SessionStore } from "../src/store.ts";

function deepArrayPayload(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** Depth where structuredClone succeeds but the recursive sanitizer overflows. */
const OVERFLOW_DEPTH = 3000;

test("sanitize failure stores placeholder, never raw payload", () => {
  const store = new SessionStore();
  const payload = deepArrayPayload(OVERFLOW_DEPTH, {
    apiKey: "super-secret-value",
    messages: [{ role: "user", content: "hi" }],
  }) as unknown[];

  store.onBeforeProviderRequest({
    payload,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 1,
  });

  const record = store.getLatestRequest();
  assert.ok(record);
  assert.deepEqual(record.sanitizedProviderPayload, SANITIZE_FAILED);
  assert.ok(
    !JSON.stringify(record.sanitizedProviderPayload).includes("super-secret-value"),
    "raw credential must not appear in the stored record",
  );
  assert.ok(
    record.warnings.some((w) => w.code === "sanitize-failed"),
    "sanitize-failed warning is recorded",
  );

  // Later mutation of Pi's event object must not change the record.
  (payload[0] as unknown[])[0] = { apiKey: "mutated" };
  const again = store.getLatestRequest();
  assert.deepEqual(again?.sanitizedProviderPayload, SANITIZE_FAILED);
});

test("run end clears pending context so next run warns instead of cross-correlating", () => {
  const store = new SessionStore();

  const startRun = (prompt: string) => {
    store.onBeforeAgentStart({
      prompt,
      systemPrompt: "sys",
      systemPromptOptions: undefined,
      model: { id: "m", provider: "p" },
      thinkingLevel: undefined,
      timestamp: 1,
    });
    store.onAgentStart();
  };

  // Run A: emits context, then ends without any provider request.
  startRun("run A");
  store.onContext([{ role: "user", content: "from run A" }], undefined, 1);
  store.onRunEnd();

  // Run B: provider request with no context of its own.
  startRun("run B");
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "b" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });

  const record = store.getLatestRequest();
  assert.ok(record);
  assert.equal(record.runId, "run-2", "request must correlate with run B, not run A");
  assert.equal(record.logicalContext, undefined, "no stale context from run A");
  assert.ok(
    record.warnings.some((w) => w.code === "missing-logical-context"),
    "must warn that no logical context was pending",
  );
});

test("pending context survives a run that emits it and is consumed by its own request", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "sys",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext([{ role: "user", content: "own" }], undefined, 1);
  store.onBeforeProviderRequest({
    payload: { messages: [] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const record = store.getLatestRequest();
  assert.ok(record);
  assert.deepEqual(record.logicalContext, [{ role: "user", content: "own" }]);
  assert.ok(!record.warnings.some((w) => w.code === "missing-logical-context"));
});
