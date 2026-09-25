import { afterEach, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import {
  MockTreeSitterClient,
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import stringWidth from "string-width";

import { parseMarkdownDiff, parseMarkdownDocument } from "../src/diff.ts";
import { buildDiffViewer } from "../src/ui.ts";

let setup: TestRendererSetup | null = null;
let treeSitterClient: MockTreeSitterClient | null = null;

afterEach(async () => {
  setup?.renderer.destroy();
  setup = null;
  await treeSitterClient?.destroy();
  treeSitterClient = null;
});

test("renders rich Markdown with distinct addition and deletion backgrounds", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,3 +1,3 @@
-# Old **heading**
+# New **heading**
${" "}
 - item
`);
  setup = await createTestRenderer({ width: 80, height: 30 });
  treeSitterClient = new MockTreeSitterClient();
  treeSitterClient.setMockResult({
    highlights: [
      [0, 2, "conceal", { conceal: "" }],
      [2, 17, "markup.heading.1"],
      [6, 8, "conceal", { conceal: "" }],
      [8, 15, "markup.strong"],
      [15, 17, "conceal", { conceal: "" }],
    ],
  });

  buildDiffViewer(setup.renderer, document, { treeSitterClient });
  await setup.renderOnce();
  treeSitterClient.resolveAllHighlightOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).toContain("guide.md");
  expect(text).not.toContain("mdcat");
  expect(text).not.toContain("− Removed");
  expect(text).not.toContain("+ Added");
  expect(text).toContain("OldNew heading");
  expect(text).toContain("═══════════");
  expect(text).not.toContain("# Old");
  expect(text).not.toContain("# New");

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const removed = spans.find((span) => span.text.includes("Old"));
  const added = spans.find((span) => span.text.includes("New"));
  expect(removed?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect(added?.bg.toInts()).toEqual([18, 38, 30, 255]);
});

test("renders Leaf-style rules below level one and two headings", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,2 +1,2 @@
 # Title
 ## Section
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trim());
  expect(lines).toContain("Title");
  expect(lines).toContain("═════");
  expect(lines).toContain("Section");
  expect(lines).toContain("───────");
});

test("separates headings, paragraphs, and lists with one blank line", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,8 +1,8 @@
 # Title
${" "}
 Paragraph before.
${" "}
 1. first
 2. second
${" "}
 Paragraph after.
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trim());
  const rule = lines.indexOf("═════");
  const before = lines.indexOf("Paragraph before.");
  const first = lines.indexOf("1. first");
  const second = lines.indexOf("2. second");
  const after = lines.indexOf("Paragraph after.");
  expect(before - rule).toBe(2);
  expect(first - before).toBe(2);
  expect(after - second).toBe(2);
});

test("renders details tags as expanded toggle blocks", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,7 +1,7 @@
 <details>
 <summary>More **information**</summary>
${" "}
 Hidden **content**.
${" "}
 - nested item
 </details>
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).toContain("▾ More information");
  expect(text).toContain("Hidden content.");
  expect(text).toContain("• nested item");
  expect(text).not.toContain("<details>");
  expect(text).not.toContain("<summary>");
  expect(text).not.toContain("</details>");

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(spans.find((span) => span.text.includes("More"))?.attributes)
    .toBe(TextAttributes.BOLD);

  const lines = text.split("\n");
  const y = lines.findIndex((line) => line.includes("More information"));
  const x = lines[y]?.indexOf("More information") ?? -1;
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  await setup.mockMouse.click(x, y);
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("▸ More information");
  expect(setup.captureCharFrame()).not.toContain("Hidden content.");

  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("▾ More information");
  expect(setup.captureCharFrame()).toContain("Hidden content.");
});

test("renders Leaf-style unordered, ordered, and task list markers", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,9 +1,9 @@
 - first **bold**
   - second
     - third
${" "}
 10. tenth
 11. eleventh
${" "}
 - [ ] todo
 - [x] done
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).toContain("• first bold");
  expect(text).toContain("  ◦ second");
  expect(text).toContain("    ▸ third");
  expect(text).toContain("10. tenth");
  expect(text).toContain("11. eleventh");
  expect(text).toContain("☐ todo");
  expect(text).toMatch(/☑ +done/);
  expect(text).not.toContain("- first");
  expect(text).not.toContain("[ ] todo");
  expect(text).not.toContain("[x] done");

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(spans.find((span) => span.text.includes("• "))?.fg.toInts())
    .toEqual([95, 200, 148, 255]);
  expect(spans.find((span) => span.text.includes("◦ "))?.fg.toInts())
    .toEqual([138, 155, 200, 255]);
  expect(spans.find((span) => span.text.includes("▸ "))?.fg.toInts())
    .toEqual([168, 168, 185, 255]);
  expect(spans.find((span) => span.text.includes("bold"))?.attributes)
    .toBe(TextAttributes.BOLD);
});

test("copies text when a mouse selection finishes", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1 +1 @@
 Copy this text
`);
  setup = await createTestRenderer({ width: 80, height: 30 });
  let copied = "";

  buildDiffViewer(setup.renderer, document, {
    copyText: (text) => {
      copied = text;
    },
  });
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("Copy this text"));
  const x = lines[y]?.indexOf("Copy this text") ?? -1;
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);

  await setup.mockMouse.drag(x, y, x + "Copy this".length - 1, y);
  expect(copied).toContain("Copy this");
});

