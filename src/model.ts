/**
 * P0.1 — Observation Core: shared observation types.
 *
 * Dependency-free by design: shapes structurally match Pi's types
 * (`BuildSystemPromptOptions`, `ContextUsage`, `ThinkingLevel`, `Model`)
 * so the recorder can assign them with a single cast at the boundary.
 */

/** Pi thinking levels (matches `ThinkingLevel` in pi-agent-core). */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Provider-neutral identity of the model in use. */
export interface ModelIdentity {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** Context usage snapshot (matches Pi's `ContextUsage`). */
export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Structured options used to build the system prompt (best-effort shape). */
export interface SystemPromptOptionsSnapshot {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: unknown[];
  [key: string]: unknown;
}

/** Captured at `before_agent_start`; attached to provider requests. */
export interface PromptSnapshot {
  systemPrompt: string;
  systemPromptOptions: SystemPromptOptionsSnapshot;
  model: ModelIdentity | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  timestamp: number;
}

/**
 * Latest applicable logical context, created/replaced at `context`.
 * Consumed (and cleared) at the next `before_provider_request`.
 */
export interface PendingContextSnapshot {
  messages: unknown[];
  contextUsage: ContextUsageSnapshot | undefined;
  runId: string | undefined;
  turnIndex: number | undefined;
  timestamp: number;
}

/** Best-effort family label for a provider payload (P0.2). */
export type ProviderShape =
  | "openai-like"
  | "anthropic-like"
  | "google-like"
  | "unknown";

/**
 * P0.2 — Provider-neutral projection of the sanitized provider payload.
 * The raw payload remains authoritative; this is a convenience projection
 * and is never used to reject or alter capture.
 */
export interface ProviderEnvelopeSummary {
  detectedShape: ProviderShape;
  model?: string;
  messageCount?: number;
  toolCount?: number;
  systemPresent?: boolean;
}

/**
 * P0.2 — Best-effort tool definition extracted from a known provider
 * location in the sanitized payload. `raw` preserves the provider's own
 * schema untouched; name/description are filled only when safely readable.
 */
export interface ExtractedToolDefinition {
  /** Position in the provider's tool list (flattened for google-like). */
  index: number;
  name?: string;
  description?: string;
  raw: unknown;
}

/** One observed `before_provider_request`. Primary inspector unit. */
export interface RequestRecord {
  requestId: string;
  requestSeq: number;
  runId: string | undefined;
  turnIndex: number | undefined;
  timestamp: number;
  model: ModelIdentity | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  prompt: PromptSnapshot | undefined;
  logicalContext: unknown[] | undefined;
  sanitizedProviderPayload: unknown;
  providerEnvelope: ProviderEnvelopeSummary | undefined;
  providerTools: ExtractedToolDefinition[] | undefined;
  contextUsage: ContextUsageSnapshot | undefined;
  warnings: ObservationWarning[];
}

/** A non-fatal observation problem, e.g. incomplete cloning. */
export interface ObservationWarning {
  code: string;
  message: string;
  timestamp: number;
}

export type ObservationWarningCode =
  | "clone-incomplete"
  | "clone-failed"
  | "missing-logical-context"
  | "sanitize-failed"
  | "provider-envelope-parse-failed";

/** Full in-memory observation state for the current Pi session. */
export interface SessionObservationState {
  runCount: number;
  requestCount: number;
  evictedRequestCount: number;
  maxRequests: number;
  currentRunId: string | undefined;
  currentTurnIndex: number | undefined;
  maxTurnIndex: number | undefined;
  currentPrompt: PromptSnapshot | undefined;
  pendingContext: PendingContextSnapshot | undefined;
  requests: RequestRecord[];
  warnings: ObservationWarning[];
}
