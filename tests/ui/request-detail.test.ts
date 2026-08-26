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
  assert.equal(detail.section, "SYSTEM");
  detail.handleInput("\u001b[C");
  assert.equal(detail.section, "CONTEXT");
  detail.handleInput("\u001b[D"); // left
  assert.equal(detail.section, "SYSTEM");
  detail.handleInput(SHIFT_TAB);
  assert.equal(detail.section, "OVERVIEW");
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB);
  detail.handleInput(TAB); // → RAW (wraps from CONTEXT through TOOLS)
  assert.equal(detail.section, "RAW");
  detail.handleInput(TAB); // wraps around to OVERVIEW
  assert.equal(detail.section, "OVERVIEW");
  detail.handleInput("4");
  assert.equal(detail.section, "TOOLS");
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
  detail.handleInput(TAB); // → CONTEXT
  const first = detail.render(100).join("\n");
  assert.ok(first.includes("[0] user: message 0"));
  detail.handleInput("\u001b[F"); // end
  const last = detail.render(100).join("\n");
  assert.ok(last.includes("[59] user: message 59"), "last message reachable");
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
  for (let i = 0; i < 5; i++) {
    const lines = detail.render(80);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 80, "no overflow");
    }
    detail.handleInput(TAB);
  }
  const text = detail.render(80).join("\n");
  assert.ok(text.includes("Unknown"), "unknown shape stated");
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
  detail.handleInput(TAB); // → TOOLS
  const text = detail.render(120).join("\n");
  assert.ok(text.includes("No tool definitions found"), "empty-tools message");
  assert.ok(!text.includes("could not be interpreted"), "schema was understood");
});
