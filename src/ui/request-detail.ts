/**
 * P0.3/P1 — Request detail component.
 *
 * Keyboard-switchable sections for one RequestRecord:
 * OVERVIEW | DIFF | SYSTEM | CONTEXT | TOOLS | RAW.
 *
 * - OVERVIEW: metadata + observation/correlation/parser warnings
 * - DIFF:     P1 diff against the predecessor request (sub-tabbed)
 * - SYSTEM:   effective system prompt + structured systemPromptOptions
 * - CONTEXT:  logical model-facing messages (expandable)
 * - TOOLS:    P0.2 provider tool extraction (expandable raw), with an
 *             explicit "cannot interpret → see RAW" state
 * - RAW:      sanitized provider payload observed by the extension
 *
 * P1 adds [ / ] request navigation and `d` to jump to the DIFF tab.
 * Every section degrades to a clear unknown/error state; rendering is
 * defensive so malformed records can never crash the inspector.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  collapseWhitespace,
  formatContextUsage,
  formatCount,
  formatThinkingLevel,
  formatTimestamp,
  formatWarning,
  messageFullText,
  providerShapeLabel,
  safePrettyJson,
  summarizeMessage,
} from "../format.ts";
import type { RequestRecord } from "../model.ts";
import { DiffService } from "../diff/request-diff.ts";
import { DiffViewComponent } from "./diff-view.ts";
import { createJsonViewer } from "./json-viewer.ts";
import { ItemListView, type ItemViewEntry } from "./item-list.ts";
import { TextViewer, type InspectorTheme, type ViewerTui } from "./text-viewer.ts";

export type DetailSectionId = "OVERVIEW" | "DIFF" | "SYSTEM" | "CONTEXT" | "TOOLS" | "RAW";

const SECTION_IDS: DetailSectionId[] = [
  "OVERVIEW",
  "DIFF",
  "SYSTEM",
  "CONTEXT",
  "TOOLS",
  "RAW",
];

const SECTION_FOOTER = "↑↓ navigate   enter expand   ←→/tab sections   esc/q back";

/**
 * Header rows the detail component renders above its section view:
 * inspector title, tabs, metadata, blank separator.
 */
const DETAIL_HEADER_ROWS = 4;
/** Rows each section view adds around its content (title, caption, footer). */
const PI_CHROME_ROWS = 3;

export interface RequestDetailOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  record: RequestRecord;
  /** P1 diff service; the DIFF tab renders a clear empty state without it. */
  diffService?: DiffService;
  /**
   * Neighbor lookup for [ (previous, older) / ] (next, newer) request
   * navigation. Without it those keys are inert.
   */
  getNeighborRecord?: (record: RequestRecord, delta: -1 | 1) => RequestRecord | undefined;
  /** Called on Esc/q (back to the ledger). */
  onBack?: () => void;
  /** Called when the inspector should close entirely. */
  onClose?: () => void;
}

export class RequestDetailComponent {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private record: RequestRecord;
  private readonly diffService: DiffService | undefined;
  private readonly getNeighborRecord:
    | ((record: RequestRecord, delta: -1 | 1) => RequestRecord | undefined)
    | undefined;
  private readonly onBack: (() => void) | undefined;
  private readonly onClose: (() => void) | undefined;
  private sectionIndex = 0;
  private views: (TextViewer | ItemListView | DiffViewComponent)[] = [];

  constructor(options: RequestDetailOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.record = options.record;
    this.diffService = options.diffService;
    this.getNeighborRecord = options.getNeighborRecord;
    this.onBack = options.onBack;
    this.onClose = options.onClose;
  }

  get section(): DetailSectionId {
    return SECTION_IDS[this.sectionIndex]!;
  }

  private currentView(): TextViewer | ItemListView | DiffViewComponent {
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
    if (data.length === 1 && data >= "1" && data <= "6") {
      this.switchToSection(Number(data) - 1);
      return;
    }
    if (data === "[" || data === "]") {
      this.switchRecord(data === "[" ? -1 : 1);
      return;
    }
    if (data === "d") {
      this.switchToSection(SECTION_IDS.indexOf("DIFF"));
      return;
    }
    this.currentView().handleInput(data);
  }

