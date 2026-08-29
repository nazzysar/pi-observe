/**
 * P1 — DIFF detail view: sub-tabbed inspection of one RequestDiff.
 *
 * Sub-views: SUMMARY | MESSAGES | SYSTEM | TOOLS | OPTIONS | RAW.
 * - sub-views are built lazily on first access, so expensive work
 *   (line diffs, full message text) happens only when the user opens
 *   the corresponding sub-view — never at capture time
 * - keyboard-first: , / . switch sub-views; everything else scrolls or
 *   expands within the active sub-view; Esc/q goes back
 * - unchanged system prompts are recognized by hash and reported as
 *   "identical" without generating a line diff
 *
 * Pure presentation over the derived RequestDiff: no store access, no
 * capture interaction, nothing model-visible.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  formatCount,
  formatSignedCount,
  formatSignedTokens,
  messageFullText,
  safePrettyJson,
} from "../format.ts";
import { shortHash } from "../hash.ts";
import type { RequestRecord } from "../model.ts";
import type { RequestDiff } from "../diff/request-diff.ts";
import { diffLines } from "../diff/text-diff.ts";
import { ItemListView, type ItemViewEntry } from "./item-list.ts";
import { TextViewer, type InspectorTheme, type ViewerTui } from "./text-viewer.ts";

export type DiffSectionId =
  | "SUMMARY"
  | "MESSAGES"
  | "SYSTEM"
  | "TOOLS"
  | "OPTIONS"
  | "RAW";

const SECTION_IDS: DiffSectionId[] = [
  "SUMMARY",
  "MESSAGES",
  "SYSTEM",
  "TOOLS",
  "OPTIONS",
  "RAW",
];

const DIFF_FOOTER = "↑↓ scroll   enter expand   ,/. sub-views   esc/q back";

/** Max entries rendered per sub-view (bounded rendering). */
const MAX_ENTRIES = 500;
/** Runs of unchanged lines longer than this are collapsed in SYSTEM. */
const COLLAPSE_SAME_RUN = 6;

export interface DiffViewOptions {
  tui: ViewerTui;
  theme: InspectorTheme;
  diff: RequestDiff;
  fromRecord: RequestRecord;
  toRecord: RequestRecord;
  /** Called on Esc/q (back to the ledger). */
  onClose?: () => void;
}

export class DiffViewComponent {
  private readonly tui: ViewerTui;
  private readonly theme: InspectorTheme;
  private readonly diff: RequestDiff;
  private readonly fromRecord: RequestRecord;
  private readonly toRecord: RequestRecord;
  private readonly onClose: (() => void) | undefined;
  private sectionIndex = 0;
  private readonly views: (TextViewer | ItemListView)[] = [];

  constructor(options: DiffViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.diff = options.diff;
    this.fromRecord = options.fromRecord;
    this.toRecord = options.toRecord;
    this.onClose = options.onClose;
  }

  get section(): DiffSectionId {
    return SECTION_IDS[this.sectionIndex]!;
  }

