/**
 * P1 — hashing helpers: stability, key-order insensitivity, and
 * fail-open behavior on hostile values.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { hashText, hashValue, shortHash } from "../../src/hash.ts";

test("hashText: stable 64-char hex digest, sensitive to content", () => {
  const a = hashText("hello");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hashText("hello"));
  assert.notEqual(a, hashText("hellp"));
});

test("hashValue: insensitive to object key order", () => {
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});

test("hashValue: sensitive to array order and values", () => {
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 1, b: 2 }));
});

test("hashValue: distinguishes distinct placeholder values", () => {
  assert.notEqual(hashValue(undefined), hashValue(null));
  assert.notEqual(hashValue(undefined), hashValue(0));
  assert.notEqual(hashValue(Number.NaN), hashValue(Number.POSITIVE_INFINITY));
});

test("hashValue: handles cycles without throwing", () => {
  const value: Record<string, unknown> = { x: 1 };
  value.self = value;
  const hash = hashValue(value);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashValue(value));
});

test("hashValue: distinguishes self-referential Map from a fresh one", () => {
  const selfMap = new Map<string, unknown>();
  selfMap.set("self", selfMap);
  const freshMap = new Map<string, unknown>();
  freshMap.set("self", "nope");
  assert.notEqual(hashValue(selfMap), hashValue(freshMap));
});

test("hashValue: deterministic across calls for exotic values", () => {
  const value = { d: new Date(0), re: /x/, err: new Error("e"), big: 5n };
  assert.equal(hashValue(value), hashValue(value));
});

test("shortHash: display form and fail-open", () => {
  const hash = hashText("x");
  assert.equal(shortHash(hash), `sha256:${hash.slice(0, 4)}…`);
  assert.equal(shortHash(""), "?");
  assert.equal(shortHash(123 as unknown as string), "?");
  assert.equal(shortHash(undefined as unknown as string), "?");
});