  /** [ / ]: show the previous (older) or next (newer) request. */
  private switchRecord(delta: -1 | 1): void {
    const next = this.getNeighborRecord?.(this.record, delta);
    if (!next) return;
    this.record = next;
    this.views = []; // rebuild all sections for the new record
    this.invalidate();
    this.tui.requestRender();
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
    // Fill the viewport so the fullscreen overlay covers everything behind it.
    const fillRows = Math.max(out.length, Math.floor(this.tui.terminal.rows));
    while (out.length < fillRows) out.push("");
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

  /** Content rows each section view may occupy so the header + tabs always fit. */
  private viewContentBudget(): number {
    return Math.max(
      4,
      this.tui.terminal.rows - DETAIL_HEADER_ROWS - PI_CHROME_ROWS,
    );
  }

  private buildSection(index: number): TextViewer | ItemListView | DiffViewComponent {
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
          maxContentRows: () => this.viewContentBudget(),
          onClose: back,
        });
      case "DIFF":
        return this.buildDiffView();
      case "SYSTEM":
        return new TextViewer({
          tui: this.tui,
          theme,
          title: "Effective system prompt",
          caption: "assembled by Pi (captured at before_agent_start) + structured systemPromptOptions",
          lines: this.systemLines(),
          footer: SECTION_FOOTER,
          maxContentRows: () => this.viewContentBudget(),
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
          maxContentRows: () => this.viewContentBudget(),
          onClose: back,
        });
      }
      case "TOOLS": {
        const tools = record.providerTools;
        const entries: ItemViewEntry[] = (tools ?? []).map((tool) => ({
          summary:
            `[${tool.index}] ` +
            (tool.name ? collapseWhitespace(tool.name) : "(unnamed)") +
            (tool.description
              ? ` — ${collapseWhitespace(tool.description)}`
              : ""),
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
          maxContentRows: () => this.viewContentBudget(),
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
          maxContentRows: () => this.viewContentBudget(),
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

  /** DIFF tab: diff against the predecessor request (P1). */
  private buildDiffView(): DiffViewComponent | TextViewer {
    const theme = this.theme;
    const back = (): void => this.onBack?.();
    const from = this.getNeighborRecord?.(this.record, -1);
    if (!from) {
      return new TextViewer({
        tui: this.tui,
        theme,
        title: "Request diff",
        lines: [
          this.diffService
            ? "(no previous request to diff against)"
            : "(no previous request to diff against, and no diff service wired)",
        ],
        footer: SECTION_FOOTER,
        maxContentRows: () => this.viewContentBudget(),
        onClose: back,
      });
    }
    if (!this.diffService) {
      return new TextViewer({
        tui: this.tui,
        theme,
        title: "Request diff",
        lines: ["(diff service unavailable)"],
        footer: SECTION_FOOTER,
        maxContentRows: () => this.viewContentBudget(),
        onClose: back,
      });
    }
    const diff = this.diffService.diff(from, this.record);
    return new DiffViewComponent({
      tui: this.tui,
      theme,
      diff,
      fromRecord: from,
      toRecord: this.record,
      onClose: back,
    });
  }

  private overviewLines(): string[] {
    const theme = this.theme;
    const record = this.record;
    const logicalMessages =
      record.logicalContext?.length ?? record.providerEnvelope?.messageCount;
    // Envelope toolCount first: it counts native tools (Gemini
    // googleSearch, codeExecution, …) that have no extractable
    // definition, so extracted definitions may undercount.
    const providerTools =
      record.providerEnvelope?.toolCount ?? record.providerTools?.length;
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
    // `views` is sparse (sections build lazily); array iteration yields
    // undefined for empty slots, so guard each entry.
    for (const view of this.views) view?.invalidate();
  }
}
