/**
 * P0.3 — Extension entry-point passivity test: loading the complete
 * extension must only subscribe to observer events and register the
 * local /inspect command — never tools, never message sends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../../src/index.ts";

function fakePi(): {
  pi: ExtensionAPI;
  events: string[];
  commands: string[];
  tools: string[];
  messages: unknown[];
} {
  const state = { events: [] as string[], commands: [] as string[], tools: [] as string[], messages: [] as unknown[] };
  const pi = {
    on: (event: string) => {
      state.events.push(event);
    },
    registerCommand: (name: string) => {
      state.commands.push(name);
    },
    registerTool: () => {
      state.tools.push("tool");
    },
    sendMessage: (message: unknown) => {
      state.messages.push(message);
    },
    sendUserMessage: (content: unknown) => {
      state.messages.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, ...state };
}

test("extension entry registers observer events and /inspect only", () => {
  const { pi, events, commands, tools, messages } = fakePi();
  const result = extensionFactory(pi);
  assert.equal(result, undefined, "factory returns nothing (no async work)");

  // Observer events (P0.1) — same set as before P0.3.
  const expectedEvents = [
    "before_agent_start",
    "agent_start",
    "turn_start",
    "turn_end",
    "context",
    "before_provider_request",
    "agent_end",
    "agent_settled",
    "session_start",
  ];
  for (const event of expectedEvents) {
    assert.ok(events.includes(event), `subscribes to ${event}`);
  }

  // P0.3: exactly one command, the local inspector.
  assert.deepEqual(commands, ["inspect"]);

  // Passivity: no LLM-callable tools, no message sends.
  assert.deepEqual(tools, [], "no LLM tools registered");
  assert.deepEqual(messages, [], "no messages sent to the model");
});
