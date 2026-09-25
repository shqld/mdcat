import {
  BoxRenderable,
  CliRenderEvents,
  MarkdownRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  TextTableRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  italic,
  link,
  strikethrough,
  underline,
  type CliRenderer,
  type KeyEvent,
  type OptimizedBuffer,
  type Selection,
  type TextChunk,
  type TreeSitterClient,
} from "@opentui/core";
import { Lexer, type Token, type Tokens } from "marked";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import stringWidth from "string-width";

import type {
  DiffKind,
  MarkdownDiff,
  MarkdownDiffFile,
  MarkdownDiffFlowBlock,
  MarkdownDiffFrontmatterBlock,
  MarkdownDiffFrontmatterRow,
  MarkdownDiffCodeBlock,
  MarkdownDiffHunk,
  MarkdownDiffTableBlock,
  MarkdownDiffTableRow,
} from "./diff.ts";
import type { FlowContainer, FlowLeaf, InlineText } from "./flow.ts";
import { diffReadable, inlinePlainText, lineBreakText, sameIgnoringWhitespace, sameInlineContent } from "./inline-diff.ts";

const COLOR = {
  canvas: "#12141c",
  status: "#121420",
  fileBackground: "#181c2c",
  fileText: "#a2c0de",
  border: "#414b6c",
  text: "#d0d2da",
  muted: "#747e9c",
  heading1: "#8cbeff",
  heading2: "#78d2aa",
  heading3: "#d2b478",
  heading4: "#a2c0de",
  headingUnderline: "#28324b",
  listLevel1: "#5fc894",
  listLevel2: "#8a9bc8",
  listLevel3: "#a8a8b9",
  taskUnchecked: "#64646e",
  added: "#78d2aa",
  addedBackground: "#12261e",
  removed: "#da5f5f",
  removedBackground: "#321c1f",
  inlineCode: "#dc9676",
  inlineCodeBackground: "#26201f",
  code: "#a5d6ff",
};

export interface DiffViewer {
  readonly root: BoxRenderable;
  readonly scroll: ScrollBoxRenderable;
}

export interface DiffViewerOptions {
  readonly treeSitterClient?: TreeSitterClient;
  readonly copyText?: (text: string) => void;
}

export async function showDiff(document: MarkdownDiff): Promise<void> {
  const terminalInput = openTerminalInput();
  try {
    const renderer = await createCliRenderer({
      stdin: terminalInput.stream,
      stdout: process.stdout,
      backgroundColor: COLOR.canvas,
      exitOnCtrlC: true,
      onDestroy: terminalInput.close,
    });
    buildDiffViewer(renderer, document);
  } catch (error: unknown) {
    terminalInput.close();
    throw error;
  }
}

export function buildDiffViewer(
  renderer: CliRenderer,
  document: MarkdownDiff,
  options: DiffViewerOptions = {},
): DiffViewer {
  const syntaxStyle = createMarkdownStyle();
  const root = new BoxRenderable(renderer, {
    id: "mdcat-viewer",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: COLOR.canvas,
  });

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "mdcat-scroll",
    width: "100%",
    height: "100%",
    flexGrow: 1,
    flexShrink: 1,
    paddingX: 1,
    paddingY: 0,
    scrollX: false,
    scrollY: true,
    backgroundColor: COLOR.canvas,
    rootOptions: { backgroundColor: COLOR.canvas },
    wrapperOptions: { backgroundColor: COLOR.canvas },
    viewportOptions: { backgroundColor: COLOR.canvas },
    contentOptions: {
      backgroundColor: COLOR.canvas,
      flexDirection: "column",
    },
    verticalScrollbarOptions: {
      trackOptions: {
        foregroundColor: COLOR.muted,
        backgroundColor: COLOR.border,
      },
    },
  });

  for (const file of document.files) {
    scroll.add(createFile(renderer, file, syntaxStyle, options.treeSitterClient));
  }

  root.add(scroll);
  root.add(createFooter(renderer));
  renderer.root.add(root);
  scroll.focus();

  const keyHandler = createKeyHandler(renderer, scroll);
  const selectionHandler = createSelectionHandler(renderer, options.copyText);
  renderer.keyInput.on("keypress", keyHandler);
  renderer.on(CliRenderEvents.SELECTION, selectionHandler);
  renderer.once(CliRenderEvents.DESTROY, () => {
    renderer.keyInput.off("keypress", keyHandler);
    renderer.off(CliRenderEvents.SELECTION, selectionHandler);
    syntaxStyle.destroy();
  });

  return { root, scroll };
}

function createFooter(renderer: CliRenderer): BoxRenderable {
  const footer = new BoxRenderable(renderer, {
    id: "mdcat-footer",
    width: "100%",
    height: 1,
    flexShrink: 0,
    paddingX: 1,
    backgroundColor: COLOR.status,
  });
  footer.add(
    new TextRenderable(renderer, {
      content: "j/k scroll · PgUp/PgDn page · g/G jump · drag copy · q quit",
      fg: COLOR.muted,
    }),
  );
  return footer;
}

function createFile(
  renderer: CliRenderer,
  file: MarkdownDiffFile,
  syntaxStyle: SyntaxStyle,
  treeSitterClient: TreeSitterClient | undefined,
): BoxRenderable {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    marginBottom: 1,
    backgroundColor: COLOR.canvas,
  });
  if (file.path !== null) {
    const title = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: COLOR.canvas,
    });
    title.add(
      new TextRenderable(renderer, {
        content: ` ${file.path} `,
        fg: COLOR.fileText,
        bg: COLOR.fileBackground,
      }),
    );
    container.add(title);
  }

  for (const hunk of file.hunks) {
    container.add(createHunk(renderer, hunk, file.status !== "unchanged", syntaxStyle, treeSitterClient));
  }

  return container;
}

