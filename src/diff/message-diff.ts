/**
 * P1 — Logical message fingerprinting and sequence diffing.
 *
 * Agent conversations are append-heavy, so the diff optimizes for that:
 * common prefix and suffix are matched first, exact content matches in
 * the remaining middle are paired by hash, and only the leftovers are
 * classified as added/removed/changed — no generalized sequence algorithm.
 *
 * Message identity is content-based: volatile envelope fields (timestamps,
 * usage, provider/model metadata, stop reasons, tool `details`) are
 * excluded from the content hash so re-sending the same logical message
 * between turns does not register as a change. A full structural hash is
 * still carried for drill-down. Pure functions; inputs are never mutated.
 */

import { hashValue } from "../hash.ts";
import { safePrettyJson } from "../format.ts";

export interface MessageFingerprint {
  /** Position in its own message sequence. */
  index: number;
  role: string | undefined;
  /** Tool name for toolResult messages; undefined otherwise. */
  kind: string | undefined;
  toolCallId: string | undefined;
  /** Hash of the content core (volatile envelope fields excluded). */
  contentHash: string;
  /** Hash of the whole message, envelope included. */
  structuralHash: string;
  /** Char length of the message's text content (or JSON fallback). */
  length: number;
  /** Concise human label: "assistant", "toolResult:bash", "custom:<role>". */
  summary: string;
}

export interface MessageDelta {
  index: number;
  role?: string;
  kind?: string;
  hash: string;
  length: number;
  summary: string;
}

export interface MessageChange {
  /** Position of the changed message in the new sequence. */
  index: number;
  old: MessageDelta;
  new: MessageDelta;
}

export interface MessageSequenceDiff {
  /** True when either side has no logical context (diff unavailable). */
  unknown: boolean;
  oldCount: number;
  newCount: number;
  commonPrefix: number;
  commonSuffix: number;
  added: MessageDelta[];
  removed: MessageDelta[];
  changed: MessageChange[];
}

/**
 * Envelope fields excluded from the content core. These hold execution
 * metadata that is stable for a given logical message but irrelevant to
 * what the model sees in context.
 */
const VOLATILE_FIELDS = new Set([
  "timestamp",
  "usage",
  "api",
  "provider",
  "model",
  "responseModel",
  "responseId",
  "diagnostics",
  "stopReason",
  "rawStopReason",
  "endTurn",
  "deferred",
  "details",
  "addedToolNames",
]);

const STANDARD_ROLES = new Set(["user", "assistant", "toolResult"]);

/** Fingerprint one logical message. Never throws. */
export function fingerprintMessage(message: unknown, index: number): MessageFingerprint {
  const record = isRecord(message) ? message : undefined;
  const role = stringField(record, "role");
  const toolCallId = stringField(record, "toolCallId");
  const toolName = stringField(record, "toolName");
  const kind = role === "toolResult" ? toolName ?? undefined : undefined;

  const contentHash = hashValue(contentCore(message));
  const structuralHash = hashValue(message);

  return {
    index,
    role,
    kind,
    toolCallId,
    contentHash,
    structuralHash,
    length: messageTextLength(message),
    summary: messageSummaryLabel(role, toolName),
  };
}

/**
 * Diff two logical message sequences. Either side may be undefined
 * (no logical context captured) — the result is then `unknown`.
 */
