import { diffArrays } from "diff";
import { Lexer, type Token } from "marked";

export type InlineChange =
  | {
      readonly kind: "context";
      readonly value: string;
      readonly oldValue: string;
    }
  | {
      readonly kind: "addition" | "deletion";
      readonly value: string;
    };

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });
const SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "sentence" });
const WHITESPACE = /\s/g;
const HTML_BREAK = /^<br\s*\/?>$/i;
const SIMILARITY_THRESHOLD = 0.45;
const MAX_CHANGES_PER_SENTENCE = 2;
const MAX_ALIGNMENT_CELLS = 10_000;

export function diffReadable(oldText: string, newText: string): readonly InlineChange[] {
  const changes = alignBySimilarity(segmentSentences(oldText), segmentSentences(newText), sentenceSimilarity)
    .flatMap((pair): readonly InlineChange[] => {
      const oldSentence = pair.old ?? "";
      const newSentence = pair.new ?? "";
      const sentenceChanges = absorbShortContext(diffInline(oldSentence, newSentence));
      return changeRunCount(sentenceChanges) <= MAX_CHANGES_PER_SENTENCE
        ? sentenceChanges
        : collapseChanges(sentenceChanges);
    });
  return groupChanges(changes);
}

function sentenceSimilarity(oldSentence: string | undefined, newSentence: string | undefined): number {
  return oldSentence === undefined || newSentence === undefined ? 0 : textSimilarity(oldSentence, newSentence);
}

function segmentSentences(text: string): readonly string[] {
  const boundaries = Array.from(SENTENCE_SEGMENTER.segment(text.replaceAll("\n", " ")), (segment) => segment.index);
  return boundaries.map((start, index) => text.slice(start, boundaries[index + 1] ?? text.length));
}

function absorbShortContext(changes: readonly InlineChange[]): readonly InlineChange[] {
  let result = groupChanges(changes);
  for (let index = 1; index < result.length - 1; index += 1) {
    const context = result[index];
    if (context?.kind !== "context") {
      continue;
    }
    const before = changeRun(result, index - 1, -1);
    const after = changeRun(result, index + 1, 1);
    const length = visibleLength(context.value);
    if (before > 0 && after > 0 && length <= before && length <= after) {
      result = groupChanges([
        ...result.slice(0, index),
        { kind: "deletion", value: context.oldValue },
        { kind: "addition", value: context.value },
        ...result.slice(index + 1),
      ]);
      index = 0;
    }
  }
  return result;
}

function collapseChanges(changes: readonly InlineChange[]): readonly InlineChange[] {
  const first = changes.findIndex((change) => change.kind !== "context");
  const last = changes.findLastIndex((change) => change.kind !== "context");
  const middle = changes.slice(first, last + 1);
  return [
    ...changes.slice(0, first),
    {
      kind: "deletion",
      value: middle.map((change) => change.kind === "context" ? change.oldValue : change.kind === "deletion" ? change.value : "").join(""),
    },
    {
      kind: "addition",
      value: middle.map((change) => change.kind === "deletion" ? "" : change.value).join(""),
    },
    ...changes.slice(last + 1),
  ];
}

function changeRun(changes: readonly InlineChange[], start: number, step: 1 | -1): number {
  let longest = 0;
  for (let index = start; index >= 0 && index < changes.length; index += step) {
    const change = changes[index];
    if (change === undefined || change.kind === "context") {
      break;
    }
    longest = Math.max(longest, visibleLength(change.value));
  }
  return longest;
}

function changeRunCount(changes: readonly InlineChange[]): number {
  return changes.filter((change, index) =>
    change.kind !== "context" && (index === 0 || changes[index - 1]?.kind === "context")
  ).length;
}

function groupChanges(changes: readonly InlineChange[]): InlineChange[] {
  const result: InlineChange[] = [];
  let deleted = "";
  let added = "";
  function flush(): void {
    if (deleted.length > 0) {
      result.push({ kind: "deletion", value: deleted });
    }
    if (added.length > 0) {
      result.push({ kind: "addition", value: added });
    }
    deleted = "";
    added = "";
  }
  for (const change of changes) {
    if (change.kind !== "context") {
      if (change.kind === "deletion") {
        deleted += change.value;
      } else {
        added += change.value;
      }
    } else {
      flush();
      const last = result.at(-1);
      if (last?.kind === "context") {
        result[result.length - 1] = {
          kind: "context",
          value: last.value + change.value,
          oldValue: last.oldValue + change.oldValue,
        };
      } else if (change.value.length > 0 || change.oldValue.length > 0) {
        result.push(change);
      }
    }
  }
  flush();
  return result;
}