function createHunk(
  renderer: CliRenderer,
  hunk: MarkdownDiffHunk,
  showRange: boolean,
  syntaxStyle: SyntaxStyle,
  treeSitterClient: TreeSitterClient | undefined,
): BoxRenderable {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    marginTop: 1,
    backgroundColor: COLOR.canvas,
  });

  if (hunk.omittedBefore > 0) {
    container.add(
      new TextRenderable(renderer, {
        content: `⋯ ${hunk.omittedBefore} unchanged ${hunk.omittedBefore === 1 ? "line" : "lines"}`,
        fg: COLOR.muted,
        attributes: TextAttributes.DIM,
        marginLeft: 1,
        marginBottom: 1,
      }),
    );
  }

  if (showRange) {
    container.add(
      new TextRenderable(renderer, {
        content: formatHunkRange(hunk),
        fg: COLOR.muted,
        attributes: TextAttributes.DIM,
        marginLeft: 1,
        marginBottom: 1,
      }),
    );
  }

  for (const block of hunk.blocks) {
    if (block.type === "table") {
      container.add(createTableBlock(renderer, block));
    } else if (block.type === "frontmatter") {
      container.add(createFrontmatterBlock(renderer, block));
    } else if (block.type === "code") {
      container.add(createCodeBlock(renderer, block));
    } else {
      container.add(createFlowBlock(renderer, block, { syntaxStyle, treeSitterClient }));
    }
  }

  return container;
}

interface FlowOptions {
  readonly syntaxStyle: SyntaxStyle;
  readonly treeSitterClient: TreeSitterClient | undefined;
}

function createFlowBlock(
  renderer: CliRenderer,
  block: MarkdownDiffFlowBlock,
  options: FlowOptions,
): BoxRenderable {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 1,
    marginBottom: 1,
    backgroundColor: COLOR.canvas,
  });
  appendFlow(renderer, container, block.leaves, 0, null, options);
  return container;
}

function appendFlow(
  renderer: CliRenderer,
  parent: BoxRenderable,
  leaves: readonly FlowLeaf[],
  depth: number,
  owner: FlowContainer | null,
  options: FlowOptions,
): void {
  let previous: FlowContainer | null | undefined;
  let index = 0;
  while (index < leaves.length) {
    const leaf = leaves[index];
    if (leaf === undefined) {
      break;
    }
    const container = leaf.path[depth] ?? null;
    let end = index + 1;
    while (container !== null && end < leaves.length && leaves[end]?.path[depth]?.id === container.id) {
      end += 1;
    }
    const node = container === null
      ? createFlowLeaf(renderer, leaf, options)
      : createFlowContainer(renderer, container, leaves.slice(index, end), depth, options);
    const tight = (owner?.type === "item" && !owner.loose)
      || (previous?.type === "item" && !previous.loose && container?.type === "item");
    node.marginTop = previous === undefined || tight ? 0 : 1;
    parent.add(node);
    previous = container;
    index = end;
  }
}

function createFlowContainer(
  renderer: CliRenderer,
  container: FlowContainer,
  leaves: readonly FlowLeaf[],
  depth: number,
  options: FlowOptions,
): BoxRenderable {
  if (container.type === "details") {
    return createFlowDetails(renderer, container, leaves, depth, options);
  }

  const background = kindBackground(uniformKind(leaves));
  const row = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: background,
  });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: background,
  });
  appendFlow(renderer, body, leaves, depth + 1, container, options);

  if (container.type === "quote") {
    body.border = ["left"];
    body.borderColor = COLOR.border;
    body.paddingLeft = 1;
    row.add(body);
    return row;
  }

  const level = leaves[0]?.path.slice(0, depth + 1).filter((item) => item.type === "item").length ?? 1;
  const marker = listMarkerGlyph(container.ordered, container, level);
  const first = leaves[0];
  const markerBackground = first !== undefined && first.path.length === depth + 1
    ? kindBackground(leafKind(first))
    : background;
  row.add(new TextRenderable(renderer, {
    content: new StyledText([fg(marker.color)(marker.text)]),
    width: stringWidth(marker.text),
    flexShrink: 0,
    bg: markerBackground,
  }));
  row.add(body);
  return row;
}

