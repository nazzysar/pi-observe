/**
 * P1 — canonicalize(): deterministic string form of arbitrary values.
 * Covers key sorting, order sensitivity, `~`-tagged placeholders,
 * cycle detection (objects, arrays, and self-referential Maps/Sets),
 * determinism, and stack safety on very deep shapes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize } from "../../src/canonicalize.ts";

test("primitives and null", () => {
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(undefined), "~undefined");
  assert.equal(canonicalize("a\"b"), `"a\\"b"`);
  assert.equal(canonicalize(1.5), "1.5");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
});

test("non-finite numbers get tagged placeholders", () => {
  assert.equal(canonicalize(Number.POSITIVE_INFINITY), "~num:Infinity");
  assert.equal(canonicalize(Number.NaN), "~num:NaN");
});

test("exotic values get stable ~-tagged placeholders", () => {
  assert.equal(canonicalize(10n), "~bigint:10");
  assert.equal(canonicalize(Symbol("s")), "~symbol:Symbol(s)");
  assert.equal(canonicalize(function named() {}), "~function:named");
  assert.equal(canonicalize(() => {}), "~function:");
});

test("Date, RegExp, and Error are rendered stably", () => {
  assert.equal(
    canonicalize(new Date(1700000000000)),
    "~date:2023-11-14T22:13:20.000Z",
  );
  assert.equal(canonicalize(new Date(NaN)), "~date:invalid");
  assert.equal(canonicalize(/a+b/i), "~re:a+b~i");
  assert.equal(
    canonicalize(new TypeError("boom")),
    "~error:TypeError:boom",
  );
});

test("object keys are sorted (UTF-16 order)", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({}), "{}");
});

test("array order is preserved (significant)", () => {
  assert.equal(canonicalize([1, 2]), "[1,2]");
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  assert.equal(canonicalize([]), "[]");
});

test("nested structures", () => {
  assert.equal(
    canonicalize({ a: [{ b: [1, null, "x"] }] }),
    '{"a":[{"b":[1,null,"x"]}]}',
  );
});

test("Maps render entry pairs in iteration order", () => {
  assert.equal(canonicalize(new Map([["k", 1]])), `[["k",1]]`);
  assert.equal(canonicalize(new Map()), "[]");
});

test("Sets render values in iteration order", () => {
  assert.equal(canonicalize(new Set([1, 2])), "[1,2]");
});

test("typed arrays render as their values", () => {
  assert.equal(canonicalize(new Uint8Array([1, 2, 3])), "[1,2,3]");
});

test("determinism: same value, same string (repeated calls)", () => {
  const value = { b: [1, { c: new Set([1]) }], a: null };
  assert.equal(canonicalize(value), canonicalize(value));
  // Key order in the input object must not matter.
  assert.equal(
    canonicalize({ b: 2, a: 1, c: [3] }),
    canonicalize({ a: 1, c: [3], b: 2 }),
  );
});

test("input is never mutated", () => {
  const value = { b: 2, a: [1, 2] };
  const before = canonicalize(value);
  canonicalize(value);
  assert.deepEqual(value, { b: 2, a: [1, 2] });
  assert.equal(canonicalize(value), before);
});

test("self-referential object cuts with ~circular", () => {
  const value: Record<string, unknown> = { name: "x" };
  value.self = value;
  assert.equal(canonicalize(value), '{"name":"x","self":~circular}');
});

test("self-referential array cuts with ~circular", () => {
  const value: unknown[] = [];
  value.push(value);
  assert.equal(canonicalize(value), "[~circular]");
});

test("self-referential Map terminates (no infinite loop)", () => {
  const map = new Map<string, unknown>();
  map.set("self", map);
  map.set("k", 1);
  const out = canonicalize(map);
  // Entries render in iteration order: ["self", map] then ["k", 1].
  assert.equal(out, `[["self",~circular],["k",1]]`);
});

test("self-referential Set terminates (no infinite loop)", () => {
  const set = new Set<unknown>();
  set.add(1);
  set.add(set);
  assert.equal(canonicalize(set), "[1,~circular]");
});

test("mutually recursive Map/Set pair terminates", () => {
  const a = new Map<string, unknown>();
  const b = new Set<unknown>();
  a.set("b", b);
  b.add(a);
  const out = canonicalize({ a, b });
  assert.match(out, /~circular/);
});

test("inProgress bookkeeping: same Map in two siblings is fully walked twice", () => {
  const map = new Map([["k", 1]]);
  const out = canonicalize({ a: map, b: map });
  assert.equal(out, `{"a":[["k",1]],"b":[["k",1]]}`);
});

test("very deep nesting does not overflow the call stack", () => {
  // The sanitizer's depth-3000 test shape is explicitly a requirement.
  const depth = 3000;
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i++) value = { next: value };
  const out = canonicalize(value);
  // `{"next":` per level + innermost `{"leaf":true}` + `}` per level.
  assert.equal(out, `{"next":`.repeat(depth) + `{"leaf":true}` + `}`.repeat(depth));
});
