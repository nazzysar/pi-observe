/**
 * P0.3 — Safe pretty JSON viewer.
 *
 * Wraps TextViewer with `safePrettyJson` so arbitrary observed values
 * (sanitized provider payloads, tool definitions, systemPromptOptions)
 * render as scrollable, inspectable text. JSON failures degrade to
 * String()/[unprintable] inside format.ts — never a crash.
 */

import { safePrettyJson } from "../format.ts";
import { TextViewer, type TextViewerOptions, type ViewerTui } from "./text-viewer.ts";

export interface JsonViewerOptions {
  tui: ViewerTui;
  theme: TextViewerOptions["theme"];
  /** Title shown above the JSON. */
  label: string;
  /** Optional dim caption under the title. */
  caption?: string;
  /** The observed value to render. */
  value: unknown;
  /** Left-hand footer hint. */
  footer?: string;
  onClose?: () => void;
}

/** Create a scrolling JSON viewer for an arbitrary observed value. */
export function createJsonViewer(options: JsonViewerOptions): TextViewer {
  const lines = safePrettyJson(options.value).split("\n");
  return new TextViewer({
    tui: options.tui,
    theme: options.theme,
    title: options.label,
    caption: options.caption,
    lines,
    emptyText: "(empty payload)",
    footer: options.footer ?? "↑↓ scroll   esc/q close",
    onClose: options.onClose,
  });
}