function createFlowDetails(
  renderer: CliRenderer,
  container: FlowContainer,
  leaves: readonly FlowLeaf[],
  depth: number,
  options: FlowOptions,
): BoxRenderable {
  const own = (leaf: FlowLeaf): boolean => leaf.path.length === depth + 1;
  const summaries = leaves.filter((leaf) => own(leaf) && leaf.type === "summary");
  const tags = leaves.filter((leaf) => own(leaf) && leaf.type === "tag" && leafKind(leaf) !== "context");
  const bodyLeaves = leaves.filter((leaf) => !own(leaf) || (leaf.type !== "summary" && leaf.type !== "tag"));
  const background = kindBackground(uniformKind(leaves));
  const details = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: background,
  });
  const body = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    marginLeft: 1,
    paddingLeft: 1,
    border: ["left"],
    borderColor: COLOR.border,
    backgroundColor: background,
  });
  appendFlow(renderer, body, bodyLeaves, depth + 1, container, options);

  const summaryTexts: readonly InlineText[] = summaries.flatMap((leaf) => leaf.type === "summary" ? [leaf.text] : []);
  const fallback: InlineText = { kind: "context", text: "Details" };
  const headerTexts = summaryTexts.length === 0 ? [fallback] : summaryTexts;
  const summary = new TextRenderable(renderer, {
    content: renderDetailsSummary(headerTexts, true),
    width: "100%",
    flexShrink: 0,
    wrapMode: "word",
    bg: background,
  });
  let expanded = true;
  const setExpanded = (next: boolean): void => {
    expanded = next;
    body.visible = expanded;
    summary.content = renderDetailsSummary(headerTexts, expanded);
  };
  const header = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    backgroundColor: background,
    focusable: true,
    onMouseDown() {
      this.focus();
      setExpanded(!expanded);
    },
    onKeyDown: (key) => {
      if (key.name === "return" || key.name === "enter" || key.name === "space") {
        setExpanded(!expanded);
      }
    },
  });
  header.add(summary);
  details.add(header);
  for (const tag of tags) {
    if (tag.type === "tag") {
      details.add(new TextRenderable(renderer, {
        content: new StyledText(renderInlineText(tag.text, { foreground: COLOR.muted }, false)),
        width: "100%",
        flexShrink: 0,
        wrapMode: "word",
        bg: kindBackground(tag.text.kind),
      }));
    }
  }
  details.add(body);
  return details;
}

function renderDetailsSummary(texts: readonly InlineText[], expanded: boolean): StyledText {
  return new StyledText([
    fg(COLOR.heading2)(expanded ? "▾ " : "▸ "),
    ...texts.flatMap((text, index) => [
      ...(index === 0 ? [] : [fg(COLOR.muted)(" ")]),
      ...renderInlineText(text, { bold: true, foreground: COLOR.heading4 }).map((chunk) =>
        text.kind === "context" || text.kind === "modification" ? chunk : diffChunk(chunk, text.kind)
      ),
    ]),
  ]);
}

function uniformKind(leaves: readonly FlowLeaf[]): DiffKind | "modification" {
  const kinds = new Set(leaves
    .filter((leaf) => leaf.type !== "tag" || leafKind(leaf) !== "context")
    .map(leafKind));
  const [only] = kinds;
  return kinds.size === 1 && (only === "addition" || only === "deletion") ? only : "context";
}

function createFlowLeaf(renderer: CliRenderer, leaf: FlowLeaf, options: FlowOptions): BoxRenderable {
  const background = kindBackground(leafKind(leaf));
  const box = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: background,
  });
  if (leaf.type === "raw") {
    box.add(createMarkdownRenderable(renderer, leaf.source, options.syntaxStyle, options.treeSitterClient, background));
    return box;
  }

  const heading = leaf.type === "heading";
  const comment = leaf.type === "comment";
  const commentStyle: InlineStyle = { foreground: COLOR.muted, italic: true };
  const segments: InlineSegment[] = comment
    ? [
      { chunks: [createTextChunk("<!-- ", commentStyle)], kind: "context" },
      ...renderInlineTextSegments(leaf.text, commentStyle, false),
      { chunks: [createTextChunk(" -->", commentStyle)], kind: "context" },
    ]
    : renderInlineTextSegments(leaf.text, heading
      ? { bold: true, foreground: headingColor(leaf.depth) }
      : { foreground: COLOR.text });
  box.add(new WrappedTextRenderable(renderer, segments, background, leaf.printWidth));
  if (leaf.type === "heading" && leaf.depth <= 2) {
    const title = leaf.text.kind === "modification" ? leaf.text.newText : leaf.text.text;
    box.add(new TextRenderable(renderer, {
      content: (leaf.depth === 1 ? "═" : "─").repeat(stringWidth(inlinePlainText(title))),
      fg: COLOR.headingUnderline,
      bg: background,
      height: 1,
      flexShrink: 0,
    }));
  }
  return box;
}

function renderInlineText(text: InlineText, style: InlineStyle, markdown = true): TextChunk[] {
  return renderInlineTextSegments(text, style, markdown).flatMap((segment) => segment.chunks);
}

function renderInlineTextSegments(text: InlineText, style: InlineStyle, markdown = true): InlineSegment[] {
  return text.kind === "modification"
    ? renderInlineDiffSegments(text.oldText, text.newText, style, undefined, markdown)
    : [{ chunks: renderInlineSource(text.text, style, markdown), kind: "context" }];
}

function renderInlineSource(source: string, style: InlineStyle, markdown: boolean): TextChunk[] {
  return markdown
    ? renderInlineTokens(Lexer.lexInline(source, { gfm: true }), style)
    : [createTextChunk(source, style)];
}

function leafKind(leaf: FlowLeaf): DiffKind | "modification" {
  return leaf.type === "raw" ? leaf.kind : leaf.text.kind;
}

function kindBackground(kind: DiffKind | "modification"): string {
  return kind === "modification" ? COLOR.canvas : blockBackground(kind);
}

function createMarkdownRenderable(
  renderer: CliRenderer,
  content: string,
  syntaxStyle: SyntaxStyle,
  treeSitterClient: TreeSitterClient | undefined,
  backgroundColor: string,
): MarkdownRenderable {
  return new MarkdownRenderable(renderer, {
    content: `${content.trimEnd()}\n\n`,
    syntaxStyle,
    treeSitterClient,
    conceal: true,
    streaming: true,
    internalBlockMode: "top-level",
    fg: COLOR.text,
    bg: backgroundColor,
    width: "100%",
    flexShrink: 0,
    renderNode: (token) => isListToken(token)
      ? createLeafListRenderable(
        renderer,
        token,
        syntaxStyle,
        treeSitterClient,
        backgroundColor,
      )
      : undefined,
    tableOptions: {
      style: "grid",
      widthMode: "full",
      wrapMode: "word",
      borderColor: COLOR.border,
    },
  });
}

