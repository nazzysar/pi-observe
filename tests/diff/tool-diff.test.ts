/**
 * P1 — tool-set normalization and diffing: name-based matching,
 * positional fallback for unnamed tools, key-order-insensitive identity,
 * and best-effort parameter extraction across provider shapes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diffTools, normalizeTool } from "../../src/diff/tool-diff.ts";
import type { ExtractedToolDefinition } from "../../src/model.ts";

function tool(
  index: number,
  name: string | undefined,
  raw: unknown,
  description?: string,
): ExtractedToolDefinition {
  return { index, name, description, raw };
}

test("diffTools: uninterpretable when either side is undefined", () => {
  assert.equal(diffTools(undefined, undefined).uninterpretable, true);
  assert.equal(diffTools([tool(0, "a", {})], undefined).uninterpretable, true);
});

test("diffTools: identical tools are unchanged", () => {
  const tools = [tool(0, "read", { name: "read", description: "d" })];
  const result = diffTools(tools, tools);
  assert.equal(result.uninterpretable, false);
  assert.equal(result.unchanged, 1);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.changed.length, 0);
});

test("diffTools: key order in the schema is not a change", () => {
  const old = [tool(0, "read", { name: "read", params: { a: 1, b: 2 } })];
  const next = [tool(0, "read", { params: { b: 2, a: 1 }, name: "read" })];
  const result = diffTools(old, next);
  assert.equal(result.unchanged, 1);
  assert.equal(result.changed.length, 0);
});

test("diffTools: reordered same-named tools are unchanged", () => {
  const old = [tool(0, "read", { s: 1 }), tool(1, "bash", { s: 2 })];
  const next = [tool(0, "bash", { s: 2 }), tool(1, "read", { s: 1 })];
  const result = diffTools(old, next);
  assert.equal(result.unchanged, 2);
  assert.equal(result.changed.length, 0);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

test("diffTools: added and removed tools", () => {
  const result = diffTools(
    [tool(0, "read", { s: 1 }), tool(1, "edit", { s: 2 })],
    [tool(0, "read", { s: 1 })],
  );
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0]!.name, "edit");
  assert.equal(result.added.length, 0);

  const added = diffTools(
    [tool(0, "read", { s: 1 })],
    [tool(0, "read", { s: 1 }), tool(1, "bash", { s: 3 })],
  );
  assert.equal(added.added.length, 1);
  assert.equal(added.added[0]!.name, "bash");
});

test("diffTools: changed schema reports changed paths", () => {
  const result = diffTools(
    [tool(0, "read", { name: "read", parameters: { type: "object" } })],
    [tool(0, "read", { name: "read", parameters: { type: "string" } })],
  );
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0]!.name, "read");
  assert.equal(result.changed[0]!.oldIndex, 0);
  assert.equal(result.changed[0]!.newIndex, 0);
  assert.ok(result.changed[0]!.changedPaths.includes("$.parameters.type"));
  assert.notEqual(result.changed[0]!.oldHash, result.changed[0]!.newHash);
});

test("unnamed tools are paired positionally", () => {
  const result = diffTools(
    [tool(0, undefined, { s: 1 }), tool(1, undefined, { s: 2 })],
    [tool(0, undefined, { s: 1 }), tool(1, undefined, { s: 9 })],
  );
  assert.equal(result.unchanged, 1);
  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0]!.name, undefined);
});

test("normalizeTool: extracts parameters from known provider shapes", () => {
  // OpenAI chat: function.parameters
  assert.deepEqual(
    normalizeTool(tool(0, "read", { type: "function", function: { name: "read", parameters: { type: "object" } } })).parameters,
    { type: "object" },
  );
  // Responses/custom: top-level parameters
  assert.deepEqual(
    normalizeTool(tool(0, "read", { name: "read", parameters: { p: 1 } })).parameters,
    { p: 1 },
  );
  // Anthropic: input_schema
  assert.deepEqual(
    normalizeTool(tool(0, "read", { name: "read", input_schema: { i: 1 } })).parameters,
    { i: 1 },
  );
  // Bedrock: toolSpec.inputSchema
  assert.deepEqual(
    normalizeTool(tool(0, "read", { name: "read", toolSpec: { inputSchema: { b: 1 } } })).parameters,
    { b: 1 },
  );
  // No known location → undefined
  assert.equal(
    normalizeTool(tool(0, "read", { name: "read" })).parameters,
    undefined,
  );
});

test("normalizeTool: non-string name/description become undefined", () => {
  const normalized = normalizeTool({ index: 0, name: 42 as unknown as string, description: null as unknown as string, raw: {} });
  assert.equal(normalized.name, undefined);
  assert.equal(normalized.description, undefined);
  assert.match(normalized.hash, /^[0-9a-f]{64}$/);
});
