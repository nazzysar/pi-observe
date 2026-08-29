/**
 * P0.3 — /inspect command: local request inspector UI.
 *
 * Local-only by design: opens a TUI over the observation store, sends
 * no model message, registers no LLM tool, and never mutates session
 * context, the system prompt, or provider payloads. The command handler
 * only reads store state through getState()/getRequest().
 *
 * Grammar (kept minimal per P0.3):
 *   /inspect        → ledger (newest first)
 *   /inspect latest → detail of the most recent request
 *   /inspect 17     → detail of request sequence 17
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatContextUsage, formatCount } from "../format.ts";
import type { RequestRecord, SessionObservationState } from "../model.ts";
import { DiffService } from "../diff/request-diff.ts";
import type { SessionStore } from "../store.ts";
import { RequestDetailComponent } from "./request-detail.ts";
import { RequestListComponent } from "./request-list.ts";

const STATUS_KEY = "pi-observe";

export interface InspectorOptions {
  /** P1 derived-diff service shared across inspector invocations. */
  diffService: DiffService;
}

/** Open the inspector as a full-viewport overlay instead of inline content. */
const FULLSCREEN_OVERLAY = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 },
} as const;

type ListResult =
  | { kind: "pick"; record: RequestRecord }
  | { kind: "close" };

type DetailResult = { kind: "back" } | { kind: "close" };

/** Parse /inspect args. Returns the target request seq or undefined for the ledger. */
function parseArgs(args: string): number | "latest" | undefined {
  const trimmed = args.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "latest") return "latest";
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return undefined;
}

export function registerInspectCommand(
  pi: ExtensionAPI,
  store: SessionStore,
  options: InspectorOptions = { diffService: new DiffService() },
): void {
  pi.registerCommand("inspect", {
    description:
      "Open the local request inspector: observed provider requests, prompts, context, tools, raw payloads, and request diffs (no model interaction)",
    handler: async (args, ctx) => {
      try {
        await runInspector(ctx, store, options, args);
      } catch (error) {
        // UI failures stay local: the agent session is never affected.
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`/inspect failed: ${message}`, "error");
        else console.log(`pi-observe: /inspect failed: ${message}`);
      }
    },
  });
}

async function runInspector(
  ctx: ExtensionCommandContext,
  store: SessionStore,
  options: InspectorOptions,
  args: string,
): Promise<void> {
  const state = store.getState();
  const target = parseArgs(args);
  const requested = target === undefined ? undefined : resolveTarget(store, target);

  if (requested === undefined && target !== undefined) {
    if (ctx.hasUI) {
      ctx.ui.notify(`No observed request matches "${args}"`, "warning");
    }
  }

  if (!ctx.hasUI) {
    // Print mode / headless: a one-line summary is the whole UI.
    console.log(summaryLine(state));
    return;
  }

  const sessionId = shortSessionId(ctx);
  const neighborFinder = neighborFinderFor(state.requests);
  setStatus(ctx, state);
  try {
    if (requested) {
      await showDetailLoop(ctx, store, options, neighborFinder, requested, sessionId);
    } else {
      await showListLoop(ctx, store, options, neighborFinder, sessionId);
    }
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function resolveTarget(
  store: SessionStore,
  target: number | "latest",
): RequestRecord | undefined {
  if (target === "latest") return store.getLatestRequest();
  return store.getRequests().find((record) => record.requestSeq === target);
}

type NeighborFinder = (record: RequestRecord, delta: -1 | 1) => RequestRecord | undefined;

/**
 * Positional [ / ] neighbor lookup. Built from the same snapshot the
 * ledger displays: `getRequests()` would deep-clone every retained
 * record on every keypress, and snapshot semantics keep navigation
 * consistent with what is on screen.
 */
function neighborFinderFor(requests: RequestRecord[]): NeighborFinder {
  return (record, delta) => {
    const index = requests.findIndex((candidate) => candidate.requestSeq === record.requestSeq);
    if (index < 0) return undefined;
    return requests[index + delta];
  };
}

/** Ledger loop: pick a request → detail → back → ledger → close. */
async function showListLoop(
  ctx: ExtensionCommandContext,
  store: SessionStore,
  options: InspectorOptions,
  neighborFinder: NeighborFinder,
  sessionId: string | undefined,
): Promise<void> {
  let current: RequestRecord | null = null; // null = ledger visible
  while (true) {
    if (current === null) {
      const result = await ctx.ui.custom<ListResult>(
        (tui, theme, _keybindings, done) => {
          const list = new RequestListComponent({
            tui,
            theme,
            state: store.getState(),
            sessionId,
            diffService: options.diffService,
            onSelect: (record) => done({ kind: "pick", record }),
            onClose: () => done({ kind: "close" }),
          });
          return list;
        },
        FULLSCREEN_OVERLAY,
      );
      if (!result || result.kind === "close") return;
      current = result.record;
    } else {
      const result = await ctx.ui.custom<DetailResult>(
        (tui, theme, _keybindings, done) => {
          const detail = new RequestDetailComponent({
            tui,
            theme,
            record: current!,
            diffService: options.diffService,
            getNeighborRecord: neighborFinder,
            onBack: () => done({ kind: "back" }),
            onClose: () => done({ kind: "close" }),
          });
          return detail;
        },
        FULLSCREEN_OVERLAY,
      );
      if (!result || result.kind === "close") return;
      current = null; // back to the ledger
    }
  }
}

/** Detail-only loop for `latest` / numeric targets (esc closes). */
async function showDetailLoop(
  ctx: ExtensionCommandContext,
  store: SessionStore,
  options: InspectorOptions,
  neighborFinder: NeighborFinder,
  record: RequestRecord,
  sessionId: string | undefined,
): Promise<void> {
  const result = await ctx.ui.custom<DetailResult>(
    (tui, theme, _keybindings, done) => {
      const detail = new RequestDetailComponent({
        tui,
        theme,
        record,
        diffService: options.diffService,
        getNeighborRecord: neighborFinder,
        onBack: () => done({ kind: "back" }),
        onClose: () => done({ kind: "close" }),
      });
      return detail;
    },
    FULLSCREEN_OVERLAY,
  );
  if (!result || result.kind === "close") return;
  // Back from a targeted detail falls through to the ledger.
  return showListLoop(ctx, store, options, neighborFinder, sessionId);
}

function summaryLine(state: SessionObservationState): string {
  const latest = state.requests[state.requests.length - 1];
  return (
    `pi-observe: ${formatCount(state.runCount)} runs, ` +
    `${formatCount(state.turnCount)} turns, ` +
    `${formatCount(state.requestCount)} requests ` +
    `(context ${formatContextUsage(latest?.contextUsage)})`
  );
}

/** Optional footer status while the inspector is open. */
function setStatus(
  ctx: ExtensionCommandContext,
  state: SessionObservationState,
): void {
  const latest = state.requests[state.requests.length - 1];
  const context = formatContextUsage(latest?.contextUsage);
  const text =
    `obs r${formatCount(state.requestCount)} · ` +
    `t${formatCount(state.turnCount)} · ${context}`;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
}

function shortSessionId(ctx: ExtensionCommandContext): string | undefined {
  try {
    const id = ctx.sessionManager.getSessionId();
    if (!id) return undefined;
    const chars = Array.from(id);
    return chars.length > 8 ? chars.slice(0, 8).join("") : id;
  } catch {
    return undefined;
  }
}
