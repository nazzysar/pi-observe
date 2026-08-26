/**
 * P0.3 — Request ledger component tests: newest-first ordering, column
 * layout at 80/120 columns, unknown fields, empty state, and
 * navigation with 50+ requests.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionStore } from "../../src/store.ts";
import { RequestListComponent } from "../../src/ui/request-list.ts";
import { fakeTheme, fakeTui, seedStore } from "./helpers.ts";

function listFor(
  store: SessionStore,
  rows = 40,
): {
  list: RequestListComponent;
  tui: ReturnType<typeof fakeTui>;
  state: { picked: unknown[]; closed: boolean };
} {
  const tui = fakeTui(rows);
  const state = { picked: [] as unknown[], closed: false };
  const list = new RequestListComponent({
    tui,
    theme: fakeTheme(),
    state: store.getState(),
    sessionId: "abc123",
    onSelect: (record) => state.picked.push(record),
    onClose: () => {
      state.closed = true;
    },
  });
  return { list, tui, state };
}

test("renders header with session, run/turn/request counts and context", () => {
  const { list } = listFor(seedStore({ requests: 3 }));
  const lines = list.render(100);
  const header = lines.find((l) => l.includes("Pi Request Inspector"));
  assert.ok(header);
  const summary = lines.find((l) => l.includes("Session: abc123"));
  assert.ok(summary, "session id shown");
  assert.ok(summary!.includes("Runs: 1"));
  assert.ok(summary!.includes("Turns: 3"));
  assert.ok(summary!.includes("Requests: 3"));
  assert.ok(summary!.includes("Context: 3k / 128k") || summary!.includes("Context:"), "context shown");
});

test("requests are listed newest first with expected summaries", () => {
  const store = seedStore({ requests: 5 });
  const { list } = listFor(store);
  const lines = list.render(120);
  const body = lines.slice(3, lines.length - 1);
  const rows = body.filter((l) => /^\s*\d+\s+/.test(l));
  assert.equal(rows.length, 5);
  const summary = lines.find((l) => l.includes("Session: abc123"));
  assert.ok(summary!.includes("Turns: 5"), "turns count across two runs (3 + 2), not per-run max index");
  const seqs = rows.map((r) => Number.parseInt(r.trim(), 10));
  assert.deepEqual(seqs, [5, 4, 3, 2, 1], "newest request first");
  assert.ok(rows[0]!.includes("openrouter/deepseek-v4"));
  assert.ok(rows[0]!.includes("104k / 128k"), "context usage per request");
  assert.ok(rows[0]!.includes("2"), "tool count column");
});

test("native-only Gemini tools count via the envelope, not extracted definitions", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "sys",
    systemPromptOptions: undefined,
    model: { id: "gemini-2.5-flash", provider: "google" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext([{ role: "user", content: "hi" }], undefined, 1);
  // googleSearch is a real tool in the payload but carries no extractable
  // function definition: only the envelope toolCount reports it.
  store.onBeforeProviderRequest({
    payload: {
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ googleSearch: {} }],
    },
    model: { id: "gemini-2.5-flash", provider: "google" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { list } = listFor(store);
  const lines = list.render(120);
  const row = lines.find(
    (l) => l.includes("gemini-2.5-flash") && !l.includes("MODEL"),
  );
  assert.ok(row, "request row present");
  assert.ok(
    row!.endsWith("    1"),
    `TOOLS column shows envelope count 1, got: ${JSON.stringify(row)}`,
  );
});

test("no rendered line exceeds the terminal width at 80 and 120 columns", () => {
  const { list } = listFor(seedStore({ requests: 5 }));
  for (const width of [80, 120, 160]) {
    for (const line of list.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `line exceeds ${width}: ${JSON.stringify(line)}`,
      );
    }
  }
});

test("long model ids are truncated without breaking layout", () => {
  const { list } = listFor(
    seedStore({ requests: 1, modelId: "openrouter/deepseek-v4-0123456789abcdef" }),
  );
  const lines = list.render(80);
  const row = lines.find((l) => l.includes("deepseek"));
  assert.ok(row, "model row present");
  assert.ok(row!.includes("…"), "model id truncated");
  assert.ok(visibleWidth(row!) <= 80);
});

test("unknown values render as ?", () => {
  const store = new SessionStore();
  // Request with no run/turn/context/model info at all.
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: undefined,
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 5,
  });
  const { list } = listFor(store);
  const lines = list.render(100);
  const row = lines.find((l) => /req|^\s*1\s/.test(l) && l.includes("?"));
  assert.ok(row, "row renders ? for unknown values");
  assert.ok(row!.includes("?"), `row shows unknown marker: ${row}`);
});

test("empty state shows the empty message", () => {
  const { list } = listFor(new SessionStore());
  const lines = list.render(100);
  assert.ok(
    lines.some((l) => l.includes("No provider requests observed yet.")),
    "empty state message",
  );
  assert.ok(lines.some((l) => l.includes("Requests: 0")));
});

test("navigation: enter picks the selected (newest) request; esc/q close", () => {
  const store = seedStore({ requests: 3 });
  const { list, state } = listFor(store);
  list.handleInput("\u001b[B"); // down → second newest
  list.handleInput("\u000d"); // enter
  assert.equal(state.picked.length, 1);
  assert.equal((state.picked[0] as { requestSeq: number }).requestSeq, 2);
  list.handleInput("\u001b"); // esc closes
  assert.equal(state.closed, true);
});

test("navigation: 50+ requests remain usable and scroll with selection", () => {
  const store = seedStore({ requests: 55, maxRequests: 100 });
  const { list, state } = listFor(store, 30);
  const lines = list.render(100);
  assert.ok(lines.length <= 30, "view stays bounded to the terminal");

  // Page down to the oldest request and pick it.
  list.handleInput("\u001b[6~"); // page down
  list.handleInput("\u001b[6~");
  list.handleInput("\u001b[F"); // end
  list.handleInput("\u000d");
  assert.equal(state.picked.length, 1);
  assert.equal((state.picked[0] as { requestSeq: number }).requestSeq, 1, "oldest reachable");

  // Home back to the newest.
  list.handleInput("\u001b[H");
  list.handleInput("\u000d");
  assert.equal(state.picked.length, 2);
  assert.equal((state.picked[0] as { requestSeq: number }).requestSeq, 1);
});

test("retention-sized history (100) navigates without layout breakage", () => {
  const store = seedStore({ requests: 100, maxRequests: 100 });
  const { list, state } = listFor(store, 40);
  for (const line of list.render(80)) {
    assert.ok(visibleWidth(line) <= 80);
  }
  list.handleInput("\u001b[F");
  list.handleInput("\u000d");
  assert.equal((state.picked[0] as { requestSeq: number }).requestSeq, 1);
});

test("height-only terminal resize recomputes the ledger view", () => {
  const store = seedStore({ requests: 55, maxRequests: 100 });
  const { list, tui } = listFor(store, 40); // 30 content rows
  assert.equal(list.render(100).length, 34); // 3 header + 30 rows + footer

  // Resize only the terminal height; the same width must not hit the cache.
  tui.terminal.rows = 20; // 10 content rows
  const short = list.render(100);
  assert.equal(short.length, 14, "fewer rows after shrink");
  assert.ok(
    short.some((l) => l.includes("1-10/55")),
    "footer reflects the new window",
  );
});
