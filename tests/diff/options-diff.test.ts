/**
 * P1 — per-field prompt-option diffs: special-field details
 * (text lengths, name sets, key sets, counts, cwd), canonical
 * equality, and the 8 tracked fields only.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { optionFieldDiffs } from "../../src/diff/options-diff.ts";
import type { SystemPromptOptionsSnapshot } from "../../src/model.ts";

function field(result: ReturnType<typeof optionFieldDiffs>, name: string) {
  const entry = result.find((f) => f.field === name);
  assert.ok(entry, `field ${name} present`);
  return entry!;
}

test("both sides undefined → no tracked fields", () => {
  assert.deepEqual(optionFieldDiffs(undefined, undefined), []);
});

test("identical options: every tracked field equal", () => {
  const options: SystemPromptOptionsSnapshot = {
    cwd: "/tmp",
    customPrompt: "p",
    selectedTools: ["read", "bash"],
    promptGuidelines: ["be concise"],
    toolSnippets: { read: "snip" },
  };
  const result = optionFieldDiffs(options, { ...options });
  assert.equal(result.length, 8);
  for (const entry of result) {
    assert.equal(entry.equal, true, entry.field);
    assert.equal(entry.detail, "unchanged");
  }
});

test("untracked fields are not reported", () => {
  const result = optionFieldDiffs({ cwd: "/a", foo: 1 }, { cwd: "/a", foo: 2 });
  for (const entry of result) assert.equal(entry.equal, true);
});

test("customPrompt: length change, added, removed", () => {
  const changed = field(
    optionFieldDiffs({ cwd: "/a", customPrompt: "a" }, { cwd: "/a", customPrompt: "abc" }),
    "customPrompt",
  );
  assert.equal(changed.equal, false);
  assert.equal(changed.detail, "1 → 3 chars");

  const added = field(
    optionFieldDiffs({ cwd: "/a" }, { cwd: "/a", customPrompt: "hello" }),
    "customPrompt",
  );
  assert.equal(added.detail, "added (5 chars)");

  const removed = field(
    optionFieldDiffs({ cwd: "/a", customPrompt: "x" }, { cwd: "/a" }),
    "customPrompt",
  );
  assert.equal(removed.detail, "removed");
});

test("appendSystemPrompt uses the same text detail", () => {
  const entry = field(
    optionFieldDiffs({ cwd: "/a", appendSystemPrompt: "one" }, { cwd: "/a", appendSystemPrompt: "two!" }),
    "appendSystemPrompt",
  );
  assert.equal(entry.detail, "3 → 4 chars");
});

test("cwd: string → string and missing", () => {
  assert.equal(
    field(optionFieldDiffs({ cwd: "/a" }, { cwd: "/b" }), "cwd").detail,
    "/a → /b",
  );
  assert.equal(
    field(optionFieldDiffs({ cwd: "/a" }, { cwd: 5 as unknown as string }), "cwd").detail,
    "/a → number",
  );
  assert.equal(
    field(optionFieldDiffs({ cwd: "/a" }, {} as SystemPromptOptionsSnapshot), "cwd").detail,
    "/a → undefined",
  );
});

test("selectedTools: added/removed names, capped", () => {
  const entry = field(
    optionFieldDiffs(
      { cwd: "/a", selectedTools: ["read", "bash"] },
      { cwd: "/a", selectedTools: ["read", "edit"] },
    ),
    "selectedTools",
  );
  assert.equal(entry.equal, false);
  assert.equal(entry.detail, "+ edit, - bash");

  const capped = field(
    optionFieldDiffs(
      { cwd: "/a", selectedTools: ["read"] },
      { cwd: "/a", selectedTools: ["read", "a", "b", "c", "d", "e"] },
    ),
    "selectedTools",
  );
  assert.equal(capped.detail, "+ a, + b, + c (+2 more)");

  // Reorder without add/remove is a change with no names.
  const reordered = field(
    optionFieldDiffs(
      { cwd: "/a", selectedTools: ["a", "b"] },
      { cwd: "/a", selectedTools: ["b", "a"] },
    ),
    "selectedTools",
  );
  assert.equal(reordered.equal, false);
  assert.equal(reordered.detail, "changed");
});

test("contextFiles use their path", () => {
  const entry = field(
    optionFieldDiffs(
      { cwd: "/a" },
      { cwd: "/a", contextFiles: [{ path: "/x/AGENTS.md", content: "c" }] },
    ),
    "contextFiles",
  );
  assert.equal(entry.detail, "+ /x/AGENTS.md");
});

test("toolSnippets: key-set detail", () => {
  const entry = field(
    optionFieldDiffs(
      { cwd: "/a", toolSnippets: { read: "s" } },
      { cwd: "/a", toolSnippets: { read: "s", bash: "s" } },
    ),
    "toolSnippets",
  );
  assert.equal(entry.detail, "+ bash");
});

test("promptGuidelines: count detail", () => {
  const entry = field(
    optionFieldDiffs(
      { cwd: "/a", promptGuidelines: ["g"] },
      { cwd: "/a", promptGuidelines: ["g", "h"] },
    ),
    "promptGuidelines",
  );
  assert.equal(entry.detail, "1 → 2 entries");
});

test("skills use their name property", () => {
  const entry = field(
    optionFieldDiffs(
      { cwd: "/a", skills: [{ name: "one" }] },
      { cwd: "/a", skills: [{ name: "one" }, { name: "two" }] },
    ),
    "skills",
  );
  assert.equal(entry.detail, "+ two");
});