  handleInput(data: string): void {
    if (data === "," || data === ".") {
      this.switchSection(data === "," ? -1 : 1);
      return;
    }
    this.currentView().handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const theme = this.theme;
    const out: string[] = [];
    out.push(
      theme.fg(
        "accent",
        theme.bold(`Request Diff ${this.diff.fromRequestId} → ${this.diff.toRequestId}`),
      ),
    );
    out.push(this.tabsLine(safeWidth));
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

  private switchSection(delta: number): void {
    this.sectionIndex =
      (this.sectionIndex + delta + SECTION_IDS.length) % SECTION_IDS.length;
    this.invalidate();
    this.tui.requestRender();
  }

  private currentView(): TextViewer | ItemListView {
    let view = this.views[this.sectionIndex];
    if (!view) {
      view = this.buildSection(this.sectionIndex);
      this.views[this.sectionIndex] = view;
    }
    return view;
  }

  private buildSection(index: number): TextViewer | ItemListView {
    const theme = this.theme;
    const budget = (): number => this.contentBudget();
    const back = (): void => this.onClose?.();
    switch (SECTION_IDS[index]) {
      case "SUMMARY":
        return new TextViewer({
          tui: this.tui,
          theme,
          lines: this.summaryLines(),
          footer: DIFF_FOOTER,
          maxContentRows: budget,
          onClose: back,
        });
      case "MESSAGES":
        return this.messagesView();
      case "SYSTEM":
        return this.systemView();
      case "TOOLS":
        return this.toolsView();
      case "OPTIONS":
        return this.optionsView();
      case "RAW":
        return this.rawView();
      default:
        return new TextViewer({
          tui: this.tui,
          theme,
          lines: ["(unknown section)"],
          footer: DIFF_FOOTER,
          onClose: back,
        });
    }
  }

  /** Content budget passed to sub-views so the sub-tab line stays visible. */
  private contentBudget(): number {
    return Math.max(4, Math.floor(this.tui.terminal.rows) - 8);
  }

  // ------------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------------

  private summaryLines(): string[] {
    const theme = this.theme;
    const diff = this.diff;
    const rows: Array<[string, string]> = [
      ["Context", contextLine(diff)],
      ["Messages", messagesLine(diff)],
      ["System prompt", systemLine(diff)],
      ["Prompt inputs", promptOptionsLine(diff)],
      ["Tool schemas", toolsLine(diff)],
      ["Model", modelLine(diff)],
    ];
    if (diff.model.thinkingLevelChanged) {
      rows.push([
        "Thinking",
        `${diff.model.thinkingLevelFrom ?? "?"} → ${diff.model.thinkingLevelTo ?? "?"}`,
      ]);
    }
    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    return rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
  }

  // ------------------------------------------------------------------
  // MESSAGES
  // ------------------------------------------------------------------

  private messagesView(): ItemListView {
    const theme = this.theme;
    const diff = this.diff.messages;
    const entries: ItemViewEntry[] = [];
    for (const removed of diff.removed.slice(0, MAX_ENTRIES)) {
      entries.push({
        summary: theme.fg("error", `- [${removed.index}] ${removed.summary} · ${removed.length} chars`),
        details: messageAt(this.fromRecord, removed.index),
      });
    }
    for (const change of diff.changed.slice(0, MAX_ENTRIES)) {
      entries.push({
        summary:
          theme.fg("warning", `~ [${change.index}] ${change.new.summary}`) +
          ` · ${change.old.length} → ${change.new.length} chars`,
        details:
          `OLD:\n${messageAt(this.fromRecord, change.old.index)}\n\nNEW:\n` +
          messageAt(this.toRecord, change.new.index),
      });
    }
    for (const added of diff.added.slice(0, MAX_ENTRIES)) {
      entries.push({
        summary: theme.fg("success", `+ [${added.index}] ${added.summary} · ${added.length} chars`),
        details: messageAt(this.toRecord, added.index),
      });
    }
    if (entries.length === 0) {
      entries.push({
        summary: diff.unknown
          ? "message diff unavailable (no logical context captured)"
          : "no message differences",
        details: "",
      });
    }
    const truncated =
      diff.added.length + diff.removed.length + diff.changed.length > MAX_ENTRIES * 3;
    return new ItemListView({
      tui: this.tui,
      theme,
      title: "Messages",
      caption: messageCaption(diff),
      entries: truncated
        ? [...entries, { summary: "(more entries truncated)", details: "" }]
        : entries,
      emptyMessage: "no message differences",
      footer: DIFF_FOOTER,
      maxContentRows: () => this.contentBudget(),
      onClose: () => this.onClose?.(),
    });
  }

  // ------------------------------------------------------------------
  // SYSTEM
  // ------------------------------------------------------------------

  private systemView(): TextViewer {
    const theme = this.theme;
    const prompt = this.diff.systemPrompt;
    const out: string[] = [];
    if (prompt.equal) {
      out.push(`identical  ${shortHash(prompt.newHash)}`);
    } else if (prompt.oldHash === prompt.newHash) {
      out.push("unchanged");
    } else {
      out.push(
        `changed · ${prompt.oldLength.toLocaleString("en-US")} → ` +
          `${prompt.newLength.toLocaleString("en-US")} chars`,
      );
      out.push("");
      const oldPrompt = this.fromRecord.prompt?.systemPrompt ?? "";
      const newPrompt = this.toRecord.prompt?.systemPrompt ?? "";
      out.push(...collapsedLineDiff(oldPrompt, newPrompt, theme));
    }
    return new TextViewer({
      tui: this.tui,
      theme,
      title: "System prompt",
      lines: out,
      footer: DIFF_FOOTER,
      maxContentRows: () => this.contentBudget(),
      onClose: () => this.onClose?.(),
    });
  }

  // ------------------------------------------------------------------
  // TOOLS
  // ------------------------------------------------------------------

  private toolsView(): ItemListView {
    const theme = this.theme;
    const tools = this.diff.tools;
    const entries: ItemViewEntry[] = [];
    for (const removed of tools.removed.slice(0, MAX_ENTRIES)) {
      entries.push({
        summary: theme.fg("error", `- ${removed.summary} [${removed.index}]`),
        details: toolRawAt(this.fromRecord, removed.index),
      });
    }
    for (const change of tools.changed.slice(0, MAX_ENTRIES)) {
      const paths = change.changedPaths.length > 0
        ? ` · ${change.changedPaths.join(", ")}`
        : "";
      entries.push({
        summary: theme.fg("warning", `~ ${change.name ?? "(unnamed)"} [${change.oldIndex} → ${change.newIndex}]${paths}`),
        details:
          `OLD:\n${toolRawAt(this.fromRecord, change.oldIndex)}\n\nNEW:\n` +
          toolRawAt(this.toRecord, change.newIndex),
      });
    }
    for (const added of tools.added.slice(0, MAX_ENTRIES)) {
      entries.push({
        summary: theme.fg("success", `+ ${added.summary} [${added.index}]`),
        details: toolRawAt(this.toRecord, added.index),
      });
    }
    if (entries.length === 0) {
      entries.push({
        summary: tools.uninterpretable
          ? "tool diff unavailable (provider tool schema uninterpretable)"
          : "no tool differences",
        details: "",
      });
    }
    return new ItemListView({
      tui: this.tui,
      theme,
      title: "Tools",
      caption: tools.uninterpretable
        ? undefined
        : `${tools.unchanged} unchanged`,
      entries,
      emptyMessage: "no tool differences",
      footer: DIFF_FOOTER,
      maxContentRows: () => this.contentBudget(),
      onClose: () => this.onClose?.(),
    });
  }

  // ------------------------------------------------------------------
  // OPTIONS
  // ------------------------------------------------------------------

  private optionsView(): TextViewer {
    const theme = this.theme;
    const out: string[] = [];
    if (this.diff.systemPromptOptions.equal) {
      out.push("unchanged");
    } else {
      const changed = this.diff.optionFields.filter((field) => !field.equal);
      if (changed.length === 0) {
        out.push("changed (no tracked-field differences; see paths below)");
      } else {
        const labelWidth = Math.max(...changed.map((field) => field.field.length));
        for (const field of changed) {
          out.push(`${field.field.padEnd(labelWidth)}  ${field.detail}`);
        }
      }
      out.push("");
      out.push(theme.fg("dim", "changed paths"));
      const paths = this.diff.systemPromptOptions.changedPaths;
      if (paths.length === 0) {
        out.push(theme.fg("dim", "(none reported)"));
      } else {
        for (const path of paths) out.push(`  ${path}`);
        if (this.diff.systemPromptOptions.truncated) {
          out.push(theme.fg("warning", "  (list truncated)"));
        }
      }
    }
    return new TextViewer({
      tui: this.tui,
      theme,
      title: "Prompt construction options",
      lines: out,
      footer: DIFF_FOOTER,
      maxContentRows: () => this.contentBudget(),
      onClose: () => this.onClose?.(),
    });
  }

  // ------------------------------------------------------------------
  // RAW (provider payload structural changes)
  // ------------------------------------------------------------------

  private rawView(): TextViewer {
    const theme = this.theme;
    const payload = this.diff.providerPayload;
    const out: string[] = [];
    if (payload.equal) {
      out.push(`identical  ${shortHash(payload.newHash)}`);
    } else {
      if (payload.changedPaths.length === 0) {
        out.push("changed (no paths reported)");
      } else {
        for (const path of payload.changedPaths) out.push(`  ${path}`);
      }
      if (payload.truncated) out.push(theme.fg("warning", "(list truncated)"));
      out.push("");
      out.push(theme.fg("dim", "full before/after payloads: OVERVIEW tabs SYSTEM/RAW"));
    }
    return new TextViewer({
      tui: this.tui,
      theme,
      title: "Provider payload structural changes",
      caption: "secondary/debug view — message content changes are elided here",
      lines: out,
      footer: DIFF_FOOTER,
      maxContentRows: () => this.contentBudget(),
      onClose: () => this.onClose?.(),
    });
  }

  invalidate(): void {
    // `views` is sparse (sections build lazily); guard each entry.
    for (const view of this.views) view?.invalidate();
  }
}

// ---------------------------------------------------------------------------
// Summary line helpers (pure, defensive)
// ---------------------------------------------------------------------------

function contextLine(diff: RequestDiff): string {
  if (diff.contextUsage === "unknown") return "unknown";
  const usage = diff.contextUsage;
  return (
    `${formatSignedTokens(usage.delta)} reported tokens ` +
    `(${usage.from.toLocaleString("en-US")} → ${usage.to.toLocaleString("en-US")})`
  );
}

function messagesLine(diff: RequestDiff): string {
  const messages = diff.messages;
  if (messages.unknown) return "unknown";
  const deltas =
    `${formatSignedCount(messages.added.length)} / ` +
    `${formatSignedCount(-messages.removed.length)} / ` +
    `~${messages.changed.length} changed`;
  return `${deltas} (${messages.oldCount} → ${messages.newCount})`;
}

function systemLine(diff: RequestDiff): string {
  if (diff.systemPrompt.equal) return "unchanged";
  return `changed · ${diff.systemPrompt.oldLength.toLocaleString("en-US")} → ` +
    `${diff.systemPrompt.newLength.toLocaleString("en-US")} chars`;
}

function promptOptionsLine(diff: RequestDiff): string {
  if (diff.systemPromptOptions.equal) return "unchanged";
  const changed = diff.optionFields.filter((field) => !field.equal);
  if (changed.length === 0) return "changed";
  return changed.map((field) => `${field.field}: ${field.detail}`).join(" · ");
}

function toolsLine(diff: RequestDiff): string {
  const tools = diff.tools;
  if (tools.uninterpretable) return "unknown (tool schema uninterpretable)";
  if (tools.added.length + tools.removed.length + tools.changed.length === 0) {
    return `unchanged (${tools.unchanged} tools)`;
  }
  return (
    `${formatSignedCount(tools.added.length)} / ` +
    `${formatSignedCount(-tools.removed.length)} / ` +
    `~${tools.changed.length} changed (${tools.unchanged} unchanged)`
  );
}

function modelLine(diff: RequestDiff): string {
  const model = diff.model;
  if (!model.changed) return `unchanged (${model.to ?? "?"})`;
  return `${model.from ?? "?"} → ${model.to ?? "?"}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Caption summarizing the sequence shape for the MESSAGES sub-view. */
function messageCaption(diff: RequestDiff["messages"]): string {
  if (diff.unknown) return "logical context unavailable for one of the two requests";
  return (
    `${diff.oldCount} → ${diff.newCount} messages · ` +
    `common prefix ${diff.commonPrefix} · common suffix ${diff.commonSuffix}`
  );
}

/** Collapse long runs of unchanged lines; mark added/removed lines. */
function collapsedLineDiff(oldText: string, newText: string, theme: InspectorTheme): string[] {
  const { lines, lineEndingOnly } = diffLines(oldText, newText);
  if (lineEndingOnly) {
    return [theme.fg("dim", "line endings only (CRLF/CR → LF) — content identical")];
  }
  const out: string[] = [];
  let sameRun = 0;
  const flushRun = (): void => {
    if (sameRun > COLLAPSE_SAME_RUN) {
      out.push(theme.fg("dim", `  … ${sameRun} unchanged lines`));
    } else {
      for (let i = 0; i < sameRun; i++) {
        out.push(theme.fg("dim", `  ${bufferedSame[i]}`));
      }
    }
    sameRun = 0;
    bufferedSame.length = 0;
  };
  const bufferedSame: string[] = [];
  for (const line of lines) {
    if (line.type === "same") {
      bufferedSame.push(line.text);
      sameRun++;
      continue;
    }
    flushRun();
    if (line.type === "added") out.push(theme.fg("success", `+ ${line.text}`));
    else out.push(theme.fg("error", `- ${line.text}`));
  }
  flushRun();
  if (out.length === 0) out.push(theme.fg("dim", "(no line differences)"));
  return out;
}

/** Logical message at `index`, rendered as full text (defensive). */
function messageAt(record: RequestRecord, index: number): string {
  const message = record.logicalContext?.[index];
  if (message === undefined) return "(message not available)";
  return messageFullText(message);
}

/** Raw tool definition at `index` in the record's extracted tools. */
function toolRawAt(record: RequestRecord, index: number): string {
  const tool = record.providerTools?.find((tool) => tool.index === index);
  return tool === undefined ? "(tool not available)" : safePrettyJson(tool.raw);
}
