/**
 * P0.3 — Scrolling text viewer component.
 *
 * A leaf TUI component (per pi-tui's custom-component contract) that
 * renders a block of pre-split text lines with an internal scroll
 * window. Used for the SYSTEM prompt, RAW payload, and detail sections.
 *
 * The component cannot know its exact allocated height, so the visible
 * window is estimated from the terminal height minus a small reserved
 * area for the dock/footer. On short terminals the window shrinks but
 * scrolling keeps every line reachable.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

  /** First visible line index. */
  private offset = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;

  constructor(options: TextViewerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.caption = options.caption;
    this.lines = options.lines;
    this.emptyText = options.emptyText ?? "(empty)";
    this.footer = options.footer;
    this.onClose = options.onClose;
  }

  setLines(lines: string[]): void {
    this.lines = lines;
    this.clampOffset();
    this.invalidate();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  /** Estimated rows available for content (excluding chrome). */
  private contentRows(): number {
    return Math.max(
      MIN_CONTENT_ROWS,
      Math.floor(this.tui.terminal.rows) - RESERVED_ROWS,
    );
  }

  private clampOffset(): void {
    const max = Math.max(0, this.lines.length - this.contentRows());
    if (this.offset > max) this.offset = max;
    if (this.offset < 0) this.offset = 0;
  }

  handleInput(data: string): void {
    const rows = this.contentRows();
    if (matchesKey(data, Key.up)) {
      if (this.offset > 0) this.offset -= 1;
    } else if (matchesKey(data, Key.down)) {
      if (this.offset < this.lines.length - rows) this.offset += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, this.offset - rows);
    } else if (matchesKey(data, Key.pageDown)) {
      this.offset = Math.min(this.lines.length - rows, this.offset + rows);
    } else if (matchesKey(data, Key.home)) {
      this.offset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.offset = Math.max(0, this.lines.length - rows);
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
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const safeWidth = Math.max(1, Math.floor(width));
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
    const visible = this.lines.slice(this.offset, this.offset + rows);
    if (visible.length === 0) {
      out.push(theme.fg("dim", this.emptyText));
    } else {
      for (const line of visible) {
        out.push(truncateToWidth(line, safeWidth));
      }
    }

    out.push(this.footerLine(safeWidth));
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  private footerLine(width: number): string {
    const theme = this.theme;
    const hint = this.footer ?? "↑↓ scroll   esc/q close";
    const total = this.lines.length;
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
    this.cachedLines = undefined;
  }
}
