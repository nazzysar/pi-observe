/**
 * P0.2 — Provider Payload Interpretation.
 *
 * Turns the captured `sanitizedProviderPayload: unknown` into a
 * provider-neutral, best-effort projection (`ProviderEnvelopeSummary`)
 * plus extractable tool definitions — without pretending all providers
 * share a schema.
 *
 * Hard invariants (all unit-tested):
 * - never mutates the payload (read-only by construction; internally
 *   guarded so even hostile inputs like throwing getters cannot throw)
 * - never rejects an unknown payload; `detectedShape: "unknown"` always
 *   works, `extractProviderTools` returns `undefined`
 * - counts only when the relevant field is an array with clear semantics
 * - `extractProviderTools` returns `[]` only when the schema is
 *   understood and no tools exist; `undefined` means "schema cannot be
 *   interpreted" — P0.3 relies on that distinction
 * - tool definitions are read from known provider locations only, never
 *   inferred from Pi logical context
 * - `raw` on every extracted tool preserves the provider's own schema
 *   untouched; name/description are filled only when safely readable
 *
 * Interpretation is a pure function of the sanitized snapshot; the raw
 * payload remains the source record.
 */

import type {
  ExtractedToolDefinition,
  ProviderEnvelopeSummary,
  ProviderShape,
} from "./model.ts";

/** Combined result of P0.2 interpretation for one request. */
export interface ProviderInterpretation {
  summary: ProviderEnvelopeSummary;
  /** undefined = schema uninterpretable; [] = understood, no tools. */
  tools: ExtractedToolDefinition[] | undefined;
}

/** Interpret the sanitized payload once; both projections in one pass. */
export function interpretProviderPayload(
  payload: unknown,
): ProviderInterpretation {
  return {
    summary: summarizeProviderPayload(payload),
    tools: extractProviderTools(payload),
  };
}

/**
 * Best-effort envelope summary. Never throws: anything that cannot be
 * interpreted yields `{ detectedShape: "unknown" }` (with a top-level
 * string `model` kept when safe).
 */
export function summarizeProviderPayload(
  payload: unknown,
): ProviderEnvelopeSummary {
  try {
    return summarize(payload);
  } catch {
    // Defense in depth: adversarial inputs (throwing getters, proxies)
    // must never break observation. Unknown is the honest answer.
    return { detectedShape: "unknown" };
  }
}

/**
 * Best-effort tool definitions. Never throws. Returns `undefined` when
 * the schema cannot be interpreted (unknown shape, malformed tools
 * field), `[]` when the shape is understood and no tools are declared.
 */
