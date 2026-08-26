/**
 * P0.2 — Provider Payload Interpretation tests.
 *
 * Covers shape detection, model/message/system/tool projections, raw
 * tool-definition preservation, unknown/malformed hardening, and the
 * recorder integration contract (parser failure never blocks capture).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  extractProviderTools,
  interpretProviderPayload,
  summarizeProviderPayload,
} from "../src/provider-envelope.ts";
import { Recorder } from "../src/recorder.ts";
import { SessionStore } from "../src/store.ts";
import {
  agentStartEvent,
  contextEvent,
  fakeCtx,
  fakeModel,
  providerRequestEvent,
  turnStartEvent,
} from "./helpers.ts";

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixtures: openai-like
// ---------------------------------------------------------------------------

test("openai chat fixture: shape, model, counts, system role", () => {
  const fixture = loadFixture("openai-chat.json") as Record<string, unknown>;
  const summary = summarizeProviderPayload(fixture);
  assert.deepEqual(summary, {
    detectedShape: "openai-like",
    model: "gpt-4o",
    messageCount: 3,
    toolCount: 2,
    systemPresent: true,
  });
});

test("openai chat fixture: tool extraction preserves raw definitions", () => {
  const fixture = loadFixture("openai-chat.json") as Record<string, unknown>;
  const tools = extractProviderTools(fixture);
  assert.equal(tools?.length, 2);
  assert.equal(tools?.[0]?.index, 0);
  assert.equal(tools?.[0]?.name, "read_file");
  assert.equal(tools?.[0]?.description, "Read a file from disk");
  // Provider-specific schema preserved verbatim, including parameters.
  assert.deepEqual(tools?.[0]?.raw, {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  });
  // Second tool has no description: omitted, not fabricated.
  assert.equal(tools?.[1]?.index, 1);
  assert.equal(tools?.[1]?.name, "bash");
  assert.equal(tools?.[1]?.description, undefined);
});

test("openai chat without system role: systemPresent false", () => {
  const summary = summarizeProviderPayload({
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.systemPresent, false);
  assert.equal(summary.toolCount, undefined);
});

test("openai chat with developer role counts as system present", () => {
  const summary = summarizeProviderPayload({
    messages: [{ role: "developer", content: "d" }],
  });
  assert.equal(summary.systemPresent, true);
});

test("openai responses fixture: instructions + input", () => {
  const fixture = loadFixture("openai-responses.json") as Record<string, unknown>;
  const summary = summarizeProviderPayload(fixture);
  assert.deepEqual(summary, {
    detectedShape: "openai-like",
    model: "gpt-5",
    messageCount: 1,
    toolCount: 1,
    systemPresent: true,
  });
  const tools = extractProviderTools(fixture);
  assert.equal(tools?.[0]?.name, "list_dir"); // Responses-style entry.name
  assert.equal(tools?.[0]?.description, "List directory contents");
});

test("openai responses with string input: no fabricated message count", () => {
  const summary = summarizeProviderPayload({
    model: "gpt-5",
    input: "hello",
  });
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(summary.messageCount, undefined); // arrays only
  assert.equal(summary.systemPresent, false); // input understood, no instructions
});

test("openai responses: system/developer item inside input counts as system", () => {
  // Pi's adapter emits the system prompt as an input item without an
  // instructions field; system presence must come from the input roles.
  const payload = {
    model: "gpt-5",
    input: [
      { role: "system", content: [{ type: "output_text", text: "You are pi." }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  };
  const summary = summarizeProviderPayload(payload);
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.systemPresent, true);
});

test("openai responses: developer item inside input counts as system", () => {
  const summary = summarizeProviderPayload({
    input: [{ role: "developer", content: "d" }],
  });
  assert.equal(summary.systemPresent, true);
});

test("openai responses: input array without system/developer roles is false", () => {
  const summary = summarizeProviderPayload({
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  });
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.systemPresent, false);
});

// ---------------------------------------------------------------------------
// Fixtures: anthropic-like
// ---------------------------------------------------------------------------

test("anthropic fixture: shape, model, counts, system", () => {
  const fixture = loadFixture("anthropic-messages.json") as Record<string, unknown>;
  const summary = summarizeProviderPayload(fixture);
  assert.deepEqual(summary, {
    detectedShape: "anthropic-like",
    model: "claude-3-7-sonnet-20250219",
    messageCount: 2,
    toolCount: 1,
    systemPresent: true,
  });
});

test("anthropic fixture: tool extraction reads name/description/input_schema raw", () => {
  const fixture = loadFixture("anthropic-messages.json") as Record<string, unknown>;
  const tools = extractProviderTools(fixture);
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.name, "bash");
  assert.equal(tools?.[0]?.description, "Run a shell command");
  assert.deepEqual(tools?.[0]?.raw, {
    name: "bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  });
});

test("anthropic without system key: systemPresent false", () => {
  const summary = summarizeProviderPayload({
    model: "claude",
    anthropic_version: "2023-06-01",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(summary.detectedShape, "anthropic-like");
  assert.equal(summary.systemPresent, false);
});

test("bare messages+model without distinctive signals is openai-like", () => {
  // Genuinely ambiguous between chat/completions and a bare Anthropic
  // body; conservative detection falls back to the residual messages
  // shape rather than guessing. Raw payload remains authoritative.
  const summary = summarizeProviderPayload({
    model: "claude",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(summary.messageCount, 1);
});

test("anthropic detection via input_schema alone (no system field)", () => {
  const payload = {
    model: "claude",
    max_tokens: 100,
    tools: [{ name: "bash", input_schema: { type: "object" } }],
  };
  assert.equal(summarizeProviderPayload(payload).detectedShape, "anthropic-like");
  assert.equal(extractProviderTools(payload)?.[0]?.name, "bash");
});

// ---------------------------------------------------------------------------
// Fixtures: google-like
// ---------------------------------------------------------------------------

test("google fixture: shape, model, counts, systemInstruction", () => {
  const fixture = loadFixture("google-like.json") as Record<string, unknown>;
  const summary = summarizeProviderPayload(fixture);
  assert.deepEqual(summary, {
    detectedShape: "google-like",
    model: "gemini-2.5-pro",
    messageCount: 1,
    toolCount: 2, // functionDeclarations expanded
    systemPresent: true,
  });
});

test("google fixture: tool extraction flattens functionDeclarations", () => {
  const fixture = loadFixture("google-like.json") as Record<string, unknown>;
  const tools = extractProviderTools(fixture);
  assert.equal(tools?.length, 2);
  assert.equal(tools?.[0]?.index, 0);
  assert.equal(tools?.[0]?.name, "web_search");
  assert.equal(tools?.[0]?.description, "Search the web");
  assert.equal(tools?.[1]?.index, 1);
  assert.equal(tools?.[1]?.name, "open_url");
  assert.equal(tools?.[1]?.description, undefined); // not fabricated
  assert.deepEqual(tools?.[1]?.raw, {
    name: "open_url",
    parameters: { type: "object", properties: { url: { type: "string" } } },
  });
});

test("google without systemInstruction: systemPresent false", () => {
  const summary = summarizeProviderPayload({ contents: [{ role: "user", parts: [] }] });
  assert.equal(summary.detectedShape, "google-like");
  assert.equal(summary.systemPresent, false);
});

test("google non-function tool entries count but are not extracted", () => {
  const payload = {
    contents: [],
    tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: "f" }] }],
  };
  assert.equal(summarizeProviderPayload(payload).toolCount, 2);
  const tools = extractProviderTools(payload);
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.name, "f");
});

test("google SDK payload: config.systemInstruction and config.tools are read", () => {
  // Pi's adapter emits { model, contents, config: { systemInstruction,
  // tools } }; the nested locations must drive the projection.
  const payload = {
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: {
      systemInstruction: { parts: [{ text: "You are Gemini." }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "web_search",
              description: "Search the web",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
  };
  const summary = summarizeProviderPayload(payload);
  assert.deepEqual(summary, {
    detectedShape: "google-like",
    model: "gemini-2.5-flash",
    messageCount: 1,
    toolCount: 1,
    systemPresent: true,
  });
  const tools = extractProviderTools(payload);
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.name, "web_search");
  assert.equal(tools?.[0]?.description, "Search the web");
});

test("google SDK payload: top-level fields win over config", () => {
  const payload = {
    contents: [],
    tools: [{ functionDeclarations: [{ name: "top_tool" }] }],
    config: {
      systemInstruction: { parts: [{ text: "nested" }] },
      tools: [{ functionDeclarations: [{ name: "nested_tool" }] }],
    },
  };
  const summary = summarizeProviderPayload(payload);
  assert.equal(summary.systemPresent, true);
  assert.equal(summary.toolCount, 1);
  const tools = extractProviderTools(payload);
  assert.equal(tools?.[0]?.name, "top_tool");
});

test("google SDK payload: empty config yields no fabricated data", () => {
  const payload = { contents: [{ role: "user", parts: [] }], config: {} };
  const summary = summarizeProviderPayload(payload);
  assert.equal(summary.systemPresent, false);
  assert.equal(summary.toolCount, undefined);
  assert.deepEqual(extractProviderTools(payload), []);
});

test("google SDK payload: malformed config.tools is uninterpretable", () => {
  assert.equal(
    extractProviderTools({ contents: [], config: { tools: {} } }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Fixtures: bedrock-like
// ---------------------------------------------------------------------------

test("bedrock fixture: shape, modelId, counts, system", () => {
  const fixture = loadFixture("bedrock-like.json") as Record<string, unknown>;
  const summary = summarizeProviderPayload(fixture);
  assert.deepEqual(summary, {
    detectedShape: "bedrock-like",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messageCount: 2,
    toolCount: 2,
    systemPresent: true,
  });
});

test("bedrock fixture: top-level system+messages is not misread as anthropic", () => {
  // Regression: the anthropic heuristic (top-level `system` + `messages`)
  // must not fire for Bedrock Converse payloads.
  const fixture = loadFixture("bedrock-like.json") as Record<string, unknown>;
  assert.equal(fixture.system !== undefined, true);
  assert.equal(Array.isArray(fixture.messages), true);
  assert.equal(summarizeProviderPayload(fixture).detectedShape, "bedrock-like");
});

test("bedrock fixture: tool extraction reads toolSpec, preserves raw", () => {
  const fixture = loadFixture("bedrock-like.json") as Record<string, unknown>;
  const tools = extractProviderTools(fixture);
  assert.equal(tools?.length, 2);
  assert.equal(tools?.[0]?.index, 0);
  assert.equal(tools?.[0]?.name, "read_file");
  assert.equal(tools?.[0]?.description, "Read a file from disk");
  // Provider-specific schema preserved verbatim, toolSpec wrapper intact.
  assert.deepEqual(tools?.[0]?.raw, {
    toolSpec: {
      name: "read_file",
      description: "Read a file from disk",
      inputSchema: {
        json: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  });
  // Second tool has no description: omitted, not fabricated.
  assert.equal(tools?.[1]?.index, 1);
  assert.equal(tools?.[1]?.name, "bash");
  assert.equal(tools?.[1]?.description, undefined);
});

test("bedrock without system: systemPresent false", () => {
  const summary = summarizeProviderPayload({
    modelId: "amazon.nova-pro-v1:0",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  });
  assert.equal(summary.detectedShape, "bedrock-like");
  assert.equal(summary.model, "amazon.nova-pro-v1:0");
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.systemPresent, false);
  assert.equal(summary.toolCount, undefined);
});

test("bedrock with explicit toolConfig undefined: no tools, shape still detected", () => {
  // Pi's adapter emits `toolConfig: undefined` when no tools are
  // configured; the own property survives structuredClone, so shape
  // detection must still see Bedrock and extraction must say "no tools".
  const payload = {
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
    system: [{ text: "You are pi." }],
    inferenceConfig: {},
    toolConfig: undefined,
  };
  const summary = summarizeProviderPayload(payload);
  assert.equal(summary.detectedShape, "bedrock-like");
  assert.equal(summary.toolCount, undefined);
  assert.deepEqual(extractProviderTools(payload), []);
});

test("bedrock absent toolConfig: extraction says no tools", () => {
  const payload = { modelId: "m", messages: [] };
  assert.equal(summarizeProviderPayload(payload).detectedShape, "bedrock-like");
  assert.deepEqual(extractProviderTools(payload), []);
});

test("bedrock detected via inferenceConfig alone", () => {
  const summary = summarizeProviderPayload({ inferenceConfig: { maxTokens: 100 } });
  assert.equal(summary.detectedShape, "bedrock-like");
});

test("bedrock malformed toolConfig is uninterpretable, never fabricated", () => {
  assert.equal(
    extractProviderTools({ modelId: "m", messages: [], toolConfig: { tools: {} } }),
    undefined,
  );
  assert.equal(
    extractProviderTools({ modelId: "m", messages: [], toolConfig: 42 }),
    undefined,
  );
  // toolConfig present without a tools key: understood, no tools.
  assert.deepEqual(
    extractProviderTools({ modelId: "m", messages: [], toolConfig: {} }),
    [],
  );
  const summary = summarizeProviderPayload({
    modelId: "m",
    messages: [],
    toolConfig: { tools: {} },
  });
  assert.equal(summary.detectedShape, "bedrock-like");
  assert.equal(summary.toolCount, undefined);
});

test("bedrock non-object tool entries are skipped, indices kept", () => {
  const tools = extractProviderTools({
    modelId: "m",
    messages: [],
    toolConfig: {
      tools: [null, { toolSpec: { name: "a" } }, "junk"],
    },
  });
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.index, 1);
  assert.equal(tools?.[0]?.name, "a");
});

test("google SDK string systemInstruction counts as present", () => {
  // Pi's adapter supplies the system prompt as a plain string.
  const summary = summarizeProviderPayload({
    model: "gemini-2.5-pro",
    contents: [],
    config: {
      systemInstruction: "You are Gemini.",
    },
  });
  assert.equal(summary.detectedShape, "google-like");
  assert.equal(summary.model, "gemini-2.5-pro");
  assert.equal(summary.systemPresent, true);
});

test("google array systemInstruction counts as present", () => {
  const summary = summarizeProviderPayload({
    contents: [],
    config: { systemInstruction: [{ text: "You are Gemini." }] },
  });
  assert.equal(summary.systemPresent, true);
});

test("google empty-string systemInstruction counts as present (field semantics)", () => {
  // Same "field is present" rule as Anthropic's `system: ""` and
  // OpenAI's `instructions: ""` — presence, not truthiness.
  const summary = summarizeProviderPayload({
    contents: [],
    config: { systemInstruction: "" },
  });
  assert.equal(summary.systemPresent, true);
});

test("google malformed systemInstruction primitive is false", () => {
  const summary = summarizeProviderPayload({
    contents: [],
    config: { systemInstruction: 42 },
  });
  assert.equal(summary.systemPresent, false);
});

// ---------------------------------------------------------------------------
// Unknown / hardening
// ---------------------------------------------------------------------------

test("unknown fixture returns unknown and uninterpretable tools", () => {
  const fixture = loadFixture("unknown.json");
  assert.deepEqual(summarizeProviderPayload(fixture), {
    detectedShape: "unknown",
  });
  assert.equal(extractProviderTools(fixture), undefined);
});

test("unknown shape keeps a generic top-level string model only", () => {
  assert.deepEqual(summarizeProviderPayload({ model: "mystery-model", foo: 1 }), {
    detectedShape: "unknown",
    model: "mystery-model",
  });
});

test("null, primitives, arrays, and empty objects never throw", () => {
  const values: unknown[] = [
    null,
    undefined,
    "text",
    42,
    true,
    [1, 2, 3],
    [],
    {},
    new Date(),
  ];
  for (const value of values) {
    assert.deepEqual(
      summarizeProviderPayload(value),
      { detectedShape: "unknown" },
      `summarize(${String(value)})`,
    );
    assert.equal(extractProviderTools(value), undefined);
  }
});

test("malformed known-looking payloads omit counts, never fabricate", () => {
  // anthropic_version present but messages/tools malformed
  const anthropic = summarizeProviderPayload({
    anthropic_version: "2023-06-01",
    messages: "nope",
    tools: {},
  });
  assert.equal(anthropic.detectedShape, "anthropic-like");
  assert.equal(anthropic.messageCount, undefined);
  assert.equal(anthropic.toolCount, undefined);
  assert.equal(anthropic.systemPresent, undefined);
  assert.equal(extractProviderTools({ anthropic_version: "x", tools: {} }), undefined);

  // contents malformed
  const google = summarizeProviderPayload({ contents: 42, tools: "nope" });
  assert.equal(google.detectedShape, "google-like");
  assert.equal(google.messageCount, undefined);
  assert.equal(google.systemPresent, false); // no systemInstruction anywhere
  assert.equal(google.toolCount, undefined);

  // messages malformed: not openai-like, not anthropic-like
  assert.deepEqual(summarizeProviderPayload({ messages: "nope", model: "m" }), {
    detectedShape: "unknown",
    model: "m",
  });

  // non-string model is not reported
  const numericModel = summarizeProviderPayload({ messages: [], model: 42 });
  assert.equal(numericModel.detectedShape, "openai-like");
  assert.equal(numericModel.model, undefined);
  assert.equal(numericModel.messageCount, 0);
  assert.equal(numericModel.systemPresent, false);
});

test("empty arrays count as zero; absent tools field means no tools", () => {
  const summary = summarizeProviderPayload({ model: "gpt-4o", messages: [] });
  assert.equal(summary.messageCount, 0);
  assert.equal(summary.toolCount, undefined);
  assert.deepEqual(extractProviderTools({ messages: [] }), []);

  const withEmptyTools = summarizeProviderPayload({
    messages: [],
    tools: [],
  });
  assert.equal(withEmptyTools.toolCount, 0);
  assert.deepEqual(extractProviderTools({ messages: [], tools: [] }), []);
});

test("malformed tools field: extraction is explicitly uninterpretable", () => {
  // tools present but not an array → undefined (not []), even in a
  // recognized shape. P0.3 can say "schema could not be interpreted".
  assert.equal(extractProviderTools({ messages: [], tools: {} }), undefined);
  assert.equal(
    extractProviderTools({ messages: [], tools: [{ not: "a tool" }] })?.length,
    1, // object entries are definitions; name/description stay absent
  );
});

test("extraction skips non-object entries but keeps original indices", () => {
  const tools = extractProviderTools({
    messages: [],
    tools: [null, { type: "function", function: { name: "a" } }, "junk"],
  });
  assert.equal(tools?.length, 1);
  assert.equal(tools?.[0]?.index, 1);
  assert.equal(tools?.[0]?.name, "a");
});

test("parser never mutates the payload (deep-frozen input)", () => {
  const fixture = deepFreeze(loadFixture("openai-chat.json"));
  const before = JSON.stringify(fixture);
  const summary = summarizeProviderPayload(fixture);
  const tools = extractProviderTools(fixture);
  const interpretation = interpretProviderPayload(fixture);
  assert.equal(summary.detectedShape, "openai-like");
  assert.equal(tools?.[0]?.name, "read_file");
  assert.equal(interpretation.summary.model, "gpt-4o");
  assert.equal(JSON.stringify(fixture), before);
});

test("interpretProviderPayload combines both projections", () => {
  const fixture = loadFixture("google-like.json");
  const { summary, tools } = interpretProviderPayload(fixture);
  assert.equal(summary.detectedShape, "google-like");
  assert.equal(tools?.length, 2);
});

// ---------------------------------------------------------------------------
// Recorder integration (P0.2.7)
// ---------------------------------------------------------------------------

function makeRecorder(maxRequests = 100) {
  const store = new SessionStore({ maxRequests });
  const recorder = new Recorder({ store });
  return { store, recorder };
}

test("recorder stores envelope + tools on the request record", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel({ id: "gpt-4o", provider: "openai" }) });
  const payload = loadFixture("openai-chat.json");

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "hi" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent(payload), ctx);

  const [record] = store.getRequests();
  assert.equal(record.providerEnvelope?.detectedShape, "openai-like");
  assert.equal(record.providerEnvelope?.model, "gpt-4o");
  assert.equal(record.providerEnvelope?.messageCount, 3);
  assert.equal(record.providerEnvelope?.systemPresent, true);
  assert.equal(record.providerEnvelope?.toolCount, 2);
  assert.equal(record.providerTools?.[0]?.name, "read_file");
  assert.equal(record.providerTools?.[1]?.name, "bash");
  // Raw sanitized payload remains the authoritative source record.
  assert.deepEqual(record.sanitizedProviderPayload, payload);
  assert.deepEqual(record.warnings, []);
});

test("interpretation runs on the sanitized payload (credentials removed)", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });
  const payload = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    apiKey: "sk-secret",
  };

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "hi" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent(payload), ctx);

  const [record] = store.getRequests();
  assert.equal(record.providerEnvelope?.detectedShape, "openai-like");
  assert.equal(record.providerEnvelope?.messageCount, 1);
  assert.equal(
    (record.sanitizedProviderPayload as Record<string, unknown>).apiKey,
    "[REDACTED]",
  );
});

test("unknown payload records with unknown envelope, tools undefined", () => {
  const { store, recorder } = makeRecorder();
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "hi" }]), ctx);
  recorder.beforeProviderRequest(providerRequestEvent({ foo: "bar" }), ctx);

  const [record] = store.getRequests();
  assert.deepEqual(record.providerEnvelope, { detectedShape: "unknown" });
  assert.equal(record.providerTools, undefined);
  assert.deepEqual(record.sanitizedProviderPayload, { foo: "bar" });
  assert.deepEqual(record.warnings, []);
});

test("parser failure never prevents request recording", () => {
  const store = new SessionStore({
    interpretPayload: () => {
      throw new Error("interpreter exploded");
    },
  });
  const recorder = new Recorder({ store });
  const ctx = fakeCtx({ model: fakeModel() });

  recorder.agentStart(agentStartEvent(), ctx);
  recorder.turnStart(turnStartEvent(0), ctx);
  recorder.context(contextEvent([{ role: "user", content: "hi" }]), ctx);
  recorder.beforeProviderRequest(
    providerRequestEvent({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    ctx,
  );

  const [record] = store.getRequests();
  assert.equal(record.requestId, "req-1");
  assert.equal(record.providerEnvelope, undefined);
  assert.equal(record.providerTools, undefined);
  assert.deepEqual(record.sanitizedProviderPayload, {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(record.warnings.map((w) => w.code), [
    "provider-envelope-parse-failed",
  ]);
  assert.deepEqual(store.getState().warnings.map((w) => w.code), [
    "provider-envelope-parse-failed",
  ]);
});
