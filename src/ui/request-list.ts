/**
 * P0.3 — Request ledger component (main /inspect view).
 *
 * Renders the observed provider-request history newest first with
 * session-level counters. Leaf component: manages its own selection
 * and scroll window, adapts column widths to the terminal, truncates
 * long model ids instead of breaking layout, and renders "?" for every
 * unknown value. Never throws on malformed records.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatContextUsage,
  formatCount,
  formatSignedTokens,
  truncateModelId,
} from "../format.ts";
import type { RequestRecord, SessionObservationState } from "../model.ts";
import type { DiffService } from "../diff/request-diff.ts";
import type { RequestDiff } from "../diff/request-diff.ts";
import type { InspectorTheme, ViewerTui } from "./text-viewer.ts";

export interface RequestListOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  state: SessionObservationState;
  /** Short session identifier shown in the header. */
  sessionId: string | undefined;
  /** P1 diff service for the adjacent-request delta preview. */
  diffService?: DiffService;
  /** Called with the selected record (Enter). */
  onSelect?: (record: RequestRecord) => void;
  /** Called on Esc/q. */
  onClose?: () => void;
}

const COLUMN_GAP = 2;
const COLUMN_COUNT = 7;
const EMPTY_TEXT = "No provider requests observed yet.";
/** Rows reserved above the footer for the delta preview (blank + 2 lines). */
const PREVIEW_ROWS = 3;
/** Below this terminal width the preview switches to the compact layout. */
const COMPACT_PREVIEW_WIDTH = 60;

export class RequestListComponent {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly state: SessionObservationState;
  private readonly sessionId: string | undefined;
  private readonly diffService: DiffService | undefined;
  private readonly onSelect: ((record: RequestRecord) => void) | undefined;
  private readonly onClose: (() => void) | undefined;

  private selectedIndex = 0;
  private offset = 0;
  private cachedWidth = -1;
  /** Content rows at cache time; rendered lines also depend on terminal height. */
  private cachedRows = -1;
  private cachedLines: string[] | undefined;

  constructor(options: RequestListOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.state = options.state;
    this.sessionId = options.sessionId;
    this.diffService = options.diffService;
    this.onSelect = options.onSelect;
    this.onClose = options.onClose;
  }

  /** Newest-first records. */
  private records(): RequestRecord[] {
    const requests = this.state.requests;
    const out = requests.slice();
    out.reverse();
    return out;
  }

  private contentRows(): number {
    // Fullscreen overlay: title + summary + header + rows + preview + footer
    // must fill the whole terminal height. The preview area is reserved
    // whenever a delta preview is possible (≥ 2 records) so navigating does
    // not shift the ledger layout.
    const preview = this.state.requests.length >= 2 ? PREVIEW_ROWS : 0;
    return Math.max(4, Math.floor(this.tui.terminal.rows) - 4 - preview);
  }

  private clampOffset(): void {
    const count = this.records().length;
    if (count === 0) {
      this.offset = 0;
      this.selectedIndex = 0;
      return;
    }
    if (this.selectedIndex >= count) this.selectedIndex = count - 1;
    if (this.selectedIndex < 0) this.selectedIndex = 0;
    const rows = this.contentRows();
    if (this.selectedIndex < this.offset) this.offset = this.selectedIndex;
    if (this.selectedIndex >= this.offset + rows) {
      this.offset = this.selectedIndex - rows + 1;
    }
    const maxOffset = Math.max(0, count - rows);
    if (this.offset > maxOffset) this.offset = maxOffset;
  }

