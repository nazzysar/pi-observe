/**
 * P1 — Diffing of structured BuildSystemPromptOptions.
 *
 * Reports the prompt-construction fields Pi actually uses, with concise
 * human details ("+ .pi/AGENTS.md", "2 → 3 entries"), while the generic
 * structural path summary remains available for everything else.
 * Source attribution and rich provenance belong to P2. Pure functions.
 */

import { hashValue } from "../hash.ts";
import type { SystemPromptOptionsSnapshot } from "../model.ts";

export interface OptionFieldDiff {
  field: string;
  equal: boolean;
  /** Concise human detail, e.g. "+ .pi/AGENTS.md" or "120 → 340 chars". */
  detail: string;
}

/** Fields compared specially, in display order (P1 plan §9). */
const SPECIAL_FIELDS = [
  "customPrompt",
  "selectedTools",
  "toolSnippets",
  "promptGuidelines",
  "appendSystemPrompt",
  "cwd",
  "contextFiles",
  "skills",
] as const;

const MAX_NAMES = 3;

/** Per-field summaries for the special prompt-construction fields. */
export function optionFieldDiffs(
  oldOptions: SystemPromptOptionsSnapshot | undefined,
  newOptions: SystemPromptOptionsSnapshot | undefined,
): OptionFieldDiff[] {
  if (oldOptions === undefined && newOptions === undefined) return [];
  const out: OptionFieldDiff[] = [];
  for (const field of SPECIAL_FIELDS) {
    const oldValue = fieldOf(oldOptions, field);
    const newValue = fieldOf(newOptions, field);
    out.push(fieldDiff(field, oldValue, newValue));
  }
  return out;
}

function fieldOf(
  options: SystemPromptOptionsSnapshot | undefined,
  field: string,
): unknown {
  if (options === undefined) return undefined;
  return options[field];
}

function fieldDiff(field: string, oldValue: unknown, newValue: unknown): OptionFieldDiff {
  const equal = hashValue(oldValue) === hashValue(newValue);
  return { field, equal, detail: equal ? "unchanged" : detailFor(field, oldValue, newValue) };
}

function detailFor(field: string, oldValue: unknown, newValue: unknown): string {
  const detail = lazyDetailFor(field, oldValue, newValue);
  return detail ?? "changed";
}

function lazyDetailFor(field: string, oldValue: unknown, newValue: unknown): string | undefined {
  switch (field) {
    case "customPrompt":
    case "appendSystemPrompt":
      return textDetail(oldValue, newValue);
    case "cwd":
      return `${stringOrType(oldValue)} → ${stringOrType(newValue)}`;
    case "selectedTools":
    case "contextFiles":
    case "skills":
      return nameSetDetail(field, oldValue, newValue);
    case "toolSnippets":
      return keySetDetail(oldValue, newValue);
    case "promptGuidelines":
      return countDetail(oldValue, newValue);
    default:
      return undefined;
  }
}

function textDetail(oldValue: unknown, newValue: unknown): string {
  if (oldValue === undefined) return `added (${textLength(newValue)} chars)`;
  if (newValue === undefined) return "removed";
  return `${textLength(oldValue)} → ${textLength(newValue)} chars`;
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function countDetail(oldValue: unknown, newValue: unknown): string {
  return `${arrayLength(oldValue)} → ${arrayLength(newValue)} entries`;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Set-style detail for array fields: added/removed entry names, capped.
 * `selectedTools` entries are strings; `contextFiles` use their `path`;
 * `skills` fall back to any `name` property, then a JSON stub.
 */
function nameSetDetail(field: string, oldValue: unknown, newValue: unknown): string {
  const oldNames = entryNames(field, oldValue);
  const newNames = entryNames(field, newValue);
  const addedNames = newNames.filter((name) => !oldNames.includes(name));
  const removedNames = oldNames.filter((name) => !newNames.includes(name));
  const parts: string[] = [];
  parts.push(...addedNames.map((name) => `+ ${name}`));
  parts.push(...removedNames.map((name) => `- ${name}`));
  if (parts.length === 0) return "changed";
  if (parts.length > MAX_NAMES) {
    return `${parts.slice(0, MAX_NAMES).join(", ")} (+${parts.length - MAX_NAMES} more)`;
  }
  return parts.join(", ");
}

function entryNames(field: string, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (isRecord(entry) && typeof entry.path === "string" && field === "contextFiles") {
      names.push(entry.path);
    } else if (isRecord(entry) && typeof entry.name === "string") {
      names.push(entry.name);
    } else {
      names.push(JSON.stringify(entry)?.slice(0, 24) ?? "?");
    }
  }
  return names;
}

/** Key-set detail for Record fields like toolSnippets. */
function keySetDetail(oldValue: unknown, newValue: unknown): string {
  const oldKeys = isRecord(oldValue) ? Object.keys(oldValue) : [];
  const newKeys = isRecord(newValue) ? Object.keys(newValue) : [];
  const addedKeys = newKeys.filter((key) => !oldKeys.includes(key));
  const removedKeys = oldKeys.filter((key) => !newKeys.includes(key));
  const parts = [
    ...addedKeys.map((key) => `+ ${key}`),
    ...removedKeys.map((key) => `- ${key}`),
  ];
  if (parts.length === 0) return "changed";
  if (parts.length > MAX_NAMES) {
    return `${parts.slice(0, MAX_NAMES).join(", ")} (+${parts.length - MAX_NAMES} more)`;
  }
  return parts.join(", ");
}

function stringOrType(value: unknown): string {
  return typeof value === "string" ? value : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
