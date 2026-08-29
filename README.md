# pi-observe — P0.1 Observation Core + P0.2 Provider Payload Interpretation + P0.3 Request Inspector TUI

Passive, fail-open, in-memory observation of Pi coding-agent sessions.
P0.1 establishes the trustworthy capture/correlation layer; P0.2 adds a
provider-neutral, best-effort interpretation of each captured payload
(envelope summary + extractable tool definitions); P0.3 adds the local
`/inspect` request inspector TUI on top of both.

**Design rule: passive observability only.** This extension never adds
model-visible messages, tools, prompt text, or provider payload
transformations — every observer hook returns `undefined`, and
`/inspect` is a local UI command with no LLM interaction.

## What local state answers (per P0.1)

- run count (`runCount`), actual turns started (`turnCount` — one per
  `turn_start`; Pi's zero-based per-run `turnIndex` is never used as a
  session count), actual provider-request count (`requestCount`) — a
  provider request exists only when `before_provider_request` fires;
  `turn_start` and `context` never create request records
- run/turn correlation per `RequestRecord` (`runId`, `turnIndex`)
- effective system prompt (`PromptSnapshot.systemPrompt`) and
  `systemPromptOptions`
- preceding logical context (`RequestRecord.logicalContext` from the
  latest `context` event, consumed at commit)
- sanitized provider payload (`RequestRecord.sanitizedProviderPayload`)
- provider envelope projection (`RequestRecord.providerEnvelope`):
  detected family (`openai-like` / `anthropic-like` / `google-like` /
  `unknown`), model string, message count, tool count, system presence
- extracted tool definitions (`RequestRecord.providerTools`): raw,
  provider-schema-preserving definitions plus safe name/description
  metadata; `undefined` = schema uninterpretable, `[]` = no tools
- model/provider (`ModelIdentity`), thinking level, context usage
  (`ContextUsageSnapshot`), plus observation warnings

## P0.2 — Provider payload interpretation

`src/provider-envelope.ts` turns the sanitized raw payload into a
convenience projection. The raw payload remains authoritative; the
projection is never used to reject or alter capture.

- `summarizeProviderPayload(payload)` → `ProviderEnvelopeSummary`
  (`detectedShape` + optional `model`, `messageCount`, `toolCount`,
  `systemPresent`) — never throws, `unknown` shape for anything
  unrecognized, counts only when the relevant field is an array with
  clear semantics, absent-but-inspected system slots report `false`
- `extractProviderTools(payload)` → `ExtractedToolDefinition[] |
  undefined` — `undefined` means "schema cannot be interpreted" (P0.3
  shows *Tool schema could not be interpreted… See RAW*); `[]` means
  schema understood, no tools. Raw definitions preserve the provider's
  own schema (OpenAI `function`/`parameters`, Anthropic `input_schema`,
  Google `functionDeclarations`, Bedrock `toolSpec`); name/description
  filled only when safe
- `interpretProviderPayload(payload)` → both projections in one pass

Heuristics are deliberately conservative and signature-based:
`contents` → google-like; `toolConfig` / `inferenceConfig` / string
`modelId` + `messages` → bedrock-like; `anthropic_version`, top-level
`system` + `messages`, or tools with `input_schema` → anthropic-like;
`messages` → openai-like (chat); `input` → openai-like (Responses);
otherwise unknown. A bare `messages`+`model` body without distinctive
signals falls back to openai-like rather than guessing.

Provider-adapter realities handled:

