/**
 * P0.3 — Formatting helpers for the request inspector.
 *
 * Pure display functions: no TUI imports, no side effects, no Pi
 * dependencies beyond the shared observation types. Everything here
 * degrades gracefully — unknown/missing values render as "?" and no
 * helper throws, so a malformed record can never crash the inspector.
 */

import type {
  ContextUsageSnapshot,
  ObservationWarning,
  ProviderShape,
  ThinkingLevel,
} from "./model.ts";

/** The single character used for every unknown/missing value. */
export const UNKNOWN = "?";

/** Ellipsis used when truncating model ids and long summaries. */
export const ELLIPSIS = "…";

/** Human label for a detected provider shape. */
export function providerShapeLabel(shape: ProviderShape | undefined): string {
  switch (shape) {
    case "openai-like":
      return "OpenAI-like";
    case "anthropic-like":
      return "Anthropic-like";
    case "google-like":
      return "Google-like";
    case "bedrock-like":
      return "Bedrock-like";
    case "unknown":
      return "Unknown";
    default:
      return UNKNOWN;
  }
}

/** Thinking level, or "?" when unknown. */
export function formatThinkingLevel(level: ThinkingLevel | undefined): string {
  return level ?? UNKNOWN;
}

/** Integer count, or "?" when unknown. */
export function formatCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : UNKNOWN;
}

/**
 * Token count with SI-ish suffix: 41800 → "41.8k", 128000 → "128k",
 * 1250000 → "1.3m". Unknown → "?". Never throws.
 */
export function formatTokens(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return UNKNOWN;
  if (!Number.isFinite(tokens)) return UNKNOWN;
  const abs = Math.abs(tokens);
  let scaled: number;
  let suffix: string;
  if (abs >= 1_000_000) {
    scaled = tokens / 1_000_000;
    suffix = "m";
  } else if (abs >= 1_000) {
    scaled = tokens / 1_000;
    suffix = "k";
  } else {
    return String(Math.round(tokens));
  }
  const rounded = Math.round(scaled * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}${suffix}`;
}

/**
 * Context usage as "41.8k / 128k" (tokens / window). Either side may be
 * "?" when unknown; entirely unknown → "?".
 */
export function formatContextUsage(
  usage: ContextUsageSnapshot | undefined,
): string {
  if (!usage) return UNKNOWN;
  const tokens = formatTokens(usage.tokens);
  const window = formatTokens(usage.contextWindow);
  return `${tokens} / ${window}`;
}

/** Signed compact token delta: 6221 → "+6.2k", -1200 → "-1.2k", 0 → "+0". */
export function formatSignedTokens(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "+";
  return sign + formatTokens(Math.abs(delta));
}

/** Signed integer delta: 3 → "+3", -1 → "-1", 0 → "+0". */
export function formatSignedCount(delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "+";
  return sign + String(Math.abs(delta));
}

/** Compact timestamp "YYYY-MM-DD HH:MM:SS". Unknown → "?". */
export function formatTimestamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return UNKNOWN;
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Truncate a model id to `width` columns (including the ellipsis).
 * Unknown → "?". Long ids are cut rather than breaking layout.
 */
export function truncateModelId(
  id: string | undefined,
  width: number,
): string {
  if (id === undefined || id === null || id === "") return UNKNOWN;
  const chars = Array.from(id);
  if (chars.length <= width) return id;
  if (width <= 0) return "";
  if (width === 1) return ELLIPSIS;
  return chars.slice(0, width - 1).join("") + ELLIPSIS;
}

/**
 * Collapse runs of whitespace (including newlines) to a single space
 * and trim. TUI list rows must be exactly one terminal line each, so
 * summaries are strictly single-line: an embedded newline would render
 * as multiple rows and desync the list's scroll window from the
 * terminal, visually duplicating content.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * One-line compact summary of a logical context message:
 * "user: fix the build in src/index.ts", "assistant: 3 blocks
 * (text, toolCall)", "tool: result for read". Defensive against every
 * message shape; unknown shapes fall back to a JSON-ish string.
 * Always single-line: whitespace/newlines are collapsed.
 */
export function summarizeMessage(
  message: unknown,
  maxLength = 64,
): string {
  const role = messageRole(message);
  const body = messageBody(message);
  const label = role ? `${role}: ${body}` : body;
  return truncateUtf8(collapseWhitespace(label), maxLength);
}

/** Best-effort role/type of a message; "" when not discoverable. */
export function messageRole(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  if (typeof record.role === "string") return record.role;
  if (typeof record.type === "string") return record.type;
  return "";
}

/** Best-effort compact body of a message. */
function messageBody(message: unknown): string {
  if (message === null || message === undefined) return UNKNOWN;
  if (typeof message === "string") return message;
  if (typeof message !== "object") return String(message);
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    const MAX_BLOCKS = 8;
    for (const block of content) {
      if (parts.length >= MAX_BLOCKS) break;
      parts.push(blockSummary(block));
    }
    if (content.length > parts.length) {
      parts.push(`+${content.length - parts.length} more`);
    }
    return parts.length > 0
      ? `${content.length} block${content.length === 1 ? "" : "s"} (${parts.join(", ")})`
      : "empty content";
  }
  // No content field: describe the shape itself (tool results, etc.).
  return safeJsonSummary(record);
}

function blockSummary(block: unknown): string {
  if (block === null || typeof block !== "object") return String(block);
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "block";
  if (typeof record.text === "string") {
    return `${type} "${truncateUtf8(collapseWhitespace(record.text), 24)}"`;
  }
  if (typeof record.name === "string") {
    return `${type} ${record.name}`;
  }
  return type;
}

function safeJsonSummary(value: Record<string, unknown>): string {
  try {
    return truncateUtf8(JSON.stringify(value), 40) || UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/** Truncate to `maxLength` code points with an ellipsis. */
export function truncateUtf8(text: string, maxLength: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return ELLIPSIS;
  return chars.slice(0, maxLength - 1).join("") + ELLIPSIS;
}

/**
 * Pretty-print an arbitrary observed value as JSON. Never throws:
 * JSON failure falls back to String(), and a final failure to a fixed
 * placeholder. Cycles cannot normally occur (records are cloned), but
 * the inspector must stay safe regardless.
 */
export function safePrettyJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/** One-line warning display: "code: message". */
export function formatWarning(warning: ObservationWarning): string {
  return `${warning.code}: ${warning.message}`;
}

/**
 * Full text of a logical message: text extraction, else pretty JSON.
 * Used for expandable message entries in CONTEXT and DIFF views.
 */
export function messageFullText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === null || typeof message !== "object") {
    return safePrettyJson(message);
  }
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block !== null && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else parts.push(safePrettyJson(b));
      } else {
        parts.push(safePrettyJson(block));
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return safePrettyJson(message);
}
