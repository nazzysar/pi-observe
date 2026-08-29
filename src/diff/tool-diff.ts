/**
 * P1 — Provider-neutral tool normalization and tool-set diffing.
 *
 * P0.2's extracted tool definitions are normalized into a stable shape
 * (name / description / parameters / raw) and compared by tool name when
 * the provider exposes one; unnamed tools (providers whose schema cannot
 * be interpreted) are paired positionally. Reordered tools with the same
 * name therefore classify as unchanged.
 *
 * Tool identity is the canonical hash of the provider's own definition
 * (raw), so any real change in schema or description registers, while
 * JSON key order does not (canonicalization sorts keys). Pure functions.
 */

import type { ExtractedToolDefinition } from "../model.ts";
import { hashValue } from "../hash.ts";
import { structuralDiff } from "./structural-diff.ts";

export interface NormalizedTool {
  /** Position in the provider's tool list (flattened, from P0.2). */
  index: number;
  name: string | undefined;
  description: string | undefined;
  /** Best-effort extracted parameter schema; undefined when not found. */
  parameters: unknown;
  /** The provider's own definition, untouched. */
  raw: unknown;
  /** Canonical hash of `raw` — the tool's identity key. */
  hash: string;
}

export interface ToolDelta {
  index: number;
  name: string | undefined;
  hash: string;
  summary: string;
}

export interface ToolChange {
  oldIndex: number;
  newIndex: number;
  name: string | undefined;
  oldHash: string;
  newHash: string;
  changedPaths: string[];
  truncated: boolean;
}

export interface ToolSetDiff {
  /** True when either side's tool schema could not be interpreted (P0.2). */
  uninterpretable: boolean;
  added: ToolDelta[];
  removed: ToolDelta[];
  changed: ToolChange[];
  unchanged: number;
}

/** Normalize one P0.2 extracted tool definition. Never throws. */
export function normalizeTool(definition: ExtractedToolDefinition): NormalizedTool {
  const name = typeof definition.name === "string" ? definition.name : undefined;
  const description =
    typeof definition.description === "string" ? definition.description : undefined;
  return {
    index: definition.index,
    name,
    description,
    parameters: extractParameters(definition.raw),
    raw: definition.raw,
    hash: hashValue(definition.raw),
  };
}

/** Diff two extracted tool lists. undefined means "schema uninterpretable". */
export function diffTools(
  oldTools: ExtractedToolDefinition[] | undefined,
  newTools: ExtractedToolDefinition[] | undefined,
): ToolSetDiff {
  if (oldTools === undefined || newTools === undefined) {
    return {
      uninterpretable: true,
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
    };
  }

  const oldNormalized = oldTools.map(normalizeTool);
  const newNormalized = newTools.map(normalizeTool);

  // Match by name (queue per name for duplicate names), fall back to
  // positional matching for unnamed tools.
  const byName = new Map<string, NormalizedTool[]>();
  const unnamed: NormalizedTool[] = [];
  for (const tool of oldNormalized) {
    if (tool.name === undefined) unnamed.push(tool);
    else {
      const queue = byName.get(tool.name);
      if (queue) queue.push(tool);
      else byName.set(tool.name, [tool]);
    }
  }

  const pairs: Array<{ old: NormalizedTool; new: NormalizedTool }> = [];
  const unmatchedOld = new Set<NormalizedTool>(oldNormalized);
  const added: ToolDelta[] = [];

  for (const tool of newNormalized) {
    let match: NormalizedTool | undefined;
    if (tool.name !== undefined) {
      const queue = byName.get(tool.name);
      match = queue?.shift();
    } else {
      match = unnamed.shift();
    }
    if (match) {
      unmatchedOld.delete(match);
      pairs.push({ old: match, new: tool });
    } else {
      added.push(toDelta(tool));
    }
  }

  const removed: ToolDelta[] = [...unmatchedOld].map(toDelta);
  const changed: ToolChange[] = [];
  let unchanged = 0;
  for (const { old, new: current } of pairs) {
    if (old.hash === current.hash) {
      unchanged++;
      continue;
    }
    const paths = structuralDiff(old.raw, current.raw, { maxPaths: 10 });
    changed.push({
      oldIndex: old.index,
      newIndex: current.index,
      name: current.name,
      oldHash: old.hash,
      newHash: current.hash,
      changedPaths: paths.changedPaths,
      truncated: paths.truncated,
    });
  }

  return { uninterpretable: false, added, removed, changed, unchanged };
}

/**
 * Best-effort parameter schema extraction from known provider locations:
 * OpenAI chat (`function.parameters`), OpenAI Responses / custom
 * (`parameters`), Anthropic (`input_schema`), Bedrock
 * (`toolSpec.inputSchema`), Google declarations (`parameters`).
 */
function extractParameters(raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  const candidates = [
    raw.parameters,
    isRecord(raw.function) ? raw.function.parameters : undefined,
    raw.input_schema,
    raw.inputSchema,
    isRecord(raw.toolSpec) ? raw.toolSpec.inputSchema : undefined,
    isRecord(raw.toolSpec) ? raw.toolSpec.input_schema : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function toDelta(tool: NormalizedTool): ToolDelta {
  return {
    index: tool.index,
    name: tool.name,
    hash: tool.hash,
    summary: tool.name ?? "(unnamed)",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