function createLeafListRenderable(
  renderer: CliRenderer,
  token: Tokens.List,
  syntaxStyle: SyntaxStyle,
  treeSitterClient: TreeSitterClient | undefined,
  backgroundColor: string,
): BoxRenderable {
  const list = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor,
  });
  appendLeafListRows(
    renderer,
    list,
    token,
    syntaxStyle,
    treeSitterClient,
    backgroundColor,
    1,
  );
  return list;
}

function appendLeafListRows(
  renderer: CliRenderer,
  list: BoxRenderable,
  token: Tokens.List,
  syntaxStyle: SyntaxStyle,
  treeSitterClient: TreeSitterClient | undefined,
  backgroundColor: string,
  depth: number,
): void {
  for (let itemIndex = 0; itemIndex < token.items.length; itemIndex += 1) {
    const item = token.items[itemIndex];
    if (item === undefined) {
      continue;
    }
    const marker = leafListMarker(token, item, itemIndex, depth);
    let markerPending = true;

    for (const child of item.tokens) {
      if (child.type === "checkbox" || child.type === "space") {
        continue;
      }
      if (isListToken(child)) {
        appendLeafListRows(
          renderer,
          list,
          child,
          syntaxStyle,
          treeSitterClient,
          backgroundColor,
          depth + 1,
        );
        continue;
      }

      const prefix = markerPending ? marker.text : " ".repeat(stringWidth(marker.text));
      const color = markerPending ? marker.color : COLOR.text;
      const content = isInlineListContent(child)
        ? createLeafListText(renderer, child.tokens, backgroundColor)
        : createMarkdownRenderable(
          renderer,
          child.raw,
          syntaxStyle,
          treeSitterClient,
          backgroundColor,
        );
      list.add(createLeafListRow(renderer, prefix, color, content, backgroundColor));
      markerPending = false;
    }

    if (markerPending) {
      list.add(createLeafListRow(
        renderer,
        marker.text,
        marker.color,
        createLeafListText(renderer, [], backgroundColor),
        backgroundColor,
      ));
    }
  }
}

function headingColor(depth: number): string {
  return [COLOR.heading1, COLOR.heading2, COLOR.heading3, COLOR.heading4][depth - 1] ?? COLOR.text;
}

function createCodeBlock(renderer: CliRenderer, block: MarkdownDiffCodeBlock): BoxRenderable {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    marginBottom: 1,
    backgroundColor: COLOR.canvas,
  });
  for (const line of block.lines) {
    const backgroundColor = line.kind === "context" ? COLOR.inlineCodeBackground : blockBackground(line.kind);
    const marker = line.kind === "addition" ? "+ " : line.kind === "deletion" ? "− " : "  ";
    const markerColor = line.kind === "addition" ? COLOR.added : line.kind === "deletion" ? COLOR.removed : COLOR.muted;
    const row = new BoxRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      paddingX: 1,
      backgroundColor,
    });
    row.add(new TextRenderable(renderer, {
      content: new StyledText([fg(markerColor)(marker), fg(COLOR.code)(line.text)]),
      width: "100%",
      flexShrink: 0,
      wrapMode: "char",
      bg: backgroundColor,
    }));
    container.add(row);
  }
  return container;
}

function createLeafListRow(
  renderer: CliRenderer,
  prefix: string,
  markerColor: string,
  content: TextRenderable | MarkdownRenderable,
  backgroundColor: string,
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor,
  });
  row.add(
    new TextRenderable(renderer, {
      content: new StyledText([fg(markerColor)(prefix)]),
      width: stringWidth(prefix),
      flexShrink: 0,
      bg: backgroundColor,
    }),
  );
  row.add(content);
  return row;
}

function createLeafListText(
  renderer: CliRenderer,
  tokens: readonly Token[],
  backgroundColor: string,
): TextRenderable {
  return new TextRenderable(renderer, {
    content: new StyledText(renderInlineTokens(tokens, { foreground: COLOR.text })),
    flexGrow: 1,
    flexShrink: 1,
    wrapMode: "word",
    bg: backgroundColor,
  });
}

function leafListMarker(
  list: Tokens.List,
  item: Tokens.ListItem,
  itemIndex: number,
  depth: number,
): { readonly text: string; readonly color: string } {
  const start = typeof list.start === "number" ? list.start : 1;
  return listMarker(list.ordered, {
    ordinal: start + itemIndex,
    task: item.task,
    checked: item.checked === true,
  }, depth);
}

function listMarker(
  ordered: boolean,
  item: { readonly ordinal: number; readonly task: boolean; readonly checked: boolean },
  depth: number,
): { readonly text: string; readonly color: string } {
  const glyph = listMarkerGlyph(ordered, item, depth);
  return { text: `${"  ".repeat(Math.max(0, depth - 1))}${glyph.text}`, color: glyph.color };
}

function listMarkerGlyph(
  ordered: boolean,
  item: { readonly ordinal: number; readonly task: boolean; readonly checked: boolean },
  depth: number,
): { readonly text: string; readonly color: string } {
  if (item.task) {
    return {
      text: `${item.checked ? "☑" : "☐"} `,
      color: item.checked ? COLOR.listLevel1 : COLOR.taskUnchecked,
    };
  }
  if (ordered) {
    return { text: `${item.ordinal}. `, color: COLOR.listLevel1 };
  }
  const bullets = ["•", "◦", "▸"];
  return {
    text: `${bullets[Math.min(depth - 1, bullets.length - 1)]} `,
    color: depth === 1
      ? COLOR.listLevel1
      : depth === 2
        ? COLOR.listLevel2
        : COLOR.listLevel3,
  };
}

