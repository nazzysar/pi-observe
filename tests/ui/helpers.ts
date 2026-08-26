/**
 * P0.3 — Test helpers for UI components: fake theme/TUI and a store
 * seeded with realistic requests across runs/turns.
 */

import type { SessionObservationState } from "../../src/model.ts";
import { SessionStore } from "../../src/store.ts";
import type { InspectorTheme, ViewerTui } from "../../src/ui/text-viewer.ts";

/** Identity theme: colors are stripped, layout is what tests assert. */
export function fakeTheme(): InspectorTheme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

export interface FakeTui extends ViewerTui {
  renderCount: number;
}

export function fakeTui(rows = 40): FakeTui {
  const tui: FakeTui = {
    terminal: { rows },
    renderCount: 0,
    requestRender: () => {
      tui.renderCount += 1;
    },
  };
  return tui;
}

export interface SeedOptions {
  requests?: number;
  maxRequests?: number;
  /** Model id used for every request. */
  modelId?: string;
}

/**
 * Seed a store with `requests` provider requests across two runs and
 * several turns, using a realistic openai-chat payload with tools.
 */
export function seedStore(options: SeedOptions = {}): SessionStore {
  const count = options.requests ?? 3;
  const store = new SessionStore({ maxRequests: options.maxRequests ?? 100 });
  const modelId = options.modelId ?? "openrouter/deepseek-v4";

  const startRun = (prompt: string, turnStart: number, turnEnd: number) => {
    store.onBeforeAgentStart({
      prompt,
      systemPrompt: `You are Pi. ${prompt}`,
      systemPromptOptions: {
        cwd: "/tmp/project",
        selectedTools: ["read", "bash", "edit"],
        promptGuidelines: ["be concise"],
      },
      model: { id: modelId, provider: "openrouter", api: "openai-completions" },
      thinkingLevel: "high",
      timestamp: 1,
    });
    store.onAgentStart();
    for (let turn = turnStart; turn <= turnEnd; turn++) {
      store.onTurnStart(turn);
    }
  };

  const request = (payload: unknown, timestamp: number) => {
    store.onContext(
      [
        { role: "user", content: `user message ${timestamp}` },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      { tokens: 1000 * timestamp, contextWindow: 128000, percent: 1 },
      timestamp,
    );
    store.onBeforeProviderRequest({
      payload,
      model: { id: modelId, provider: "openrouter", api: "openai-completions" },
      thinkingLevel: "high",
      contextUsage: { tokens: 1000 * timestamp, contextWindow: 128000, percent: 1 },
      timestamp,
    });
  };

  const payload = (ts: number) => ({
    model: modelId,
    messages: [
      { role: "system", content: "You are Pi." },
      { role: "user", content: `prompt ${ts}` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file from disk",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      {
        type: "function",
        function: {
          name: "bash",
          description: "Execute a bash command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ],
    max_tokens: 8192,
  });

  startRun("run one", 1, 3);
  for (let i = 0; i < Math.min(count, 3); i++) {
    request(payload(10 + i), 10 + i);
  }
  if (count > 3) {
    startRun("run two", 1, 2);
    for (let i = 3; i < count; i++) {
      request(payload(100 + i), 100 + i);
    }
  }
  return store;
}

export function seedState(options: SeedOptions = {}): SessionObservationState {
  return seedStore(options).getState();
}
