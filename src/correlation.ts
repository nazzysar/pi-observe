/**
 * P0.1 — Correlation: pure functions that turn raw event inputs into
 * observation artifacts (IDs, model identity, prompt snapshots, pending
 * context, request records). The store applies these; nothing here
 * touches Pi or side effects, so everything is unit-testable.
 */

import type {
  ContextUsageSnapshot,
  ModelIdentity,
  ObservationWarning,
  PendingContextSnapshot,
  PromptSnapshot,
  RequestRecord,
  SystemPromptOptionsSnapshot,
  ThinkingLevel,
} from "./model.ts";

export function allocateRunId(seq: number): string {
  return `run-${seq}`;
}

export function allocateRequestId(seq: number): string {
  return `req-${seq}`;
}

/** Extract a provider-neutral identity from a structural Pi `Model`. */
export function buildModelIdentity(model: unknown): ModelIdentity | undefined {
  if (model === null || model === undefined) return undefined;
  const m = model as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.provider !== "string") {
    return undefined;
  }
  return {
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    provider: m.provider,
    api: typeof m.api === "string" ? m.api : "unknown",
    reasoning: m.reasoning === true,
    contextWindow: numberOr(m.contextWindow, 0),
    maxTokens: numberOr(m.maxTokens, 0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Structural snapshot of Pi's `ContextUsage` (or undefined). */
export function buildContextUsageSnapshot(
  usage: unknown,
): ContextUsageSnapshot | undefined {
  if (usage === null || usage === undefined) return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u.contextWindow !== "number") return undefined;
  return {
    tokens: typeof u.tokens === "number" ? u.tokens : null,
    contextWindow: u.contextWindow,
    percent: typeof u.percent === "number" ? u.percent : null,
  };
}

/** Snapshot of the system prompt and its construction options. */
export function buildPromptSnapshot(input: {
  systemPrompt: string;
  systemPromptOptions: unknown;
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  timestamp: number;
}): PromptSnapshot {
  return {
    systemPrompt: input.systemPrompt,
    systemPromptOptions: input.systemPromptOptions as SystemPromptOptionsSnapshot,
    model: buildModelIdentity(input.model),
    thinkingLevel: input.thinkingLevel,
    timestamp: input.timestamp,
  };
}

/** Snapshot of the latest logical context, correlated to run/turn. */
export function buildPendingContext(input: {
  messages: unknown[];
  contextUsage: unknown;
  runId: string | undefined;
  turnIndex: number | undefined;
  timestamp: number;
}): PendingContextSnapshot {
  return {
    messages: input.messages,
    contextUsage: buildContextUsageSnapshot(input.contextUsage),
    runId: input.runId,
    turnIndex: input.turnIndex,
    timestamp: input.timestamp,
  };
}

export interface AssembleRequestRecordInput {
  requestId: string;
  requestSeq: number;
  /** Run id carried by the pending context, else the active run. */
  runId: string | undefined;
  /** Turn index carried by the pending context, else the active turn. */
  turnIndex: number | undefined;
  timestamp: number;
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  prompt: PromptSnapshot | undefined;
  /** Consumed pending context (undefined when none was pending). */
  logicalContext: unknown[] | undefined;
  sanitizedProviderPayload: unknown;
  contextUsage: unknown;
  warnings: ObservationWarning[];
}

/** Assemble the canonical record for one observed provider request. */
export function assembleRequestRecord(
  input: AssembleRequestRecordInput,
): RequestRecord {
  return {
    requestId: input.requestId,
    requestSeq: input.requestSeq,
    runId: input.runId,
    turnIndex: input.turnIndex,
    timestamp: input.timestamp,
    model: buildModelIdentity(input.model),
    thinkingLevel: input.thinkingLevel,
    prompt: input.prompt,
    logicalContext: input.logicalContext,
    sanitizedProviderPayload: input.sanitizedProviderPayload,
    providerEnvelope: undefined,
    contextUsage: buildContextUsageSnapshot(input.contextUsage),
    warnings: input.warnings,
  };
}

export function missingContextWarning(timestamp: number): ObservationWarning {
  return {
    code: "missing-logical-context",
    message: "before_provider_request fired with no pending context event",
    timestamp,
  };
}

export function cloneIncompleteWarning(
  detail: string,
  timestamp: number,
): ObservationWarning {
  return {
    code: "clone-incomplete",
    message: `payload snapshot incomplete: ${detail}`,
    timestamp,
  };
}
