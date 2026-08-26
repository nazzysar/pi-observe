/**
 * P0.3 — Request detail component.
 *
 * Keyboard-switchable sections for one RequestRecord:
 * OVERVIEW | SYSTEM | CONTEXT | TOOLS | RAW.
 *
 * - OVERVIEW: metadata + observation/correlation/parser warnings
 * - SYSTEM:   effective system prompt + structured systemPromptOptions
 * - CONTEXT:  logical model-facing messages (expandable)
 * - TOOLS:    P0.2 provider tool extraction (expandable raw), with an
 *             explicit "cannot interpret → see RAW" state
 * - RAW:      sanitized provider payload observed by the extension
 *
 * Every section degrades to a clear unknown/error state; rendering is
 * defensive so malformed records can never crash the inspector.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  formatContextUsage,
  formatCount,
  formatThinkingLevel,
  formatTimestamp,
  formatWarning,
  providerShapeLabel,
  safePrettyJson,
  summarizeMessage,
} from "../format.ts";
import type { RequestRecord } from "../model.ts";
import { createJsonViewer } from "./json-viewer.ts";
import { TextViewer, type InspectorTheme, type ViewerTui } from "./text-viewer.ts";

export type DetailSectionId = "OVERVIEW" | "SYSTEM" | "CONTEXT" | "TOOLS" | "RAW";

const SECTION_IDS: DetailSectionId[] = [
  "OVERVIEW",
  "SYSTEM",
  "CONTEXT",
  "TOOLS",
  "RAW",
];

const SECTION_FOOTER = "↑↓ navigate   enter expand   ←→/tab sections   esc/q back";

export interface RequestDetailOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  record: RequestRecord;
  /** Called on Esc/q (back to the ledger). */
  onBack?: () => void;
  /** Called when the inspector should close entirely. */
  onClose?: () => void;
}

/** One selectable/expandable entry in CONTEXT / TOOLS. */
export interface ItemViewEntry {
  summary: string;
  /** Full content shown below the summary when expanded. */
  details: string;
}

/** List-like view with a cursor and per-entry expansion. */
class ItemListView {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly title: string | undefined;
  private readonly caption: string | undefined;
  private readonly entries: ItemViewEntry[];
  private readonly emptyMessage: string;
  private readonly footer: string;
  private readonly onClose: (() => void) | undefined;
  private readonly expanded = new Set<number>();
  private cursor = 0;
  private offset = 0;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;