export function diffInline(oldText: string, newText: string): readonly InlineChange[] {
  const changes = diffArrays(segmentWords(oldText), segmentWords(newText));
  const result: InlineChange[] = [];
  let deleted = "";
  let added = "";

  function pushContext(value: string, oldValue: string): void {
    const last = result.at(-1);
    if (last?.kind === "context") {
      result[result.length - 1] = {
        kind: "context",
        value: last.value + value,
        oldValue: last.oldValue + oldValue,
      };
    } else if (value.length > 0 || oldValue.length > 0) {
      result.push({ kind: "context", value, oldValue });
    }
  }

  function flush(): void {
    if (sameIgnoringWhitespace(deleted, added)) {
      pushContext(added, deleted);
    } else {
      if (deleted.length > 0) {
        result.push({ kind: "deletion", value: deleted });
      }
      if (added.length > 0) {
        result.push({ kind: "addition", value: added });
      }
    }
    deleted = "";
    added = "";
  }

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change === undefined) {
      continue;
    }
    const value = change.value.join("");
    if (change.added) {
      added += value;
      continue;
    }
    if (change.removed) {
      deleted += value;
      continue;
    }

    const inChange = deleted.length > 0 || added.length > 0;
    const next = changes[index + 1];
    if (inChange && (next?.added || next?.removed) && !hasWord(value)) {
      deleted += value;
      added += value;
      continue;
    }
    flush();
    pushContext(value, value);
  }
  flush();

  return result;
}

export function textSimilarity(oldText: string, newText: string): number {
  const unchanged = diffInline(oldText, newText)
    .reduce((length, change) => change.kind === "context" ? length + visibleLength(change.value) : length, 0);
  return (2 * unchanged) / Math.max(1, visibleLength(oldText) + visibleLength(newText));
}

export function sameIgnoringWhitespace(oldText: string, newText: string): boolean {
  return oldText.replace(WHITESPACE, "") === newText.replace(WHITESPACE, "");
}

export function sameInlineContent(oldSource: string, newSource: string): boolean {
  if (sameIgnoringWhitespace(oldSource, newSource)) {
    return true;
  }
  const oldTokens = Lexer.lexInline(oldSource, { gfm: true });
  const newTokens = Lexer.lexInline(newSource, { gfm: true });
  return sameIgnoringWhitespace(plainTextFromTokens(oldTokens), plainTextFromTokens(newTokens))
    && linkTargets(oldTokens).join("\n") === linkTargets(newTokens).join("\n");
}

function linkTargets(tokens: readonly Token[]): readonly string[] {
  return tokens.flatMap((token): readonly string[] => [
    ...((token.type === "link" || token.type === "image") && "href" in token && typeof token.href === "string"
      ? [token.href]
      : []),
    ...("tokens" in token && Array.isArray(token.tokens) ? linkTargets(token.tokens) : []),
  ]);
}

export function inlinePlainText(source: string): string {
  return plainTextFromTokens(Lexer.lexInline(source, { gfm: true }));
}

export function plainTextFromTokens(tokens: readonly Token[]): string {
  return tokens.map((token, index) => {
    if ("tokens" in token && Array.isArray(token.tokens)) {
      return plainTextFromTokens(token.tokens);
    }
    const lineBreak = lineBreakText(token, tokens[index + 1]);
    if (lineBreak !== null) {
      return lineBreak;
    }
    return "text" in token && typeof token.text === "string" ? token.text : token.raw;
  }).join("");
}

export function lineBreakText(token: Token, next: Token | undefined): string | null {
  if (token.type === "br") {
    return "\n";
  }
  if (token.type !== "html" || !HTML_BREAK.test(token.raw)) {
    return null;
  }
  return next === undefined || next.raw.startsWith("\n") ? "" : "\n";
}

function visibleLength(text: string): number {
  return text.replace(WHITESPACE, "").length;
}

function segmentWords(text: string): string[] {
  return Array.from(WORD_SEGMENTER.segment(text), (segment) => segment.segment);
}

function hasWord(text: string): boolean {
  return Array.from(WORD_SEGMENTER.segment(text)).some((segment) => segment.isWordLike === true);
}

export interface AlignedPair<T> {
  readonly old?: T;
  readonly new?: T;
}