- **Responses system slot**: system presence comes from the
  `instructions` field *or* a `system`/`developer` item inside
  `input` (what Pi's adapter emits — no instructions field); a string
  `input` is a single user turn and cannot carry a system item
- **Google SDK config nesting**: Pi's adapter emits
  `{ model, contents, config: { systemInstruction, tools } }`; the
  nested `config` locations are read as fallbacks, with the top-level
  wire format (`systemInstruction`, `tools`) winning when both exist.
  `systemInstruction` counts as present in any form the SDK accepts
  (string, object, or array); an explicit empty string counts as
  present, matching Anthropic/OpenAI field-presence semantics
- **Bedrock Converse**: Pi's adapter emits `modelId` + `messages` +
  `system` (block array) + `inferenceConfig`, with tools under
  `toolConfig.tools[].toolSpec` — never top-level `tools`. Bedrock is
  detected *before* the Anthropic heuristic so its `system`+`messages`
  body is not mislabeled; `model` is read from `modelId`; tool
  extraction unwraps `toolSpec` while preserving the entry as `raw`.
  The adapter's explicit `toolConfig: undefined` (no tools configured)
  counts as "no tools", not an uninterpretable schema

Capture integration (P0.2.7): `before_provider_request` → P0.1 snapshot
+ sanitize → P0.2 summarize/extract from the **sanitized** snapshot →
store `RequestRecord` with `providerEnvelope` / `providerTools`.
Interpretation is wrapped; a throwing interpreter adds a
`provider-envelope-parse-failed` warning and the raw record is still
appended. The interpreter is injectable via
`SessionStoreOptions.interpretPayload` (used by tests).

## Truthful authority

The captured `sanitizedProviderPayload` is the payload **observed by
this extension**, not guaranteed wire bytes. Later extensions can
replace the payload after this extension's handler runs. Load the
observer **last** (after all other extensions) so what it sees is what
Pi sends.

## Install

```bash
# dev: symlink repo into auto-discovered location
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-observe
# prod: copy or use pi install <pkg> once published
```

Then run `pi` — extension auto-discovers via `package.json` →
`pi.extensions: ["./pi-observe.ts"]`.

Config: `PI_OBSERVE_MAX_REQUESTS` (default 100) bounds retained
records; oldest are evicted. Nothing is persisted.

Remove with:

```bash
rm ~/.pi/agent/extensions/pi-observe
```

## P0.3 — Request inspector (`/inspect`)

Local-only command: opens a TUI over the observation store. It sends no
model message, registers no LLM-callable tool, and never mutates
session context, the system prompt, or provider payloads — it only
reads store state (`getState` / `getRequest`).

```
/inspect          # ledger: observed provider requests, newest first
/inspect latest   # detail of the most recent request
/inspect 17       # detail of request sequence 17
```

**Ledger** — session-level counters (Runs / Turns / Requests /
Context) plus per-request rows: `#`, run, turn, model (truncated to
fit), context usage, logical message count, provider tool count.
Unknown values render as `?`; empty sessions show
"No provider requests observed yet."; 50+ requests navigate with
selection-following scroll.

**Detail** — keyboard-switchable sections (`←→`/`tab`/`1-5`):

- `OVERVIEW` — request id, run, turn, timestamp, provider/model,
  thinking level, context usage, message/tool counts, detected
  provider shape, observation/correlation/parser warnings
- `SYSTEM` — effective system prompt + structured `systemPromptOptions`
  (no provenance decomposition — later phase)
- `CONTEXT` — logical model-facing messages (expand for full content);
  summaries are single-line, and the selected message's summary stays
  pinned at the top of the window while its detail is scrolled
- `TOOLS` — P0.2 extraction (expand for raw definitions); an
  uninterpretable schema explicitly says so and points to RAW
- `RAW` — sanitized provider payload observed by the extension
  (labeled, not guaranteed wire bytes)

All sections scroll; long content (prompts, context, raw JSON) stays
navigable at 80 columns and wider. Formatting lives in `src/format.ts`,
separate from capture/parsing, and every display helper degrades
gracefully to `?` or inspectable text — malformed payloads can never
crash the inspector or the agent.

While the inspector is open, the footer shows the optional status
indicator (`obs r17 · t12 · 41.8k/128k`) via `ctx.ui.setStatus`; it is
cleared on close and Pi's footer is untouched.

## Development

```bash
npm install
npm test          # node --test "tests/**/*.test.ts" (native TS, no build)
npm run typecheck # tsc --noEmit
```

## Files

| Path | Purpose |
|------|---------|
| `src/model.ts` | Shared types (structurally match Pi) |
| `src/clone.ts` | `safeSnapshot` — structuredClone, JSON fallback, fail-open |
| `src/sanitize.ts` | Key-name credential redaction, cycle-safe |
| `src/provider-envelope.ts` | P0.2 shape detection, envelope summary, tool extraction |
| `src/correlation.ts` | Pure builders: ids, model identity, prompts, records |
| `src/store.ts` | State machine + bounded store; canonical commit point |
| `src/recorder.ts` | Pi event wiring (handlers return undefined) |
| `src/format.ts` | P0.3 display helpers (tokens, timestamps, summaries, safe JSON) |
| `src/ui/text-viewer.ts` | P0.3 scrolling text viewer + shared theme/tui types |
| `src/ui/json-viewer.ts` | P0.3 safe pretty-JSON viewer (RAW section) |
| `src/ui/request-list.ts` | P0.3 ledger component |
| `src/ui/request-detail.ts` | P0.3 OVERVIEW/SYSTEM/CONTEXT/TOOLS/RAW detail component |
| `src/ui/inspect.ts` | P0.3 `/inspect` command registration + orchestration |
| `src/index.ts` | Extension entry (observer + `/inspect`) |
| `tests/` | 130 tests: clone, sanitize, correlation, recorder, provider-envelope, store (+ fixtures), UI components, command wiring |

## Verified against installed Pi 0.84.2

- `@earendil-works/*` scope (current upstream) — no `@mariozechner/*`
  imports anywhere
- events: `before_agent_start`, `agent_start`, `agent_end`,
  `agent_settled`, `turn_start`/`turn_end` (`turnIndex`), `context`,
  `before_provider_request` (`payload: unknown`),
  `session_start` — confirmed live in a real `pi -p` run:
  `before_agent_start → agent_start → turn_start → context →
  before_provider_request → agent_end → agent_settled`
- ctx: `getSystemPrompt()`, `getContextUsage()`, `model`, `thinkingLevel`
- intentionally NOT subscribed: `before_provider_headers` (forbidden),
  `model_select`/`thinking_level_select` (notification-only; commit-time
  ctx values are fresher), `after_provider_response` (P0.4+ HTTP tracing)

## Zero-context verification (P0.1.6)

Runtime proof with a probe extension capturing, in a real `pi -p` run:
`before_agent_start` system prompt/options, `context` messages,
`before_provider_request` payload, model, thinking level. With the
observer loaded before the probe, compared to baseline:

- system prompt string: **identical**
- systemPromptOptions (tools, snippets, guidelines, context files,
  skills): **identical**
- model and thinking level: **identical**
- payload top-level keys, message count, roles: **identical**;
  system message byte-identical
- the only differences are assistant-generated values (reasoning
  text, tool call ids/arguments, usage numbers) — the same categories
  of difference as between two runs *without* the extension

Static proof: no `registerTool`, `registerFlag`, or `pi.sendUserMessage`
in the source; the only `registerCommand` is the local `/inspect`
(no LLM-callable surface); all handlers return `undefined`
(unit-tested); every stored value is cloned, never referenced;
`/inspect` only reads store state (unit-tested).

## Explicitly out of scope (P0.1 + P0.2 + P0.3)

No request-to-request diffs, provenance/source attribution beyond raw
`systemPromptOptions`, persistence/restore, timing analytics
(TTFT/tokens-per-second), export/share, HTTP tracing, replay,
model-facing observability tools, or Pi core changes.
