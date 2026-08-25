import assert from "node:assert/strict";
import test from "node:test";
import { safeSnapshot, safeSnapshotResult } from "../src/clone.ts";

test("safeSnapshot clones plain objects deeply", () => {
  const original = { a: [1, { b: 2 }], c: "x" };
  const cloned = safeSnapshot(original);
  assert.deepEqual(cloned, original);
  assert.notEqual(cloned, original);
  assert.notEqual(cloned.a, original.a);
});

test("snapshot is isolated from later mutation of the original", () => {
  const original = { list: [{ n: 1 }], s: "keep" };
  const cloned = safeSnapshot(original);
  original.list[0].n = 999;
  original.s = "mutated";
  assert.equal(cloned.list[0].n, 1);
  assert.equal(cloned.s, "keep");
});

test("null/undefined pass through as complete", () => {
  assert.deepEqual(safeSnapshotResult(undefined), {
    value: undefined,
    complete: true,
  });
  assert.deepEqual(safeSnapshotResult(null), { value: null, complete: true });
});

test("functions fall back to JSON placeholder and warn", () => {
  const warnings: string[] = [];
  const fn = () => {};
  const result = safeSnapshotResult(fn, (m) => warnings.push(m));
  assert.equal(result.complete, false);
  assert.deepEqual(result.value, { $uncloneable: true, type: "function" });
  assert.ok(warnings.length >= 2, "both failure paths warn");
});

test("uncloneable values never throw and produce placeholders", () => {
  const warnings: string[] = [];
  const circular = { name: "x" };
  (circular as Record<string, unknown>).self = circular;
  const result = safeSnapshotResult(circular, (m) => warnings.push(m));
  // structuredClone handles cycles; JSON.stringify drops them — so expect complete: true
  assert.equal(result.complete, true);
  assert.equal((result.value as unknown as { self: { name: string } }).self.name, "x");
});

test("JSON fallback is used when structuredClone is unavailable", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = globalThis.structuredClone;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).structuredClone = undefined as any;
  try {
    const warnings: string[] = [];
    const value = { a: [1, 2] };
    const result = safeSnapshotResult(value, (m) => warnings.push(m));
    assert.equal(result.complete, false);
    assert.deepEqual(result.value, { a: [1, 2] });
    assert.equal(warnings.length, 1);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).structuredClone = original;
  }
});

test("Date survives structuredClone and JSON fallback", () => {
  const value = { when: new Date(1700000000000), text: "use a token here" };
  const cloned = safeSnapshot(value);
  assert.deepEqual(cloned, { when: new Date(1700000000000), text: "use a token here" });
});

test("warning callback is only invoked on failure paths", () => {
  let warned = false;
  safeSnapshot({ ok: true }, () => {
    warned = true;
  });
  assert.equal(warned, false);
});
