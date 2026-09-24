import { describe, expect, test } from "bun:test";

import { alignBySimilarity, deletionsFirst, diffReadable, textSimilarity, type InlineChange } from "../src/inline-diff.ts";

function marked(changes: readonly InlineChange[]): string {
  return changes.map((change) =>
    change.kind === "context"
      ? change.value
      : change.kind === "deletion"
        ? `[-${change.value}-]`
        : `{+${change.value}+}`
  ).join("");
}

describe("diffReadable", () => {
  test("keeps small edits inside a sentence inline", () => {
    expect(marked(diffReadable(
      "この機能は来週リリースされる予定です。キャッシュはメモリに保持する。",
      "この機能は来週リリースする予定です。キャッシュはRedisに保持する。",
    ))).toBe("この機能は来週リリース[-される-]{+する+}予定です。キャッシュは[-メモリ-]{+Redis+}に保持する。");
  });

  test("replaces a heavily rewritten sentence as a whole while keeping its unchanged edges", () => {
    expect(marked(diffReadable(
      "報告したが、実際には差分ゼロだった。その間に人間が修正を適用し、別のワーカーが CI の失敗を直しており、head は 3 世代古かった。",
      "報告の後に人間が修正を適用したり、別のワーカーが CI を直したりしていれば、head は数世代古い。",
    ))).toBe(
      "[-報告したが、実際には差分ゼロだった。その間に人間が修正を適用し、別のワーカーが CI の失敗を直しており、head は 3 世代古かった-]"
        + "{+報告の後に人間が修正を適用したり、別のワーカーが CI を直したりしていれば、head は数世代古い+}。",
    );
  });

  test("does not end a sentence at a soft line break", () => {
    expect(marked(diffReadable(
      "曖昧なまま進んでいたら、\n不可逆な書き込みを無承認で実行していた。",
      "曖昧なまま進めると、\n不可逆な書き込みを無承認で実行する。",
    ))).toBe("曖昧なまま[-進んでいたら-]{+進めると+}、\n不可逆な書き込みを無承認で実行[-していた-]{+する+}。");
  });

  test("reconstructs both sides exactly", () => {
    const oldText = "A  first sentence here. Another one that changes a lot today.";
    const newText = "A first sentence here. Something else entirely different now.";
    const changes = diffReadable(oldText, newText);
    expect(changes.map((change) => change.kind === "context" ? change.oldValue : change.kind === "deletion" ? change.value : "").join(""))
      .toBe(oldText);
    expect(changes.map((change) => change.kind === "deletion" ? "" : change.value).join("")).toBe(newText);
  });
});

describe("alignBySimilarity", () => {
  const similarity = (oldItem: string | undefined, newItem: string | undefined) =>
    oldItem === undefined || newItem === undefined ? 0 : textSimilarity(oldItem, newItem);

  test("prefers one exact match over several similar ones", () => {
    expect(alignBySimilarity(
      ["Alpha beta gamma delta.", "Alpha beta gamma epsilon."],
      ["Alpha beta gamma changed.", "Alpha beta gamma delta."],
      similarity,
    )).toEqual([
      { new: "Alpha beta gamma changed." },
      { old: "Alpha beta gamma delta.", new: "Alpha beta gamma delta." },
      { old: "Alpha beta gamma epsilon." },
    ]);
  });

  test("stays fast for thousands of nearly identical sentences", () => {
    const started = performance.now();
    diffReadable("A. ".repeat(2000), `${"A. ".repeat(1999)}B.`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("deletionsFirst", () => {
  test("moves removals ahead of additions between matched items", () => {
    expect(deletionsFirst([
      { old: "a", new: "a" },
      { old: "b" },
      { new: "x" },
      { old: "c" },
      { old: "d", new: "d" },
    ])).toEqual([
      { old: "a", new: "a" },
      { old: "b" },
      { old: "c" },
      { new: "x" },
      { old: "d", new: "d" },
    ]);
  });
});
