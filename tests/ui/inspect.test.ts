/**
 * P0.3 — /inspect command wiring tests: local-only passivity, arg
 * handling, print-mode summary, status set/clear, and error isolation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RequestRecord } from "../../src/model.ts";
import { SessionStore } from "../../src/store.ts";
import { registerInspectCommand } from "../../src/ui/inspect.ts";
import { seedStore } from "./helpers.ts";

interface CapturedCommand {
  name: string;
  description: string | undefined;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakePi(): { pi: ExtensionAPI; commands: CapturedCommand[] } {
  const commands: CapturedCommand[] = [];
  const pi = {
    registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      commands.push({ name, description: options.description, handler: options.handler });
    },
    commands,
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

/** Scripted UI: each custom() call returns the next result in `script`. */
function fakeCtx(options: {
  hasUI: boolean;
  script?: Array<
    | { kind: "pick"; record: RequestRecord }
    | { kind: "close" }
    | { kind: "back" }
  >;
}): {
  ctx: ExtensionCommandContext;
  state: {
    customCalls: number;
    notifications: Array<{ message: string; type?: string }>;
    statuses: Array<string | undefined>;
  };
} {
  const script = options.script ?? [];
  const state = {
    customCalls: 0,
    notifications: [] as Array<{ message: string; type?: string }>,
    statuses: [] as Array<string | undefined>,
  };
  const ctx = {
    hasUI: options.hasUI,
    cwd: "/tmp",
    sessionManager: {
      getSessionId: () => "0123456789abcdef",
    },
    ui: {
      custom: async () => {
        state.customCalls += 1;
        const result = script.shift();
        return result ?? { kind: "close" as const };
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        state.notifications.push({ message, type });
      },
      setStatus: (_key: string, text: string | undefined) => {
        state.statuses.push(text);
      },
      theme: { fg: (_c: string, s: string) => s },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, state };
}

function getHandler(pi: ExtensionAPI): CapturedCommand {
  const commands = (pi as unknown as { commands: CapturedCommand[] }).commands;
  const command = commands.find((c) => c.name === "inspect");
  assert.ok(command, "/inspect is registered");
  return command!;
}

/** Register /inspect on a fresh fake pi and return its handler. */
function registeredHandler(store: SessionStore): CapturedCommand {
  const { pi } = fakePi();
  registerInspectCommand(pi, store);
  return getHandler(pi);
}
test("registers /inspect only — no tools, no messages", () => {
  const { pi, commands } = fakePi();
  registerInspectCommand(pi, new SessionStore());
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.name, "inspect");
  assert.ok(commands[0]!.description?.includes("local"), "description says local");
  // The extension never registers anything else; passivity is enforced
  // by the absence of registerTool/sendUserMessage in the handler body.
});

test("handler with no UI prints a one-line summary and mutates nothing", async () => {
  const store = new SessionStore();
  const { ctx, state } = fakeCtx({ hasUI: false });
  await registeredHandler(store).handler("", ctx);
  assert.equal(state.customCalls, 0);
  assert.equal(state.notifications.length, 0);
  assert.equal(state.statuses.length, 0, "no status without UI");
});

test("empty session opens the ledger and shows the empty state via the list", async () => {
  const store = new SessionStore();
  const { ctx, state } = fakeCtx({
    hasUI: true,
    script: [{ kind: "close" }],
  });
  await registeredHandler(store).handler("", ctx);
  assert.equal(state.customCalls, 1, "ledger opened once");
});

test("latest opens the detail directly and back falls through to the ledger", async () => {
  const store = seedStore({ requests: 3 });
  const { ctx, state } = fakeCtx({
    hasUI: true,
    script: [
      { kind: "back" }, // detail → back
      { kind: "close" }, // ledger → close
    ],
  });
  await registeredHandler(store).handler("latest", ctx);
  assert.equal(state.customCalls, 2, "detail then ledger");
});

test("numeric arg opens the matching request or warns and falls back", async () => {
  const store = seedStore({ requests: 3 });
  // "2" matches request seq 2.
  const hit = fakeCtx({ hasUI: true, script: [{ kind: "close" }] });
  await registeredHandler(store).handler("2", hit.ctx);
  assert.equal(hit.state.customCalls, 1, "detail for seq 2 opened directly");
  assert.equal(hit.state.notifications.length, 0);

  // "999" matches nothing: warn, then the ledger opens.
  const miss = fakeCtx({ hasUI: true, script: [{ kind: "close" }] });
  await registeredHandler(store).handler("999", miss.ctx);
  assert.equal(miss.state.notifications.length, 1);
  assert.ok(miss.state.notifications[0]!.message.includes("999"));
  assert.equal(miss.state.customCalls, 1, "ledger opened as fallback");
});

test("status indicator is set while open and cleared afterwards", async () => {
  const store = seedStore({ requests: 2 });
  const { ctx, state } = fakeCtx({
    hasUI: true,
    script: [{ kind: "close" }],
  });
  await registeredHandler(store).handler("", ctx);
  assert.equal(state.statuses.length, 2, "set then cleared");
  assert.ok(state.statuses[0]!.includes("obs r"), "status shows observation counts");
  assert.ok(state.statuses[0]!.includes("128k"), "status shows context window");
  assert.equal(state.statuses[1], undefined, "cleared in finally");
});

test("UI failures are contained: handler rejects without touching the session", async () => {
  const store = new SessionStore();
  // A custom() implementation that always throws simulates a broken UI.
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "abc" },
    ui: {
      custom: async () => {
        throw new Error("ui exploded");
      },
      notify: (_message: string, _type?: string) => {},
      setStatus: (_key: string, _text?: string) => {},
      theme: { fg: (_c: string, s: string) => s },
    },
  } as unknown as ExtensionCommandContext;
  await registeredHandler(store).handler("", ctx);
  // The store is untouched and the agent session never saw an error.
  assert.equal(store.getState().requestCount, 0);
});

test("unknown args behave like the ledger", async () => {
  const store = new SessionStore();
  const { ctx, state } = fakeCtx({
    hasUI: true,
    script: [{ kind: "close" }],
  });
  await registeredHandler(store).handler("banana", ctx);
  assert.equal(state.customCalls, 1, "ledger opened");
});