function isListToken(token: Token): token is Tokens.List {
  return token.type === "list" && "items" in token && Array.isArray(token.items);
}

function isInlineListContent(
  token: Token,
): token is (Tokens.Text | Tokens.Paragraph) & { readonly tokens: Token[] } {
  return (token.type === "text" || token.type === "paragraph") && hasInlineTokens(token);
}

function createTableBlock(renderer: CliRenderer, block: MarkdownDiffTableBlock): BoxRenderable {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    paddingX: 1,
    marginBottom: 1,
    backgroundColor: COLOR.canvas,
  });
  container.add(
    new TextTableRenderable(renderer, {
      content: renderTableContent(block.rows),
      width: "100%",
      flexShrink: 0,
      columnWidthMode: "content",
      columnFitter: "balanced",
      wrapMode: "word",
      cellPaddingX: 1,
      cellPaddingY: 0,
      border: true,
      outerBorder: true,
      borderColor: COLOR.border,
      borderBackgroundColor: COLOR.canvas,
      backgroundColor: COLOR.canvas,
      fg: COLOR.text,
      bg: COLOR.canvas,
      renderAfter: (buffer) => colorTableRules(buffer, block.rows),
    }),
  );
  return container;
}

function renderTableContent(rows: readonly MarkdownDiffTableRow[]): TextChunk[][][] {
  return rows.map(renderTableRow);
}

function colorTableRules(buffer: OptimizedBuffer, rows: readonly MarkdownDiffTableRow[]): void {
  const ruleRows = findTableRuleRows(buffer);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const top = ruleRows[index];
    const bottom = ruleRows[index + 1];
    if (row === undefined || top === undefined || bottom === undefined) {
      continue;
    }
    if (row.kind === "addition" || row.kind === "deletion") {
      const background = rowBackground(row.kind, COLOR.canvas);
      for (let y = top + 1; y < bottom; y += 1) {
        replaceCanvasBackground(buffer, y, background);
      }
    }
    const next = rows[index + 1];
    if (next !== undefined && row.kind === next.kind
      && (row.kind === "addition" || row.kind === "deletion")) {
      replaceCanvasBackground(buffer, bottom, rowBackground(row.kind, COLOR.canvas));
    }
  }
}

function findTableRuleRows(buffer: OptimizedBuffer): number[] {
  const leftRuleCharacters = new Set(["┌", "├", "└"].map((character) => character.charCodeAt(0)));
  const characters = buffer.buffers.char;
  const rows: number[] = [];
  for (let y = 0; y < buffer.height; y += 1) {
    const character = characters[y * buffer.width];
    if (character !== undefined && leftRuleCharacters.has(character)) {
      rows.push(y);
    }
  }
  return rows;
}

function replaceCanvasBackground(buffer: OptimizedBuffer, y: number, color: string): void {
  const backgrounds = buffer.buffers.bg;
  const canvas = RGBA.fromHex(COLOR.canvas).buffer;
  const replacement = RGBA.fromHex(color).buffer;
  for (let x = 0; x < buffer.width; x += 1) {
    const offset = (y * buffer.width + x) * 4;
    if (backgrounds[offset] === canvas[0]
      && backgrounds[offset + 1] === canvas[1]
      && backgrounds[offset + 2] === canvas[2]
      && backgrounds[offset + 3] === canvas[3]) {
      backgrounds.set(replacement, offset);
    }
  }
}

function createFrontmatterBlock(
  renderer: CliRenderer,
  block: MarkdownDiffFrontmatterBlock,
): BoxRenderable {
  const keyWidth = block.rows.reduce((width, row) => Math.max(width, stringWidth(row.key)), 0);
  const container = new BoxRenderable(renderer, {
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    marginBottom: 1,
    backgroundColor: COLOR.fileBackground,
  });

  for (const row of block.rows) {
    const rowContainer = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: rowBackground(row.kind, COLOR.fileBackground),
    });
    rowContainer.add(
      new TextRenderable(renderer, {
        content: new StyledText(renderFrontmatterRow(row, keyWidth)),
        height: 1,
        flexShrink: 0,
      }),
    );
    container.add(rowContainer);
  }
  return container;
}

function renderFrontmatterRow(row: MarkdownDiffFrontmatterRow, keyWidth: number): TextChunk[] {
  const marker = frontmatterMarker(row);
  const keyPadding = " ".repeat(Math.max(0, keyWidth - stringWidth(row.key)));
  const key = bold(fg(COLOR.heading4)(`${row.key}${keyPadding}`));
  const value = row.kind === "modification"
    ? renderCellDiff(row.oldValue, row.newValue, false)
    : [fg(COLOR.text)(row.value.length === 0 ? "—" : row.value)];
  return [fg(COLOR.border)("│ "), marker, key, fg(COLOR.muted)("  "), ...value];
}

function frontmatterMarker(row: MarkdownDiffFrontmatterRow): TextChunk {
  if (row.kind === "addition") {
    return fg(COLOR.added)("+ ");
  }
  if (row.kind === "deletion") {
    return fg(COLOR.removed)("− ");
  }
  if (row.kind === "modification") {
    return fg(COLOR.muted)("~ ");
  }
  return fg(COLOR.muted)("  ");
}