  handleInput(data: string): void {
    const count = this.records().length;
    const rows = this.contentRows();
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) this.selectedIndex -= 1;
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedIndex < count - 1) this.selectedIndex += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - rows);
    } else if (matchesKey(data, Key.pageDown)) {
      this.selectedIndex = Math.min(count - 1, this.selectedIndex + rows);
    } else if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
    } else if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, count - 1);
    } else if (matchesKey(data, Key.enter)) {
      const record = this.records()[this.selectedIndex];
      if (record) this.onSelect?.(record);
      return;
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose?.();
      return;
    } else {
      return;
    }
    this.clampOffset();
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedRows === this.contentRows()
    ) {
      return this.cachedLines;
    }
    const safeWidth = Math.max(1, Math.floor(width));
    const theme = this.theme;
    const records = this.records();
    this.clampOffset();

    const out: string[] = [];
    out.push(theme.fg("accent", theme.bold("Pi Request Inspector")));
    out.push(truncateToWidth(theme.fg("dim", this.summaryLine()), safeWidth));

    if (records.length === 0) {
      out.push("");
      out.push(theme.fg("dim", EMPTY_TEXT));
      out.push("");
    } else {
      const columns = this.columnWidths(records, safeWidth);
      out.push(this.headerLine(columns, safeWidth));
      const rows = this.contentRows();
      for (let i = 0; i < rows; i++) {
        const index = this.offset + i;
        if (index >= records.length) break;
        const selected = index === this.selectedIndex;
        out.push(this.rowLine(records[index]!, columns, selected, safeWidth));
      }
    }
    // P1: compact delta preview for the selected request (vs its predecessor).
    const preview = this.previewLines(safeWidth);
    if (preview.length > 0) {
      out.push("");
      out.push(...preview);
    }
    out.push(this.footerLine(safeWidth, records.length));
    // Fill the viewport so the fullscreen overlay covers everything behind it.
    const fillRows = Math.max(out.length, Math.floor(this.tui.terminal.rows));
    while (out.length < fillRows) out.push("");
    this.cachedWidth = width;
    this.cachedRows = this.contentRows();
    this.cachedLines = out;
    return out;
  }

  private summaryLine(): string {
    const state = this.state;
    const latest = state.requests[state.requests.length - 1];
    const context = formatContextUsage(latest?.contextUsage);
    const session = this.sessionId ? `Session: ${this.sessionId}   ` : "";
    return (
      `${session}Runs: ${formatCount(state.runCount)}   ` +
      `Turns: ${formatCount(state.turnCount)}   ` +
      `Requests: ${formatCount(state.requestCount)}   ` +
      `Context: ${context}`
    );
  }

  private columnWidths(
    records: RequestRecord[],
    totalWidth: number,
  ): { id: number; run: number; turn: number; model: number; ctx: number; messages: number; tools: number } {
    const digits = (n: number): number => Math.max(1, String(Math.max(0, n)).length);
    const idWidth = Math.max(3, digits(records[0]?.requestSeq ?? 0));
    let runWidth = 5;
    let turnWidth = 5;
    for (const record of records) {
      if (record.runId) runWidth = Math.max(runWidth, Array.from(record.runId).length);
      if (typeof record.turnIndex === "number") {
        turnWidth = Math.max(turnWidth, digits(record.turnIndex));
      }
    }
    const ctxWidth = 13;
    const messagesWidth = 8;
    const toolsWidth = 5;
    const fixed =
      idWidth + runWidth + turnWidth + ctxWidth + messagesWidth + toolsWidth +
      COLUMN_GAP * (COLUMN_COUNT - 1);
    const modelWidth = Math.max(8, totalWidth - fixed);
    return {
      id: idWidth,
      run: runWidth,
      turn: turnWidth,
      model: modelWidth,
      ctx: ctxWidth,
      messages: messagesWidth,
      tools: toolsWidth,
    };
  }

  private headerLine(
    columns: ReturnType<RequestListComponent["columnWidths"]>,
    width: number,
  ): string {
    const cells = [
      padLeft("#", columns.id),
      padLeft("RUN", columns.run),
      padLeft("TURN", columns.turn),
      truncateModelId("MODEL", columns.model).padEnd(columns.model),
      padLeft("CTX", columns.ctx),
      padLeft("MESSAGES", columns.messages),
      padLeft("TOOLS", columns.tools),
    ].join(" ".repeat(COLUMN_GAP));
    return this.theme.fg("muted", truncateToWidth(cells, width));
  }

  private rowLine(
    record: RequestRecord,
    columns: ReturnType<RequestListComponent["columnWidths"]>,
    selected: boolean,
    width: number,
  ): string {
    const modelId = record.model?.id ?? (record.providerEnvelope?.model as string | undefined);
    const context = formatContextUsage(record.contextUsage);
    const messages =
      record.logicalContext !== undefined
        ? String(record.logicalContext.length)
        : record.providerEnvelope?.messageCount !== undefined
          ? String(record.providerEnvelope.messageCount)
          : "?";
    // Prefer the envelope tool count: it is the true count of tools in
    // the provider payload and includes native tools (Gemini googleSearch,
    // codeExecution, …) that carry no extractable definition. Extracted
    // definitions are the fallback, and may undercount native tools.
    const tools =
      record.providerEnvelope?.toolCount !== undefined
        ? String(record.providerEnvelope.toolCount)
        : record.providerTools !== undefined
          ? String(record.providerTools.length)
          : "?";

    const cells = [
      padLeft(formatCount(record.requestSeq), columns.id),
      padLeft(record.runId ?? "?", columns.run),
      padLeft(formatCount(record.turnIndex), columns.turn),
      truncateModelId(modelId, columns.model).padEnd(columns.model),
      padLeft(context, columns.ctx),
      padLeft(messages, columns.messages),
      padLeft(tools, columns.tools),
    ].join(" ".repeat(COLUMN_GAP));

    const line = truncateToWidth(cells, width);
    return selected ? this.theme.bg("selectedBg", line) : line;
  }

  /**
   * Compact delta preview for the selected request vs its predecessor
   * (request N-1). Two lines when a predecessor exists; blank reserved
   * lines otherwise. Uses the cheap diff mode (no raw-payload path
   * detection). Fail-open: any computation error just hides the preview.
   */
  private previewLines(width: number): string[] {
    const reserved = this.state.requests.length >= 2 ? PREVIEW_ROWS - 1 : 0;
    const blanks = Array.from({ length: reserved }, () => "");
    try {
      const records = this.records();
      const selected = records[this.selectedIndex];
      const predecessor = records[this.selectedIndex + 1]; // older neighbor
      if (!selected || !predecessor || !this.diffService) return blanks;
      const diff = this.diffService.diff(predecessor, selected, { payloadPaths: false });
      const header = `Δ ${diff.fromRequestId} → ${diff.toRequestId}`;
      const detail =
        width >= COMPACT_PREVIEW_WIDTH
          ? this.previewDetailWide(diff, width)
          : this.previewDetailCompact(diff, width);
      return [header, detail, ...blanks.slice(0, Math.max(0, reserved - 2))].slice(0, Math.max(reserved, 2));
    } catch {
      return blanks;
    }
  }

  /** "ctx +6.2k · msg +3/-0/~0 · system = · tools = · model =" */
  private previewDetailWide(diff: RequestDiff, width: number): string {
    const theme = this.theme;
    const parts = [
      `ctx ${previewContext(diff)}`,
      `msg ${previewMessages(diff)}`,
      `system ${flag(previewSystemChanged(diff))}`,
      `tools ${previewTools(diff)}`,
      `model ${flag(diff.summary.modelChanged)}`,
    ];
    return theme.fg("dim", truncateToWidth(parts.join(" · "), width));
  }

  /** "ctx +6.2k  msg +3  sys= tools=" */
  private previewDetailCompact(diff: RequestDiff, width: number): string {
    const theme = this.theme;
    const parts = [
      `ctx ${previewContext(diff)}`,
      `msg ${previewMessages(diff)}`,
      `sys${flag(previewSystemChanged(diff))}`,
      `tools${previewTools(diff) === "=" ? "=" : "≠"}`,
    ];
    return theme.fg("dim", truncateToWidth(parts.join("  "), width));
  }

  private footerLine(width: number, count: number): string {
    const theme = this.theme;
    const hint = "↑↓ select   enter inspect   esc/q close";
    let scrollInfo = "";
    if (count > this.contentRows()) {
      const end = Math.min(this.offset + this.contentRows(), count);
      scrollInfo = `${this.offset + 1}-${end}/${count}`;
    }
    const hintStyled = theme.fg("dim", hint);
    const gap = Math.max(1, width - visibleWidth(hintStyled) - visibleWidth(scrollInfo));
    return truncateToWidth(hintStyled + " ".repeat(gap) + scrollInfo, width);
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedRows = -1;
    this.cachedLines = undefined;
  }
}

