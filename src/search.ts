import {
  RGBA,
  TextBufferRenderable,
  TextTableRenderable,
  type OptimizedBuffer,
  type Renderable,
} from "@opentui/core";
import stringWidth from "string-width";

const CHAR_FLAG_MASK = 0xc0000000;
const CHAR_FLAG_CONTINUATION = 0xc0000000;

export interface SearchRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SearchHighlight {
  readonly match: RGBA;
  readonly current: RGBA;
  readonly text: RGBA;
}

export function searchPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  const source = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(source, query === query.toLowerCase() ? "gi" : "g");
}

function* matches(pattern: RegExp, text: string): Generator<{ readonly start: number; readonly end: number }> {
  for (const match of text.matchAll(pattern)) {
    yield { start: match.index, end: match.index + match[0].length };
  }
}

export function findMatchLines(content: Renderable, query: string): number[] {
  const pattern = searchPattern(query);
  if (pattern === null) {
    return [];
  }
  const lines = new Set<number>();
  const visit = (renderable: Renderable): void => {
    if (!renderable.visible) {
      return;
    }
    const top = renderable.y - content.y;
    if (renderable instanceof TextBufferRenderable) {
      for (const line of textMatchLines(renderable, pattern)) {
        lines.add(top + line);
      }
    } else if (renderable instanceof TextTableRenderable) {
      if (!matches(pattern, tableText(renderable)).next().done) {
        lines.add(top);
      }
    }
    for (const child of renderable.getChildren()) {
      visit(child);
    }
  };
  visit(content);
  return [...lines].sort((a, b) => a - b);
}

function textMatchLines(renderable: TextBufferRenderable, pattern: RegExp): number[] {
  const text = renderable.plainText;
  const starts = renderable.lineInfo.lineStartCols;
  const lines: number[] = [];
  for (const { start } of matches(pattern, text)) {
    const column = stringWidth(text.slice(0, start).replace(/\n/g, " "));
    let line = 0;
    while (line + 1 < starts.length && (starts[line + 1] ?? Number.POSITIVE_INFINITY) <= column) {
      line += 1;
    }
    lines.push(line);
  }
  return lines;
}

function tableText(table: TextTableRenderable): string {
  return table.content
    .map((row) => row.map((cell) => (cell ?? []).map((chunk) => chunk.text).join("")).join(" "))
    .join("\n");
}

export function highlightMatches(
  buffer: OptimizedBuffer,
  region: SearchRegion,
  query: string,
  currentRow: number | null,
  colors: SearchHighlight,
): void {
  const pattern = searchPattern(query);
  if (pattern === null) {
    return;
  }
  const { char, bg, fg } = buffer.buffers;
  for (let row = 0; row < region.height; row += 1) {
    const y = region.y + row;
    if (y < 0 || y >= buffer.height) {
      continue;
    }
    let text = "";
    const columns: number[] = [];
    for (let x = region.x; x < Math.min(region.x + region.width, buffer.width); x += 1) {
      const code = char[y * buffer.width + x] ?? 0;
      if (isContinuation(code)) {
        continue;
      }
      const cell = cellText(code);
      text += cell;
      for (let unit = 0; unit < cell.length; unit += 1) {
        columns.push(x);
      }
    }
    const isCurrent = row === currentRow;
    const background = isCurrent ? colors.current : colors.match;
    for (const match of matches(pattern, text)) {
      const start = columns[match.start] ?? 0;
      let end = columns[match.end - 1] ?? start;
      while (end + 1 < buffer.width && isContinuation(char[y * buffer.width + end + 1] ?? 0)) {
        end += 1;
      }
      for (let x = start; x <= end; x += 1) {
        const offset = (y * buffer.width + x) * 4;
        bg.set(background.buffer, offset);
        if (isCurrent) {
          fg.set(colors.text.buffer, offset);
        }
      }
    }
  }
}

function isContinuation(code: number): boolean {
  return ((code & CHAR_FLAG_MASK) >>> 0) === CHAR_FLAG_CONTINUATION;
}

function cellText(code: number): string {
  if (code === 0) {
    return " ";
  }
  return (code & CHAR_FLAG_MASK) === 0 ? String.fromCodePoint(code) : "\uFFFD";
}
