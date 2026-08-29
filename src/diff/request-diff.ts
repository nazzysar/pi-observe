/**
 * P1 — Request-level diff service: combines the component diffs into a
 * single derived RequestDiff for two immutable request snapshots.
 *
 * Invariants:
 * - purely derived: never mutates the records, never alters P0 capture
 * - deterministic: same two snapshots always produce the same RequestDiff
 * - default comparison is request N-1 → N (getAdjacentDiff)
 * - expensive raw-payload path detection is optional (payloadPaths) so
 *   callers can get a cheap summary for the ledger preview
 * - memoized per (from, to, mode) pair with a bounded LRU-ish cache;
 *   records are immutable so a cached diff stays correct for the session
 *   it was computed in — but requestSeq restarts at 1 after a store
 *   reset, so callers must invoke clear() on reset (the recorder does)
 */

import type { RequestRecord, ThinkingLevel } from "../model.ts";
import { diffMessages } from "./message-diff.ts";
import type { MessageSequenceDiff } from "./message-diff.ts";
import { optionFieldDiffs } from "./options-diff.ts";
import type { OptionFieldDiff } from "./options-diff.ts";
import { diffTools } from "./tool-diff.ts";
import type { ToolSetDiff } from "./tool-diff.ts";
import { structuralDiff } from "./structural-diff.ts";
import type { StructuralDiffSummary } from "./structural-diff.ts";
import { textDiffSummary } from "./text-diff.ts";
import type { TextDiffSummary } from "./text-diff.ts";

/** Diff of the Pi-reported aggregate context token count. */
export interface NumericDiff {
  from: number;
  to: number;
  delta: number;
}

export interface ModelDiff {
  changed: boolean;
  from: string | undefined;
  to: string | undefined;
  thinkingLevelChanged: boolean;
  thinkingLevelFrom: ThinkingLevel | undefined;
  thinkingLevelTo: ThinkingLevel | undefined;
}

export interface DiffSummary {
  systemChanged: boolean;
  promptOptionsChanged: boolean;
  messagesAdded: number;
  messagesRemoved: number;
  messagesChanged: number;
  toolsAdded: number;
  toolsRemoved: number;
  toolsChanged: number;
  modelChanged: boolean;
}

export interface RequestDiff {
  /** Request sequence numbers ("#" in the ledger) of the compared pair. */
  fromRequestId: number;
  toRequestId: number;

  summary: DiffSummary;
  model: ModelDiff;
  /** Pi-reported aggregate context usage; "unknown" when unavailable. */
  contextUsage: NumericDiff | "unknown";

  systemPrompt: TextDiffSummary;
  systemPromptOptions: StructuralDiffSummary;
  /** Per-field prompt-construction summaries (P1 plan §9). */
  optionFields: OptionFieldDiff[];
  messages: MessageSequenceDiff;
  tools: ToolSetDiff;
  providerPayload: StructuralDiffSummary;
}

export interface DiffOptions {
  /**
   * When false, skip raw-payload changed-path detection (hash equality
   * is still computed) — for cheap previews. Default true.
   */
  payloadPaths?: boolean;
}

/** Minimal read surface the service needs (satisfied by SessionStore). */
export interface ObservationStore {
  getRequests(): RequestRecord[];
}

const MAX_CACHE = 200;

export class DiffService {
  private cache = new Map<string, RequestDiff>();

