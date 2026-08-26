/**
 * P0.1 — Observation store: bounded in-memory state and the correlation
 * state machine. Passive and fail-open: no method throws, no method
 * mutates its inputs' callers' data, and every mutator returns undefined.
 *
 * Canonical boundary: `commitProviderRequest` runs exactly once per
 * observed `before_provider_request` and is the only place the request
 * sequence increments. `context` only creates/replaces a pending
 * snapshot consumed there.
 */

import { safeSnapshotResult } from "./clone.ts";
import {
  allocateRequestId,
  allocateRunId,
  assembleRequestRecord,
  buildPendingContext,
  buildPromptSnapshot,
  cloneIncompleteWarning,
  missingContextWarning,
} from "./correlation.ts";
import type {
  ExtractedToolDefinition,
  ObservationWarning,
  ObservationWarningCode,
  PendingContextSnapshot,
  PromptSnapshot,
  ProviderEnvelopeSummary,
  RequestRecord,
  SessionObservationState,
  ThinkingLevel,
} from "./model.ts";
import { interpretProviderPayload } from "./provider-envelope.ts";
import type { ProviderInterpretation } from "./provider-envelope.ts";
import { SANITIZE_FAILED, sanitizeProviderPayload } from "./sanitize.ts";

export interface SessionStoreOptions {
  /** Max retained request records; oldest are evicted. Default 100. */
  maxRequests?: number;
  /** Max retained observation warnings. Default maxRequests * 2. */
  maxWarnings?: number;
  /**
   * P0.2 interpreter hook (defaults to `interpretProviderPayload`).
   * Injectable for tests; a throwing interpreter must never prevent
   * request recording — the store appends `provider-envelope-parse-failed`
   * and keeps the raw record.
   */
  interpretPayload?: (payload: unknown) => ProviderInterpretation;
}

export interface BeforeAgentStartInput {
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: unknown;
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  timestamp: number;
}

export interface ProviderRequestInput {
  payload: unknown;
  model: unknown;
  thinkingLevel: ThinkingLevel | undefined;
  contextUsage: unknown;
  timestamp: number;
}

export class SessionStore {
  private runSeq = 0;
  private requestSeq = 0;
  private pendingRunId: string | undefined;
  private runCount = 0;
  private evictedRequestCount = 0;
  private currentRunId: string | undefined;
  private currentTurnIndex: number | undefined;
  private maxTurnIndex: number | undefined;
  private currentPrompt: PromptSnapshot | undefined;
  private pendingContext: PendingContextSnapshot | undefined;
  private requests: RequestRecord[] = [];
  private warnings: ObservationWarning[] = [];
  private readonly maxRequests: number;
  private readonly maxWarnings: number;
  private readonly interpretPayload: (payload: unknown) => ProviderInterpretation;

  constructor(options: SessionStoreOptions = {}) {
    this.maxRequests = Math.max(1, Math.floor(options.maxRequests ?? 100));
    this.maxWarnings = Math.max(1, Math.floor(options.maxWarnings ?? this.maxRequests * 2));
    this.interpretPayload = options.interpretPayload ?? interpretProviderPayload;
  }

  // ------------------------------------------------------------------
  // Correlation state machine (event handlers)
  // ------------------------------------------------------------------

  /** before_agent_start: allocate run id, snapshot prompt/model/thinking. */
  onBeforeAgentStart(input: BeforeAgentStartInput): void {
    const runId = allocateRunId(++this.runSeq);
    this.pendingRunId = runId;
    const options = safeSnapshotResult(input.systemPromptOptions, (message) =>
      this.appendWarningCode("clone-incomplete", message),
    ).value;
    this.currentPrompt = buildPromptSnapshot({
      systemPrompt: input.systemPrompt,
      systemPromptOptions: options,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      timestamp: input.timestamp,
    });
  }

  /** agent_start: promote the pending run, count it exactly once. */
  onAgentStart(): void {
    const runId = this.pendingRunId ?? allocateRunId(++this.runSeq);
    this.pendingRunId = undefined;
    this.currentRunId = runId;
    this.runCount += 1;
  }

  /** turn_start: track the current turn index. */
  onTurnStart(turnIndex: number): void {
    this.currentTurnIndex = turnIndex;
    this.maxTurnIndex =
      this.maxTurnIndex === undefined
        ? turnIndex
        : Math.max(this.maxTurnIndex, turnIndex);
  }

  /** turn_end: bookkeeping only; the index was already tracked. */
  onTurnEnd(_turnIndex: number): void {
    // Nothing to do — turns are tracked at turn_start.
  }

  /** context: create/replace pending context, associated with run/turn. */
  onContext(messages: unknown[], contextUsage: unknown, timestamp: number): void {
    const snapshot = safeSnapshotResult(messages, (message) =>
      this.appendWarningCode("clone-incomplete", message),
    );
    this.pendingContext = buildPendingContext({
      messages: snapshot.value,
      contextUsage,
      runId: this.currentRunId,
      turnIndex: this.currentTurnIndex,
      timestamp,
    });
  }