export function diffMessages(
  oldMessages: unknown[] | undefined,
  newMessages: unknown[] | undefined,
): MessageSequenceDiff {
  if (oldMessages === undefined || newMessages === undefined) {
    return {
      unknown: true,
      oldCount: oldMessages?.length ?? 0,
      newCount: newMessages?.length ?? 0,
      commonPrefix: 0,
      commonSuffix: 0,
      added: [],
      removed: [],
      changed: [],
    };
  }

  const oldFps = oldMessages.map((message, i) => fingerprintMessage(message, i));
  const newFps = newMessages.map((message, i) => fingerprintMessage(message, i));

  // Step B — common prefix.
  let prefix = 0;
  while (
    prefix < oldFps.length &&
    prefix < newFps.length &&
    oldFps[prefix]!.contentHash === newFps[prefix]!.contentHash
  ) {
    prefix++;
  }
  // Step C — common suffix (not crossing the prefix).
  let suffix = 0;
  while (
    suffix < oldFps.length - prefix &&
    suffix < newFps.length - prefix &&
    oldFps[oldFps.length - 1 - suffix]!.contentHash ===
      newFps[newFps.length - 1 - suffix]!.contentHash
  ) {
    suffix++;
  }

  // Step D — unmatched middle: exact-hash matching first.
  const oldMiddle = oldFps.slice(prefix, oldFps.length - suffix);
  const newMiddle = newFps.slice(prefix, newFps.length - suffix);

  const queues = new Map<string, MessageFingerprint[]>();
  for (const fp of oldMiddle) {
    const queue = queues.get(fp.contentHash);
    if (queue) queue.push(fp);
    else queues.set(fp.contentHash, [fp]);
  }
  const matchedOld = new Set<MessageFingerprint>();
  const matchedNew = new Set<MessageFingerprint>();
  for (const fp of newMiddle) {
    const queue = queues.get(fp.contentHash);
    const match = queue?.shift();
    if (match) {
      matchedOld.add(match);
      matchedNew.add(fp);
    }
  }

  const remOld = oldMiddle.filter((fp) => !matchedOld.has(fp));
  const remNew = newMiddle.filter((fp) => !matchedNew.has(fp));

  const added: MessageDelta[] = [];
  const removed: MessageDelta[] = [];
  const changed: MessageChange[] = [];

  // Pair leftovers positionally while role and kind line up: same slot,
  // different content → "changed". Everything else is added or removed.
  let paired = 0;
  while (
    paired < remOld.length &&
    paired < remNew.length &&
    remOld[paired]!.role === remNew[paired]!.role &&
    remOld[paired]!.kind === remNew[paired]!.kind
  ) {
    paired++;
  }
  for (let i = paired; i < remOld.length; i++) removed.push(toDelta(remOld[i]!));
  for (let i = paired; i < remNew.length; i++) added.push(toDelta(remNew[i]!));
  for (let i = 0; i < paired; i++) {
    changed.push({
      index: remNew[i]!.index,
      old: toDelta(remOld[i]!),
      new: toDelta(remNew[i]!),
    });
  }

  return {
    unknown: false,
    oldCount: oldMessages.length,
    newCount: newMessages.length,
    commonPrefix: prefix,
    commonSuffix: suffix,
    added,
    removed,
    changed,
  };
}

/**
 * The content core: everything except volatile envelope fields. For
 * non-object messages the value itself is the core.
 */
function contentCore(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (!VOLATILE_FIELDS.has(key)) core[key] = value;
  }
  return core;
}

function messageSummaryLabel(role: string | undefined, toolName: string | undefined): string {
  if (role === undefined || role === "") return "unknown";
  if (role === "toolResult") {
    return toolName ? `toolResult:${toolName}` : "toolResult";
  }
  if (STANDARD_ROLES.has(role)) return role;
  return `custom:${role}`;
}

/** Char length of a message's text content, JSON fallback for other shapes. */
function messageTextLength(message: unknown): number {
  if (typeof message === "string") return message.length;
  if (!isRecord(message)) return safePrettyJson(message).length;
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let length = 0;
    let hasText = false;
    for (const block of content) {
      if (isRecord(block) && typeof block.text === "string") {
        length += block.text.length;
        hasText = true;
      }
    }
    return hasText ? length : safePrettyJson(message).length;
  }
  return safePrettyJson(message).length;
}

function toDelta(fp: MessageFingerprint): MessageDelta {
  return {
    index: fp.index,
    role: fp.role,
    kind: fp.kind,
    hash: fp.contentHash,
    length: fp.length,
    summary: fp.summary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}