  constructor(options: {
    tui: ViewerTui;
    theme: InspectorTheme;
    title?: string;
    caption?: string;
    entries: ItemViewEntry[];
    emptyMessage: string;
    footer: string;
    onClose?: () => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.title = options.title;
    this.caption = options.caption;
    this.entries = options.entries;
    this.emptyMessage = options.emptyMessage;
    this.footer = options.footer;
    this.onClose = options.onClose;
  }

  private contentRows(): number {
    return Math.max(4, Math.floor(this.tui.terminal.rows) - 8);
  }

  /** Number of rows entry `index` occupies (1 summary + expanded details). */
  private entryRowCount(index: number): number {
    return 1 + (this.expanded.has(index) ? this.detailLines(index).length : 0);
  }

  private detailLines(index: number): string[] {
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
    if (cursorRow < this.offset) this.offset = cursorRow;
    const cursorEnd = cursorRow + this.entryRowCount(this.cursor);
    if (cursorEnd > this.offset + rows) {
      this.offset = cursorEnd - rows;
    }
    const maxOffset = Math.max(0, this.totalRows() - rows);
    if (this.offset > maxOffset) this.offset = maxOffset;
    if (this.offset < 0) this.offset = 0;
  }

  handleInput(data: string): void {
    const rows = this.contentRows();
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
    } else if (matchesKey(data, Key.end)) {
      this.cursor = Math.max(0, this.entries.length - 1);
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
    this.clamp();
    const rows = this.contentRows();
    if (this.entries.length === 0) {
      out.push(truncateToWidth(theme.fg("dim", this.emptyMessage), safeWidth));
    } else {
      // Render from `offset` for `rows` rows, walking entries.
      let rendered = 0;
      let row = 0;
      for (let i = 0; i < this.entries.length && rendered < rows; i++) {
        const start = row;
        const end = row + this.entryRowCount(i);
        if (end > this.offset && start < this.offset + rows) {
          const visible = this.entries[i]!.summary;
          const selected = i === this.cursor;
          const line = truncateToWidth(visible, safeWidth);
          out.push(selected ? theme.bg("selectedBg", line) : line);
          rendered += 1;
          if (this.expanded.has(i)) {
            for (const detail of this.detailLines(i)) {
              if (rendered >= rows) break;
              out.push(truncateToWidth(`  ${detail}`, safeWidth));
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
    this.cachedLines = out;
    return out;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = undefined;
  }
}

export class RequestDetailComponent {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly record: RequestRecord;
  private readonly onBack: (() => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private sectionIndex = 0;
  private readonly views: (TextViewer | ItemListView)[] = [];

  constructor(options: RequestDetailOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.record = options.record;
    this.onBack = options.onBack;
    this.onClose = options.onClose;
  }

  get section(): DetailSectionId {
    return SECTION_IDS[this.sectionIndex]!;
  }

  private currentView(): TextViewer | ItemListView {
    let view = this.views[this.sectionIndex];
    if (!view) {
      view = this.buildSection(this.sectionIndex);
      this.views[this.sectionIndex] = view;
    }
    return view;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab)) {
      this.switchSection(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.switchSection(-1);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.switchSection(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.switchSection(1);
      return;
    }
    if (data.length === 1 && data >= "1" && data <= "5") {
      this.switchToSection(Number(data) - 1);
      return;
    }
    this.currentView().handleInput(data);
  }

  private switchToSection(index: number): void {
    if (index === this.sectionIndex) return;
    this.sectionIndex = index;
    this.invalidate();
    this.tui.requestRender();
  }

  private switchSection(delta: number): void {
    const next =
      (this.sectionIndex + delta + SECTION_IDS.length) % SECTION_IDS.length;
    if (next === this.sectionIndex) return;
    this.sectionIndex = next;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const theme = this.theme;
    const record = this.record;
    const out: string[] = [];

    out.push(
      theme.fg(
        "accent",
        theme.bold(`Pi Request Inspector — ${record.requestId ?? "?"}`),
      ),
    );
    out.push(this.tabsLine(safeWidth));
    const model =
      record.model?.id ?? (record.providerEnvelope?.model as string | undefined) ?? "?";
    const meta = [
      record.runId ?? "?",
      `turn ${formatCount(record.turnIndex)}`,
      model,
      formatTimestamp(record.timestamp),
    ].join(" · ");
    out.push(theme.fg("dim", truncateToWidth(meta, safeWidth)));
    out.push("");
    out.push(...this.currentView().render(safeWidth));
    return out;
  }

  private tabsLine(width: number): string {
    const theme = this.theme;
    const labels = SECTION_IDS.map(
      (id, index) =>
        index === this.sectionIndex
          ? theme.bg("selectedBg", ` ${id} `)
          : theme.fg("muted", ` ${id} `),
    );
    return truncateToWidth(labels.join(" "), width);
  }

  private buildSection(index: number): TextViewer | ItemListView {
    const theme = this.theme;
    const record = this.record;
    const back = (): void => this.onBack?.();
    const close = (): void => this.onClose?.();
    switch (SECTION_IDS[index]) {
      case "OVERVIEW":
        return new TextViewer({
          tui: this.tui,
          theme,
          title: "Request overview",
          lines: this.overviewLines(),
          footer: SECTION_FOOTER,
          onClose: back,
        });
      case "SYSTEM":
        return new TextViewer({
          tui: this.tui,
          theme,
          title: "Effective system prompt",
          caption: "assembled by Pi (captured at before_agent_start) + structured systemPromptOptions",
          lines: this.systemLines(),
          footer: SECTION_FOOTER,
          onClose: back,
        });
      case "CONTEXT": {
        const context = record.logicalContext;
        const entries: ItemViewEntry[] = (context ?? []).map((message, i) => ({
          summary: `[${i}] ${summarizeMessage(message)}`,
          details: messageFullText(message),
        }));
        return new ItemListView({
          tui: this.tui,
          theme,
          title: "Logical message context",
          caption: "model-facing context prepared by Pi — distinct from the provider payload",
          entries,
          emptyMessage:
            context === undefined
              ? "No logical context captured for this request (before_provider_request had no pending context event)."
              : "(no logical messages)",
          footer: SECTION_FOOTER,
          onClose: back,
        });
      }
      case "TOOLS": {
        const tools = record.providerTools;
        const entries: ItemViewEntry[] = (tools ?? []).map((tool) => ({
          summary:
            `[${tool.index}] ` +
            (tool.name ?? "(unnamed)") +
            (tool.description ? ` — ${tool.description}` : ""),
          details: safePrettyJson(tool.raw),
        }));
        return new ItemListView({
          tui: this.tui,
          theme,
          title: "Provider tool definitions",
          caption: "extracted from the observed provider payload (P0.2)",
          entries,
          emptyMessage:
            tools === undefined
              ? `Tool schema could not be interpreted for this provider payload (shape: ${providerShapeLabel(record.providerEnvelope?.detectedShape)}). See RAW for the observed payload.`
              : "No tool definitions found in this provider payload.",
          footer: SECTION_FOOTER,
          onClose: back,
        });
      }
      case "RAW":
        return createJsonViewer({
          tui: this.tui,
          theme,
          label: "Provider payload (observed by this extension)",
          caption: "sanitized snapshot captured at before_provider_request — not guaranteed wire bytes",
          value: record.sanitizedProviderPayload,
          footer: SECTION_FOOTER,
          onClose: back,
        });
      default:
        return new TextViewer({
          tui: this.tui,
          theme,
          lines: ["(unknown section)"],
          footer: SECTION_FOOTER,
          onClose: back,
        });
    }
  }

  private overviewLines(): string[] {
    const theme = this.theme;
    const record = this.record;
    const logicalMessages =
      record.logicalContext?.length ?? record.providerEnvelope?.messageCount;
    const providerTools =
      record.providerTools?.length ?? record.providerEnvelope?.toolCount;
    const rows: Array<[string, string]> = [
      ["Request ID", record.requestId ?? "?"],
      ["User run", record.runId ?? "?"],
      ["Pi turn", formatCount(record.turnIndex)],
      ["Captured", formatTimestamp(record.timestamp)],
      ["Provider", record.model?.provider ?? "?"],
      ["Model", record.model?.id ?? (record.providerEnvelope?.model as string | undefined) ?? "?"],
      ["Thinking", formatThinkingLevel(record.thinkingLevel)],
      ["Context usage", formatContextUsage(record.contextUsage)],
      ["Logical messages", formatCount(logicalMessages)],
      ["Provider tools", formatCount(providerTools)],
      ["Provider shape", providerShapeLabel(record.providerEnvelope?.detectedShape)],
    ];
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    const lines = rows.map(
      ([label, value]) => `${label.padEnd(labelWidth)}  ${value}`,
    );
    if (record.warnings.length === 0) {
      lines.push(`${"Warnings".padEnd(labelWidth)}  none`);
    } else {
      lines.push(`${"Warnings".padEnd(labelWidth)}  ${record.warnings.length}`);
      for (const warning of record.warnings) {
        lines.push(theme.fg("warning", `  ${formatWarning(warning)}`));
      }
    }
    return lines;
  }

  private systemLines(): string[] {
    const theme = this.theme;
    const prompt = this.record.prompt;
    const out: string[] = [];
    if (!prompt) {
      out.push("(no system prompt snapshot for this request)");
      out.push(theme.fg("dim", "prompts are captured at before_agent_start and attached to requests"));
    } else {
      const system = prompt.systemPrompt;
      out.push(
        ...(system.length > 0
          ? system.split("\n")
          : [theme.fg("dim", "(empty system prompt)")]),
      );
    }
    out.push(theme.fg("dim", "─".repeat(40)));
    out.push(theme.fg("dim", "systemPromptOptions"));
    const options = prompt?.systemPromptOptions;
    if (options === undefined || options === null) {
      out.push(theme.fg("dim", "(not captured)"));
    } else {
      out.push(...safePrettyJson(options).split("\n"));
    }
    return out;
  }

  invalidate(): void {
    for (const view of this.views) view.invalidate();
  }
}

/** Full text of a logical message: text extraction, else pretty JSON. */
function messageFullText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === null || typeof message !== "object") {
    return safePrettyJson(message);
  }
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block !== null && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else parts.push(safePrettyJson(b));
      } else {
        parts.push(safePrettyJson(block));
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return safePrettyJson(message);
}