  /** before_provider_request: canonical commit point. */
  onBeforeProviderRequest(input: ProviderRequestInput): void {
    const requestSeq = ++this.requestSeq;
    const requestId = allocateRequestId(requestSeq);
    const timestamp = input.timestamp;

    const recordWarnings: ObservationWarning[] = [];
    const warn = (message: string) => {
      const warning = cloneIncompleteWarning(message, timestamp);
      recordWarnings.push(warning);
      this.appendWarning(warning);
    };

    let sanitizedPayload: unknown;
    try {
      const snapshot = safeSnapshotResult(input.payload, warn);
      sanitizedPayload = sanitizeProviderPayload(snapshot.value);
    } catch (error) {
      // sanitize/snapshot should never throw; fail open with a safe
      // placeholder — never the raw payload (credentials would leak and
      // later mutation of Pi's event objects could change the record).
      const warning: ObservationWarning = {
        code: "sanitize-failed",
        message: error instanceof Error ? error.message : String(error),
        timestamp,
      };
      recordWarnings.push(warning);
      this.appendWarning(warning);
      sanitizedPayload = SANITIZE_FAILED;
    }

    // P0.2: interpret the sanitized snapshot. Interpretation is a
    // convenience projection, never a prerequisite for capture — a
    // throwing interpreter only adds a warning and the record survives.
    let providerEnvelope: ProviderEnvelopeSummary | undefined;
    let providerTools: ExtractedToolDefinition[] | undefined;
    try {
      const interpretation = this.interpretPayload(sanitizedPayload);
      providerEnvelope = interpretation.summary;
      providerTools = interpretation.tools;
    } catch (error) {
      const warning: ObservationWarning = {
        code: "provider-envelope-parse-failed",
        message: error instanceof Error ? error.message : String(error),
        timestamp,
      };
      recordWarnings.push(warning);
      this.appendWarning(warning);
    }

    const pending = this.pendingContext;
    if (!pending) {
      const warning = missingContextWarning(timestamp);
      recordWarnings.push(warning);
      this.appendWarning(warning);
    }

    const record = assembleRequestRecord({
      requestId,
      requestSeq,
      runId: pending?.runId ?? this.currentRunId,
      turnIndex: pending?.turnIndex ?? this.currentTurnIndex,
      timestamp,
      model: input.model ?? this.currentPrompt?.model,
      thinkingLevel: input.thinkingLevel ?? this.currentPrompt?.thinkingLevel,
      prompt: this.currentPrompt,
      logicalContext: pending?.messages,
      sanitizedProviderPayload: sanitizedPayload,
      providerEnvelope,
      providerTools,
      contextUsage: input.contextUsage ?? pending?.contextUsage,
      warnings: recordWarnings,
    });
    this.requests.push(record);
    this.pendingContext = undefined; // consumed
    this.enforceRetention();
  }

  /** agent_end / agent_settled: mark the run inactive and drop stale pending context. */
  onRunEnd(): void {
    this.currentRunId = undefined;
    this.currentTurnIndex = undefined;
    this.pendingContext = undefined;
  }

  /** Full reset (session switch/new session). Counters restart. */
  reset(): void {
    this.runSeq = 0;
    this.requestSeq = 0;
    this.runCount = 0;
    this.evictedRequestCount = 0;
    this.currentRunId = undefined;
    this.currentTurnIndex = undefined;
    this.maxTurnIndex = undefined;
    this.currentPrompt = undefined;
    this.pendingContext = undefined;
    this.requests = [];
    this.warnings = [];
  }

  // ------------------------------------------------------------------
  // Store boundary (read APIs for P0.2/P0.3)
  // ------------------------------------------------------------------

  /** Deep copy of the full state. Never throws (fail-open). */
  getState(): SessionObservationState {
    const state: SessionObservationState = {
      runCount: this.runCount,
      requestCount: this.requestSeq,
      evictedRequestCount: this.evictedRequestCount,
      maxRequests: this.maxRequests,
      currentRunId: this.currentRunId,
      currentTurnIndex: this.currentTurnIndex,
      maxTurnIndex: this.maxTurnIndex,
      currentPrompt: this.currentPrompt,
      pendingContext: this.pendingContext,
      requests: this.requests,
      warnings: this.warnings,
    };
    try {
      return structuredClone(state);
    } catch {
      return state; // read-only by convention; never throw into Pi
    }
  }

  /** Deep copy of all retained request records, oldest first. Never throws. */
  getRequests(): RequestRecord[] {
    return this.cloneValue(this.requests) ?? this.requests;
  }

  getRequest(requestId: string): RequestRecord | undefined {
    const record = this.requests.find((r) => r.requestId === requestId);
    return record ? (this.cloneValue(record) ?? record) : undefined;
  }

  getLatestRequest(): RequestRecord | undefined {
    const latest = this.requests[this.requests.length - 1];
    return latest ? (this.cloneValue(latest) ?? latest) : undefined;
  }

  private cloneValue<T>(value: T): T | undefined {
    try {
      return structuredClone(value);
    } catch {
      return undefined; // fail-open: caller keeps internal reference
    }
  }

  /** Append a store-level observation warning (bounded). */
  appendWarning(warning: ObservationWarning): void {
    this.warnings.push(warning);
    while (this.warnings.length > this.maxWarnings) this.warnings.shift();
  }

  appendWarningCode(code: ObservationWarningCode, message: string): void {
    this.appendWarning({ code, message, timestamp: Date.now() });
  }

  private enforceRetention(): void {
    while (this.requests.length > this.maxRequests) {
      this.requests.shift();
      this.evictedRequestCount += 1;
    }
  }
}