  /** Diff two request snapshots. Order is normalized (from = older). */
  diff(
    fromRecord: RequestRecord,
    toRecord: RequestRecord,
    options: DiffOptions = {},
  ): RequestDiff {
    let from = fromRecord;
    let to = toRecord;
    if (from.requestSeq > to.requestSeq) [from, to] = [to, from];
    const payloadPaths = options.payloadPaths ?? true;
    const key = `${from.requestSeq}:${to.requestSeq}:${payloadPaths ? "full" : "light"}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const diff = computeRequestDiff(from, to, payloadPaths);
    this.cache.set(key, diff);
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return diff;
  }

  /**
   * Diff of a request against its retained predecessor (request N-1).
   * Convenience for programmatic callers; the inspector UI resolves its
   * own neighbors over the ledger snapshot.
   */
  getAdjacentDiff(
    store: ObservationStore,
    requestId: number,
    options: DiffOptions = {},
  ): RequestDiff | undefined {
    const requests = store.getRequests();
    const index = requests.findIndex((record) => record.requestSeq === requestId);
    if (index <= 0) return undefined;
    const from = requests[index - 1];
    const to = requests[index];
    if (!from || !to) return undefined;
    return this.diff(from, to, options);
  }

  /** Drop all memoized diffs (e.g. after store.reset()). */
  clear(): void {
    this.cache.clear();
  }
}

function computeRequestDiff(
  from: RequestRecord,
  to: RequestRecord,
  payloadPaths: boolean,
): RequestDiff {
  const systemPrompt = textDiffSummary(
    from.prompt?.systemPrompt,
    to.prompt?.systemPrompt,
  );
  const messages = diffMessages(from.logicalContext, to.logicalContext);
  const tools = diffTools(from.providerTools, to.providerTools);
  const model = diffModel(from, to);
  const providerPayload = diffProviderPayload(from, to, payloadPaths, messages);

  const systemPromptOptions = structuralDiff(
    from.prompt?.systemPromptOptions,
    to.prompt?.systemPromptOptions,
    { maxPaths: 20 },
  );
  const optionFields = optionFieldDiffs(
    from.prompt?.systemPromptOptions,
    to.prompt?.systemPromptOptions,
  );

  return {
    fromRequestId: from.requestSeq,
    toRequestId: to.requestSeq,
    summary: {
      systemChanged: !systemPrompt.equal,
      promptOptionsChanged: !systemPromptOptions.equal,
      messagesAdded: messages.added.length,
      messagesRemoved: messages.removed.length,
      messagesChanged: messages.changed.length,
      toolsAdded: tools.added.length,
      toolsRemoved: tools.removed.length,
      toolsChanged: tools.changed.length,
      modelChanged: model.changed || model.thinkingLevelChanged,
    },
    model,
    contextUsage: contextUsageDiff(from, to),
    systemPrompt,
    systemPromptOptions,
    optionFields,
    messages,
    tools,
    providerPayload,
  };
}

function diffModel(from: RequestRecord, to: RequestRecord): ModelDiff {
  const fromModel = from.model;
  const toModel = to.model;
  const changed =
    (fromModel?.id ?? undefined) !== (toModel?.id ?? undefined) ||
    (fromModel?.provider ?? undefined) !== (toModel?.provider ?? undefined);
  const thinkingLevelChanged =
    (from.thinkingLevel ?? undefined) !== (to.thinkingLevel ?? undefined);
  return {
    changed,
    from: fromModel?.id,
    to: toModel?.id,
    thinkingLevelChanged,
    thinkingLevelFrom: from.thinkingLevel,
    thinkingLevelTo: to.thinkingLevel,
  };
}

function contextUsageDiff(from: RequestRecord, to: RequestRecord): NumericDiff | "unknown" {
  const a = from.contextUsage?.tokens;
  const b = to.contextUsage?.tokens;
  if (typeof a !== "number" || typeof b !== "number") return "unknown";
  return { from: a, to: b, delta: b - a };
}

/**
 * Raw payload structural diff. When the message diff already explains
 * context growth, provider message arrays are elided (reported once as
 * a single path) so gigantic message content cannot flood the summary.
 */
function diffProviderPayload(
  from: RequestRecord,
  to: RequestRecord,
  payloadPaths: boolean,
  messages: MessageSequenceDiff,
): StructuralDiffSummary {
  const summary = structuralDiff(from.sanitizedProviderPayload, to.sanitizedProviderPayload, {
    maxPaths: payloadPaths ? 50 : 0,
    skipSubtree: payloadPaths ? messageArraySkip(messages) : undefined,
  });
  if (payloadPaths) return summary;
  return { ...summary, changedPaths: [], truncated: false };
}

/**
 * Skip predicate for provider message arrays: the top-level arrays that
 * carry messages across the known provider families (chat `messages`,
 * Gemini `contents`, Responses `input`). Only active when the logical
 * message diff has something to explain.
 */
function messageArraySkip(messages: MessageSequenceDiff):
  | ((segments: string[]) => boolean)
  | undefined {
  const explains = messages.unknown ||
    messages.added.length + messages.removed.length + messages.changed.length > 0;
  if (!explains) return undefined;
  return (segments) => segments.length === 1 && MESSAGE_ARRAY_KEYS.has(segments[0]!);
}

const MESSAGE_ARRAY_KEYS = new Set(["messages", "contents", "input"]);