function renderTableRow(row: MarkdownDiffTableRow): TextChunk[][] {
  const cells = row.kind === "modification"
    ? renderModifiedCells(row)
    : row.cells.map((cell) => renderInlineMarkdown(cell, row.header));
  const decorated = cells.map((cell) => decorateRowChunks(cell, row));
  const firstCell = decorated[0] ?? [fg(COLOR.text)("")];
  decorated[0] = [rowMarker(row), ...firstCell];
  return decorated;
}

function renderModifiedCells(
  row: Extract<MarkdownDiffTableRow, { readonly kind: "modification" }>,
): TextChunk[][] {
  return row.oldCells.map((oldCell, index) => {
    const newCell = row.newCells[index] ?? "";
    return renderCellDiff(oldCell, newCell, row.header);
  });
}

function renderCellDiff(oldCell: string, newCell: string, header: boolean): TextChunk[] {
  return renderInlineDiff(oldCell, newCell, {
    bold: header,
    foreground: header ? COLOR.heading1 : COLOR.text,
  }, fg(COLOR.muted)(" → "));
}

interface InlineSegment {
  readonly chunks: readonly TextChunk[];
  readonly kind: DiffKind;
}

function renderInlineDiff(
  oldSource: string,
  newSource: string,
  style: InlineStyle,
  separator?: TextChunk,
  markdown = true,
): TextChunk[] {
  return renderInlineDiffSegments(oldSource, newSource, style, separator, markdown)
    .flatMap((segment) => segment.chunks);
}

function renderInlineDiffSegments(
  oldSource: string,
  newSource: string,
  style: InlineStyle,
  separator?: TextChunk,
  markdown = true,
): InlineSegment[] {
  const oldChunks = renderInlineSource(oldSource, style, markdown);
  const newChunks = renderInlineSource(newSource, style, markdown);
  if (markdown ? sameInlineContent(oldSource, newSource) : sameIgnoringWhitespace(oldSource, newSource)) {
    return [{ chunks: newChunks, kind: "context" }];
  }

  const separatorSegments: InlineSegment[] = separator === undefined ? [] : [{ chunks: [separator], kind: "context" }];
  const oldText = chunksText(oldChunks);
  const newText = chunksText(newChunks);
  if (sameIgnoringWhitespace(oldText, newText)) {
    return [
      { chunks: oldChunks.map((chunk) => diffChunk(chunk, "deletion")), kind: "deletion" },
      ...separatorSegments,
      { chunks: newChunks.map((chunk) => diffChunk(chunk, "addition")), kind: "addition" },
    ];
  }

  const segments: InlineSegment[] = [];
  const changes = diffReadable(oldText, newText);
  let oldOffset = 0;
  let newOffset = 0;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change === undefined) {
      continue;
    }
    if (change.kind === "context") {
      segments.push({ chunks: sliceChunks(newChunks, newOffset, newOffset + change.value.length), kind: "context" });
      oldOffset += change.oldValue.length;
      newOffset += change.value.length;
    } else if (change.kind === "deletion") {
      const deleted = sliceChunks(oldChunks, oldOffset, oldOffset + change.value.length);
      segments.push({ chunks: deleted.map((chunk) => diffChunk(chunk, "deletion")), kind: "deletion" });
      oldOffset += change.value.length;
      if (changes[index + 1]?.kind === "addition") {
        segments.push(...separatorSegments);
      }
    } else {
      const added = sliceChunks(newChunks, newOffset, newOffset + change.value.length);
      segments.push({ chunks: added.map((chunk) => diffChunk(chunk, "addition")), kind: "addition" });
      newOffset += change.value.length;
    }
  }
  return groupChangeSegments(segments);
}

function groupChangeSegments(segments: readonly InlineSegment[]): InlineSegment[] {
  const grouped: InlineSegment[] = [];
  let deleted: TextChunk[] = [];
  let added: TextChunk[] = [];
  const flush = (): void => {
    if (deleted.length > 0) {
      grouped.push({ chunks: deleted, kind: "deletion" });
    }
    if (added.length > 0) {
      grouped.push({ chunks: added, kind: "addition" });
    }
    deleted = [];
    added = [];
  };
  for (const segment of segments) {
    if (segment.kind === "deletion") {
      deleted.push(...segment.chunks);
    } else if (segment.kind === "addition") {
      added.push(...segment.chunks);
    } else if (chunksText(segment.chunks).length > 0) {
      flush();
      grouped.push(segment);
    }
  }
  flush();
  return grouped;
}

function wrapSegments(segments: readonly InlineSegment[], width: number, hardWidth = width): TextChunk[] {
  const wrapped: TextChunk[] = [];
  let column = 0;
  const breakLine = (): void => {
    wrapped.push(fg(COLOR.text)("\n"));
    column = 0;
  };

  for (const segment of segments) {
    const firstLine = chunksText(segment.chunks).split("\n")[0] ?? "";
    const firstLineWidth = wrapUnits(firstLine).reduce((sum, unit) => sum + unitWidth(unit), 0);
    if (segment.kind !== "context" && column > 0 && column + firstLineWidth > width) {
      breakLine();
    }
    for (const chunk of segment.chunks) {
      for (const unit of wrapUnits(chunk.text).flatMap((part) => splitWideUnit(part, width))) {
        if (unit === "\n") {
          wrapped.push({ ...chunk, text: unit });
          column = 0;
          continue;
        }
        const measured = unitWidth(unit);
        const hangs = CLOSING_PUNCTUATION.test(unit) && column + measured <= hardWidth;
        if (column > 0 && column + measured > width && !hangs) {
          breakLine();
          if (unit.trim().length === 0) {
            continue;
          }
        }
        wrapped.push({ ...chunk, text: unit });
        column += measured;
      }
    }
  }
  return wrapped;
}

