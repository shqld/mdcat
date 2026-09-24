#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

import { isUnifiedDiff, parseMarkdownDiff, parseMarkdownDocument, type MarkdownDiff } from "./diff.ts";
import { createBlobReader } from "./git.ts";
import { render } from "./render.ts";

const HELP = `Usage: mdcat <file>...
       <markdown-or-unified-diff> | mdcat

Render Markdown files, or Markdown changes in a unified diff, as rich text in a terminal UI.

With no file, mdcat reads stdin and renders it as a diff when it contains one.

Examples:
  mdcat README.md
  cat README.md | mdcat
  git diff --word-diff | mdcat
`;

export async function main(args: readonly string[]): Promise<number> {
  const [argument] = args;
  if (argument === "--help" || argument === "-h" || (argument === undefined && process.stdin.isTTY)) {
    process.stdout.write(HELP);
    return 0;
  }
  return render("mdcat", () => args.length === 0 ? readStdin() : readFiles(args));
}

async function readStdin(): Promise<MarkdownDiff> {
  const input = await Bun.stdin.text();
  return isUnifiedDiff(input)
    ? parseMarkdownDiff(input, createBlobReader())
    : { files: [parseMarkdownDocument(null, input)] };
}

async function readFiles(paths: readonly string[]): Promise<MarkdownDiff> {
  const files = await Promise.all(paths.map(async (path) => parseMarkdownDocument(path, await readFile(path, "utf8"))));
  return { files };
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
