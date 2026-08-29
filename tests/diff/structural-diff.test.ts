/**
 * P1 — structural changed-path detection.
 * Covers path rendering, object/array traversal, key-order insensitivity,
 * and the bounds (maxPaths, maxDepth, maxNodes, skipSubtree).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  renderPath,
  structuralDiff,
} from "../../src/diff/structural-diff.ts";

test("equal values: no paths, hashes equal", () => {
  const result = structuralDiff({ a: [1, 2], b: "x" }, { b: "x", a: [1, 2] });
  assert.equal(result.equal, true, "key order must not count as a change");
  assert.equal(result.oldHash, result.newHash);
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.truncated, false);
});

test("primitive change at the root reports $", () => {
  const result = structuralDiff(1, 2);
  assert.equal(result.equal, false);
  assert.deepEqual(result.changedPaths, ["$"]);
});

test("nested object path", () => {
  const result = structuralDiff({ a: { b: 1 } }, { a: { b: 2 } });
  assert.deepEqual(result.changedPaths, ["$.a.b"]);
});

test("added and removed keys", () => {
  assert.deepEqual(
    structuralDiff({ a: 1 }, { a: 1, b: 2 }).changedPaths,
    ["$.b"],
  );
  assert.deepEqual(
    structuralDiff({ a: 1, b: 2 }, { a: 1 }).changedPaths,
    ["$.b"],
  );
});

test("array index paths", () => {
  assert.deepEqual(
    structuralDiff([1, 2, 3], [1, 9, 3]).changedPaths,
    ["$[1]"],
  );
  // Extra elements report their own indices.
  assert.deepEqual(
    structuralDiff([1, 2], [1, 2, 3]).changedPaths,
    ["$[2]"],
  );
  assert.deepEqual(
    structuralDiff([1, 2, 3], [1, 2]).changedPaths,
    ["$[2]"],
  );
});

test("type mismatch reports the path", () => {
  assert.deepEqual(
    structuralDiff({ a: 1 }, { a: "1" }).changedPaths,
    ["$.a"],
  );
  assert.deepEqual(
    structuralDiff({ a: { b: 1 } }, { a: [1] }).changedPaths,
    ["$.a"],
  );
});

test("paths are reported in document order", () => {
  const result = structuralDiff(
    { b: { z: 1, a: 2 }, a: [1, 2] },
    { b: { z: 9, a: 2 }, a: [1, 8] },
  );
  assert.deepEqual(result.changedPaths, ["$.a[1]", "$.b.z"]);
});

test("maxPaths truncates and sets truncated", () => {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) {
    old[`k${i}`] = 1;
    next[`k${i}`] = 2;
  }
  const result = structuralDiff(old, next, { maxPaths: 10 });
  assert.equal(result.changedPaths.length, 10);
  assert.equal(result.truncated, true);
});

test("maxDepth stops descending at the depth cap", () => {
  // Change lives 100 levels deep; with maxDepth 5 the report caps out.
  const leaf = { deep: 1 };
  let old: Record<string, unknown> = leaf;
  let next: Record<string, unknown> = { deep: 2 };
  for (let i = 0; i < 100; i++) {
    old = { l: old };
    next = { l: next };
  }
  const result = structuralDiff(old, next, { maxDepth: 5 });
  assert.equal(result.truncated, true);
  const depths = result.changedPaths.map((p) => (p.match(/\.l/g) || []).length);
  assert.ok(Math.max(...depths) <= 5, "no path deeper than the cap");
});

test("maxNodes bounds work on huge payloads", () => {
  const old = Array.from({ length: 1000 }, (_, i) => ({ v: i }));
  const next = Array.from({ length: 1000 }, (_, i) => ({ v: i + 1 }));
  const result = structuralDiff(old, next, { maxNodes: 10 });
  assert.equal(result.truncated, true);
  assert.ok(result.changedPaths.length <= 50);
});

test("skipSubtree reports the subtree once and does not descend", () => {
  const result = structuralDiff(
    { messages: [{ a: 1, b: 2 }], model: "m" },
    { messages: [{ a: 9, b: 9 }], model: "m2" },
    { skipSubtree: (segments) => segments[0] === "messages" },
  );
  assert.ok(result.changedPaths.includes("$.messages"));
  assert.ok(
    !result.changedPaths.some((p) => p.startsWith("$.messages[0]")),
    "skipped subtree must not be descended",
  );
  assert.ok(result.changedPaths.includes("$.model"));
});

test("identical circular structures are equal via hash", () => {
  const value: Record<string, unknown> = { x: 1 };
  value.self = value;
  const result = structuralDiff(value, value);
  assert.equal(result.equal, true);
  assert.deepEqual(result.changedPaths, []);
});

test("distinct circular structures terminate (node budget bounds the walk)", () => {
  const a: Record<string, unknown> = { x: 1 };
  a.self = a;
  const b: Record<string, unknown> = { x: 2 };
  b.self = b;
  const result = structuralDiff(a, b);
  assert.equal(result.equal, false);
  assert.equal(result.truncated, true);
  assert.ok(result.changedPaths.length > 0);
});

test("renderPath formats segments", () => {
  assert.equal(renderPath([]), "$");
  assert.equal(renderPath(["messages", "[4]", "content"]), "$.messages[4].content");
  assert.equal(renderPath(["a"]), "$.a");
});

test("never throws on hostile shapes", () => {
  // undefined/undefined, mismatched primitives, functions, etc.
  assert.equal(structuralDiff(undefined, undefined).equal, true);
  assert.equal(structuralDiff("a", 1).equal, false);
  assert.equal(structuralDiff(null, {}).equal, false);
});
