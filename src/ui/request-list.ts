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
  truncateModelId,
} from "../format.ts";
import type { RequestRecord, SessionObservationState } from "../model.ts";
import type { InspectorTheme, ViewerTui } from "./text-viewer.ts";

export interface RequestListOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  state: SessionObservationState;
  /** Short session identifier shown in the header. */
  sessionId: string | undefined;
  /** Called with the selected record (Enter). */
  onSelect?: (record: RequestRecord) => void;
  /** Called on Esc/q. */
  onClose?: () => void;
}

const COLUMN_GAP = 2;
const COLUMN_COUNT = 7;
const EMPTY_TEXT = "No provider requests observed yet.";

export class RequestListComponent {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly state: SessionObservationState;
  private readonly sessionId: string | undefined;
  private readonly onSelect: ((record: RequestRecord) => void) | undefined;
  private readonly onClose: (() => void) | undefined;

  private selectedIndex = 0;
  private offset = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;

  constructor(options: RequestListOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.state = options.state;
    this.sessionId = options.sessionId;
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
    return Math.max(4, Math.floor(this.tui.terminal.rows) - 10);
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
    if (this.cachedLines && this.cachedWidth === width) {
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
    out.push(this.footerLine(safeWidth, records.length));
    this.cachedWidth = width;
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
      `Turns: ${formatCount(state.maxTurnIndex)}   ` +
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
    const tools =
      record.providerTools !== undefined
        ? String(record.providerTools.length)
        : record.providerEnvelope?.toolCount !== undefined
          ? String(record.providerEnvelope.toolCount)
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
    this.cachedLines = undefined;
  }
}

function padLeft(text: string, width: number): string {
  return text.padStart(Math.max(0, width));
}