const MIN_PRINT_WIDTH = 40;
const CLOSING_PUNCTUATION = /^[、。，．,.!?！？:;：；)）\]］}｝」』】〉》〕…ー]+$/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TAB_WIDTH = 2;

function wrapUnits(text: string): readonly string[] {
  return (text.match(/\n|[ \t]+|[\x21-\x7e]+|[^\n \t\x21-\x7e]+/gu) ?? []).flatMap((part) =>
    /^[^\n \t\x21-\x7e]/u.test(part) ? graphemes(part) : [part]
  );
}

function graphemes(text: string): readonly string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment) => segment.segment);
}

function unitWidth(unit: string): number {
  return unit.includes("\t")
    ? stringWidth(unit.replaceAll("\t", "")) + TAB_WIDTH * (unit.split("\t").length - 1)
    : stringWidth(unit);
}

function splitWideUnit(unit: string, width: number): readonly string[] {
  if (unit === "\n" || unitWidth(unit) <= width) {
    return [unit];
  }
  const parts: string[] = [];
  let current = "";
  for (const grapheme of graphemes(unit)) {
    if (current.length > 0 && unitWidth(current + grapheme) > width) {
      parts.push(current);
      current = "";
    }
    current += grapheme;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

class WrappedTextRenderable extends TextRenderable {
  private wrappedWidth = 0;

  constructor(
    renderer: CliRenderer,
    private readonly segments: readonly InlineSegment[],
    backgroundColor: string,
    private readonly printWidth: number,
  ) {
    super(renderer, {
      content: new StyledText(segments.flatMap((segment) => [...segment.chunks])),
      width: "100%",
      flexShrink: 0,
      wrapMode: "char",
      bg: backgroundColor,
    });
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    const wrapWidth = this.printWidth === 0 ? width : Math.min(width, Math.max(this.printWidth, MIN_PRINT_WIDTH));
    if (wrapWidth > 0 && wrapWidth !== this.wrappedWidth) {
      this.wrappedWidth = wrapWidth;
      this.content = new StyledText(wrapSegments(this.segments, wrapWidth, width));
    }
  }
}

function chunksText(chunks: readonly TextChunk[]): string {
  return chunks.map((chunk) => chunk.text).join("");
}

function sliceChunks(chunks: readonly TextChunk[], start: number, end: number): TextChunk[] {
  const sliced: TextChunk[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const chunkStart = offset;
    offset += chunk.text.length;
    const from = Math.max(start, chunkStart);
    const to = Math.min(end, offset);
    if (from < to) {
      sliced.push({ ...chunk, text: chunk.text.slice(from - chunkStart, to - chunkStart) });
    }
  }
  return sliced;
}

function diffChunk(chunk: TextChunk, kind: "addition" | "deletion"): TextChunk {
  const color = kind === "addition" ? COLOR.added : COLOR.removed;
  const background = kind === "addition" ? COLOR.addedBackground : COLOR.removedBackground;
  const highlighted = bg(background)(fg(color)(chunk));
  return kind === "deletion" ? strikethrough(highlighted) : highlighted;
}

function decorateRowChunks(chunks: readonly TextChunk[], row: MarkdownDiffTableRow): TextChunk[] {
  let decorated = [...chunks];
  if (row.kind === "addition" || row.kind === "deletion") {
    decorated = highlightChunks(decorated, row.kind);
  }
  return row.header ? decorated.map(bold) : decorated;
}

function highlightChunks(
  chunks: readonly TextChunk[],
  kind: "addition" | "deletion",
): TextChunk[] {
  const background = kind === "addition" ? COLOR.addedBackground : COLOR.removedBackground;
  return chunks.map(bg(background));
}

function rowMarker(row: MarkdownDiffTableRow): TextChunk {
  if (row.kind === "addition") {
    return bg(COLOR.addedBackground)(fg(COLOR.added)("+ "));
  }
  if (row.kind === "deletion") {
    return bg(COLOR.removedBackground)(fg(COLOR.removed)("− "));
  }
  if (row.kind === "modification") {
    return fg(COLOR.muted)("~ ");
  }
  return fg(COLOR.muted)("  ");
}

interface InlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
  readonly foreground?: string;
  readonly background?: string;
  readonly href?: string;
}

function renderInlineMarkdown(source: string, header: boolean): TextChunk[] {
  return renderInlineTokens(Lexer.lexInline(source, { gfm: true }), {
    bold: header,
    foreground: header ? COLOR.heading1 : COLOR.text,
  });
}

function renderInlineTokens(tokens: readonly Token[], style: InlineStyle): TextChunk[] {
  return tokens.flatMap((token, index): readonly TextChunk[] => {
    if (isStrongToken(token)) {
      return renderInlineTokens(token.tokens, { ...style, bold: true });
    }
    if (isEmToken(token)) {
      return renderInlineTokens(token.tokens, { ...style, italic: true });
    }
    if (isDelToken(token)) {
      return renderInlineTokens(token.tokens, { ...style, strikethrough: true });
    }
    if (isLinkToken(token)) {
      return renderInlineTokens(token.tokens, {
        ...style,
        foreground: COLOR.heading1,
        href: token.href,
        underline: true,
      });
    }
    if (isCodespanToken(token)) {
      return [createTextChunk(token.text, {
        ...style,
        foreground: COLOR.inlineCode,
        background: COLOR.inlineCodeBackground,
      })];
    }
    const lineBreak = lineBreakText(token, tokens[index + 1]);
    if (lineBreak !== null) {
      return lineBreak.length === 0 ? [] : [createTextChunk(lineBreak, style)];
    }
    if (hasInlineTokens(token)) {
      return renderInlineTokens(token.tokens, style);
    }
    if (hasTokenText(token)) {
      return [createTextChunk(token.text, style)];
    }
    return token.raw.length === 0 ? [] : [createTextChunk(token.raw, style)];
  });
}

function createTextChunk(value: string, style: InlineStyle): TextChunk {
  let chunk = fg(style.foreground ?? COLOR.text)(value);
  if (style.background !== undefined) {
    chunk = bg(style.background)(chunk);
  }
  if (style.bold) {
    chunk = bold(chunk);
  }
  if (style.italic) {
    chunk = italic(chunk);
  }
  if (style.strikethrough) {
    chunk = strikethrough(chunk);
  }
  if (style.underline) {
    chunk = underline(chunk);
  }
  if (style.href !== undefined) {
    chunk = link(style.href)(chunk);
  }
  return chunk;
}

function isStrongToken(token: Token): token is Tokens.Strong {
  return token.type === "strong" && hasInlineTokens(token);
}

function isEmToken(token: Token): token is Tokens.Em {
  return token.type === "em" && hasInlineTokens(token);
}

function isDelToken(token: Token): token is Tokens.Del {
  return token.type === "del" && hasInlineTokens(token);
}

function isLinkToken(token: Token): token is Tokens.Link {
  return token.type === "link" && hasInlineTokens(token) && "href" in token && typeof token.href === "string";
}

function isCodespanToken(token: Token): token is Tokens.Codespan {
  return token.type === "codespan" && hasTokenText(token);
}

function hasInlineTokens(token: Token): token is Token & { readonly tokens: Token[] } {
  return "tokens" in token && Array.isArray(token.tokens);
}

function hasTokenText(token: Token): token is Token & { readonly text: string } {
  return "text" in token && typeof token.text === "string";
}

function createMarkdownStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: COLOR.text },
    "markup.heading.1": { fg: COLOR.heading1, bold: true },
    "markup.heading.2": { fg: COLOR.heading2, bold: true },
    "markup.heading.3": { fg: COLOR.heading3, bold: true },
    "markup.heading.4": { fg: COLOR.heading4, bold: true },
    "markup.heading.5": { fg: COLOR.text, bold: true },
    "markup.heading.6": { fg: COLOR.text, bold: true },
    "markup.list": { fg: COLOR.text },
    "markup.raw": { fg: COLOR.code },
    "markup.link": { fg: "#5898ee", underline: true },
    "markup.bold": { fg: COLOR.text, bold: true },
    "markup.italic": { fg: COLOR.text, italic: true },
  });
}