export function extractProviderTools(
  payload: unknown,
): ExtractedToolDefinition[] | undefined {
  try {
    return extractTools(payload);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Internal implementation (all defensive, all read-only)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Family detection, most distinctive signal first. Each branch is a
 * conservative signature; anything unrecognized is "unknown".
 */
function detectShape(payload: Record<string, unknown>): ProviderShape {
  // `contents` is the mandatory Gemini generateContent field.
  if (hasOwn(payload, "contents")) return "google-like";
  // Bedrock Converse: Pi's adapter emits top-level `modelId` + `messages`
  // + `system` (blocks), with tools under `toolConfig` (never `tools`)
  // and `inferenceConfig`. Those three field names never appear in the
  // other families, so any one of them is a Bedrock signature. Must run
  // before the Anthropic branch — Bedrock also has `system` + `messages`.
  if (
    hasOwn(payload, "toolConfig") ||
    hasOwn(payload, "inferenceConfig") ||
    (typeof payload.modelId === "string" && Array.isArray(payload.messages))
  ) {
    return "bedrock-like";
  }
  // Anthropic REST requests carry anthropic_version; top-level `system`
  // alongside `messages` is the Anthropic signature (OpenAI never uses
  // a top-level system field); `input_schema` is Anthropic's tool shape.
  if (hasOwn(payload, "anthropic_version")) return "anthropic-like";
  if (hasOwn(payload, "system") && Array.isArray(payload.messages)) {
    return "anthropic-like";
  }
  if (hasFunctionToolsWithInputSchema(payload.tools)) return "anthropic-like";
  // chat/completions-like: `messages` array is the residual messages shape.
  if (Array.isArray(payload.messages)) return "openai-like";
  // Responses-like: `input` (string or array of items).
  if (hasOwn(payload, "input")) return "openai-like";
  return "unknown";
}

function hasFunctionToolsWithInputSchema(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some(
    (entry) => isRecord(entry) && hasOwn(entry, "input_schema"),
  );
}

function summarize(payload: unknown): ProviderEnvelopeSummary {
  if (!isRecord(payload)) return { detectedShape: "unknown" };

  const shape = detectShape(payload);
  const summary: ProviderEnvelopeSummary = { detectedShape: shape };

  // `model` is a top-level string in every known family and harmless as
  // a generic field, so keep it for unknown shapes too.
  const model = stringField(payload, "model");
  if (model !== undefined) summary.model = model;

  switch (shape) {
    case "openai-like":
      summarizeOpenAi(payload, summary);
      break;
    case "anthropic-like":
      summarizeAnthropic(payload, summary);
      break;
    case "google-like":
      summarizeGoogle(payload, summary);
      break;
    case "bedrock-like":
      summarizeBedrock(payload, summary);
      break;
    case "unknown":
      break;
  }
  return summary;
}

function summarizeOpenAi(
  payload: Record<string, unknown>,
  summary: ProviderEnvelopeSummary,
): void {
  const messages = payload.messages;
  const input = payload.input;
  if (Array.isArray(messages)) {
    summary.messageCount = messages.length;
    const system = systemPresentInChatMessages(messages);
    if (system !== undefined) summary.systemPresent = system;
  } else if (hasOwn(payload, "input")) {
    // Responses-like: `input` may be a string (single text turn); count
    // arrays only. The system slot is either the `instructions` field or
    // a system/developer item inside `input` — Pi's adapter emits the
    // system prompt as an input item without an instructions field.
    if (Array.isArray(input)) summary.messageCount = input.length;
    if (typeof payload.instructions === "string") {
      summary.systemPresent = true;
    } else if (Array.isArray(input)) {
      const fromInput = systemPresentInChatMessages(input);
      if (fromInput !== undefined) summary.systemPresent = fromInput;
    } else if (typeof input === "string") {
      // A string input is a single user turn; it cannot carry a system item.
      summary.systemPresent = false;
    }
  }
  if (Array.isArray(payload.tools)) {
    summary.toolCount = payload.tools.length;
  }
}

function summarizeAnthropic(
  payload: Record<string, unknown>,
  summary: ProviderEnvelopeSummary,
): void {
  if (Array.isArray(payload.messages)) {
    summary.messageCount = payload.messages.length;
    // Explicit `system` (string or block array) indicates system presence;
    // its absence in an understood shape is a definite false.
    const system = payload.system;
    summary.systemPresent =
      typeof system === "string" || Array.isArray(system);
  }
  if (Array.isArray(payload.tools)) {
    summary.toolCount = payload.tools.length;
  }
}

/**
 * Bedrock Converse: `modelId` names the model (not `model`), `system`
 * is a block array, and tools live under `toolConfig.tools`.
 * `toolConfig` may be an explicit `undefined` (what Pi's adapter emits
 * when no tools are configured) — that is "no tools", not malformed.
 */
function summarizeBedrock(
  payload: Record<string, unknown>,
  summary: ProviderEnvelopeSummary,
): void {
  if (Array.isArray(payload.messages)) {
    summary.messageCount = payload.messages.length;
  }
  const system = payload.system;
  summary.systemPresent =
    typeof system === "string" || Array.isArray(system);
  const modelId = stringField(payload, "modelId");
  if (modelId !== undefined) summary.model = modelId;
  const toolConfig = payload.toolConfig;
  if (toolConfig === undefined) return; // adapter's explicit "no tools"
  if (isRecord(toolConfig) && Array.isArray(toolConfig.tools)) {
    summary.toolCount = toolConfig.tools.length;
  }
}

function summarizeGoogle(
  payload: Record<string, unknown>,
  summary: ProviderEnvelopeSummary,
): void {
  if (Array.isArray(payload.contents)) {
    summary.messageCount = payload.contents.length;
  }
  summary.systemPresent = googleSystemPresent(payload);
  const tools = googleField(payload, "tools");
  if (Array.isArray(tools)) {
    const count = countGoogleTools(tools);
    if (count !== undefined) summary.toolCount = count;
  }
}

/**
 * Google's SDK accepts `systemInstruction` as a string, an object with
 * `parts`, or an array — any of these means the field is present.
 * Undefined and malformed primitives (numbers, booleans) are false.
 * An explicitly supplied empty string counts as present, matching the
 * field-presence semantics already used for Anthropic and OpenAI.
 */
function googleSystemPresent(payload: Record<string, unknown>): boolean {
  const system = googleField(payload, "systemInstruction");
  return (
    typeof system === "string" ||
    isRecord(system) ||
    Array.isArray(system)
  );
}

/**
 * Google SDK payloads (what Pi's adapter emits) nest `systemInstruction`
 * and `tools` under `config`; the wire format keeps them at the top
 * level. Top level wins when both are present; `config` is the fallback.
 */
function googleField(
  payload: Record<string, unknown>,
  key: string,
): unknown {
  if (hasOwn(payload, key)) return payload[key];
  const config = payload.config;
  return isRecord(config) && hasOwn(config, key) ? config[key] : undefined;
}

/** Whether `key` exists at the top level or in `config` (google-like). */
function googleHasField(
  payload: Record<string, unknown>,
  key: string,
): boolean {
  if (hasOwn(payload, key)) return true;
  const config = payload.config;
  return isRecord(config) && hasOwn(config, key);
}

/** true/false when every message was inspectable; undefined otherwise. */
function systemPresentInChatMessages(
  messages: unknown[],
): boolean | undefined {
  let interpretable = true;
  for (const message of messages) {
    if (!isRecord(message)) {
      interpretable = false;
      continue;
    }
    const role = message.role;
    if (role === "system" || role === "developer") return true;
  }
  return interpretable ? false : undefined;
}

/**
 * Gemini tools: each entry is one tool; a `functionDeclarations` entry
 * holds N named functions. Count entries, expanding functionDeclarations.
 * Returns undefined when any entry is not an object (shape unclear).
 */
function countGoogleTools(tools: unknown[]): number | undefined {
  let total = 0;
  for (const entry of tools) {
    if (!isRecord(entry)) return undefined;
    if (Array.isArray(entry.functionDeclarations)) {
      total += entry.functionDeclarations.length;
    } else {
      total += 1; // e.g. { googleSearch: {} }, { codeExecution: {} }
    }
  }
  return total;
}

function extractTools(
  payload: unknown,
): ExtractedToolDefinition[] | undefined {
  if (!isRecord(payload)) return undefined;
  const shape = detectShape(payload);
  if (shape === "unknown") return undefined;

  if (shape === "google-like") {
    const googleTools = googleField(payload, "tools");
    if (!Array.isArray(googleTools)) {
      // Shape understood: absent tools means "no tools"; a present but
      // malformed tools field (top level or config) means uninterpretable.
      return googleHasField(payload, "tools") ? undefined : [];
    }
    return extractGoogleTools(googleTools);
  }

  if (shape === "bedrock-like") {
    const toolConfig = payload.toolConfig;
    // `toolConfig: undefined` is Pi's adapter saying "no tools"; a
    // missing toolConfig is Bedrock's optional field — both are "no
    // tools". A present but malformed toolConfig is uninterpretable.
    if (toolConfig === undefined) return [];
    if (!isRecord(toolConfig)) return undefined;
    if (!hasOwn(toolConfig, "tools")) return [];
    const bedrockTools = toolConfig.tools;
    if (!Array.isArray(bedrockTools)) return undefined;
    return extractBedrockTools(bedrockTools);
  }

  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    // Shape understood: absent tools field means "no tools"; a present
    // but malformed tools field means "schema cannot be interpreted".
    return hasOwn(payload, "tools") ? undefined : [];
  }

  switch (shape) {
    case "openai-like":
      return extractOpenAiTools(tools);
    case "anthropic-like":
      return extractAnthropicTools(tools);
    default:
      return undefined;
  }
}

/**
 * OpenAI tools: `{ type: "function", function: { name, description,
 * parameters } }` (chat) or `{ type: "function", name, description,
 * parameters }` (Responses / custom). The whole entry is preserved as
 * `raw`; name/description come from the innermost object that has them.
 */
function extractOpenAiTools(tools: unknown[]): ExtractedToolDefinition[] {
  const out: ExtractedToolDefinition[] = [];
  tools.forEach((entry, index) => {
    if (!isRecord(entry)) return; // not a definition; keep index gap
    const def: ExtractedToolDefinition = { index, raw: entry };
    const fn = entry.function;
    if (isRecord(fn)) {
      const name = stringField(fn, "name");
      if (name !== undefined) def.name = name;
      const description = stringField(fn, "description");
      if (description !== undefined) def.description = description;
    } else {
      const name = stringField(entry, "name");
      if (name !== undefined) def.name = name;
      const description = stringField(entry, "description");
      if (description !== undefined) def.description = description;
    }
    out.push(def);
  });
  return out;
}

/**
 * Bedrock tools: `toolConfig.tools[]` where each entry wraps a spec as
 * `{ toolSpec: { name, description, inputSchema } }`. The whole entry
 * is preserved as `raw`; name/description come from `toolSpec`.
 */
function extractBedrockTools(tools: unknown[]): ExtractedToolDefinition[] {
  const out: ExtractedToolDefinition[] = [];
  tools.forEach((entry, index) => {
    if (!isRecord(entry)) return; // not a definition; keep index gap
    const def: ExtractedToolDefinition = { index, raw: entry };
    const spec = entry.toolSpec;
    if (isRecord(spec)) {
      const name = stringField(spec, "name");
      if (name !== undefined) def.name = name;
      const description = stringField(spec, "description");
      if (description !== undefined) def.description = description;
    }
    out.push(def);
  });
  return out;
}

/** Anthropic tools: `{ name, description, input_schema }`. */
function extractAnthropicTools(tools: unknown[]): ExtractedToolDefinition[] {
  const out: ExtractedToolDefinition[] = [];
  tools.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const def: ExtractedToolDefinition = { index, raw: entry };
    const name = stringField(entry, "name");
    if (name !== undefined) def.name = name;
    const description = stringField(entry, "description");
    if (description !== undefined) def.description = description;
    out.push(def);
  });
  return out;
}

/**
 * Gemini tools: named definitions live in `tools[].functionDeclarations[]`.
 * Each declaration becomes one definition with the flattened position as
 * index; non-function tool entries (googleSearch, codeExecution, ...)
 * carry no extractable definition and are skipped (they still count via
 * toolCount).
 */
function extractGoogleTools(tools: unknown[]): ExtractedToolDefinition[] {
  const out: ExtractedToolDefinition[] = [];
  let index = 0;
  for (const entry of tools) {
    if (!isRecord(entry) || !Array.isArray(entry.functionDeclarations)) {
      continue;
    }
    for (const declaration of entry.functionDeclarations) {
      const def: ExtractedToolDefinition = { index, raw: declaration };
      if (isRecord(declaration)) {
        const name = stringField(declaration, "name");
        if (name !== undefined) def.name = name;
        const description = stringField(declaration, "description");
        if (description !== undefined) def.description = description;
      }
      out.push(def);
      index += 1;
    }
  }
  return out;
}
