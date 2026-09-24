import { Lexer, type Token, type Tokens } from "marked";
import stringWidth from "string-width";

import type { DiffKind } from "./diff.ts";
import {
  alignBySimilarity,
  deletionsFirst,
  inlinePlainText,
  sameIgnoringWhitespace,
  sameInlineContent,
  textSimilarity,
} from "./inline-diff.ts";

export type InlineText =
  | {
      readonly kind: DiffKind;
      readonly text: string;
    }
  | {
      readonly kind: "modification";
      readonly oldText: string;
      readonly newText: string;
    };

export type FlowContainer =
  | {
      readonly id: number;
      readonly type: "item";
      readonly ordered: boolean;
      readonly loose: boolean;
      readonly ordinal: number;
      readonly task: boolean;
      readonly checked: boolean;
    }
  | {
      readonly id: number;
      readonly type: "quote";
    }
  | {
      readonly id: number;
      readonly type: "details";
    };

export type FlowLeaf =
  | {
      readonly type: "paragraph" | "summary" | "tag" | "comment";
      readonly path: readonly FlowContainer[];
      readonly text: InlineText;
      readonly printWidth: number;
    }
  | {
      readonly type: "heading";
      readonly depth: number;
      readonly path: readonly FlowContainer[];
      readonly text: InlineText;
      readonly printWidth: number;
    }
  | {
      readonly type: "raw";
      readonly path: readonly FlowContainer[];
      readonly kind: DiffKind;
      readonly source: string;
    };

type SideLeaf =
  | {
      readonly type: "paragraph" | "summary" | "tag" | "comment";
      readonly path: readonly FlowContainer[];
      readonly text: string;
    }
  | {
      readonly type: "heading";
      readonly depth: number;
      readonly path: readonly FlowContainer[];
      readonly text: string;
    }
  | {
      readonly type: "raw";
      readonly path: readonly FlowContainer[];
      readonly text: string;
    };

const DETAILS_TAG = /<\/?details\b[^>]*>/gi;
const DETAILS_OPEN = /<details\b[^>]*>/i;
const SUMMARY = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;
const PAIRED_TAG_SIMILARITY = 0.5;
const COMMENT = /^\s*<!--([\s\S]*?)-->\s*$/;

export function diffFlow(oldSource: string, newSource: string): readonly FlowLeaf[] {
  const ids = { next: 0 };
  const oldLeaves = sideLeaves(oldSource, [], ids);
  const newLeaves = sideLeaves(newSource, [], ids);
  const printWidths = new Map<SideLeaf, number>([...sectionWidths(oldLeaves), ...sectionWidths(newLeaves)]);
  const containers = new Map<number, FlowContainer>();
  const mappedFrom = new Map<number, number>();
  const pairs = deletionsFirst(alignBySimilarity(oldLeaves, newLeaves, leafSimilarity, sameLeaf).flatMap((pair) => {
    const oldLeaf = pair.old;
    const newLeaf = pair.new;
    if (oldLeaf === undefined || newLeaf === undefined) {
      return [pair];
    }
    const consistent = oldLeaf.path.every((container, index) => {
      const mapped = newLeaf.path[index];
      return mapped !== undefined
        && (containers.get(container.id)?.id ?? mapped.id) === mapped.id
        && (mappedFrom.get(mapped.id) ?? container.id) === container.id;
    });
    if (!consistent) {
      return [{ old: oldLeaf }, { new: newLeaf }];
    }
    oldLeaf.path.forEach((container, index) => {
      const mapped = newLeaf.path[index];
      if (mapped !== undefined) {
        containers.set(container.id, mapped);
        mappedFrom.set(mapped.id, container.id);
      }
    });
    return [pair];
  }));

  const widthOf = (leaf: SideLeaf | undefined): number => leaf === undefined ? 0 : printWidths.get(leaf) ?? 0;
  return pairs.flatMap((pair): readonly FlowLeaf[] => {
    const printWidth = Math.max(widthOf(pair.old), widthOf(pair.new));
    if (pair.new !== undefined) {
      return [toFlowLeaf(pair.new, pair.old, printWidth)];
    }
    if (pair.old === undefined) {
      return [];
    }
    const path = pair.old.path.map((container) => containers.get(container.id) ?? container);
    return [toFlowLeaf({ ...pair.old, path }, undefined, printWidth, "deletion")];
  });
}

