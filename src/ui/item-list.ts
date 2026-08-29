/**
 * P0.3/P1 — Scrollable list of expandable entries.
 *
 * Extracted from request-detail.ts for P1 so the DIFF views (messages,
 * tools) can reuse the same cursor + per-entry-expansion behavior.
 * Rendering is defensive; expanded details are wrapped ANSI-aware.
 */

import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { collapseWhitespace } from "../format.ts";
import type { InspectorTheme, ViewerTui } from "./text-viewer.ts";

/** One selectable/expandable entry in a list view (CONTEXT, TOOLS, DIFF). */
export interface ItemViewEntry {
  summary: string;
  /** Full content shown below the summary when expanded. */
  details: string;
}

/** List-like view with a cursor and per-entry expansion. */
export class ItemListView {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly title: string | undefined;
  private readonly caption: string | undefined;
  private readonly entries: ItemViewEntry[];
  private readonly emptyMessage: string;
  private readonly footer: string;
  private readonly onClose: (() => void) | undefined;
  /** Parent-imposed live cap on content rows (keeps the tabs visible). */
  private readonly maxContentRows: (() => number) | undefined;
  private readonly expanded = new Set<number>();
  private cursor = 0;
  private offset = 0;
  private cachedWidth = -1;
  /** Content rows at cache time; rendered lines also depend on terminal height. */
  private cachedRows = -1;
  private cachedLines: string[] | undefined;
  /** Detail wrap width of the last render; -1 before first render. */
  private wrapWidth = -1;
  /** Expanded detail lines wrapped at `wrapWidth`, keyed by entry index. */
  private wrappedDetails: Map<number, string[]> | undefined;

  constructor(options: {
    tui: ViewerTui;
    theme: InspectorTheme;
    title?: string;
    caption?: string;
    entries: ItemViewEntry[];
    emptyMessage: string;
    footer: string;
    onClose?: () => void;
    /** Parent-imposed live cap on content rows. */
    maxContentRows?: () => number;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.caption = options.caption;
    this.entries = options.entries;
    this.emptyMessage = options.emptyMessage;
    this.footer = options.footer;
    this.maxContentRows = options.maxContentRows;
    this.onClose = options.onClose;
  }

  private contentRows(): number {
    const estimated = Math.floor(this.tui.terminal.rows) - 7;
    const cap = this.maxContentRows?.();
    return Math.max(4, Math.min(cap ?? estimated, estimated));
  }

  /** Number of rows entry `index` occupies (1 summary + expanded details). */
  private entryRowCount(index: number): number {
    return 1 + (this.expanded.has(index) ? this.detailLines(index).length : 0);
  }

  /** Detail lines for entry `index`, wrapped at the last render width. */
  private detailLines(index: number): string[] {
    if (this.wrappedDetails) {
      const wrapped = this.wrappedDetails.get(index);
      if (wrapped) return wrapped;
    }
    return this.entries[index]!.details.split("\n");
  }

  /** Row where entry `index` starts. */
  private rowOf(index: number): number {
    let row = 0;
    for (let i = 0; i < index; i++) row += this.entryRowCount(i);
    return row;
  }

  private totalRows(): number {
    let rows = 0;
    for (let i = 0; i < this.entries.length; i++) rows += this.entryRowCount(i);
    return rows;
  }

  private entryAtRow(row: number): number {
    let start = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const end = start + this.entryRowCount(i);
      if (row < end) return i;
      start = end;
    }
    return Math.max(0, this.entries.length - 1);
  }

  /** True when the cursor entry's summary has scrolled above the viewport. */
  private pinActive(): boolean {
    return this.entries.length > 0 && this.rowOf(this.cursor) < this.offset;
  }

  /**
   * Rows available for the scroll window. When the cursor entry's
   * summary is pinned above the window, it consumes one row, so the
   * window shrinks by one to keep the total rendered height stable.
   */
  private windowRows(): number {
    return Math.max(1, this.contentRows() - (this.pinActive() ? 1 : 0));
  }

  /** Single-line summary for entry `index` (defensive: never a raw newline). */
  private summaryOf(index: number): string {
    return collapseWhitespace(this.entries[index]!.summary);
  }

  private clamp(): void {
    const count = this.entries.length;
    if (count === 0) {
      this.cursor = 0;
      this.offset = 0;
      return;
    }
    if (this.cursor >= count) this.cursor = count - 1;
    if (this.cursor < 0) this.cursor = 0;
    const rows = this.contentRows();
    const cursorRow = this.rowOf(this.cursor);
    const cursorRows = this.entryRowCount(this.cursor);
    if (cursorRows > rows) {
      // Cursor entry is taller than the viewport: keep the offset inside
      // the entry so sub-entry scroll positions (PageUp/PageDown/End)
      // survive the clamp instead of snapping back to the summary.
      if (this.offset < cursorRow) this.offset = cursorRow;
      const tailOffset = cursorRow + cursorRows - this.windowRows();
      if (this.offset > tailOffset) this.offset = tailOffset;
    } else {
      // Cursor entry fits the viewport: reveal it fully.
      if (cursorRow < this.offset) this.offset = cursorRow;
      const cursorEnd = cursorRow + cursorRows;
      if (cursorEnd > this.offset + this.windowRows()) {
        this.offset = cursorEnd - this.windowRows();
      }
    }
    const maxOffset = Math.max(0, this.totalRows() - this.windowRows());
    if (this.offset > maxOffset) this.offset = maxOffset;
    if (this.offset < 0) this.offset = 0;
  }

