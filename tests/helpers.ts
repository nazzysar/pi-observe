/**
 * Test helpers: build fake Pi events/contexts for the recorder.
 */

import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Recorder } from "../src/recorder.ts";

let seq = 0;
export function resetSeq(): void {
  seq = 0;
}
function nextNum(): number {
  seq += 1;
  return seq;
}

export interface FakeModelInput {
  id?: string;
  name?: string;
  provider?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export function fakeModel(input: FakeModelInput = {}): Record<string, unknown> {
  return {
    id: input.id ?? `model-${nextNum()}`,
    name: input.name ?? "Fake Model",
    provider: input.provider ?? "fake-provider",
    api: input.api ?? "openai-completions",
    reasoning: input.reasoning ?? false,
    contextWindow: input.contextWindow ?? 128000,
    maxTokens: input.maxTokens ?? 8192,
  };
}

export interface FakeCtxInput {
  model?: unknown;
  thinkingLevel?: unknown;
  contextUsage?: unknown;
}

export function fakeCtx(input: FakeCtxInput = {}): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {} as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: input.model as ExtensionContext["model"],
    thinkingLevel: input.thinkingLevel as ExtensionContext["thinkingLevel"],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => input.contextUsage,
    getSystemPrompt: () => "sys",
    compact: () => {},
    ui: {} as ExtensionContext["ui"],
  } as ExtensionContext;
}

export function beforeAgentStartEvent(
  overrides: Partial<BeforeAgentStartEvent> = {},
): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: `prompt-${nextNum()}`,
    systemPrompt: `system-prompt-${nextNum()}`,
    systemPromptOptions: { cwd: "/tmp", selectedTools: ["read", "bash"] },
    ...overrides,
  } as BeforeAgentStartEvent;
}

export function agentStartEvent(): AgentStartEvent {
  return { type: "agent_start" };
}

export function turnStartEvent(index: number): TurnStartEvent {
  return { type: "turn_start", turnIndex: index, timestamp: Date.now() };
}

export function turnEndEvent(index: number): TurnEndEvent {
  return {
    type: "turn_end",
    turnIndex: index,
    message: { role: "assistant", content: [] },
    toolResults: [],
  } as unknown as TurnEndEvent;
}

export function contextEvent(messages: unknown[]): ContextEvent {
  return { type: "context", messages: messages as ContextEvent["messages"] };
}

export function providerRequestEvent(payload: unknown): BeforeProviderRequestEvent {
  return { type: "before_provider_request", payload };
}

export function agentEndEvent(): AgentEndEvent {
  return { type: "agent_end", messages: [] } as AgentEndEvent;
}

export function agentSettledEvent(): AgentSettledEvent {
  return { type: "agent_settled" };
}

export function sessionStartEvent(reason: SessionStartEvent["reason"]): SessionStartEvent {
  return { type: "session_start", reason };
}

export interface HandlerReturn {
  method: keyof Recorder;
  value: unknown;
}

/** Call a recorder handler and record its return value. */
export function invoke<K extends keyof Recorder>(
  recorder: Recorder,
  method: K,
  ...args: Parameters<Recorder[K]>
): HandlerReturn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = (recorder[method] as any)(...args);
  return { method, value };
}