function sectionWidths(leaves: readonly SideLeaf[]): readonly (readonly [SideLeaf, number])[] {
  const sections: SideLeaf[][] = [[]];
  for (const leaf of leaves) {
    if (leaf.type === "heading" && leaf.path.length === 0) {
      sections.push([]);
    }
    sections.at(-1)?.push(leaf);
  }
  return sections.flatMap((section) => {
    const measured = section.filter((leaf) => leaf.type === "heading"
      || (leaf.type === "paragraph" && leaf.path.every((container) => container.type !== "item")));
    const width = measured.some((leaf) => leaf.type === "paragraph")
      ? Math.max(...measured.flatMap((leaf) => leaf.text.split("\n").flatMap((line) => inlinePlainText(line).split("\n").map((part) => stringWidth(part)))))
      : 0;
    return section.map((leaf): readonly [SideLeaf, number] => [leaf, width]);
  });
}

function toFlowLeaf(
  leaf: SideLeaf,
  old: SideLeaf | undefined,
  printWidth: number,
  only?: "deletion",
): FlowLeaf {
  const kind: DiffKind = only ?? (old === undefined ? "addition" : "context");
  if (leaf.type === "raw") {
    return { type: "raw", path: leaf.path, kind, source: leaf.text };
  }
  const same = leaf.type === "tag" || leaf.type === "comment" ? sameIgnoringWhitespace : sameInlineContent;
  const text: InlineText = old === undefined || same(old.text, leaf.text)
    ? { kind, text: leaf.text }
    : { kind: "modification", oldText: old.text, newText: leaf.text };
  return leaf.type === "heading"
    ? { type: "heading", depth: leaf.depth, path: leaf.path, text, printWidth }
    : { type: leaf.type, path: leaf.path, text, printWidth };
}

function sameLeaf(oldLeaf: SideLeaf, newLeaf: SideLeaf): boolean {
  return compatible(oldLeaf, newLeaf) && oldLeaf.text === newLeaf.text;
}

function leafSimilarity(oldLeaf: SideLeaf | undefined, newLeaf: SideLeaf | undefined): number {
  if (oldLeaf === undefined || newLeaf === undefined || !compatible(oldLeaf, newLeaf)) {
    return 0;
  }
  if (oldLeaf.type === "raw") {
    return sameIgnoringWhitespace(oldLeaf.text, newLeaf.text) ? 1 : 0;
  }
  if (oldLeaf.type === "comment") {
    return sameIgnoringWhitespace(oldLeaf.text, newLeaf.text) ? 1 : textSimilarity(oldLeaf.text, newLeaf.text);
  }
  if (oldLeaf.type === "tag") {
    return sameIgnoringWhitespace(oldLeaf.text, newLeaf.text) ? 1 : PAIRED_TAG_SIMILARITY;
  }
  if (oldLeaf.type === "summary") {
    return Math.max(
      PAIRED_TAG_SIMILARITY,
      sameInlineContent(oldLeaf.text, newLeaf.text) ? 1 : textSimilarity(inlinePlainText(oldLeaf.text), inlinePlainText(newLeaf.text)),
    );
  }
  if (sameInlineContent(oldLeaf.text, newLeaf.text)) {
    return 1;
  }
  return textSimilarity(inlinePlainText(oldLeaf.text), inlinePlainText(newLeaf.text));
}

function compatible(oldLeaf: SideLeaf, newLeaf: SideLeaf): boolean {
  if (oldLeaf.type !== newLeaf.type || oldLeaf.path.length !== newLeaf.path.length) {
    return false;
  }
  if (oldLeaf.type === "heading" && newLeaf.type === "heading" && oldLeaf.depth !== newLeaf.depth) {
    return false;
  }
  return oldLeaf.path.every((container, index) => {
    const other = newLeaf.path[index];
    if (other === undefined || other.type !== container.type) {
      return false;
    }
    return container.type !== "item" || other.type !== "item"
      || (container.ordered === other.ordered && container.task === other.task
        && container.checked === other.checked);
  });
}

