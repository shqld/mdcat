import { Lexer, type Token, type Tokens } from "marked";

import { diffFlow, type FlowLeaf } from "./flow.ts";
import {
  alignBySimilarity,
  sameIgnoringWhitespace,
  sameInlineContent,
  textSimilarity,
} from "./inline-diff.ts";

const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const WORD_DIFF_MARKER = /\[-([\s\S]*?)-\]|\{\+([\s\S]*?)\+\}/g;

type Side = "old" | "new";

export type DiffKind = DiffLine["kind"];

export type MarkdownDiffTableRow =
  | {
      readonly kind: DiffKind;
      readonly header: boolean;
      readonly cells: readonly string[];
    }
  | {
      readonly kind: "modification";
      readonly header: boolean;
      readonly oldCells: readonly string[];
      readonly newCells: readonly string[];
    };

export interface MarkdownDiffTableBlock {
  readonly type: "table";
  readonly rows: readonly MarkdownDiffTableRow[];
}

export type MarkdownDiffFrontmatterRow =
  | {
      readonly kind: DiffKind;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly kind: "modification";
      readonly key: string;
      readonly oldValue: string;
      readonly newValue: string;
    };

export interface MarkdownDiffFrontmatterBlock {
  readonly type: "frontmatter";
  readonly rows: readonly MarkdownDiffFrontmatterRow[];
}

export interface MarkdownDiffCodeLine {
  readonly kind: DiffKind;
  readonly text: string;
}

export interface MarkdownDiffCodeBlock {
  readonly type: "code";
  readonly language: string;
  readonly lines: readonly MarkdownDiffCodeLine[];
}

export interface MarkdownDiffFlowBlock {
  readonly type: "flow";
  readonly leaves: readonly FlowLeaf[];
}

export type MarkdownDiffBlock =
  | MarkdownDiffCodeBlock
  | MarkdownDiffFlowBlock
  | MarkdownDiffFrontmatterBlock
  | MarkdownDiffTableBlock;

export interface MarkdownDiffHunk {
  readonly oldStart: number;
  readonly oldLength: number;
  readonly newStart: number;
  readonly newLength: number;
  readonly omittedBefore: number;
  readonly blocks: readonly MarkdownDiffBlock[];
}

export interface MarkdownDiffFile {
  readonly path: string | null;
  readonly status: "added" | "deleted" | "modified" | "unchanged";
  readonly hunks: readonly MarkdownDiffHunk[];
}

export interface MarkdownDiff {
  readonly files: readonly MarkdownDiffFile[];
}

export type DiffLine =
  | {
      readonly kind: "context";
      readonly text: string;
      readonly oldLine: number;
      readonly newLine: number;
    }
  | {
      readonly kind: "addition";
      readonly text: string;
      readonly newLine: number;
    }
  | {
      readonly kind: "deletion";
      readonly text: string;
      readonly oldLine: number;
    };

interface Hunk {
  readonly oldStart: number;
  readonly oldLength: number;
  readonly newStart: number;
  readonly newLength: number;
  readonly lines: readonly DiffLine[];
}

interface DiffFile {
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
  readonly oldHeaderPath: string | null;
  readonly newHeaderPath: string | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly hunks: readonly Hunk[];
}

interface DiffLineGroup {
  readonly kind: DiffLine["kind"];
  readonly lines: readonly DiffLine[];
}

interface ParsedTableRow {
  readonly kind: DiffKind;
  readonly cells: readonly string[];
}

interface ParsedTable {
  readonly header: ParsedTableRow;
  readonly rows: readonly ParsedTableRow[];
}

interface ParsedFrontmatterEntry {
  readonly key: string;
  readonly value: string;
}

interface MutableHunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  oldConsumed: number;
  newConsumed: number;
  lines: DiffLine[];
  rawLines: string[];
  format: "unified" | "word";
}

interface WordDiffPart {
  readonly kind: DiffKind;
  readonly text: string;
}

interface MutableDiffFile {
  oldBlob: string | null;
  newBlob: string | null;
  oldHeaderPath: string | null;
  newHeaderPath: string | null;
  oldPath: string | null;
  newPath: string | null;
  hunks: MutableHunk[];
}

export function diffToMarkdown(input: string): string {
  const files = parseUnifiedDiff(stripAnsi(input));
  const rendered = files.flatMap(renderFile);

  return rendered.length === 0 ? "" : `${rendered.join("\n\n")}\n`;
}

export type ReadBlob = (blob: string, paths: readonly string[]) => string | null;

export function parseMarkdownDiff(input: string, readBlob: ReadBlob = () => null): MarkdownDiff {
  const files = parseUnifiedDiff(stripAnsi(input)).flatMap((file) => toMarkdownDiffFile(file, readBlob));
  return { files };
}

export function isUnifiedDiff(input: string): boolean {
  return parseUnifiedDiff(stripAnsi(input)).some((file) => file.hunks.length > 0);
}

export function parseMarkdownDocument(path: string | null, text: string): MarkdownDiffFile {
  const texts = text.split(/\r?\n/);
  if (texts.at(-1) === "") {
    texts.pop();
  }
  const lines = texts.map((line, index): DiffLine => ({ kind: "context", text: line, oldLine: index + 1, newLine: index + 1 }));
  const known: FenceState = { known: true, open: null };
  return {
    path,
    status: "unchanged",
    hunks: [{
      oldStart: 1,
      oldLength: lines.length,
      newStart: 1,
      newLength: lines.length,
      omittedBefore: 0,
      blocks: groupMarkdownDiffLines(lines, 1, 1, { old: known, new: known }),
    }],
  };
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
}

