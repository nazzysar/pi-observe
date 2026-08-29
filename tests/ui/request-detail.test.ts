/**
 * P0.3 — Request detail component tests: section navigation, OVERVIEW
 * metadata/warnings, SYSTEM prompt + options, CONTEXT expand/collapse,
 * TOOLS extraction with unknown fallback, RAW sanitized payload,
 * scrolling, and back/close behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionStore } from "../../src/store.ts";
import { RequestDetailComponent } from "../../src/ui/request-detail.ts";
import { fakeTheme, fakeTui, seedStore } from "./helpers.ts";

function detailFor(store: SessionStore, rows = 40): {
  detail: RequestDetailComponent;
  tui: ReturnType<typeof fakeTui>;
  state: { backed: boolean; closed: boolean };
} {
  const tui = fakeTui(rows);
  const record = store.getLatestRequest()!;
  const state = { backed: false, closed: false };
  const detail = new RequestDetailComponent({
    tui,
    theme: fakeTheme(),
    record,
    onBack: () => {
      state.backed = true;
    },
    onClose: () => {
      state.closed = true;
    },
  });
  return { detail, tui, state };
}

const TAB = "\u0009";
const SHIFT_TAB = "\u001b[Z";
const ENTER = "\u000d";

test("renders title, tabs, and metadata line", () => {
  const { detail } = detailFor(seedStore({ requests: 1 }));
  const lines = detail.render(100);
  assert.ok(lines[0]!.includes("Pi Request Inspector — req-1"));
  assert.ok(lines[1]!.includes("OVERVIEW"));
  assert.ok(lines[1]!.includes("RAW"));
  assert.ok(
    lines.some((l) => l.includes("run-1") && l.includes("openrouter/deepseek-v4")),
    "metadata line has run + model",
  );
});

test("OVERVIEW shows metadata, shape, counts, and warnings", () => {
  // Force a missing-logical-context warning: request with no pending context.
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "sys",
    systemPromptOptions: { cwd: "/tmp" },
    model: { id: "openrouter/deepseek-v4", provider: "openrouter" },
    thinkingLevel: "high",
    timestamp: 1,
  });
  store.onAgentStart();
  store.onBeforeProviderRequest({
    payload: { model: "openrouter/deepseek-v4", messages: [{ role: "user", content: "hi" }] },
    model: { id: "openrouter/deepseek-v4", provider: "openrouter" },
    thinkingLevel: "high",
    contextUsage: { tokens: 41800, contextWindow: 128000, percent: 32 },
    timestamp: 1700000000000,
  });
  const { detail } = detailFor(store);
  const lines = detail.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Request ID"));
  assert.ok(text.includes("req-1"));
  assert.ok(text.includes("run-1"));
  assert.ok(text.includes("OpenAI-like"), "detected provider shape");
  assert.ok(text.includes("41.8k / 128k"), "context usage");
  assert.ok(text.includes("high"), "thinking level");
  assert.ok(text.includes("missing-logical-context"), "warning surfaced");
});

test("SYSTEM shows effective prompt and structured systemPromptOptions", () => {
  const { detail } = detailFor(seedStore({ requests: 1 }));
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → SYSTEM
  const lines = detail.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Effective system prompt"));
  assert.ok(text.includes("You are Pi. run one"), "system prompt text");
  assert.ok(text.includes("systemPromptOptions"), "options section");
  assert.ok(text.includes('"selectedTools"'), "structured options JSON");
  assert.ok(text.includes('"promptGuidelines"'));
});

test("CONTEXT shows logical messages and expands full content", () => {
  const { detail, tui } = detailFor(seedStore({ requests: 1 }));
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT
  const collapsed = detail.render(120);
  const collapsedText = collapsed.join("\n");
  assert.ok(collapsedText.includes("Logical message context"));
  assert.ok(collapsedText.includes("[0] user: user message 10"), "message summary");
  assert.ok(collapsedText.includes("assistant"), "assistant summary");

  // Enter expands the selected (first) message: full content appears.
  detail.handleInput(ENTER);
  const expanded = detail.render(120).join("\n");
  assert.ok(expanded.includes("user message 10"), "full text content");
  detail.handleInput(ENTER); // collapse again
  const recollapsed = detail.render(120).join("\n");
  assert.ok(!recollapsed.split("\n").some((l) => l.trim() === "user message 10"));
  assert.ok(tui.renderCount > 0, "interaction requested renders");
});

test("TOOLS shows extracted definitions and expands raw schema", () => {
  const { detail } = detailFor(seedStore({ requests: 1 }));
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → TOOLS
  const lines = detail.render(120);
  const text = lines.join("\n");
  assert.ok(text.includes("Provider tool definitions"));
  assert.ok(text.includes("[0] read — Read a file from disk"), "name + description");
  assert.ok(text.includes("[1] bash — Execute a bash command"));

  detail.handleInput(ENTER); // expand first tool
  const expanded = detail.render(120).join("\n");
  assert.ok(expanded.includes('"parameters"'), "raw tool schema shown");
  assert.ok(expanded.includes('"name": "read"'));
});

test("unknown provider schema falls back explicitly and never fabricates tools", () => {
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
  // Unknown shape: no extractable tools, no messages array.
  store.onBeforeProviderRequest({
    payload: { weird: { nested: true }, blob: "x" },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → TOOLS
  const text = detail.render(120).join("\n");
  assert.ok(text.includes("could not be interpreted"), "explicit fallback");
  assert.ok(text.includes("RAW"), "directs the user to RAW");
  assert.ok(!text.includes("[0]"), "no fabricated tool rows");
});

test("RAW shows the sanitized observed payload", () => {
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
  store.onBeforeProviderRequest({
    payload: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "super-secret-value",
    },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → RAW
  const text = detail.render(120).join("\n");
  assert.ok(text.includes("observed by this extension"), "truthful label");
  assert.ok(text.includes('"messages"'), "payload JSON rendered");
  assert.ok(text.includes("[REDACTED]"), "credentials redacted");
  assert.ok(!text.includes("super-secret-value"), "secret never rendered");
});

test("section switching via arrows, tab, shift+tab, and digits", () => {
  const { detail } = detailFor(seedStore({ requests: 1 }));
  assert.equal(detail.section, "OVERVIEW");
  detail.handleInput("\u001b[C"); // right
  assert.equal(detail.section, "DIFF");
  detail.handleInput("\u001b[C");
  assert.equal(detail.section, "SYSTEM");
  detail.handleInput("\u001b[C");
  assert.equal(detail.section, "CONTEXT");
  detail.handleInput("\u001b[D"); // left
  assert.equal(detail.section, "SYSTEM");
  detail.handleInput(SHIFT_TAB);
  detail.handleInput(SHIFT_TAB);
  assert.equal(detail.section, "OVERVIEW");
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → RAW (OVERVIEW → DIFF → SYSTEM → CONTEXT → TOOLS → RAW)
  assert.equal(detail.section, "RAW");
  detail.handleInput(TAB); // wraps around to OVERVIEW
  assert.equal(detail.section, "OVERVIEW");
  detail.handleInput("5");
  assert.equal(detail.section, "TOOLS");
  detail.handleInput("2");
  assert.equal(detail.section, "DIFF");
  detail.handleInput("d");
  assert.equal(detail.section, "DIFF", "d jumps to the DIFF tab");
});

test("esc and q trigger back; back to the ledger is the detail's only exit", () => {
  const a = detailFor(seedStore({ requests: 1 }));
  a.detail.handleInput("\u001b");
  assert.equal(a.state.backed, true);
  assert.equal(a.state.closed, false);
  const b = detailFor(seedStore({ requests: 1 }));
  b.detail.handleInput("q");
  assert.equal(b.state.backed, true);
});

test("scrolling inside long sections keeps every line reachable", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext(
    Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `message ${i}` })),
    undefined,
    1,
  );
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store, 30);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT
  const first = detail.render(100).join("\n");
  assert.ok(first.includes("[0] user: message 0"));
  detail.handleInput("\u001b[F"); // end
  const last = detail.render(100).join("\n");
  assert.ok(last.includes("[59] user: message 59"), "last message reachable");
});

test("scrolling inside one large expanded entry reaches the tail", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  const body = Array.from({ length: 80 }, (_, i) => `detail line ${i}`).join("\n");
  store.onContext([{ role: "user", content: body }], undefined, 1);
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store, 30); // contentRows() = 22
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT
  detail.handleInput(ENTER); // expand the single message
  const head = detail.render(100).join("\n");
  assert.ok(head.includes("detail line 0"), "head visible after expand");
  assert.ok(!head.includes("detail line 79"), "tail clipped initially");

  detail.handleInput("\u001b[F"); // end → last row of the expanded entry
  const tail = detail.render(100).join("\n");
  assert.ok(tail.includes("detail line 79"), "tail reachable with End");
  assert.ok(tail.includes("[0] user"), "cursor summary pinned at the cut");
  assert.ok(
    !tail.split("\n").some((l) => l === "detail line 0"),
    "head not re-rendered as a row when scrolled to tail",
  );

  detail.handleInput("\u001b[6~"); // page down
  const paged = detail.render(100).join("\n");
  assert.ok(paged.includes("detail line 79"), "PageDown keeps the tail visible");
  assert.ok(paged.includes("[0] user"), "summary stays pinned across PageDown");
  assert.ok(
    !paged.split("\n").some((l) => l === "detail line 0"),
    "PageDown does not reset to the head",
  );

  detail.handleInput("\u001b[5~");
  detail.handleInput("\u001b[5~");
  detail.handleInput("\u001b[5~"); // page up ×3 → back at the top
  const rehead = detail.render(100).join("\n");
  assert.ok(rehead.includes("detail line 0"), "PageUp reaches the head again");
  assert.ok(!rehead.includes("detail line 79"), "tail clipped at the top");
});

test("multi-line messages render single-line summaries and pin the selection", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext(
    Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content:
        `MSG-${i}: ` +
        Array.from({ length: i === 0 ? 30 : 2 }, (_, j) => `detail-${i}-${j}`).join("\n"),
    })),
    undefined,
    1,
  );
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store, 30);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT

  // Every rendered row is exactly one terminal line: no embedded newlines.
  const collapsed = detail.render(100);
  for (const line of collapsed) {
    assert.ok(!line.includes("\n"), "rendered row contains no raw newline");
  }
  const summaryRow = collapsed.find((l) => l.startsWith("[0] user: MSG-0: detail-0-0 detail-0-1"));
  assert.ok(summaryRow, "summary is a single collapsed line");
  assert.ok(summaryRow!.endsWith("…"), "long summary truncated with ellipsis");

  detail.handleInput(ENTER); // expand message 0 (31 rows tall)
  detail.handleInput("\u001b[6~"); // page down → scroll deep inside entry 0
  const tail = detail.render(100).join("\n");
  assert.ok(tail.includes("[0] user: MSG-0"), "summary pinned while scrolled inside it");
  assert.ok(tail.includes("detail-0-29"), "tail of the expanded entry reachable");
  assert.ok(!tail.includes("[1] assistant"), "no other summary at the cut");
});

test("TOOLS summaries collapse newlines in names and descriptions", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onBeforeProviderRequest({
    payload: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "run",
            description: "line one\nline two",
            parameters: { type: "object" },
          },
        },
      ],
    },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → TOOLS
  const lines = detail.render(120);
  for (const line of lines) {
    assert.ok(!line.includes("\n"), "rendered row contains no raw newline");
  }
  assert.ok(
    lines.some((l) => l.includes("[0] run — line one line two")),
    "description collapsed to a single line",
  );
});

test("expanded details with long lines wrap so the tail is reachable", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  // One giant line: summary shows only the head, expanded details wrap.
  const long = `head-marker ${"w".repeat(3000)} tail-marker-42`;
  store.onContext([{ role: "user", content: long }], undefined, 1);
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store, 30); // contentRows() = 22
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT
  detail.handleInput(ENTER); // expand the single message
  const head = detail.render(60).join("\n");
  assert.ok(head.includes("head-marker"), "head of the long line visible");
  assert.ok(!head.includes("tail-marker-42"), "tail wrapped out of view initially");
  for (const line of detail.render(60)) {
    assert.ok(visibleWidth(line) <= 60, "wrapped detail line exceeds width");
  }
  detail.handleInput("\u001b[F"); // end
  const tail = detail.render(60).join("\n");
  assert.ok(tail.includes("tail-marker-42"), "tail reachable after End");
});

test("malformed records render without crashing (all sections)", () => {
  const store = new SessionStore();
  store.onBeforeProviderRequest({
    payload: null, // malformed-ish payload
    model: undefined,
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 3,
  });
  const { detail } = detailFor(store);
  for (let i = 0; i < 6; i++) {
    const lines = detail.render(80);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 80, "no overflow");
    }
    detail.handleInput(TAB);
  }
  const text = detail.render(80).join("\n");
  assert.ok(text.includes("Unknown"), "unknown shape stated");
});

test("OVERVIEW counts native Gemini tools via the envelope", () => {
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
  // googleSearch + one functionDeclaration: the envelope counts 2 while
  // extraction yields only the functionDeclaration (index 0).
  store.onBeforeProviderRequest({
    payload: {
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [{ name: "web_search" }] },
      ],
    },
    model: { id: "gemini-2.5-flash", provider: "google" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store);
  const text = detail.render(120).join("\n");
  const match = text.match(/Provider tools\s+(\d+)/);
  assert.ok(match, "provider tools row present");
  assert.equal(
    match![1],
    "2",
    "envelope toolCount preferred over the 1 extracted definition",
  );

  // Native-only: envelope counts 1, extraction finds nothing.
  const nativeOnly = new SessionStore();
  nativeOnly.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "sys",
    systemPromptOptions: undefined,
    model: { id: "gemini-2.5-flash", provider: "google" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  nativeOnly.onAgentStart();
  nativeOnly.onBeforeProviderRequest({
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
  const native = detailFor(nativeOnly);
  const nativeText = native.detail.render(120).join("\n");
  const nativeMatch = nativeText.match(/Provider tools\s+(\d+)/);
  assert.ok(nativeMatch, "provider tools row present (native-only)");
  assert.equal(
    nativeMatch![1],
    "1",
    "native tool counted even with zero extracted definitions",
  );
});

test("no tool definitions (understood schema) shows the empty message", () => {
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
  store.onBeforeProviderRequest({
    payload: { model: "m", messages: [{ role: "user", content: "hi" }] }, // no tools
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail } = detailFor(store);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → TOOLS
  const text = detail.render(120).join("\n");
  assert.ok(text.includes("No tool definitions found"), "empty-tools message");
  assert.ok(!text.includes("could not be interpreted"), "schema was understood");
});

test("height-only terminal resize recomputes the detail view", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext(
    Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `message ${i}` })),
    undefined,
    1,
  );
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  const { detail, tui } = detailFor(store, 40); // contentRows() = 40 − 4 header − 3 chrome = 33
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → CONTEXT
  assert.equal(detail.render(100).length, 40); // 4 chrome + 1 title + 1 caption + 33 rows + 1 footer = full viewport

  // Resize only the terminal height; the same width must not hit the cache.
  tui.terminal.rows = 20; // contentRows() = 13
  const short = detail.render(100);
  assert.equal(short.length, 20, "window shrinks with the terminal");

  // Growing back re-clamps the scroll offset (End at 20 rows sat at 47).
  detail.handleInput("\u001b[F");
  tui.terminal.rows = 40; // contentRows() = 33 → max offset 27
  const grown = detail.render(100).join("\n");
  assert.ok(grown.includes("[30] user: message 30"), "offset re-clamped after growth");
  assert.ok(grown.includes("[59] user: message 59"), "tail still visible");
});

test("tabs stay visible on SYSTEM/RAW even with long content", () => {
  const store = new SessionStore();
  store.onBeforeAgentStart({
    prompt: "p",
    systemPrompt: "s",
    systemPromptOptions: undefined,
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    timestamp: 1,
  });
  store.onAgentStart();
  store.onContext([{ role: "user", content: "hi" }], undefined, 1);
  store.onBeforeProviderRequest({
    payload: { messages: [{ role: "user", content: "hi" }] },
    model: { id: "m", provider: "p" },
    thinkingLevel: undefined,
    contextUsage: undefined,
    timestamp: 2,
  });
  // The most recent record holds the long system prompt and payload.
  const longRecord = store.getLatestRequest()!;
  longRecord.prompt = {
    systemPrompt: Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"),
    systemPromptOptions: { cwd: "/tmp" },
    model: undefined,
    thinkingLevel: undefined,
    timestamp: 1,
  };
  longRecord.sanitizedProviderPayload = {
    data: Array.from({ length: 200 }, (_, i) => `item ${i}`).join("\n"),
  };
  const { detail } = detailFor(store, 30); // contentRows() = 30 − 7 = 23
  const assertTabsVisible = (label: string): void => {
    const lines = detail.render(100);
    assert.ok(
      lines[0]!.includes("Pi Request Inspector"),
      `${label}: inspector title stays visible`,
    );
    assert.ok(lines[1]!.includes("OVERVIEW"), `${label}: tabs stay visible`);
    assert.ok(lines[1]!.includes("RAW"), `${label}: RAW tab label visible`);
    assert.ok(
      lines.length <= 30,
      `${label}: total lines fill but never overflow the viewport (30 rows)`,
    );
  };
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → SYSTEM
  assertTabsVisible("SYSTEM");
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → RAW
  assertTabsVisible("RAW");
});