function padLeft(text: string, width: number): string {
  return text.padStart(Math.max(0, width));
}

// ---------------------------------------------------------------------------
// P1 — delta preview formatting (pure, defensive)
// ---------------------------------------------------------------------------

/** "=" when unchanged, "≠" when changed. */
function flag(changed: boolean): string {
  return changed ? "≠" : "=";
}

/** "+6.2k" reported-token delta, or "?" when unknown. */
function previewContext(diff: RequestDiff): string {
  return diff.contextUsage === "unknown" ? "?" : formatSignedTokens(diff.contextUsage.delta);
}

/** "=" when unchanged; "+3" normally, "-1" for pure removals, "~2" for
 * changes, combos joined. Matches the tools/system flags on the same line. */
function previewMessages(diff: RequestDiff): string {
  const messages = diff.messages;
  if (messages.unknown) return "?";
  const added = messages.added.length;
  const removed = messages.removed.length;
  const changed = messages.changed.length;
  if (added + removed + changed === 0) return "=";
  let out = "";
  if (added > 0) out += `+${added}`;
  if (removed > 0) out += `-${removed}`;
  if (changed > 0) out += `~${changed}`;
  return out;
}

function previewSystemChanged(diff: RequestDiff): boolean {
  return diff.summary.systemChanged;
}

/** "=" when unchanged, "+1/-1/~1" when changed, "?" when uninterpretable. */
function previewTools(diff: RequestDiff): string {
  const tools = diff.tools;
  if (tools.uninterpretable) return "?";
  const total = tools.added.length + tools.removed.length + tools.changed.length;
  if (total === 0) return "=";
  let out = "";
  if (tools.added.length > 0) out += `+${tools.added.length}`;
  if (tools.removed.length > 0) out += `-${tools.removed.length}`;
  if (tools.changed.length > 0) out += `~${tools.changed.length}`;
  return out;
}
