/**
 * P0.3 — Scrolling text viewer component.
 *
 * A leaf TUI component (per pi-tui's custom-component contract) that
 * renders a block of pre-split text lines with an internal scroll
 * window. Used for the SYSTEM prompt, RAW payload, and detail sections.
 *
 * Long lines are wrapped (ANSI-aware) at the terminal width instead of
 * truncated, so full content — system prompts, JSON string values —
 * stays reachable by scrolling; nothing is permanently hidden.
 *
 * The component cannot know its exact allocated height, so the visible
 * window is estimated from the terminal height minus a small reserved
 * area for the dock/footer. On short terminals the window shrinks but
 * scrolling keeps every line reachable.
 */

import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Minimal structural theme: satisfied by pi's Theme class. */
export interface InspectorTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** Minimal TUI surface the viewer needs (satisfied by pi's TUI). */
export interface ViewerTui {
  terminal: { rows: number };
  requestRender(): void;
}

export interface TextViewerOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  /** Optional title line shown above the content. */
  title?: string;
  /** Optional caption line shown above the content (dim). */
  caption?: string;
  /** Content lines; may be empty (renders an empty-state line). */
  lines: string[];
  /** Empty-state line when `lines` is empty. */
  emptyText?: string;
  /** Left-hand footer hint. */
  footer?: string;
  /** Called on Esc/q. */
  onClose?: () => void;
  /**
   * Optional live cap on content rows when a parent layout renders chrome
   * above this viewer (e.g. the detail header/tabs). Evaluated per render
   * so terminal resizes re-budget. Without it the viewer estimates from
   * the terminal height, which can overflow the allocated area and get
   * clipped from the top by pi.
   */
  maxContentRows?: () => number;
}

/** Rows reserved below the component (status/footer/editor chrome). */
const RESERVED_ROWS = 6;
/** Minimum content rows before the viewer scrolls internally. */
const MIN_CONTENT_ROWS = 4;

export class TextViewer {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly title: string | undefined;
  private readonly caption: string | undefined;
  private lines: string[];
  private readonly emptyText: string;
  private readonly footer: string | undefined;
  private readonly onClose: (() => void) | undefined;
  private readonly maxContentRows: (() => number) | undefined;

  /** First visible line index (into the wrapped line sequence). */
  private offset = 0;
  private cachedWidth = -1;
  /** Content rows at cache time; rendered lines also depend on terminal height. */
  private cachedRows = -1;
  private cachedLines: string[] | undefined;
  /** Width of the last render; drives wrapping before first render. */
  private renderWidth = -1;
  /** Lines wrapped at a given width (cache; keyed by width). */
  private wrapCache: { width: number; lines: string[] } | undefined;

  constructor(options: TextViewerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.caption = options.caption;
    this.lines = options.lines;
    this.emptyText = options.emptyText ?? "(empty)";
    this.footer = options.footer;
    this.maxContentRows = options.maxContentRows;
    this.onClose = options.onClose;
  }

  setLines(lines: string[]): void {
    this.lines = lines;
    this.wrapCache = undefined;
    this.clampOffset();
    this.invalidate();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /**
   * Content wrapped to the last rendered width (fallback 80 cols before
   * the first render), so every logical line stays fully inspectable.
   */
  private wrappedLines(): string[] {
    const width = this.renderWidth > 0 ? this.renderWidth : 80;
    if (this.wrapCache === undefined || this.wrapCache.width !== width) {
      const wrapped: string[] = [];
      for (const line of this.lines) {
        wrapped.push(...wrapTextWithAnsi(line, width));
      }
      this.wrapCache = { width, lines: wrapped };
    }
    return this.wrapCache.lines;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  /**
   * Estimated rows available for content (excluding chrome). When a
   * parent layout imposes a cap (maxContentRows), the smaller of the
   * two wins so the combined output never overflows the area pi
   * allocates for the component (overflow is clipped from the top).
   */
  private contentRows(): number {
    const estimated =
      Math.floor(this.tui.terminal.rows) - RESERVED_ROWS;
    const cap = this.maxContentRows?.();
    return Math.max(
      MIN_CONTENT_ROWS,
      Math.min(cap ?? estimated, estimated),
    );
  }

  private clampOffset(): void {
    const max = Math.max(0, this.wrappedLines().length - this.contentRows());
    if (this.offset > max) this.offset = max;
    if (this.offset < 0) this.offset = 0;
  }

  handleInput(data: string): void {
    const rows = this.contentRows();
    const total = this.wrappedLines().length;
    if (matchesKey(data, Key.up)) {
      if (this.offset > 0) this.offset -= 1;
    } else if (matchesKey(data, Key.down)) {
      if (this.offset < total - rows) this.offset += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - rows);
    } else if (matchesKey(data, Key.pageDown)) {
      this.offset = Math.min(total - rows, this.offset + rows);
    } else if (matchesKey(data, Key.home)) {
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.offset = Math.max(0, total - rows);
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose?.();
      return;
    } else {
      return; // no state change
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
    this.renderWidth = safeWidth;
    const theme = this.theme;
    const out: string[] = [];

    if (this.title !== undefined) {
      out.push(truncateToWidth(theme.fg("accent", theme.bold(this.title)), safeWidth));
    }
    if (this.caption !== undefined) {
      out.push(truncateToWidth(theme.fg("dim", this.caption), safeWidth));
    }

    const rows = this.contentRows();
    this.clampOffset();
    // Wrapped lines are already fitted to `safeWidth`; push them as-is so
    // long lines stay fully inspectable instead of being cut off.
    const visible = this.wrappedLines().slice(this.offset, this.offset + rows);
    if (visible.length === 0) {
      out.push(theme.fg("dim", this.emptyText));
    } else {
      out.push(...visible);
    }

    out.push(this.footerLine(safeWidth));
    this.cachedWidth = width;
    this.cachedRows = this.contentRows();
    this.cachedLines = out;
    return out;
  }

  private footerLine(width: number): string {
    const theme = this.theme;
    const hint = this.footer ?? "↑↓ scroll   esc/q close";
    const total = this.wrappedLines().length;
    let scrollInfo = "";
    if (total > this.contentRows()) {
      const end = Math.min(this.offset + this.contentRows(), total);
      scrollInfo = `${this.offset + 1}-${end}/${total}`;
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
