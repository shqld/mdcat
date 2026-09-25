import { describe, expect, test } from "bun:test";

import { diffToMarkdown, isUnifiedDiff, parseMarkdownDiff, parseMarkdownDocument, type MarkdownDiffBlock } from "../src/diff.ts";
import type { FlowLeaf } from "../src/flow.ts";

function markdown(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("diffToMarkdown", () => {
  test("renders additions, deletions, and context as distinct rich Markdown", () => {
    const input = `diff --git a/guide.md b/guide.md
index 1111111..2222222 100644
--- a/guide.md
+++ b/guide.md
@@ -1,4 +1,4 @@
 # Guide
${" "}
-Old text
+New text
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `guide.md`",
        "",
        "# Guide",
        "",
        "> 🔴 **Removed**",
        ">",
        "> Old text",
        "",
        "> 🟢 **Added**",
        ">",
        "> New text",
      ),
    );
  });

  test("ignores non-Markdown files in a multi-file diff", () => {
    const input = `diff --git a/source.ts b/source.ts
--- a/source.ts
+++ b/source.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1 +1 @@
-# Before
+# After
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `docs/readme.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> # Before",
        "",
        "> 🟢 **Added**",
        ">",
        "> # After",
      ),
    );
  });

  test("separates files and describes omitted ranges", () => {
    const input = `diff --git a/one.md b/one.md
--- a/one.md
+++ b/one.md
@@ -5,2 +5,2 @@
-before
+after
 context
@@ -20 +20 @@
-old
+new
diff --git a/two.md b/two.md
new file mode 100644
--- /dev/null
+++ b/two.md
@@ -0,0 +1,2 @@
+# Two
+body
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `one.md`",
        "",
        "*… 4 unchanged lines omitted …*",
        "",
        "> 🔴 **Removed**",
        ">",
        "> before",
        "",
        "> 🟢 **Added**",
        ">",
        "> after",
        "",
        "context",
        "",
        "---",
        "",
        "*… 13 unchanged lines omitted …*",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old",
        "",
        "> 🟢 **Added**",
        ">",
        "> new",
        "",
        "# `two.md`",
        "",
        "> 🟢 **Added**",
        ">",
        "> # Two",
        "> body",
      ),
    );
  });

  test("renders deleted Markdown from the old side", () => {
    const input = `diff --git a/old.md b/old.md
deleted file mode 100644
--- a/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Old
-body
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `old.md` · deleted",
        "",
        "> 🔴 **Removed**",
        ">",
        "> # Old",
        "> body",
      ),
    );
  });

  test("strips ANSI color sequences", () => {
    const input = `\u001B[1mdiff --git a/a.md b/a.md\u001B[m
\u001B[31m--- a/a.md\u001B[m
\u001B[32m+++ b/a.md\u001B[m
\u001B[36m@@ -1 +1 @@\u001B[m
\u001B[31m-old\u001B[m
\u001B[32m+new\u001B[m
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `a.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old",
        "",
        "> 🟢 **Added**",
        ">",
        "> new",
      ),
    );
  });

  test("accepts a unified diff without Git metadata", () => {
    const input = `--- a/note.md
+++ b/note.md
@@ -1 +1 @@
-old
+new
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `note.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old",
        "",
        "> 🟢 **Added**",
        ">",
        "> new",
      ),
    );
  });

  test("separates multiple generic unified diffs", () => {
    const input = `--- a/one.md
+++ b/one.md
@@ -1 +1 @@
-old one
+new one
--- a/two.md
+++ b/two.md
@@ -1 +1 @@
-old two
+new two
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `one.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old one",
        "",
        "> 🟢 **Added**",
        ">",
        "> new one",
        "",
        "# `two.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old two",
        "",
        "> 🟢 **Added**",
        ">",
        "> new two",
      ),
    );
  });

  test("decodes Git quoted UTF-8 paths", () => {
    const input = `diff --git "a/\\346\\227\\245\\346\\234\\254.md" "b/\\346\\227\\245\\346\\234\\254.md"
--- "a/\\346\\227\\245\\346\\234\\254.md"
+++ "b/\\346\\227\\245\\346\\234\\254.md"
@@ -1 +1 @@
-old
+new
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `日本.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> old",
        "",
        "> 🟢 **Added**",
        ">",
        "> new",
      ),
    );
  });

  test("preserves rich Markdown syntax inside changed blocks", () => {
    const input = `diff --git a/code.md b/code.md
--- a/code.md
+++ b/code.md
@@ -1 +1,2 @@
-## Old *heading*
+## New **heading**
+- item
`;

    expect(diffToMarkdown(input)).toBe(
      markdown(
        "# `code.md`",
        "",
        "> 🔴 **Removed**",
        ">",
        "> ## Old *heading*",
        "",
        "> 🟢 **Added**",
        ">",
        "> ## New **heading**",
        "> - item",
      ),
    );
  });
});

describe("parseMarkdownDiff", () => {
  test("preserves hunk metadata and flows Markdown blocks", () => {
    const input = `diff --git a/guide.md b/guide.md
--- a/guide.md
+++ b/guide.md
@@ -5,4 +5,4 @@
 # Guide
${" "}
-Old **text**
+Something else entirely
`;

    const [file] = parseMarkdownDiff(input).files;
    expect(file).toMatchObject({ path: "guide.md", status: "modified" });
    expect(file?.hunks[0]).toMatchObject({ oldStart: 5, oldLength: 4, newStart: 5, newLength: 4, omittedBefore: 4 });
    expect(flowOf(`@@ -5,4 +5,4 @@
 # Guide
${" "}
-Old **text**
+Something else entirely
`)).toEqual([
      "# context: Guide",
      "paragraph deletion: Old **text**",
      "paragraph addition: Something else entirely",
    ]);
  });

  test("keeps changed Markdown tables valid on both sides", () => {
    const input = `diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,4 +1,4 @@
 | ID | Value |
 | --- | --- |
-| item | Before |
+| item | After |
 | Same | 3 |
`;

    expect(parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks).toEqual([{
      type: "table",
      rows: [
        { kind: "context", header: true, cells: ["ID", "Value"] },
        {
          kind: "modification",
          header: false,
          oldCells: ["item", "Before"],
          newCells: ["item", "After"],
        },
        { kind: "context", header: false, cells: ["Same", "3"] },
      ],
    }]);
  });

  test("keeps unmatched table rows as additions and deletions", () => {
    const input = `diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,5 +1,5 @@
 | Name | Value |
 | --- | --- |
-| id | Before |
-| Removed | 1 |
+| id | After |
 | Same | 2 |
+| Added | 3 |
`;

    expect(parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks).toEqual([{
      type: "table",
      rows: [
        { kind: "context", header: true, cells: ["Name", "Value"] },
        {
          kind: "modification",
          header: false,
          oldCells: ["id", "Before"],
          newCells: ["id", "After"],
        },
        { kind: "deletion", header: false, cells: ["Removed", "1"] },
        { kind: "context", header: false, cells: ["Same", "2"] },
        { kind: "addition", header: false, cells: ["Added", "3"] },
      ],
    }]);
  });

  test("does not pair completely different replacement rows", () => {
    const input = `diff --git a/table.md b/table.md
--- a/table.md
+++ b/table.md
@@ -1,3 +1,3 @@
 | Name | Value |
 | --- | --- |
-| Removed | 1 |
+| Added | 2 |
`;

    expect(parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks).toEqual([{
      type: "table",
      rows: [
        { kind: "context", header: true, cells: ["Name", "Value"] },
        { kind: "deletion", header: false, cells: ["Removed", "1"] },
        { kind: "addition", header: false, cells: ["Added", "2"] },
      ],
    }]);
  });

  test("parses frontmatter as metadata instead of Markdown content", () => {
    const input = `diff --git a/note.md b/note.md
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
`;

    expect(parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks[0]).toEqual({
      type: "frontmatter",
      rows: [
        { kind: "modification", key: "title", oldValue: "Old title", newValue: "New title" },
        { kind: "context", key: "author", value: "Sho" },
        { kind: "deletion", key: "tags", value: "cli" },
        { kind: "addition", key: "status", value: "draft" },
      ],
    });
  });

  test("pairs a rewritten paragraph as an inline modification", () => {
    expect(flowOf(`@@ -1,3 +1,3 @@
 # Guide
${" "}
-This feature will be released next week.
+This feature ships next week.
`)).toEqual([
      "# context: Guide",
      "paragraph modification: This feature will be released next week. → This feature ships next week.",
    ]);
  });

  test("expands a changed line to its whole hard-wrapped paragraph", () => {
    expect(flowOf(`@@ -1,4 +1,4 @@
 First line of the paragraph
-second line before
+second line after
 third line
${" "}
`)).toEqual([
      "paragraph modification: First line of the paragraph\nsecond line before\nthird line"
        + " → First line of the paragraph\nsecond line after\nthird line",
    ]);
  });

  test("pairs paragraphs inside one change run and keeps unmatched ones whole", () => {
    expect(flowOf(`@@ -1,3 +1,5 @@
-The cache is stored in memory.
-
-Old closing remark.
+The cache is stored in Redis.
+
+Old closing remark, revised.
+
+A brand new paragraph.
`)).toEqual([
      "paragraph modification: The cache is stored in memory. → The cache is stored in Redis.",
      "paragraph modification: Old closing remark. → Old closing remark, revised.",
      "paragraph addition: A brand new paragraph.",
    ]);
  });

  test("pairs list items and diffs their text inline", () => {
    expect(flowOf(`@@ -1,3 +1,4 @@
 Settings:
 - Target: search results
-- TTL: 5 min
+- TTL: 10 min
+- Store: Redis
`)).toEqual([
      "paragraph context: Settings:",
      "- paragraph context: Target: search results",
      "- paragraph modification: TTL: 5 min → TTL: 10 min",
      "- paragraph addition: Store: Redis",
    ]);
  });

  test("keeps ordinals of the side each list item comes from", () => {
    expect(flowOf(`@@ -3,2 +3,2 @@
-3. Old step
+3. New step
 4. Last step
`)).toEqual([
      "3. paragraph modification: Old step → New step",
      "4. paragraph context: Last step",
    ]);
  });

  test("diffs nested list items inline and keeps checkbox toggles as whole rows", () => {
    expect(flowOf(`@@ -1,4 +1,4 @@
 - Parent item
   - Child item A
-  - Child item B has an old description
+  - Child item B has a new description
`)).toEqual([
      "- paragraph context: Parent item",
      "- - paragraph context: Child item A",
      "- - paragraph modification: Child item B has an old description → Child item B has a new description",
    ]);
    expect(flowOf(`@@ -1 +1 @@
-- [ ] write tests
+- [x] write tests
`)).toEqual([
      "[ ] paragraph deletion: write tests",
      "[x] paragraph addition: write tests",
    ]);
  });

  test("treats inline style changes as unchanged", () => {
    expect(flowOf(`@@ -1,3 +1,3 @@
-The **cache** keeps *recent* entries.
+The cache keeps recent entries.
 - item
`)).toEqual([
      "paragraph context: The cache keeps recent entries.",
      "- paragraph context: item",
    ]);
    expect(flowOf(`@@ -1 +1 @@
-# **Title**
+# Title
`)).toEqual(["# context: Title"]);
    expect(flowOf(`@@ -1 +1 @@
-See [docs](old.md).
+See [docs](new.md).
`)).toEqual(["paragraph modification: See [docs](old.md). → See [docs](new.md)."]);
  });

  test("treats whitespace-only changes as unchanged", () => {
    expect(flowOf(`@@ -1,4 +1,5 @@
-Trailing space here${"  "}
-and a reflowed
-line
+Trailing space here
+and a reflowed line
+
 - item
+${"   "}
`)).toEqual([
      "paragraph context: Trailing space here\nand a reflowed line",
      "- paragraph context: item",
    ]);
  });

  test("ignores whitespace-only table cell changes", () => {
    const table = blocksOf(`@@ -1,3 +1,3 @@
 | ID | Value |
 | --- | --- |
-| a b | 1 |
+| ab  |   1 |
`)?.[0];
    expect(table).toEqual({
      type: "table",
      rows: [
        { kind: "context", header: true, cells: ["ID", "Value"] },
        { kind: "context", header: false, cells: ["ab", "1"] },
      ],
    });
  });
});

describe("word diff input", () => {
  const unified = `@@ -1,8 +1,8 @@
 # T
${" "}
 - a
-- b
+- c
${" "}
-この機能は来週リリースされる予定です。
+この機能は来週リリースする予定です。
 x
`;

  test("parses git --word-diff=plain output", () => {
    expect(blocksOf(`@@ -1,8 +1,8 @@
# T

- a
- [-b-]{+c+}

この機能は来週リリース[-され-]{+す+}る予定です。
x
`)).toEqual(blocksOf(unified));
  });

  test("parses git --word-diff=porcelain output", () => {
    expect(blocksOf(`@@ -1,8 +1,8 @@
 # T
~
${" "}
~
 - a
~
 - ${""}
-b
+c
~
${" "}
~
 この機能は来週リリース
-され
+す
 る予定です。
~
 x
~
`)).toEqual(blocksOf(unified));
  });

  test("treats a whole-line word diff as a removed and an added line", () => {
    expect(flowOf(`@@ -1,3 +1,4 @@
Intro

[-Old stuff.-]
{+Brand new text.+}
{+More words.+}
`)).toEqual([
      "paragraph context: Intro",
      "paragraph deletion: Old stuff.",
      "paragraph addition: Brand new text.\nMore words.",
    ]);
  });
});

describe("word diff edge cases", () => {
  test("keeps reading a porcelain hunk after its line counts are consumed", () => {
    expect(flowOf(`@@ -1 +1 @@
 hello${" "}
-old
+new
${"  "}world
~
`)).toEqual(["paragraph modification: hello old world → hello new world"]);
  });

  test("reads a plain hunk whose only line starts with a space", () => {
    expect(flowOf(`@@ -1 +1 @@
 indented [-old-]{+new+}
`)).toEqual(["paragraph modification:  indented old →  indented new"]);
  });

  test("keeps blank lines between removed lines inside the removal", () => {
    expect(flowOf(`@@ -1,3 +0,0 @@
[-First removed paragraph.-]

[-Second removed paragraph.-]
`)).toEqual([
      "paragraph deletion: First removed paragraph.",
      "paragraph deletion: Second removed paragraph.",
    ]);
  });

  test("does not mistake a tilde line in plain output for porcelain", () => {
    expect(flowOf(`@@ -1,2 +1,2 @@
~
[-old-]{+new+} text
`)).toEqual(["paragraph modification: ~\nold text → ~\nnew text"]);
  });
});

describe("whitespace and similarity edge cases", () => {
  test("keeps blank lines at the edge of a change out of the diff", () => {
    expect(flowOf(`@@ -1,2 +1,2 @@
-# old
-${"   "}
+# new
+
`)).toEqual(["# deletion: old", "# addition: new"]);
  });

  test("measures paragraph similarity on visible text", () => {
    expect(flowOf(`@@ -1 +1 @@
-**cat**
+**dog**
`)).toEqual(["paragraph deletion: **cat**", "paragraph addition: **dog**"]);
  });
});

describe("review regressions", () => {
  test("prefers an exact later match over a similar current item", () => {
    expect(flowOf(`@@ -1 +1,2 @@
-- Release
+- Release candidate
+- Release
`)).toEqual(["- paragraph addition: Release candidate", "- paragraph context: Release"]);
  });

  test("attaches a blank word-diff line next to a replaced line to the removal", () => {
    expect(blocksOf(`@@ -1,3 +1 @@
[-Old A-]

[-Old B-]{+X+}
`)).toEqual(blocksOf(`@@ -1,3 +1 @@
-Old A
-
-Old B
+X
`));
  });

  test("keeps link definition and nested code changes as diffs", () => {
    expect(flowOf(`@@ -1 +1 @@
-[x]: /docs/*a*
+[x]: /docs/a
`)).toEqual(["raw deletion: [x]: /docs/*a*", "raw addition: [x]: /docs/a"]);
    expect(flowOf(`@@ -1 +1 @@
->     **bold**
+>     bold
`)).toEqual(["> raw deletion:     **bold**", "> raw addition:     bold"]);
  });
});

describe("partial tables", () => {
  test("renders table rows without a header as a table", () => {
    expect(blocksOf(`@@ -10,2 +10,3 @@
 | **What to escalate** | **reviewer** |
+| **Whether records match reality** — guard | **checker** |
 | **Local decisions** | **author** decides |
`)).toEqual([{
      type: "table",
      rows: [
        { kind: "context", header: false, cells: ["**What to escalate**", "**reviewer**"] },
        { kind: "addition", header: false, cells: ["**Whether records match reality** — guard", "**checker**"] },
        { kind: "context", header: false, cells: ["**Local decisions**", "**author** decides"] },
      ],
    }]);
  });

  test("pairs edited rows of a partial table", () => {
    expect(blocksOf(`@@ -10,2 +10,2 @@
-| item | Before |
+| item | After |
 | other | 3 |
`)).toEqual([{
      type: "table",
      rows: [
        { kind: "modification", header: false, oldCells: ["item", "Before"], newCells: ["item", "After"] },
        { kind: "context", header: false, cells: ["other", "3"] },
      ],
    }]);
  });

  test("does not treat prose containing a pipe as a table", () => {
    expect(flowOf(`@@ -1 +1 @@
-Use a | b to pipe.
+Use a | c to pipe.
`)).toEqual(["paragraph modification: Use a | b to pipe. → Use a | c to pipe."]);
  });
});

describe("headings, quotes, and code blocks", () => {
  test("pairs headings of the same level", () => {
    expect(flowOf(`@@ -1 +1 @@
-## Cache design
+## Storage design
`)).toEqual(["## modification: Cache design → Storage design"]);
    expect(flowOf(`@@ -1 +1 @@
-## Cache design
+### Cache design
`)).toEqual(["## deletion: Cache design", "### addition: Cache design"]);
  });

  test("pairs paragraphs inside a quote", () => {
    expect(flowOf(`@@ -1,3 +1,3 @@
 > First paragraph.
 >
-> The cache is stored in memory.
+> The cache is stored in Redis.
`)).toEqual(["> paragraph context: First paragraph.", "> paragraph modification: The cache is stored in memory. → The cache is stored in Redis."]);
  });

  test("diffs fenced code blocks line by line, including blank lines inside", () => {
    expect(blocksOf(`@@ -1,7 +1,7 @@
 \`\`\`ts
 const ttl = 5;
${" "}
-const store = "memory";
+const store = "redis";
 const  unchanged = 1;
 \`\`\`
`)).toEqual([{
      type: "code",
      language: "ts",
      lines: [
        { kind: "context", text: "const ttl = 5;" },
        { kind: "context", text: "" },
        { kind: "deletion", text: "const store = \"memory\";" },
        { kind: "addition", text: "const store = \"redis\";" },
        { kind: "context", text: "const  unchanged = 1;" },
      ],
    }]);
  });

  test("does not read table-looking lines inside code as a table", () => {
    expect(blocksOf(`@@ -1,4 +1,4 @@
 \`\`\`
-| a | b |
+| a | c |
 \`\`\`
`)?.[0]).toMatchObject({ type: "code" });
  });
});

describe("code block and partial table review regressions", () => {
  test("keeps a code block whose opening fence changed", () => {
    expect(blocksOf(`@@ -1,3 +1,3 @@
-\`\`\`js
-| a | b |
+\`\`\`ts
+| a | c |
 \`\`\`
`)).toEqual([{
      type: "code",
      language: "ts",
      lines: [
        { kind: "deletion", text: "\`\`\`js" },
        { kind: "deletion", text: "| a | b |" },
        { kind: "addition", text: "\`\`\`ts" },
        { kind: "addition", text: "| a | c |" },
      ],
    }]);
  });

  test("does not close a fence on a line indented four spaces", () => {
    expect(blocksOf(`@@ -1,4 +1,4 @@
 \`\`\`
     \`\`\`
-| a | b |
+| a | c |
 \`\`\`
`)?.[0]).toMatchObject({ type: "code" });
  });

  test("ignores whitespace-only code line changes next to real ones", () => {
    expect(blocksOf(`@@ -1,4 +1,4 @@
 \`\`\`ts
-const  a = 1;
-const b = 2;
+const a = 1;
+const b = 3;
 \`\`\`
`)?.[0]).toEqual({
      type: "code",
      language: "ts",
      lines: [
        { kind: "context", text: "const a = 1;" },
        { kind: "deletion", text: "const b = 2;" },
        { kind: "addition", text: "const b = 3;" },
      ],
    });
  });

  test("reads partial tables without leading pipes when rows agree on columns", () => {
    expect(blocksOf(`@@ -10,2 +10,2 @@
-name | old
+name | new
 other | 3
`)?.[0]).toMatchObject({ type: "table" });
  });
});

describe("flow review regressions", () => {
  test("does not merge two old list items into one new item", () => {
    const [flow] = blocksOf(`@@ -1,2 +1,3 @@
 - Alpha
-- Beta
+
+  Beta
`) ?? [];
    expect(flow?.type === "flow" ? flow.leaves.map((leaf) => [leaf.path[0]?.id, describeLeaf(leaf)]) : []).toEqual([
      [expect.any(Number), "- paragraph context: Alpha"],
      [expect.any(Number), "- paragraph deletion: Beta"],
      [expect.any(Number), "- paragraph addition: Beta"],
    ]);
    const ids = flow?.type === "flow" ? flow.leaves.map((leaf) => leaf.path[0]?.id) : [];
    expect(ids[1]).not.toBe(ids[0]);
    expect(ids[2]).toBe(ids[0]);
  });

  test("keeps details inside list items and quotes", () => {
    expect(flowOf(`@@ -1,6 +1,6 @@
 - Parent
   <details>
   <summary>Notes</summary>
${" "}
-  The body is old.
+  The body is new.
   </details>
`)).toEqual([
      "- paragraph context: Parent",
      "- details tag context: <details>",
      "- details summary context: Notes",
      "- details paragraph modification: The body is old. → The body is new.",
    ]);
    expect(flowOf(`@@ -1,5 +1,5 @@
 > Quote
 > <details>
 > <summary>S</summary>
 >
-> Old body.
+> New body.
 > </details>
`)).toEqual([
      "> paragraph context: Quote",
      "> details tag context: <details>",
      "> details summary context: S",
      "> details paragraph modification: Old body. → New body.",
    ]);
  });

  test("pairs a changed details summary instead of moving it into the body", () => {
    expect(flowOf(`@@ -1,5 +1,5 @@
 <details>
-<summary>Alpha</summary>
+<summary>Omega</summary>
${" "}
 Same body.
 </details>
`)).toEqual([
      "details tag context: <details>",
      "details summary modification: Alpha → Omega",
      "details paragraph context: Same body.",
    ]);
  });

  test("reports details attribute changes", () => {
    expect(flowOf(`@@ -1,4 +1,4 @@
-<details open>
+<details>
 <summary>Notes</summary>
 Body
 </details>
`)).toEqual([
      "details tag modification: <details open> → <details>",
      "details summary context: Notes",
      "details paragraph context: Body",
    ]);
  });
});

describe("comments", () => {
  test("diffs HTML comments like paragraphs without reading Markdown inside", () => {
    expect(flowOf(`@@ -1,3 +1,3 @@
 A paragraph.
${" "}
-<!-- TODO: **write** the old note -->
+<!-- TODO: **write** the new note -->
`)).toEqual([
      "paragraph context: A paragraph.",
      "comment modification: TODO: **write** the old note → TODO: **write** the new note",
    ]);
    expect(flowOf(`@@ -1,4 +1,4 @@
 - item
   <!--
-  multi line old
+  multi line new
   -->
`)).toEqual([
      "- paragraph context: item",
      "- comment modification: multi line old → multi line new",
    ]);
  });

  test("does not read details tags inside a comment", () => {
    expect(flowOf(`@@ -1 +1 @@
-<!-- <details> **old** </details> -->
+<!-- <details> **new** </details> -->
`)).toEqual(["comment modification: <details> **old** </details> → <details> **new** </details>"]);
  });

  test("keeps markup-only comment changes as diffs", () => {
    expect(flowOf(`@@ -1 +1 @@
-<!-- **note** -->
+<!-- note -->
`)).toEqual(["comment modification: **note** → note"]);
  });
});

describe("code block context from the whole file", () => {
  const oldFile = "# Title\n\n```\napp/src/job\n      → insert\n```\n\nThe old description.\n\n## What to verify\n";
  const newFile = "# Title\n\n```\napp/src/job\n      → insert\n```\n\nThe new description.\n\n## What to verify\n";
  const hunk = `@@ -5,6 +5,6 @@
       → insert
 \`\`\`
${" "}
-The old description.
+The new description.
${" "}
 ## What to verify
`;
  const input = `diff --git a/doc.md b/doc.md
index 1111111..2222222 100644
--- a/doc.md
+++ b/doc.md
${hunk}`;

  test("reads the fence state before the hunk from the files", () => {
    const blocks = parseMarkdownDiff(input, (blob) => blob === "1111111" ? oldFile : blob === "2222222" ? newFile : null)
      .files[0]?.hunks[0]?.blocks;
    expect(blocks?.map((block) => block.type === "flow" ? block.leaves.map(describeLeaf) : block)).toEqual([
      { type: "code", language: "", lines: [{ kind: "context", text: "      → insert" }] },
      ["paragraph modification: The old description. → The new description.", "## context: What to verify"],
    ]);
  });

  test("shows the hunk as plain lines when the files cannot be read and fences are ambiguous", () => {
    expect(parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks).toEqual([{
      type: "code",
      language: "",
      lines: [
        { kind: "context", text: "      → insert" },
        { kind: "context", text: "```" },
        { kind: "context", text: "" },
        { kind: "deletion", text: "The old description." },
        { kind: "addition", text: "The new description." },
        { kind: "context", text: "" },
        { kind: "context", text: "## What to verify" },
      ],
    }]);
  });

  test("keeps whitespace-only lines in the plain fallback", () => {
    expect(blocksOf(`@@ -2,2 +2,2 @@
-alpha beta
+alpha  beta
 \`\`\`
`)).toEqual([{
      type: "code",
      language: "",
      lines: [
        { kind: "deletion", text: "alpha beta" },
        { kind: "addition", text: "alpha  beta" },
        { kind: "context", text: "\`\`\`" },
      ],
    }]);
  });

  test("hides opener changes that keep the language", () => {
    expect(blocksOf(`@@ -1,3 +1,3 @@
-\`\`\`js old-meta
+\`\`\`js new-meta
 const a = 1;
 \`\`\`
`)).toEqual([{ type: "code", language: "js", lines: [{ kind: "context", text: "const a = 1;" }] }]);
  });

  test("hides the fences of an added code block", () => {
    expect(blocksOf(`@@ -0,0 +1,3 @@
+\`\`\`bash
+echo hi
+\`\`\`
`)).toEqual([{ type: "code", language: "bash", lines: [{ kind: "addition", text: "echo hi" }] }]);
  });
});

function blocksOf(hunk: string): readonly MarkdownDiffBlock[] | undefined {
  const input = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
${hunk}`;
  return parseMarkdownDiff(input).files[0]?.hunks[0]?.blocks;
}

function flowOf(hunk: string): readonly string[] {
  return (blocksOf(hunk) ?? []).flatMap((block) =>
    block.type === "flow" ? block.leaves.map(describeLeaf) : [block.type]
  );
}

function describeLeaf(leaf: FlowLeaf): string {
  const path = leaf.path.map((container) => {
    if (container.type !== "item") {
      return container.type === "quote" ? ">" : "details";
    }
    if (container.task) {
      return container.checked ? "[x]" : "[ ]";
    }
    return container.ordered ? `${container.ordinal}.` : "-";
  });
  const type = leaf.type === "heading" ? "#".repeat(leaf.depth) : leaf.type;
  const prefix = [...path, type].join(" ");
  if (leaf.type === "raw") {
    return `${prefix} ${leaf.kind}: ${leaf.source}`;
  }
  const text = leaf.text;
  return `${prefix} ${text.kind}: ${text.kind === "modification" ? `${text.oldText} → ${text.newText}` : text.text}`;
}

describe("Markdown documents", () => {
  test("detects a diff by its hunks, including colored and word diff input", () => {
    expect(isUnifiedDiff("diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n")).toBe(true);
    expect(isUnifiedDiff("\u001B[1mdiff --git a/x.md b/x.md\u001B[m\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n[-a-]{+b+}\n")).toBe(true);
    expect(isUnifiedDiff("# Title\n\n---\n\ntext\n")).toBe(false);
    expect(isUnifiedDiff("diff --git a/x.md b/x.md\n")).toBe(false);
  });

  test("reads a whole document as unchanged blocks, starting outside code and frontmatter", () => {
    const file = parseMarkdownDocument("doc.md", "---\ntitle: Doc\n---\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(file.status).toBe("unchanged");
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0]?.blocks.map((block) => block.type)).toEqual(["frontmatter", "code", "table"]);
    expect(file.hunks[0]?.newLength).toBe(11);
  });
});