test("renders table replacements inline", async () => {
  const document = parseMarkdownDiff(`diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,3 +1,3 @@
 | ID | Value | Status |
 | --- | --- | --- |
-| item | Before | **active** |
+| item | After | **active** |
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text.match(/┌/g)).toHaveLength(1);
  expect(text).toContain("Before");
  expect(text).toContain("After");
  expect(text).toContain("active");
  expect(text).not.toContain("**active**");
  expect(text.split("\n").some((line) => line.includes("Before") && line.includes("After"))).toBe(true);

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const removed = spans.find((span) => span.text.includes("Before"));
  const added = spans.find((span) => span.text.includes("After"));
  const richContext = spans.find((span) => span.text.includes("active"));
  expect(removed?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect(added?.bg.toInts()).toEqual([18, 38, 30, 255]);
  expect(richContext?.attributes).toBe(TextAttributes.BOLD);
});

test("renders paragraph edits inline while keeping inline formatting", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1 +1 @@
-The cache keeps **recent** entries in memory.
+The cache keeps **recent** entries in Redis.
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).not.toContain("**");
  const lines = text.split("\n").map((line) => line.trimEnd());
  expect(lines).toContain("  The cache keeps recent entries in memory");
  expect(lines).toContain("  Redis.");

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const removed = spans.find((span) => span.text.includes("memory"));
  const added = spans.find((span) => span.text.includes("Redis"));
  const formatted = spans.find((span) => span.text.includes("recent"));
  expect(removed?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect((removed?.attributes ?? 0) & TextAttributes.STRIKETHROUGH).toBe(TextAttributes.STRIKETHROUGH);
  expect(added?.bg.toInts()).toEqual([18, 38, 30, 255]);
  expect(formatted?.attributes).toBe(TextAttributes.BOLD);
});

test("renders list item edits inline next to their markers", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,2 +1,3 @@
 - Target: search results
-- TTL: 5 min
+- TTL: 10 min
+- Store: Redis
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  expect(lines.some((line) => line.includes("• TTL: 510 min"))).toBe(true);
  expect(lines.some((line) => line.includes("• Store: Redis"))).toBe(true);

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const removed = spans.find((span) => span.text === "5");
  const added = spans.find((span) => span.text === "10");
  const newItem = spans.find((span) => span.text.includes("Store"));
  expect(removed?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect(added?.bg.toInts()).toEqual([18, 38, 30, 255]);
  expect(newItem?.bg.toInts()).toEqual([18, 38, 30, 255]);
});

test("renders heading, quote, and code block edits in place", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,11 +1,11 @@
-## Cache design
+## Storage design
${" "}
-> The cache is stored in memory.
+> The cache is stored in Redis.
${" "}
 \`\`\`ts
 const ttl = 5;
-const store = "memory";
+const store = "redis";
 \`\`\`
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  expect(lines.some((line) => line.includes("CacheStorage design"))).toBe(true);
  expect(lines.some((line) => line.includes("│ The cache is stored in memoryRedis."))).toBe(true);
  expect(lines.some((line) => line.includes("  const ttl = 5;"))).toBe(true);
  expect(lines.some((line) => line.includes("− const store = \"memory\";"))).toBe(true);
  expect(lines.some((line) => line.includes("+ const store = \"redis\";"))).toBe(true);
});

test("renders nested list items and details bodies with inline diffs", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,11 +1,11 @@
 - Parent item
   - Child A
-  - Child B is old
+  - Child B is new
${" "}
 <details>
 <summary>Notes</summary>
${" "}
-The body is old.
+The body is new.
${" "}
 </details>
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  expect(lines.some((line) => line.includes("• Parent item"))).toBe(true);
  expect(lines.some((line) => line.includes("  ◦ Child B is oldnew"))).toBe(true);
  expect(lines.some((line) => line.includes("▾ Notes"))).toBe(true);
  expect(lines.some((line) => line.includes("│ The body is oldnew."))).toBe(true);
  expect(lines.some((line) => line.includes("<details>"))).toBe(false);
});

test("fills added quotes and keeps loose list spacing", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,4 +1,6 @@
 - First paragraph.
${" "}
-  Second old.
+  Second new.
+
+> Added quote.
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  const first = lines.findIndex((line) => line.includes("First paragraph."));
  const second = lines.findIndex((line) => line.includes("Second oldnew."));
  expect(second - first).toBe(2);

  const quoteLine = setup.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("Added quote")));
  const bar = quoteLine?.spans.find((span) => span.text.includes("│"));
  expect(bar?.bg.toInts()).toEqual([18, 38, 30, 255]);
});

test("renders comment edits inline between comment markers", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1 +1 @@
-<!-- TODO: write the old note -->
+<!-- TODO: write the new note -->
`);
  setup = await createTestRenderer({ width: 80, height: 20 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n");
  expect(lines.some((line) => line.includes("<!-- TODO: write the oldnew note -->"))).toBe(true);
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  expect(spans.find((span) => span.text === "old")?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect(spans.find((span) => span.text === "new")?.bg.toInts()).toEqual([18, 38, 30, 255]);
});

test("moves an edit that would wrap to the next line instead of splitting it", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1 +1 @@
-あいうえおかきくけこさしすせそ古い表現です。
+あいうえおかきくけこさしすせそ新しくて長めの表現です。
`);
  setup = await createTestRenderer({ width: 40, height: 14 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines).toContain("  あいうえおかきくけこさしすせそ古い");
  expect(lines).toContain("  新しくて長めの表現です。");
});

test("starts a long edit on a new line instead of after the removal", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,4 +1,3 @@
-例: 本番の設定ファイルへ移行スクリプトを追加する作業で、古い形式が検証で 400 に
-なったのを **手で書き直して通し**、さらに **検証の規則を一つずつ試して整理**した。
-中身は正しい設定だったが、**古い形式のまま残した項目が警告として表示された** ——
+検証で失敗したものを **書き直して通す**、検証の規則を一つずつ試す、といった作業は、
+中身が正しい設定でも古い形式のまま残した項目が警告として表示される原因になる ——
 **内容の誤りではなく「古い形式を新しい形式へ移す」手順そのものが対象**である。
`);
  setup = await createTestRenderer({ width: 100, height: 16 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines.some((line) => line.startsWith("  検証で失敗したものを"))).toBe(true);
});

test("wraps edits at the widest heading or paragraph line of the section", async () => {
  const widest = "This context paragraph sets the section width to 58.";
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,6 +1,6 @@
 ## Section
${" "}
 ${widest}
${" "}
-The cache keeps entries in local process memory.
+The cache keeps entries in a shared Redis cluster.
`);
  setup = await createTestRenderer({ width: 120, height: 20 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines).toContain("  The cache keeps entries in local process memory");
  expect(lines).toContain("  a shared Redis cluster.");
  expect(lines.every((line) => !line.includes("cache") || line.trim().length <= widest.length)).toBe(true);
});

test("does not let short list items narrow the section width", async () => {
  const widest = "This context paragraph sets the section width to 58.";
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,7 +1,7 @@
 ## Section
${" "}
 ${widest}
${" "}
 - short
-- The cache keeps entries in local memory.
+- The cache keeps entries in shared Redis.
`);
  setup = await createTestRenderer({ width: 120, height: 20 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines).toContain("  • The cache keeps entries in local memoryshared Redis.");
});

test("leaves list-only sections at the terminal width", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,4 +1,4 @@
 ## Section
${" "}
-- The cache keeps entries in local process memory for now.
+- The cache keeps entries in a shared Redis cluster for now.
`);
  setup = await createTestRenderer({ width: 120, height: 20 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines.some((line) => line.includes("local process memory a shared Redis cluster for now."))).toBe(true);
});

test("measures tabs and long words the way the terminal draws them when wrapping", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,3 +1,3 @@
-12345678\tX old
+12345678\tX new
${" "}
 abcdefghijklmnopqrst tail
`);
  setup = await createTestRenderer({ width: 22, height: 14 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  expect(lines).toContain("  12345678  X oldnew");
  expect(lines).toContain("  abcdefghijklmnopqr");
  expect(lines).toContain("  st tail");
});

test("renders unmatched table rows with whole-row diff markers", async () => {
  const document = parseMarkdownDiff(`diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,3 +1,3 @@
 | Name | Value |
 | --- | --- |
-| Removed | 1 |
+| Added | 2 |
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).toContain("− Removed");
  expect(text).toContain("+ Added");

  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const removed = spans.find((span) => span.text.includes("Removed"));
  const added = spans.find((span) => span.text.includes("Added"));
  expect(removed?.bg.toInts()).toEqual([50, 28, 31, 255]);
  expect(added?.bg.toInts()).toEqual([18, 38, 30, 255]);

  const lines = setup.captureSpans().lines;
  const removedLine = lines.find((line) => line.spans.some((span) => span.text.includes("Removed")));
  const addedLine = lines.find((line) => line.spans.some((span) => span.text.includes("Added")));
  const removedBackgroundWidth = removedLine?.spans
    .filter((span) => span.bg.toInts().join(",") === "50,28,31,255")
    .reduce((width, span) => width + span.text.length, 0) ?? 0;
  const addedBackgroundWidth = addedLine?.spans
    .filter((span) => span.bg.toInts().join(",") === "18,38,30,255")
    .reduce((width, span) => width + span.text.length, 0) ?? 0;
  expect(removedBackgroundWidth).toBeGreaterThan("− Removed1".length);
  expect(addedBackgroundWidth).toBeGreaterThan("+ Added2".length);

  const removedColoredText = removedLine?.spans
    .filter((span) => span.bg.toInts().join(",") === "50,28,31,255")
    .map((span) => span.text)
    .join("") ?? "";
  const addedColoredText = addedLine?.spans
    .filter((span) => span.bg.toInts().join(",") === "18,38,30,255")
    .map((span) => span.text)
    .join("") ?? "";
  expect(removedColoredText).toContain("│");
  expect(addedColoredText).toContain("│");
});

test("keeps table rules aligned with wrapped wide text", async () => {
  const document = parseMarkdownDiff(`diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,3 +1,3 @@
 | 名前 | 説明 |
 | --- | --- |
-| 古い項目 | 長い説明文 |
+| 新項目 | 変更後の文 |
`);
  setup = await createTestRenderer({ width: 28, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const tableLines = setup.captureCharFrame().split("\n")
    .filter((line) => /[│┌├└]/.test(line));
  const expected = tableRulePositions(tableLines[0] ?? "");
  expect(expected).toHaveLength(3);
  for (const line of tableLines) {
    expect(tableRulePositions(line)).toEqual(expected);
  }
});

test("renders frontmatter as a distinct metadata panel", async () => {
  const document = parseMarkdownDiff(`diff --git a/note.md b/note.md
--- a/note.md
+++ b/note.md
@@ -1,7 +1,6 @@
 ---
-title: Old title
+title: New title
 author: Sho
-tags:
-  - cli
+status: draft
 ---
 # Note
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).not.toContain("---");
  expect(text).not.toContain("┌");
  expect(text).toContain("│ ~ title");
  expect(text).toContain("Old → New title");
  expect(text).toContain("│ − tags");
  expect(text).toContain("│ + status");
  expect(text).toContain("Note");
});

function tableRulePositions(line: string): number[] {
  const positions: number[] = [];
  let prefix = "";
  for (const character of line) {
    if ("│┌┬┐├┼┤└┴┘".includes(character)) {
      positions.push(stringWidth(prefix));
    }
    prefix += character;
  }
  return positions;
}

test("renders br tags as line breaks in paragraphs and table cells", async () => {
  const document = parseMarkdownDiff(`diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -1,4 +1,4 @@
 first<br>second<BR />third<br>
 fourth \`<br>\`
${" "}
-| x<br>y | z |
+| x<br>w | z |
`);
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const lines = setup.captureCharFrame().split("\n").map((line) => line.trimEnd());
  const first = lines.indexOf("  first");
  expect(lines.slice(first, first + 4)).toEqual(["  first", "  second", "  third", "  fourth <br>"]);
  expect(lines.some((line) => /│ ~ x\s+│ z │/.test(line))).toBe(true);
  expect(lines.some((line) => /│ y → w\s+│\s+│/.test(line))).toBe(true);
});

test("renders a Markdown document without diff markers", async () => {
  const document = {
    files: [parseMarkdownDocument(null, "# Title\n\nIntro with **bold**.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n")],
  };
  setup = await createTestRenderer({ width: 80, height: 30 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  const text = setup.captureCharFrame();
  expect(text).not.toContain("@@");
  expect(text).not.toContain("**");
  expect(text).toContain("Intro with bold.");
  expect(text).toContain("const x = 1;");
  expect(text.split("\n").map((line) => line.trim()).find((line) => line.length > 0)).toBe("Title");

  const backgrounds = setup.captureSpans().lines.flatMap((line) => line.spans).map((span) => span.bg.toInts().join(","));
  expect(backgrounds).not.toContain("50,28,31,255");
  expect(backgrounds).not.toContain("18,38,30,255");
});

test("searches with / and moves between matches with n and N", async () => {
  const filler = Array.from({ length: 30 }, (_, index) => `Filler paragraph ${index}.`).join("\n\n");
  const document = { files: [parseMarkdownDocument("guide.md", `First Needle here.\n\n${filler}\n\nSecond needle there.\n`)] };
  setup = await createTestRenderer({ width: 60, height: 12 });

  const viewer = buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  await setup.mockInput.typeText("/needle");
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("/needle");
  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();

  expect(viewer.scroll.scrollTop).toBeGreaterThan(0);
  expect(setup.captureCharFrame()).toContain("/needle  1/2");
  const firstRow = setup.captureCharFrame().split("\n").find((line) => line.includes("First Needle here."));
  expect(firstRow).toBeDefined();

  setup.mockInput.pressKey("n");
  await setup.waitForVisualIdle();
  let frame = setup.captureCharFrame();
  expect(frame).toContain("Second needle there.");
  expect(frame).toContain("/needle  2/2");
  const highlighted = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "needle");
  expect(highlighted?.bg.toInts()).toEqual([200, 150, 60, 255]);

  setup.mockInput.pressKey("n");
  await setup.waitForVisualIdle();
  frame = setup.captureCharFrame();
  expect(frame).toContain("First Needle here.");
  expect(frame).toContain("/needle  1/2  (wrapped)");

  setup.mockInput.pressKey("n", { shift: true });
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("/needle  2/2  (wrapped)");
});

test("keeps typed keys in the search prompt and cancels it with Escape", async () => {
  const document = { files: [parseMarkdownDocument("guide.md", "Only text.\n")] };
  setup = await createTestRenderer({ width: 60, height: 10 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();

  await setup.mockInput.typeText("/qjk");
  await setup.waitForVisualIdle();
  expect(setup.renderer.isDestroyed).toBe(false);
  expect(setup.captureCharFrame()).toContain("/qjk");

  setup.mockInput.pressKey("ESCAPE");
  await Bun.sleep(100);
  await setup.renderOnce();
  expect(setup.renderer.isDestroyed).toBe(false);
  expect(setup.captureCharFrame()).toContain("/ search");

  setup.mockInput.typeText("/missing");
  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("Pattern not found: missing");
});

test("finds a pasted phrase that the renderer wrapped across lines", async () => {
  const document = { files: [parseMarkdownDocument("guide.md", "The cache keeps search results so that repeated queries return quickly.\n")] };
  setup = await createTestRenderer({ width: 30, height: 12 });

  buildDiffViewer(setup.renderer, document);
  await setup.renderOnce();
  await setup.waitForVisualIdle();

  await setup.mockInput.pasteBracketedText("x");
  await setup.mockInput.typeText("/");
  await setup.mockInput.pasteBracketedText("search\nresults");
  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();
  expect(setup.captureCharFrame()).toContain("/search results  1/1");
});