function parseUnifiedDiff(input: string): readonly DiffFile[] {
  const files: MutableDiffFile[] = [];
  let file: MutableDiffFile | null = null;
  let hunk: MutableHunk | null = null;
  let completedHunk: MutableHunk | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      file = { oldBlob: null, newBlob: null, oldHeaderPath: null, newHeaderPath: null, oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      completedHunk = null;
      continue;
    }

    const reopened: MutableHunk | null = hunk === null && !HUNK_HEADER.test(rawLine)
      ? reopenAsWordDiff(completedHunk, rawLine)
      : null;
    if (reopened !== null) {
      hunk = reopened;
    }
    completedHunk = null;

    if (file === null) {
      if (rawLine.startsWith("--- ")) {
        file = { oldBlob: null, newBlob: null, oldHeaderPath: headerPath(rawLine.slice(4)), newHeaderPath: null, oldPath: parseHeaderPath(rawLine.slice(4)), newPath: null, hunks: [] };
        files.push(file);
      } else {
        continue;
      }
    }

    const blobs = hunk === null ? rawLine.match(INDEX_LINE) : null;
    if (blobs !== null) {
      file.oldBlob = blobs[1] ?? null;
      file.newBlob = blobs[2] ?? null;
      continue;
    }

    if (hunk === null && rawLine.startsWith("--- ") && file.hunks.length > 0) {
      file = { oldBlob: null, newBlob: null, oldHeaderPath: headerPath(rawLine.slice(4)), newHeaderPath: null, oldPath: parseHeaderPath(rawLine.slice(4)), newPath: null, hunks: [] };
      files.push(file);
      continue;
    }

    if (hunk === null && rawLine.startsWith("--- ")) {
      file.oldPath = parseHeaderPath(rawLine.slice(4));
      file.oldHeaderPath = headerPath(rawLine.slice(4));
      continue;
    }

    if (hunk === null && rawLine.startsWith("+++ ")) {
      file.newPath = parseHeaderPath(rawLine.slice(4));
      file.newHeaderPath = headerPath(rawLine.slice(4));
      continue;
    }

    const hunkMatch = rawLine.match(HUNK_HEADER);
    if (hunkMatch !== null) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLength: parseHunkLength(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLength: parseHunkLength(hunkMatch[4]),
        oldConsumed: 0,
        newConsumed: 0,
        lines: [],
        rawLines: [],
        format: "unified",
      };
      file.hunks.push(hunk);
      continue;
    }

    if (hunk !== null) {
      hunk.rawLines.push(rawLine);
      if (hunk.format === "word" || rawLine.startsWith("\\")) {
        continue;
      }

      const line = parseDiffLine(hunk, rawLine);
      if (line === null) {
        hunk.format = "word";
        continue;
      }

      hunk.lines.push(line);
      consumeHunkLine(hunk, line);
      if (hunk.oldConsumed >= hunk.oldLength && hunk.newConsumed >= hunk.newLength) {
        completedHunk = hunk;
        hunk = null;
      }
    }
  }

  for (const hunk of files.flatMap((diffFile) => diffFile.hunks)) {
    if (isWordDiffHunk(hunk)) {
      hunk.lines = parseWordDiffLines(hunk);
    }
  }
  return files;
}

function reopenAsWordDiff(hunk: MutableHunk | null, rawLine: string): MutableHunk | null {
  if (hunk === null || (rawLine !== "~" && hunk.lines.some((line) => line.kind !== "context"))) {
    return null;
  }
  hunk.format = "word";
  return hunk;
}

function isWordDiffHunk(hunk: MutableHunk): boolean {
  if (hunk.format === "word") {
    return true;
  }
  const incomplete = hunk.oldConsumed < hunk.oldLength || hunk.newConsumed < hunk.newLength;
  const unchanged = hunk.lines.every((line) => line.kind === "context");
  return (incomplete || unchanged)
    && hunk.rawLines.some((line) => new RegExp(WORD_DIFF_MARKER).test(line));
}

function isPorcelainWordDiff(rawLines: readonly string[]): boolean {
  return rawLines.includes("~") && rawLines.every((line) => /^(?:[ +\-\\~]|$)/.test(line));
}

