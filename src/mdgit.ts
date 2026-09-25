#!/usr/bin/env -S node --experimental-ffi --disable-warning=ExperimentalWarning

import { parseMarkdownDiff, parseMarkdownDocument, type MarkdownDiff, type MarkdownDiffFile } from "./diff.ts";
import { createBlobReader, readBlobObject, readGit, type GitSubcommand } from "./git.ts";
import { render } from "./render.ts";

const HELP = `Usage: mdgit diff [<git-diff-args>]
       mdgit show [<git-show-args>]

Render the Markdown files changed in git as rich text in a terminal UI.

Commands:
  diff  Render the Markdown files in git diff
  show  Render the Markdown files in git show

Examples:
  mdgit diff
  mdgit diff --cached
  mdgit show HEAD~1
  mdgit show HEAD:README.md
`;

export async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "diff" || command === "show") {
    return render("mdgit", () => command === "show" ? loadShow(rest) : loadGit(command, rest));
  }
  process.stderr.write(`mdgit: '${command}' is not a mdgit command. See 'mdgit --help'.\n`);
  return 1;
}

export async function loadShow(args: readonly string[]): Promise<MarkdownDiff> {
  const separator = args.indexOf("--");
  const objects = separator === -1 ? args : args.slice(0, separator);
  const pathspecs = separator === -1 ? [] : args.slice(separator);
  const documents: MarkdownDiffFile[] = [];
  const rest: string[] = [];
  for (const arg of objects) {
    const text = readBlobObject(arg);
    if (text === null) {
      rest.push(arg);
    } else {
      documents.push(parseMarkdownDocument(arg, text));
    }
  }
  if (documents.length > 0 && rest.every((arg) => arg.startsWith("-"))) {
    return { files: documents };
  }
  const { files } = await loadGit("show", [...rest, ...pathspecs]);
  return { files: [...documents, ...files] };
}

async function loadGit(command: GitSubcommand, args: readonly string[]): Promise<MarkdownDiff> {
  return parseMarkdownDiff(await readGit(command, args), createBlobReader());
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
