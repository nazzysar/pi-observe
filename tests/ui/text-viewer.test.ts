/**
 * P0.3 — TextViewer tests: scrolling bounds, truncation, key handling,
 * and graceful degradation on empty content.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TextViewer } from "../../src/ui/text-viewer.ts";
import { fakeTheme, fakeTui } from "./helpers.ts";

function makeViewer(
  lines: string[],
  rows = 40,
  options: Partial<ConstructorParameters<typeof TextViewer>[0]> = {},
): { viewer: TextViewer; tui: ReturnType<typeof fakeTui>; state: { closed: boolean } } {
  const tui = fakeTui(rows);
  const state = { closed: false };
  const instance = new TextViewer({
    tui,
    theme: fakeTheme(),
    lines,
    title: "Title",
    footer: "hint",
    onClose: () => {
      state.closed = true;
    },
    ...options,
  });
  return { viewer: instance, tui, state };
}

const LINES = Array.from({ length: 100 }, (_, i) => `line ${i}`);

test("renders title, content window, and footer", () => {
  const { viewer: vw } = makeViewer(LINES, 40);
  const lines = vw.render(80);
  assert.equal(lines[0], "Title");
  // 40 rows - 6 reserved = 34 content rows; 1 title + 34 content + 1 footer.
  assert.ok(lines.length <= 36);
  assert.equal(lines[1], "line 0");
  assert.ok(lines.some((l) => l === "hint" || l.startsWith("hint")));
});

test("no rendered line exceeds the requested width", () => {
  const { viewer: vw } = makeViewer(LINES, 40);
  for (const width of [40, 80, 120]) {
    for (const line of vw.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${line}`);
    }
  }
});

test("up/down scrolls within bounds; end clamps", () => {
  const { viewer: vw, tui } = makeViewer(LINES, 40);
  vw.handleInput("\u001b[A"); // up at top: no-op
  assert.equal(vw.scrollOffset, 0);
  vw.handleInput("\u001b[B"); // down
  assert.equal(vw.scrollOffset, 1);
  assert.equal(tui.renderCount, 2, "each move requests a render");
  // End → offset clamps to last window start.
  vw.handleInput("\u001b[F"); // end
  assert.ok(vw.scrollOffset > 0);
  assert.equal(vw.scrollOffset + 34, 100, "window ends at last line");
  vw.handleInput("\u001b[B"); // down at end: no-op
  assert.equal(vw.scrollOffset, 66);
});

test("page up/down and home move by window", () => {
  const { viewer: vw } = makeViewer(LINES, 40);
  vw.handleInput("\u001b[6~"); // page down
  assert.equal(vw.scrollOffset, 34);
  vw.handleInput("\u001b[5~"); // page up
  assert.equal(vw.scrollOffset, 0);
  vw.handleInput("\u001b[F"); // end
  const end = vw.scrollOffset;
  vw.handleInput("\u001b[H"); // home
  assert.equal(vw.scrollOffset, 0);
  assert.ok(end > 0);
});

test("esc and q close", () => {
  const a = makeViewer(LINES);
  a.viewer.handleInput("\u001b");
  assert.equal(a.state.closed, true);
  const b = makeViewer(LINES);
  b.viewer.handleInput("q");
  assert.equal(b.state.closed, true);
});

test("empty content renders the empty state without crashing", () => {
  const { viewer: vw } = makeViewer([], 40, { emptyText: "(nothing here)" });
  const lines = vw.render(80);
  assert.ok(lines.some((l) => l.includes("(nothing here)")));
});

test("long lines wrap to the terminal width", () => {
  const { viewer: vw } = makeViewer(["x".repeat(500)], 40);
  const lines = vw.render(60);
  assert.ok(visibleWidth(lines[1]!) <= 60);
});

test("long lines wrap so the tail stays reachable by scrolling", () => {
  // 3000 chars at 60 cols wraps to ~51 lines — far more than the
  // 34-row window, so truncation would permanently hide the tail.
  const { viewer: vw } = makeViewer([`head-marker-${"x".repeat(3000)}-TAIL42`], 40);
  const head = vw.render(60).join("\n");
  assert.ok(head.includes("head-marker-"), "head of the long line visible");
  assert.ok(!head.includes("TAIL42"), "tail wrapped out of view initially");
  for (const line of vw.render(60)) {
    assert.ok(visibleWidth(line) <= 60, `wrapped line exceeds width: ${line}`);
  }
  vw.handleInput("\u001b[F"); // end
  const tail = vw.render(60).join("\n");
  assert.ok(vw.scrollOffset > 0, "scrolled past the wrapped head");
  assert.ok(tail.includes("TAIL42"), "tail reachable after End");
});

test("small terminal shrinks the window but scrolling still works", () => {
  const { viewer: vw } = makeViewer(LINES, 12); // 12 - 6 = 6 content rows
  const lines = vw.render(80);
  assert.ok(lines.length <= 8);
  vw.handleInput("\u001b[F"); // end
  assert.equal(vw.scrollOffset, 94); // 100 - 6
  assert.equal(vw.render(80)[1]!, "line 94");
});

test("setLines replaces content and clamps offset", () => {
  const { viewer: instance } = makeViewer(LINES, 40);
  instance.handleInput("\u001b[F"); // end
  instance.setLines(["only"]);
  assert.equal(instance.scrollOffset, 0);
  assert.equal(instance.lineCount, 1);
});

test("height-only terminal resize recomputes the cached view", () => {
  const { viewer: vw, tui } = makeViewer(LINES, 40); // 34 content rows
  assert.equal(vw.render(80).length, 36);

  // Resize only the terminal height; the same width must not hit the cache.
  tui.terminal.rows = 20; // 14 content rows
  const short = vw.render(80);
  assert.equal(short.length, 16, "fewer content rows after shrink");
  assert.ok(short.some((l) => l.includes("1-14/100")), "footer shows the new window");
});

test("height growth re-renders and re-clamps the scroll offset", () => {
  const { viewer: vw, tui } = makeViewer(LINES, 20); // 14 content rows
  vw.handleInput("\u001b[F"); // end → offset 86 (100 - 14)
  assert.equal(vw.scrollOffset, 86);
  tui.terminal.rows = 40; // 34 content rows → max offset 66
  const grown = vw.render(80);
  assert.equal(grown.length, 36);
  assert.equal(vw.scrollOffset, 66, "offset re-clamped for the taller window");
  assert.equal(grown[1]!, "line 66");
});