function parseWordDiffLines(hunk: MutableHunk): DiffLine[] {
  const porcelain = isPorcelainWordDiff(hunk.rawLines);
  const logicalLines = porcelain
    ? parsePorcelainWordDiff(hunk.rawLines)
    : hunk.rawLines.flatMap((line) =>
      line === "\\ No newline at end of file" ? [] : [parsePlainWordDiffLine(line)]
    );

  const lines: DiffLine[] = [];
  const deletions: string[] = [];
  const additions: string[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  function flush(): void {
    for (const text of deletions) {
      lines.push({ kind: "deletion", text, oldLine });
      oldLine += 1;
    }
    for (const text of additions) {
      lines.push({ kind: "addition", text, newLine });
      newLine += 1;
    }
    deletions.length = 0;
    additions.length = 0;
  }

  for (const parts of attachBlankWordDiffLines(logicalLines)) {
    const hasContext = parts.some((part) => part.kind === "context");
    const hasOld = hasContext || parts.some((part) => part.kind === "deletion");
    const hasNew = hasContext || parts.some((part) => part.kind === "addition");
    const oldText = parts.filter((part) => part.kind !== "addition").map((part) => part.text).join("");
    const newText = parts.filter((part) => part.kind !== "deletion").map((part) => part.text).join("");

    if (hasOld && hasNew && oldText === newText) {
      flush();
      lines.push({ kind: "context", text: newText, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (hasOld) {
      deletions.push(oldText);
    }
    if (hasNew) {
      additions.push(newText);
    }
  }
  flush();

  return lines;
}

function attachBlankWordDiffLines(
  lines: readonly (readonly WordDiffPart[])[],
): readonly (readonly WordDiffPart[])[] {
  const sides = lines.map(wordDiffLineSides);

  return lines.map((parts, index) => {
    if (sides[index] !== null || !parts.every((part) => part.kind === "context")) {
      return parts;
    }
    const neighbors = [
      sides.slice(0, index).findLast((side) => side !== null),
      sides.slice(index + 1).find((side) => side !== null),
    ].filter((side) => side !== undefined && side !== null);
    const changedKinds: readonly DiffKind[] = ["deletion", "addition"];
    const shared = changedKinds.filter((kind) =>
      neighbors.length > 0 && neighbors.every((side) => side.includes(kind))
    );
    const [kind] = shared;
    return shared.length === 1 && kind !== undefined ? [{ kind, text: "" }] : parts;
  });
}

function wordDiffLineSides(parts: readonly WordDiffPart[]): readonly DiffKind[] | null {
  if (parts.every((part) => part.text.length === 0)) {
    return null;
  }
  const oldText = parts.filter((part) => part.kind !== "addition").map((part) => part.text).join("");
  const newText = parts.filter((part) => part.kind !== "deletion").map((part) => part.text).join("");
  if (parts.some((part) => part.kind === "context")) {
    return oldText === newText ? [] : ["deletion", "addition"];
  }
  return [...new Set(parts.map((part) => part.kind))];
}

function parsePlainWordDiffLine(line: string): readonly WordDiffPart[] {
  const parts: WordDiffPart[] = [];
  let cursor = 0;

  for (const match of line.matchAll(WORD_DIFF_MARKER)) {
    if (match.index > cursor) {
      parts.push({ kind: "context", text: line.slice(cursor, match.index) });
    }
    parts.push(match[1] === undefined
      ? { kind: "addition", text: match[2] ?? "" }
      : { kind: "deletion", text: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < line.length || parts.length === 0) {
    parts.push({ kind: "context", text: line.slice(cursor) });
  }
  return parts;
}

function parsePorcelainWordDiff(rawLines: readonly string[]): readonly (readonly WordDiffPart[])[] {
  const lines: WordDiffPart[][] = [];
  let parts: WordDiffPart[] = [];

  for (const rawLine of rawLines) {
    if (rawLine === "~") {
      lines.push(parts);
      parts = [];
      continue;
    }
    const kind = rawLine.startsWith(" ")
      ? "context"
      : rawLine.startsWith("-")
        ? "deletion"
        : rawLine.startsWith("+")
          ? "addition"
          : null;
    if (kind !== null) {
      parts.push({ kind, text: rawLine.slice(1) });
    }
  }
  if (parts.length > 0) {
    lines.push(parts);
  }
  return lines;
}

function parseDiffLine(hunk: MutableHunk, line: string): DiffLine | null {
  const text = line.slice(1);

  if (line.startsWith(" ") || line.length === 0) {
    return {
      kind: "context",
      text,
      oldLine: hunk.oldStart + hunk.oldConsumed,
      newLine: hunk.newStart + hunk.newConsumed,
    };
  }
  if (line.startsWith("+")) {
    return {
      kind: "addition",
      text,
      newLine: hunk.newStart + hunk.newConsumed,
    };
  }
  if (line.startsWith("-")) {
    return {
      kind: "deletion",
      text,
      oldLine: hunk.oldStart + hunk.oldConsumed,
    };
  }

  return null;
}

function consumeHunkLine(hunk: MutableHunk, line: DiffLine): void {
  if (line.kind === "context" || line.kind === "deletion") {
    hunk.oldConsumed += 1;
  }
  if (line.kind === "context" || line.kind === "addition") {
    hunk.newConsumed += 1;
  }
}

function parseHunkLength(value: string | undefined): number {
  return value === undefined ? 1 : Number(value);
}

function parseHeaderPath(value: string): string | null {
  const path = headerPath(value);
  return path !== null && (path.startsWith("a/") || path.startsWith("b/")) ? path.slice(2) : path;
}

function headerPath(value: string): string | null {
  const path = value.startsWith('"')
    ? parseQuotedPath(value)
    : (value.split("\t", 1)[0] ?? "");
  return path === "/dev/null" ? null : path;
}

function parseQuotedPath(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();

  function append(valueToAppend: string): void {
    bytes.push(...encoder.encode(valueToAppend));
  }

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined || character === '"') {
      break;
    }
    if (character !== "\\") {
      append(character);
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      break;
    }

    const escapeValue = decodeSimpleEscape(escaped);
    if (escapeValue !== null) {
      append(escapeValue);
      index += 1;
      continue;
    }

    if (/[0-7]/.test(escaped)) {
      const octal = value.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? "";
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    append(escaped);
    index += 1;
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function decodeSimpleEscape(value: string): string | null {
  const escapes: Readonly<Record<string, string>> = {
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };

  return escapes[value] ?? null;
}

function renderFile(file: DiffFile): readonly string[] {
  const side: Side = file.newPath === null ? "old" : "new";
  const path = side === "new" ? file.newPath : file.oldPath;

  if (path === null || !path.endsWith(".md") || file.hunks.length === 0) {
    return [];
  }

  const body = renderHunks(file.hunks, side);
  if (body.length === 0) {
    return [];
  }

  const status = side === "old" ? " · deleted" : "";
  return [`# \`${escapeInlineCode(path)}\`${status}\n\n${body}`];
}

function renderHunks(hunks: readonly Hunk[], side: Side): string {
  const sections: string[] = [];
  let previousEnd = 0;

  for (const hunk of hunks) {
    const start = side === "new" ? hunk.newStart : hunk.oldStart;
    const length = side === "new" ? hunk.newLength : hunk.oldLength;
    const gap = start - previousEnd - 1;

    const renderedContent = renderRichDiff(hunk.lines);
    sections.push(gap > 0 ? `${omission(gap)}\n\n${renderedContent}` : renderedContent);

    previousEnd = start + length - 1;
  }

  return sections.join("\n\n---\n\n");
}

function renderRichDiff(lines: readonly DiffLine[]): string {
  if (lines.length === 0) {
    return "*… empty hunk …*";
  }

  return groupDiffLines(lines).map(renderLineGroup).filter(Boolean).join("\n\n");
}

function groupDiffLines(lines: readonly DiffLine[]): readonly DiffLineGroup[] {
  const groups: { kind: DiffLine["kind"]; lines: DiffLine[] }[] = [];

  for (const line of lines) {
    const current = groups.at(-1);
    if (current === undefined || current.kind !== line.kind) {
      groups.push({ kind: line.kind, lines: [line] });
    } else {
      current.lines.push(line);
    }
  }

  return groups;
}

function toMarkdownDiffFile(file: DiffFile, readBlob: ReadBlob): readonly MarkdownDiffFile[] {
  const side: Side = file.newPath === null ? "old" : "new";
  const path = side === "new" ? file.newPath : file.oldPath;

  if (path === null || !path.toLowerCase().endsWith(".md") || file.hunks.length === 0) {
    return [];
  }

  const status = file.oldPath === null ? "added" : file.newPath === null ? "deleted" : "modified";
  const oldFences = lazyFences(file.oldBlob, [file.oldPath, file.oldHeaderPath], readBlob);
  const newFences = lazyFences(file.newBlob, [file.newPath, file.newHeaderPath], readBlob);
  let previousEnd = 0;
  const hunks = file.hunks.map((hunk): MarkdownDiffHunk => {
    const start = side === "new" ? hunk.newStart : hunk.oldStart;
    const length = side === "new" ? hunk.newLength : hunk.oldLength;
    const omittedBefore = Math.max(0, start - previousEnd - 1);
    previousEnd = start + length - 1;

    return {
      oldStart: hunk.oldStart,
      oldLength: hunk.oldLength,
      newStart: hunk.newStart,
      newLength: hunk.newLength,
      omittedBefore,
      blocks: groupMarkdownDiffLines(hunk.lines, hunk.oldStart, hunk.newStart, {
        old: fenceBefore(hunk.oldStart, oldFences),
        new: fenceBefore(hunk.newStart, newFences),
      }),
    };
  });

  return [{ path, status, hunks }];
}

function lazyFences(
  blob: string | null,
  paths: readonly (string | null)[],
  readBlob: ReadBlob,
): () => readonly (string | null)[] | null {
  let cached: readonly (string | null)[] | null | undefined;
  return () => {
    if (cached === undefined) {
      const candidates = [...new Set(paths.filter((path) => path !== null))];
      const text = blob === null || candidates.length === 0 || /^0+$/.test(blob) ? null : readBlob(blob, candidates);
      cached = text === null ? null : fenceStates(text);
    }
    return cached;
  };
}

function fenceStates(text: string): readonly (string | null)[] {
  const states: (string | null)[] = [];
  let open: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    states.push(open);
    open = nextFence(open, line).open;
  }
  states.push(open);
  return states;
}

function fenceBefore(start: number, fences: () => readonly (string | null)[] | null): FenceState {
  if (start <= 1) {
    return { known: true, open: null };
  }
  const states = fences();
  const open = states?.[start - 1];
  return states === null || open === undefined ? { known: false } : { known: true, open };
}

function groupMarkdownDiffLines(
  lines: readonly DiffLine[],
  oldStart: number,
  newStart: number,
  fences: { readonly old: FenceState; readonly new: FenceState },
): readonly MarkdownDiffBlock[] {
  const blocks: MarkdownDiffBlock[] = [];
  const frontmatterEnd = findFrontmatterEnd(lines, oldStart, newStart);
  let plainStart = frontmatterEnd ?? 0;
  let index = frontmatterEnd ?? 0;

  if (frontmatterEnd !== null) {
    blocks.push(...toFrontmatterBlocks(lines.slice(0, frontmatterEnd)));
  }

  if ((!fences.old.known || !fences.new.known) && lines.some((line) => FENCE_OPEN.test(line.text))) {
    const raw: MarkdownDiffCodeBlock = {
      type: "code",
      language: "",
      lines: lines.slice(plainStart).map((line) => ({ kind: line.kind, text: line.text })),
    };
    return [...blocks, raw];
  }
  const code = codeMembership(lines, fences);
  while (index < lines.length) {
    if (code[index]?.inCode === true) {
      let end = index;
      while (end < lines.length && code[end]?.inCode === true) {
        end += 1;
      }
      blocks.push(...toMarkdownBlocks(lines.slice(plainStart, index)));
      const block = toCodeBlock(lines.slice(index, end), code.slice(index, end));
      if (block.lines.length > 0) {
        blocks.push(block);
      }
      plainStart = end;
      index = end;
      continue;
    }
    const tableEnd = findTableEnd(lines, index);
    if (tableEnd === null) {
      index += 1;
      continue;
    }

    blocks.push(...toMarkdownBlocks(lines.slice(plainStart, index)));
    blocks.push(...toTableDiffBlocks(lines.slice(index, tableEnd)));
    index = tableEnd;
    plainStart = tableEnd;
  }

  blocks.push(...toMarkdownBlocks(lines.slice(plainStart)));
  return blocks;
}

function findFrontmatterEnd(
  lines: readonly DiffLine[],
  oldStart: number,
  newStart: number,
): number | null {
  const oldEnd = frontmatterEndForSide(lines, "old", oldStart);
  const newEnd = frontmatterEndForSide(lines, "new", newStart);
  if (oldEnd === null) {
    return newEnd;
  }
  if (newEnd === null) {
    return oldEnd;
  }
  return Math.max(oldEnd, newEnd);
}

function frontmatterEndForSide(
  lines: readonly DiffLine[],
  side: Side,
  start: number,
): number | null {
  if (start !== 1) {
    return null;
  }

  const sideKind = side === "old" ? "deletion" : "addition";
  const sideLines = lines.flatMap((line, index) =>
    line.kind === "context" || line.kind === sideKind ? [{ index, text: line.text }] : []
  );
  if (sideLines[0]?.text.trim() !== "---") {
    return null;
  }

  for (const line of sideLines.slice(1)) {
    const text = line.text.trim();
    if (text === "---" || text === "...") {
      return line.index + 1;
    }
  }
  return null;
}

function toFrontmatterBlocks(lines: readonly DiffLine[]): readonly MarkdownDiffBlock[] {
  const oldEntries = parseFrontmatterSide(lines, "old");
  const newEntries = parseFrontmatterSide(lines, "new");
  const rows = mergeFrontmatter(oldEntries, newEntries);
  return rows.length === 0 ? toMarkdownBlocks(lines) : [{ type: "frontmatter", rows }];
}

function parseFrontmatterSide(
  lines: readonly DiffLine[],
  side: Side,
): readonly ParsedFrontmatterEntry[] {
  const sideKind = side === "old" ? "deletion" : "addition";
  const sideLines = lines
    .filter((line) => line.kind === "context" || line.kind === sideKind)
    .map((line) => line.text);
  const end = sideLines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim()));
  return sideLines[0]?.trim() === "---" && end > 0
    ? parseFrontmatterEntries(sideLines.slice(1, end))
    : [];
}

function parseFrontmatterEntries(lines: readonly string[]): readonly ParsedFrontmatterEntry[] {
  const entries: ParsedFrontmatterEntry[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || /^\s/.test(line)) {
      index += 1;
      continue;
    }

    const separator = trimmed.indexOf(":");
    const key = separator < 0 ? "" : trimmed.slice(0, separator).trim();
    if (key.length === 0) {
      index += 1;
      continue;
    }

    const rawValue = trimmed.slice(separator + 1).trim();
    const continuation: string[] = [];
    index += 1;
    while (index < lines.length && /^\s/.test(lines[index] ?? "")) {
      const part = (lines[index] ?? "").trim();
      if (part.length > 0 && !part.startsWith("#")) {
        continuation.push(part.startsWith("- ") ? part.slice(2).trim() : part);
      }
      index += 1;
    }

    entries.push({
      key,
      value: formatFrontmatterValue(rawValue, continuation),
    });
  }

  return entries;
}

function formatFrontmatterValue(rawValue: string, continuation: readonly string[]): string {
  if ([">", ">-", "|", "|-"].includes(rawValue)) {
    return continuation.join(" ");
  }
  if (rawValue.length === 0 && continuation.length > 0) {
    return continuation.join(", ");
  }
  return stripMatchingQuotes(rawValue);
}

function stripMatchingQuotes(value: string): string {
  const quote = value[0];
  return value.length >= 2
    && (quote === "\"" || quote === "'")
    && value.at(-1) === quote
    ? value.slice(1, -1)
    : value;
}

function mergeFrontmatter(
  oldEntries: readonly ParsedFrontmatterEntry[],
  newEntries: readonly ParsedFrontmatterEntry[],
): readonly MarkdownDiffFrontmatterRow[] {
  const newByKey = new Map(newEntries.map((entry) => [entry.key, entry]));
  const oldKeys = new Set(oldEntries.map((entry) => entry.key));
  const rows: MarkdownDiffFrontmatterRow[] = oldEntries.map((oldEntry) => {
    const newEntry = newByKey.get(oldEntry.key);
    if (newEntry === undefined) {
      return { kind: "deletion", key: oldEntry.key, value: oldEntry.value };
    }
    if (sameIgnoringWhitespace(oldEntry.value, newEntry.value)) {
      return { kind: "context", key: oldEntry.key, value: newEntry.value };
    }
    return {
      kind: "modification",
      key: oldEntry.key,
      oldValue: oldEntry.value,
      newValue: newEntry.value,
    };
  });

  for (const entry of newEntries) {
    if (!oldKeys.has(entry.key)) {
      rows.push({ kind: "addition", key: entry.key, value: entry.value });
    }
  }
  return rows;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

interface CodeMembership {
  readonly inCode: boolean;
  readonly fence: boolean;
}

type FenceState = { readonly known: true; readonly open: string | null } | { readonly known: false };

function nextFence(open: string | null, text: string): { readonly open: string | null; readonly fence: boolean } {
  if (open === null) {
    const match = text.match(FENCE_OPEN);
    const fence = match?.[1];
    return fence === undefined || (fence.startsWith("`") && (match?.[2] ?? "").includes("`"))
      ? { open: null, fence: false }
      : { open: fence, fence: true };
  }
  const closing = text.match(FENCE_CLOSE)?.[1];
  return closing !== undefined && closing[0] === open[0] && closing.length >= open.length
    ? { open: null, fence: true }
    : { open, fence: false };
}

function codeMembership(
  lines: readonly DiffLine[],
  fences: { readonly old: FenceState; readonly new: FenceState },
): readonly CodeMembership[] {
  const oldSide = sideCodeMembership(lines, "old", fences.old.known ? fences.old.open : null);
  const newSide = sideCodeMembership(lines, "new", fences.new.known ? fences.new.open : null);
  return lines.map((line, index): CodeMembership => {
    const old = oldSide[index];
    const current = newSide[index];
    if (line.kind === "deletion") {
      return old ?? { inCode: false, fence: false };
    }
    if (line.kind === "addition") {
      return current ?? { inCode: false, fence: false };
    }
    return {
      inCode: old?.inCode === true && current?.inCode === true,
      fence: old?.fence === true && current?.fence === true,
    };
  });
}

function sideCodeMembership(
  lines: readonly DiffLine[],
  side: Side,
  initial: string | null,
): readonly (CodeMembership | undefined)[] {
  const excluded = side === "old" ? "addition" : "deletion";
  let open = initial;
  return lines.map((line): CodeMembership | undefined => {
    if (line.kind === excluded) {
      return undefined;
    }
    const wasOpen = open !== null;
    const next = nextFence(open, line.text);
    open = next.open;
    return { inCode: wasOpen || next.fence, fence: next.fence };
  });
}

function toCodeBlock(
  lines: readonly DiffLine[],
  membership: readonly CodeMembership[],
  fallbackLanguage?: string,
): MarkdownDiffCodeBlock {
  const fenceLines = lines.filter((_, index) => membership[index]?.fence === true);
  const opener = (kind: DiffKind): string | undefined =>
    fenceLines.find((line) => line.kind === kind && FENCE_OPEN.test(line.text) && !FENCE_CLOSE.test(line.text))?.text;
  const oldOpener = opener("deletion");
  const newOpener = opener("addition");
  const languageOf = (fence: string | undefined): string => fence?.match(FENCE_OPEN)?.[2]?.trim().split(/\s+/)[0] ?? "";
  const keepChangedOpeners = oldOpener !== undefined && newOpener !== undefined
    && languageOf(oldOpener) !== languageOf(newOpener);
  const languageSource = newOpener ?? fenceLines.find((line) => line.kind === "context")?.text ?? oldOpener;
  const language = fallbackLanguage ?? languageOf(languageSource);
  const body = lines.filter((line, index) =>
    membership[index]?.fence !== true
    || (keepChangedOpeners && (line.text === oldOpener || line.text === newOpener) && line.kind !== "context")
  );
  return { type: "code", language, lines: codeLines(body) };
}

function codeLines(lines: readonly DiffLine[]): readonly MarkdownDiffCodeLine[] {
  const result: MarkdownDiffCodeLine[] = [];
  const groups = groupDiffLines(lines);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group === undefined) {
      continue;
    }
    const texts = group.lines.map((line) => line.text);
    const next = groups[index + 1];
    if (group.kind === "deletion" && next?.kind === "addition") {
      result.push(...pairCodeLines(texts, next.lines.map((line) => line.text)));
      index += 1;
      continue;
    }
    for (const text of texts) {
      if (group.kind === "context" || text.trim().length > 0) {
        result.push({ kind: group.kind, text });
      } else if (group.kind === "addition") {
        result.push({ kind: "context", text });
      }
    }
  }
  return result;
}

function pairCodeLines(deleted: readonly string[], added: readonly string[]): readonly MarkdownDiffCodeLine[] {
  const result: MarkdownDiffCodeLine[] = [];
  let deletions: MarkdownDiffCodeLine[] = [];
  let additions: MarkdownDiffCodeLine[] = [];
  const flush = (): void => {
    result.push(...deletions, ...additions);
    deletions = [];
    additions = [];
  };
  const similarity = (oldText: string | undefined, newText: string | undefined): number =>
    oldText === undefined || newText === undefined
      ? 0
      : sameIgnoringWhitespace(oldText, newText) ? 1 : textSimilarity(oldText, newText);

  for (const pair of alignBySimilarity(deleted, added, similarity)) {
    if (pair.old !== undefined && pair.new !== undefined && sameIgnoringWhitespace(pair.old, pair.new)) {
      flush();
      result.push({ kind: "context", text: pair.new });
      continue;
    }
    if (pair.old !== undefined && pair.old.trim().length > 0) {
      deletions.push({ kind: "deletion", text: pair.old });
    }
    if (pair.new !== undefined) {
      (pair.new.trim().length > 0 ? additions : result).push({
        kind: pair.new.trim().length > 0 ? "addition" : "context",
        text: pair.new,
      });
    }
  }
  flush();
  return result;
}

function findTableEnd(lines: readonly DiffLine[], start: number): number | null {
  const first = lines[start];
  if (first === undefined || !isTableRow(first.text)) {
    return null;
  }

  let end = start;
  while (end < lines.length && isTableRow(lines[end]?.text ?? "")) {
    end += 1;
  }

  const candidate = lines.slice(start, end);
  const oldTable = parseTableSide(candidate, "old");
  const newTable = parseTableSide(candidate, "new");
  const hasChange = candidate.some((line) => line.kind !== "context");
  const partial = parsePartialTableSide(candidate, "old") !== null
    && parsePartialTableSide(candidate, "new") !== null;

  return hasChange && (oldTable !== null || newTable !== null || partial) ? end : null;
}

function toTableDiffBlocks(lines: readonly DiffLine[]): readonly MarkdownDiffBlock[] {
  const oldTable = parseTableSide(lines, "old");
  const newTable = parseTableSide(lines, "new");

  if (oldTable === null && newTable === null) {
    const oldRows = parsePartialTableSide(lines, "old");
    const newRows = parsePartialTableSide(lines, "new");
    return oldRows === null || newRows === null
      ? toMarkdownBlocks(lines)
      : [{ type: "table", rows: mergeTableRows(oldRows, newRows) }];
  }

  return [{
    type: "table",
    rows: mergeTables(oldTable, newTable),
  }];
}

function parseTableSide(lines: readonly DiffLine[], side: Side): ParsedTable | null {
  const sideKind = side === "old" ? "deletion" : "addition";
  const sideLines = lines.filter((line) => line.kind === "context" || line.kind === sideKind);
  const firstToken = Lexer.lex(sideLines.map((line) => line.text).join("\n"), { gfm: true })[0];

  if (!isTableToken(firstToken) || sideLines.length !== firstToken.rows.length + 2) {
    return null;
  }

  const headerLine = sideLines[0];
  if (headerLine === undefined) {
    return null;
  }

  const rows = firstToken.rows.flatMap((cells, index): readonly ParsedTableRow[] => {
    const source = sideLines[index + 2];
    return source === undefined ? [] : [{ kind: source.kind, cells: cells.map((cell) => cell.text) }];
  });

  return {
    header: { kind: headerLine.kind, cells: firstToken.header.map((cell) => cell.text) },
    rows,
  };
}

function parsePartialTableSide(lines: readonly DiffLine[], side: Side): readonly ParsedTableRow[] | null {
  const sideKind = side === "old" ? "deletion" : "addition";
  const sideLines = lines.filter((line) =>
    (line.kind === "context" || line.kind === sideKind) && !TABLE_DELIMITER.test(line.text)
  );
  const [first] = sideLines;
  if (first === undefined) {
    return [];
  }
  const leadingPipes = sideLines.every((line) => line.text.trimStart().startsWith("|"));
  if (!leadingPipes && (sideLines.length < 2 || new Set(sideLines.map((line) => partialCellCount(line.text))).size !== 1)) {
    return null;
  }

  const delimiter = first.text.replace(/[^|]/g, "-");
  const source = [first.text, delimiter, ...sideLines.slice(1).map((line) => line.text)].join("\n");
  const token = Lexer.lex(source, { gfm: true })[0];
  if (!isTableToken(token) || token.rows.length + 1 !== sideLines.length) {
    return null;
  }

  return [token.header, ...token.rows].flatMap((cells, index): readonly ParsedTableRow[] => {
    const line = sideLines[index];
    return line === undefined ? [] : [{ kind: line.kind, cells: cells.map((cell) => cell.text) }];
  });
}

function partialCellCount(text: string): number {
  const token = Lexer.lex(`${text}\n${text.replace(/[^|]/g, "-")}`, { gfm: true })[0];
  return isTableToken(token) ? token.header.length : 0;
}

function isTableToken(token: Token | undefined): token is Tokens.Table {
  return token?.type === "table" && "header" in token && "rows" in token;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.includes("|");
}

function mergeTables(oldTable: ParsedTable | null, newTable: ParsedTable | null): readonly MarkdownDiffTableRow[] {
  if (oldTable === null) {
    return newTable === null ? [] : tableRows(newTable);
  }
  if (newTable === null) {
    return tableRows(oldTable);
  }

  return [
    ...mergeHeader(oldTable.header, newTable.header),
    ...mergeTableRows(oldTable.rows, newTable.rows),
  ];
}

function tableRows(table: ParsedTable): readonly MarkdownDiffTableRow[] {
  return [
    { kind: table.header.kind, header: true, cells: table.header.cells },
    ...table.rows.map((row): MarkdownDiffTableRow => ({
      kind: row.kind,
      header: false,
      cells: row.cells,
    })),
  ];
}

function mergeHeader(oldRow: ParsedTableRow, newRow: ParsedTableRow): readonly MarkdownDiffTableRow[] {
  if (rowsEqual(oldRow, newRow)) {
    return [{ kind: "context", header: true, cells: newRow.cells }];
  }
  if (oldRow.cells.length === newRow.cells.length) {
    return [{
      kind: "modification",
      header: true,
      oldCells: oldRow.cells,
      newCells: newRow.cells,
    }];
  }
  return [
    { kind: "deletion", header: true, cells: oldRow.cells },
    { kind: "addition", header: true, cells: newRow.cells },
  ];
}

function mergeTableRows(
  oldRows: readonly ParsedTableRow[],
  newRows: readonly ParsedTableRow[],
): readonly MarkdownDiffTableRow[] {
  const rows: MarkdownDiffTableRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldRows.length || newIndex < newRows.length) {
    const oldRow = oldRows[oldIndex];
    const newRow = newRows[newIndex];

    if (oldRow?.kind === "context" && newRow?.kind === "context") {
      rows.push({ kind: "context", header: false, cells: newRow.cells });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (oldRow?.kind === "context" && newRow === undefined) {
      rows.push({ kind: "context", header: false, cells: oldRow.cells });
      oldIndex += 1;
      continue;
    }
    if (newRow?.kind === "context" && oldRow === undefined) {
      rows.push({ kind: "context", header: false, cells: newRow.cells });
      newIndex += 1;
      continue;
    }

    const oldEnd = nextContextIndex(oldRows, oldIndex);
    const newEnd = nextContextIndex(newRows, newIndex);
    rows.push(...pairChangedRows(oldRows.slice(oldIndex, oldEnd), newRows.slice(newIndex, newEnd)));
    oldIndex = oldEnd;
    newIndex = newEnd;
  }

  return rows;
}

function nextContextIndex(rows: readonly ParsedTableRow[], start: number): number {
  let index = start;
  while (index < rows.length && rows[index]?.kind !== "context") {
    index += 1;
  }
  return index;
}

function pairChangedRows(
  oldRows: readonly ParsedTableRow[],
  newRows: readonly ParsedTableRow[],
): readonly MarkdownDiffTableRow[] {
  return alignBySimilarity(oldRows, newRows, rowSimilarity)
    .flatMap((pair) => pairRows(pair.old, pair.new));
}

function pairRows(
  oldRow: ParsedTableRow | undefined,
  newRow: ParsedTableRow | undefined,
): readonly MarkdownDiffTableRow[] {
  if (oldRow === undefined) {
    return newRow === undefined ? [] : [{ kind: "addition", header: false, cells: newRow.cells }];
  }
  if (newRow === undefined) {
    return [{ kind: "deletion", header: false, cells: oldRow.cells }];
  }
  if (oldRow.cells.length !== newRow.cells.length) {
    return [
      { kind: "deletion", header: false, cells: oldRow.cells },
      { kind: "addition", header: false, cells: newRow.cells },
    ];
  }
  if (rowsEqual(oldRow, newRow)) {
    return [{ kind: "context", header: false, cells: newRow.cells }];
  }
  return [{
    kind: "modification",
    header: false,
    oldCells: oldRow.cells,
    newCells: newRow.cells,
  }];
}

function rowSimilarity(oldRow: ParsedTableRow | undefined, newRow: ParsedTableRow | undefined): number {
  if (oldRow === undefined || newRow === undefined || oldRow.cells.length !== newRow.cells.length) {
    return 0;
  }
  if (rowsEqual(oldRow, newRow)) {
    return 1;
  }

  const oldKey = oldRow.cells[0]?.trim();
  const newKey = newRow.cells[0]?.trim();
  if (oldKey !== undefined && oldKey.length > 0 && oldKey === newKey) {
    return 0.9;
  }

  return textSimilarity(oldRow.cells.join(" "), newRow.cells.join(" "));
}

function rowsEqual(oldRow: ParsedTableRow, newRow: ParsedTableRow): boolean {
  return oldRow.cells.length === newRow.cells.length
    && oldRow.cells.every((cell, index) => sameInlineContent(cell, newRow.cells[index] ?? ""));
}

function toMarkdownBlocks(lines: readonly DiffLine[]): readonly MarkdownDiffBlock[] {
  const leaves = diffFlow(sideText(lines, "old"), sideText(lines, "new"));
  return leaves.length === 0 ? [] : [{ type: "flow", leaves }];
}

function sideText(lines: readonly DiffLine[], side: Side): string {
  const excluded = side === "old" ? "addition" : "deletion";
  return lines.filter((line) => line.kind !== excluded).map((line) => line.text).join("\n");
}

function renderLineGroup(group: DiffLineGroup): string {
  const content = trimBoundaryBlankLines(group.lines.map((line) => line.text));

  if (group.kind === "context") {
    return content.join("\n");
  }

  const marker = group.kind === "addition" ? "🟢 **Added**" : "🔴 **Removed**";
  const body = content.length === 0 ? ["*blank line*"] : content;

  return [`> ${marker}`, ">", ...body.map(quoteMarkdown)].join("\n");
}

function trimBoundaryBlankLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start] === "") {
    start += 1;
  }
  while (end > start && lines[end - 1] === "") {
    end -= 1;
  }

  return lines.slice(start, end);
}

function quoteMarkdown(line: string): string {
  return line.length === 0 ? ">" : `> ${line}`;
}

function omission(lines: number): string {
  return `*… ${lines} unchanged ${lines === 1 ? "line" : "lines"} omitted …*`;
}

function escapeInlineCode(value: string): string {
  return value.replaceAll("`", "\\`");
}