export function alignBySimilarity<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  similarity: (oldItem: T | undefined, newItem: T | undefined) => number,
  same: (oldItem: T, newItem: T) => boolean = (oldItem, newItem) => oldItem === newItem,
): readonly AlignedPair<T>[] {
  const matches = (oldIndex: number, newIndex: number): boolean => {
    const oldItem = oldItems[oldIndex];
    const newItem = newItems[newIndex];
    return oldItem !== undefined && newItem !== undefined && same(oldItem, newItem);
  };
  let prefix = 0;
  while (prefix < oldItems.length && prefix < newItems.length && matches(prefix, prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldItems.length - prefix && suffix < newItems.length - prefix
    && matches(oldItems.length - 1 - suffix, newItems.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const paired = (oldItem: T, index: number, offset: number): AlignedPair<T> =>
    ({ old: oldItem, new: newItems[offset + index] ?? oldItem });
  return [
    ...oldItems.slice(0, prefix).map((item, index) => paired(item, index, 0)),
    ...deletionsFirst(alignMiddle(
      oldItems.slice(prefix, oldItems.length - suffix),
      newItems.slice(prefix, newItems.length - suffix),
      similarity,
    )),
    ...oldItems.slice(oldItems.length - suffix)
      .map((item, index) => paired(item, index, newItems.length - suffix)),
  ];
}

export function deletionsFirst<T>(pairs: readonly AlignedPair<T>[]): readonly AlignedPair<T>[] {
  const ordered: AlignedPair<T>[] = [];
  let deletions: AlignedPair<T>[] = [];
  let additions: AlignedPair<T>[] = [];
  const flush = (): void => {
    ordered.push(...deletions, ...additions);
    deletions = [];
    additions = [];
  };
  for (const pair of pairs) {
    if (pair.old !== undefined && pair.new !== undefined) {
      flush();
      ordered.push(pair);
    } else if (pair.old !== undefined) {
      deletions.push(pair);
    } else {
      additions.push(pair);
    }
  }
  flush();
  return ordered;
}

function alignMiddle<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  similarity: (oldItem: T | undefined, newItem: T | undefined) => number,
): readonly AlignedPair<T>[] {
  if (oldItems.length * newItems.length > MAX_ALIGNMENT_CELLS) {
    return [...oldItems.map((item) => ({ old: item })), ...newItems.map((item) => ({ new: item }))];
  }

  const exactWeight = Math.min(oldItems.length, newItems.length) + 1;
  const scores = oldItems.map((oldItem) => newItems.map((newItem) => {
    const score = similarity(oldItem, newItem);
    return score >= 1 ? exactWeight : score >= SIMILARITY_THRESHOLD ? score : 0;
  }));
  const best: number[][] = Array.from({ length: oldItems.length + 1 }, () =>
    new Array<number>(newItems.length + 1).fill(0)
  );
  for (let oldIndex = oldItems.length - 1; oldIndex >= 0; oldIndex -= 1) {
    const row = best[oldIndex];
    if (row === undefined) {
      continue;
    }
    for (let newIndex = newItems.length - 1; newIndex >= 0; newIndex -= 1) {
      const score = scores[oldIndex]?.[newIndex] ?? 0;
      row[newIndex] = Math.max(
        best[oldIndex + 1]?.[newIndex] ?? 0,
        best[oldIndex]?.[newIndex + 1] ?? 0,
        score > 0 ? score + (best[oldIndex + 1]?.[newIndex + 1] ?? 0) : 0,
      );
    }
  }

  const pairs: AlignedPair<T>[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldItems.length && newIndex < newItems.length) {
    const score = scores[oldIndex]?.[newIndex] ?? 0;
    const current = best[oldIndex]?.[newIndex] ?? 0;
    if (score > 0 && current === score + (best[oldIndex + 1]?.[newIndex + 1] ?? 0)) {
      pairs.push({ old: oldItems[oldIndex], new: newItems[newIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (current === (best[oldIndex + 1]?.[newIndex] ?? 0)) {
      pairs.push({ old: oldItems[oldIndex] });
      oldIndex += 1;
    } else {
      pairs.push({ new: newItems[newIndex] });
      newIndex += 1;
    }
  }
  for (const item of oldItems.slice(oldIndex)) {
    pairs.push({ old: item });
  }
  for (const item of newItems.slice(newIndex)) {
    pairs.push({ new: item });
  }
  return pairs;
}
