/**
 * P0.1 — Recorder: thin wiring between Pi lifecycle events and the
 * observation store. Passive observability only — every handler returns
 * undefined, nothing is registered with the LLM, and no event payload
 * is transformed, replaced, or mutated.
 */

import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { SessionStore } from "./store.ts";

export interface RecorderOptions {
  store: SessionStore;
  /** Clock hook for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Called on session reset, right after store.reset(). Derived views
   * keyed by request sequence (e.g. DiffService, whose cache reuses seq
   * numbers 1, 2, 3… after a reset) must drop cached state here or a
   * new session would be served the previous session's diffs.
   */
  onReset?: () => void;
}

export class Recorder {
  private readonly store: SessionStore;
  private readonly now: () => number;
  private readonly onReset: (() => void) | undefined;

  constructor(options: RecorderOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.onReset = options.onReset;
  }

  /** before_agent_start: allocate run id, snapshot prompt/model/thinking. */
  beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
    this.store.onBeforeAgentStart({
      prompt: event.prompt,
      systemPrompt: event.systemPrompt,
      systemPromptOptions: event.systemPromptOptions,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      timestamp: this.now(),
    });
  }

  /** agent_start: promote pending run; count exactly once. */
  agentStart(_event: AgentStartEvent, _ctx: ExtensionContext): void {
    this.store.onAgentStart();
  }

  /** turn_start: track current turn index. */
  turnStart(event: TurnStartEvent, _ctx: ExtensionContext): void {
    this.store.onTurnStart(event.turnIndex);
  }

  /** turn_end: bookkeeping only. */
  turnEnd(event: TurnEndEvent, _ctx: ExtensionContext): void {
    this.store.onTurnEnd(event.turnIndex);
  }

  /** context: snapshot messages + usage into pending context. */
  context(event: ContextEvent, ctx: ExtensionContext): void {
    this.store.onContext(
      event.messages as unknown[],
      this.safeContextUsage(ctx),
      this.now(),
    );
  }

  /** before_provider_request: canonical commit point. */
  beforeProviderRequest(
    event: BeforeProviderRequestEvent,
    ctx: ExtensionContext,
  ): void {
    this.store.onBeforeProviderRequest({
      payload: event.payload,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      contextUsage: this.safeContextUsage(ctx),
      timestamp: this.now(),
    });
  }

  /** ctx.getContextUsage() can fail; observation must not. */
  private safeContextUsage(ctx: ExtensionContext): unknown {
    try {
      return ctx.getContextUsage();
    } catch {
      return undefined;
    }
  }

  /** agent_end: mark run inactive. */
  agentEnd(_event: AgentEndEvent, _ctx: ExtensionContext): void {
    this.store.onRunEnd();
  }

  /** agent_settled: idempotent run-inactive marker. */
  agentSettled(_event: AgentSettledEvent, _ctx: ExtensionContext): void {
    this.store.onRunEnd();
  }

  /** session_start: full reset (new session, new history). */
  sessionStart(event: SessionStartEvent, _ctx: ExtensionContext): void {
    if (event.reason === "startup") return;
    this.store.reset();
    // The request sequence restarts at 1; let seq-keyed derived views
    // (DiffService) drop anything computed from the previous session.
    this.onReset?.();
  }
}

/** Install all observer handlers on a pi instance. */
export function installObserver(pi: ExtensionAPI, options: RecorderOptions): void {
  const recorder = new Recorder(options);
  pi.on("before_agent_start", (event, ctx) => {
    recorder.beforeAgentStart(event, ctx);
  });
  pi.on("agent_start", (event, ctx) => {
    recorder.agentStart(event, ctx);
  });
  pi.on("turn_start", (event, ctx) => {
    recorder.turnStart(event, ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    recorder.turnEnd(event, ctx);
  });
  pi.on("context", (event, ctx) => {
    recorder.context(event, ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    recorder.beforeProviderRequest(event, ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    recorder.agentEnd(event, ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    recorder.agentSettled(event, ctx);
  });
  pi.on("session_start", (event, ctx) => {
    recorder.sessionStart(event, ctx);
  });
}
