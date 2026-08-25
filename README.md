# pi-observe — P0.1 Observation Core

Passive, fail-open, in-memory observation of Pi coding-agent sessions.
P0.1 establishes the trustworthy capture/correlation layer that P0.2
(provider-shape interpretation) and P0.3 (request inspector) build on.

**Design rule: passive observability only.** This extension never adds
model-visible messages, tools, prompt text, or provider payload
transformations — every observer hook returns `undefined`.

## What local state answers (per P0.1)

- run count (`runCount`), Pi turns (`maxTurnIndex`), actual
  provider-request count (`requestCount`) — a provider request exists
  only when `before_provider_request` fires; `turn_start` and `context`
  never create request records
- run/turn correlation per `RequestRecord` (`runId`, `turnIndex`)
- effective system prompt (`PromptSnapshot.systemPrompt`) and
  `systemPromptOptions`
- preceding logical context (`RequestRecord.logicalContext` from the
  latest `context` event, consumed at commit)
- sanitized provider payload (`RequestRecord.sanitizedProviderPayload`)
- model/provider (`ModelIdentity`), thinking level, context usage
  (`ContextUsageSnapshot`), plus observation warnings

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
`pi.extensions: ["./src/index.ts"]`.

Config: `PI_OBSERVE_MAX_REQUESTS` (default 100) bounds retained
records; oldest are evicted. Nothing is persisted.

Remove with:

```bash
rm ~/.pi/agent/extensions/pi-observe
```

## Development

```bash
npm install
npm test          # node --test "tests/*.test.ts" (native TS, no build)
npm run typecheck # tsc --noEmit
```

## Files

| Path | Purpose |
|------|---------|
| `src/model.ts` | Shared types (structurally match Pi) |
| `src/clone.ts` | `safeSnapshot` — structuredClone, JSON fallback, fail-open |
| `src/sanitize.ts` | Key-name credential redaction, cycle-safe |
| `src/correlation.ts` | Pure builders: ids, model identity, prompts, records |
| `src/store.ts` | State machine + bounded store; canonical commit point |
| `src/recorder.ts` | Pi event wiring (handlers return undefined) |
| `src/index.ts` | Extension entry |
| `tests/` | 39 tests: clone, sanitize, correlation, recorder |

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

Static proof: no `registerTool`, `registerCommand`, `registerFlag`, or
`pi.sendUserMessage` in the source; all handlers return `undefined`
(unit-tested); every stored value is cloned, never referenced.

## Explicitly out of scope for P0.1

No `/inspect`, provider-shape interpretation, diffs, provenance
analysis, persistence, timing analytics, export/share, HTTP tracing,
replay, model-facing observability tools, or Pi core changes.
