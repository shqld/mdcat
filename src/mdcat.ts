#!/usr/bin/env -S node --experimental-ffi --disable-warning=ExperimentalWarning

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";

import { isUnifiedDiff, parseMarkdownDiff, parseMarkdownDocument, type MarkdownDiff } from "./diff.ts";
import { createBlobReader } from "./git.ts";
import { render } from "./render.ts";
import { update } from "./update.ts";

const HELP = `Usage: mdcat [--watch] <file>...
       <markdown-or-unified-diff> | mdcat
       mdcat --update

Render Markdown files, or Markdown changes in a unified diff, as rich text in a terminal UI.

With no file, mdcat reads stdin and renders it as a diff when it contains one.
Click a link to a Markdown file to open it, and press h and l to go back and forward.
--watch (-w) renders the files again whenever they change.
--update installs the latest version with the package manager that installed mdcat.

Examples:
  mdcat README.md
  mdcat --watch notes.md
  cat README.md | mdcat
  git diff --word-diff | mdcat
`;

export async function main(args: readonly string[]): Promise<number> {
  const [argument] = args;
  if (argument === "--help" || argument === "-h" || (argument === undefined && process.stdin.isTTY)) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argument === "--update") {
    return update("mdcat");
  }
  const watching = argument === "--watch" || argument === "-w";
  const paths = watching ? args.slice(1) : args;
  if (watching && paths.length === 0) {
    process.stderr.write("mdcat: --watch needs a file\n");
    return 1;
  }
  if (paths.length === 0) {
    return render("mdcat", async () => ({ document: await readStdin(), watched: [] }));
  }
  return render("mdcat", async () => ({
    document: await readFiles(paths),
    reload: () => readFiles(paths),
    watched: paths.map((path) => resolve(path)),
  }), { watch: watching });
}

async function readStdin(): Promise<MarkdownDiff> {
  const input = await text(process.stdin);
  return isUnifiedDiff(input)
    ? parseMarkdownDiff(input, createBlobReader())
    : { files: [parseMarkdownDocument(null, input)] };
}

async function readFiles(paths: readonly string[]): Promise<MarkdownDiff> {
  const files = await Promise.all(paths.map(async (path) => parseMarkdownDocument(path, await readFile(path, "utf8"))));
  return { files };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