  handleInput(data: string): void {
    const rows = this.windowRows();
    if (matchesKey(data, Key.up)) {
      if (this.cursor > 0) this.cursor -= 1;
    } else if (matchesKey(data, Key.down)) {
      if (this.cursor < this.entries.length - 1) this.cursor += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - rows);
      this.cursor = this.entryAtRow(this.offset);
    } else if (matchesKey(data, Key.pageDown)) {
      const target = Math.min(this.totalRows() - rows, this.offset + rows);
      this.offset = Math.max(0, target);
      this.cursor = this.entryAtRow(this.offset);
    } else if (matchesKey(data, Key.home)) {
      this.cursor = 0;
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.cursor = Math.max(0, this.entries.length - 1);
      // Jump straight to the last row instead of relying on the clamp,
      // which (correctly) preserves sub-entry offsets for tall entries.
      // When the cursor summary is pinned the window is one row shorter,
      // so the max offset is one higher; the clamp then normalizes the
      // collapsed-entry case back down.
      this.offset = Math.max(0, this.totalRows() - this.contentRows() + 1);
    } else if (matchesKey(data, Key.enter)) {
      if (this.entries.length > 0) {
        if (this.expanded.has(this.cursor)) this.expanded.delete(this.cursor);
        else this.expanded.add(this.cursor);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose?.();
      return;
    } else {
      return;
    }
    this.clamp();
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
    const indent = safeWidth >= 2 ? "  " : "";
    // Re-wrap expanded detail lines at the current width so long JSON/text
    // stays fully inspectable (wrapped, never truncated). Row accounting
    // (entryRowCount/clamp) uses the same wrapped lines.
    if (this.wrapWidth !== safeWidth) {
      const wrapAt = Math.max(1, safeWidth - indent.length);
      const map = new Map<number, string[]>();
      for (let i = 0; i < this.entries.length; i++) {
        const details: string[] = [];
        for (const raw of this.entries[i]!.details.split("\n")) {
          details.push(...wrapTextWithAnsi(raw, wrapAt));
        }
        map.set(i, details);
      }
      this.wrappedDetails = map;
      this.wrapWidth = safeWidth;
    }
    const theme = this.theme;
    const out: string[] = [];
    if (this.title !== undefined) {
      out.push(truncateToWidth(theme.fg("accent", theme.bold(this.title)), safeWidth));
    }
    if (this.caption !== undefined) {
      out.push(truncateToWidth(theme.fg("dim", this.caption), safeWidth));
    }
    this.clamp();
    const rows = this.windowRows();
    const pinned = this.pinActive();
    if (this.entries.length === 0) {
      out.push(truncateToWidth(theme.fg("dim", this.emptyMessage), safeWidth));
    } else {
      if (pinned) {
        // The cursor entry's summary scrolled above the viewport: pin it
        // at the top of the window so the current section stays
        // identifiable no matter how deep the detail is scrolled.
        out.push(
          theme.bg(
            "selectedBg",
            truncateToWidth(this.summaryOf(this.cursor), safeWidth),
          ),
        );
      }
      // Render rows [`offset`, `offset + rows`), walking entries. An entry
      // whose summary lies above the viewport is cut into: only its detail
      // lines from the cut row are shown, never the summary again.
      let rendered = 0;
      let row = 0;
      for (let i = 0; i < this.entries.length && rendered < rows; i++) {
        const start = row;
        const end = row + this.entryRowCount(i);
        if (end > this.offset && start < this.offset + rows) {
          const visibleStart = Math.max(start, this.offset);
          const selected = i === this.cursor;
          if (visibleStart === start) {
            const line = truncateToWidth(this.summaryOf(i), safeWidth);
            out.push(selected ? theme.bg("selectedBg", line) : line);
            rendered += 1;
          }
          if (this.expanded.has(i)) {
            const details = this.detailLines(i);
            // First visible row inside this entry, counting from the summary.
            const cut = visibleStart - start - 1;
            for (
              let d = Math.max(0, cut);
              d < details.length && rendered < rows;
              d++
            ) {
              out.push(indent + details[d]);
              rendered += 1;
            }
          }
        }
        row = end;
      }
    }
    out.push(
      theme.fg(
        "dim",
        truncateToWidth(this.footer, safeWidth),
      ),
    );
    this.cachedWidth = width;
    this.cachedRows = this.contentRows();
    this.cachedLines = out;
    return out;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedRows = -1;
    this.cachedLines = undefined;
  }
}