function createKeyHandler(renderer: CliRenderer, scroll: ScrollBoxRenderable): (key: KeyEvent) => void {
  return (key) => {
    if (key.name === "q" || key.name === "escape") {
      renderer.destroy();
      return;
    }
    if (key.name === "j") {
      scroll.scrollBy(1, "step");
      return;
    }
    if (key.name === "k") {
      scroll.scrollBy(-1, "step");
      return;
    }
    if (key.name === "g" && key.shift) {
      scroll.scrollTo(Number.MAX_SAFE_INTEGER);
      return;
    }
    if (key.name === "g") {
      scroll.scrollTo(0);
    }
  };
}

function createSelectionHandler(
  renderer: CliRenderer,
  copyText: ((text: string) => void) | undefined,
): (selection: Selection) => void {
  return (selection) => {
    const text = selection.getSelectedText();
    if (text.length === 0) {
      return;
    }
    if (copyText !== undefined) {
      copyText(text);
      return;
    }
    renderer.copyToClipboardOSC52(text);
    void copyToSystemClipboard(text);
  };
}

async function copyToSystemClipboard(text: string): Promise<void> {
  for (const [command = "", ...args] of clipboardCommands()) {
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => undefined);
      child.stdin.end(text);
    });
    if (copied) {
      return;
    }
  }
}

function clipboardCommands(): string[][] {
  if (process.platform === "darwin") {
    return [["pbcopy"]];
  }
  if (process.platform === "win32") {
    return [["clip.exe"]];
  }
  if (process.env.TERMUX_VERSION !== undefined) {
    return [["termux-clipboard-set"]];
  }
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

function blockBackground(kind: DiffKind): string {
  if (kind === "addition") {
    return COLOR.addedBackground;
  }
  if (kind === "deletion") {
    return COLOR.removedBackground;
  }
  return COLOR.canvas;
}

function rowBackground(kind: DiffKind | "modification", fallback: string): string {
  if (kind === "addition") {
    return COLOR.addedBackground;
  }
  if (kind === "deletion") {
    return COLOR.removedBackground;
  }
  return fallback;
}

function formatHunkRange(hunk: MarkdownDiffHunk): string {
  return `@@ -${formatRange(hunk.oldStart, hunk.oldLength)} +${formatRange(hunk.newStart, hunk.newLength)} @@`;
}

function formatRange(start: number, length: number): string {
  return length === 1 ? String(start) : `${start},${length}`;
}

function openTerminalInput(): { readonly stream: NodeJS.ReadStream; readonly close: () => void } {
  if (process.stdin.isTTY) {
    return { stream: process.stdin, close: () => undefined };
  }

  try {
    const stream = new ReadStream(openSync("/dev/tty", "r"));
    return { stream, close: () => stream.destroy() };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`an interactive terminal is required: ${reason}`);
  }
}