function sideLeaves(
  source: string,
  path: readonly FlowContainer[],
  ids: { next: number },
): readonly SideLeaf[] {
  return tokenLeaves(Lexer.lex(source, { gfm: true }), path, ids);
}

function detailsLeaves(
  source: string,
  path: readonly FlowContainer[],
  ids: { next: number },
): readonly SideLeaf[] {
  const opening = DETAILS_OPEN.exec(source);
  const closing = source.lastIndexOf("</details");
  if (opening === null) {
    return [{ type: "raw", path, text: source.replace(/\n+$/, "") }];
  }
  const inner = source.slice(opening.index + opening[0].length, closing < 0 ? source.length : closing);
  const details: FlowContainer = { id: ids.next++, type: "details" };
  const detailsPath = [...path, details];
  const summary = SUMMARY.exec(inner);
  const body = summary === null
    ? inner
    : `${inner.slice(0, summary.index)}${inner.slice(summary.index + summary[0].length)}`;
  return [
    { type: "tag", path: detailsPath, text: opening[0] },
    { type: "summary", path: detailsPath, text: (summary?.[1] ?? "Details").trim() },
    ...sideLeaves(body, detailsPath, ids),
  ];
}

function tokenLeaves(
  tokens: readonly Token[],
  path: readonly FlowContainer[],
  ids: { next: number },
): readonly SideLeaf[] {
  const leaves: SideLeaf[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token.type === "html" && !COMMENT.test(token.raw) && DETAILS_OPEN.test(token.raw)) {
      let depth = 0;
      let end = index;
      let source = "";
      for (; end < tokens.length; end += 1) {
        const raw = tokens[end]?.raw ?? "";
        source += raw;
        for (const tag of raw.matchAll(DETAILS_TAG)) {
          depth += tag[0].startsWith("</") ? -1 : 1;
        }
        if (depth <= 0) {
          break;
        }
      }
      leaves.push(...detailsLeaves(source, path, ids));
      index = end;
      continue;
    }
    leaves.push(...singleTokenLeaves(token, path, ids));
  }
  return leaves;
}

function singleTokenLeaves(
  token: Token,
  path: readonly FlowContainer[],
  ids: { next: number },
): readonly SideLeaf[] {
  if (token.type === "space" || token.type === "checkbox") {
    return [];
  }
  if ((token.type === "paragraph" || token.type === "text") && hasInlineTokens(token)) {
    return [{ type: "paragraph", path, text: token.raw.replace(/\n+$/, "") }];
  }
  if (isHeadingToken(token)) {
    return [{ type: "heading", depth: token.depth, path, text: token.text }];
  }
  const comment = token.type === "html" ? COMMENT.exec(token.raw) : null;
  if (comment !== null) {
    return [{ type: "comment", path, text: (comment[1] ?? "").trim() }];
  }
  if (isListToken(token)) {
    const start = typeof token.start === "number" ? token.start : 1;
    return token.items.flatMap((item, index) => {
      const container: FlowContainer = {
        id: ids.next++,
        type: "item",
        ordered: token.ordered,
        loose: token.loose,
        ordinal: start + index,
        task: item.task,
        checked: item.checked === true,
      };
      const children = tokenLeaves(item.tokens, [...path, container], ids);
      return children.length === 0
        ? [{ type: "paragraph", path: [...path, container], text: "" }]
        : children;
    });
  }
  if (token.type === "blockquote" && hasBlockTokens(token)) {
    return tokenLeaves(token.tokens, [...path, { id: ids.next++, type: "quote" }], ids);
  }
  return [{ type: "raw", path, text: token.raw.replace(/\n+$/, "") }];
}

function hasInlineTokens(token: Token): token is Token & { readonly tokens: Token[] } {
  return "tokens" in token && Array.isArray(token.tokens);
}

function hasBlockTokens(token: Token): token is Token & { readonly tokens: Token[] } {
  return "tokens" in token && Array.isArray(token.tokens);
}

function isHeadingToken(token: Token): token is Tokens.Heading {
  return token.type === "heading" && "depth" in token && typeof token.depth === "number" && "text" in token;
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === "list" && "items" in token && Array.isArray(token.items);
}
