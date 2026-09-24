# mdcat

`mdcat` renders Markdown files and Markdown changes as rich text in a terminal UI. In a diff, added blocks have a green background, removed blocks have a red background, and context remains neutral.

## Installation

From the repository root, pass an absolute path because Bun 1.4 rejects `.` as a global package name:

```sh
bun install --frozen-lockfile
bun install -g "$PWD"
```

This installs two commands: `mdcat` renders Markdown files or a diff piped to it, and `mdgit` renders the Markdown files changed in git.

`mdcat` renders each file it is given in full, under its path:

```sh
mdcat README.md docs/*.md
cat README.md | mdcat
```

`mdgit diff` and `mdgit show` accept the same arguments as `git diff` and `git show`, and render only the Markdown files in the result:

```sh
mdgit diff
mdgit diff --cached
mdgit diff HEAD~3..HEAD
mdgit diff HEAD docs/guide.md
mdgit show HEAD~1
mdgit show HEAD~1 -- docs/guide.md
mdgit show HEAD:docs/guide.md
```

`mdgit diff` runs the following command itself, followed by the given arguments; `mdgit show` runs `git show` the same way with `--format= --diff-merges=remerge` added, so a merge commit shows what changed from the automatic merge, conflict markers included. Options that only change how git prints the patch, such as `--color`, `--word-diff`, `--color-words`, prefixes, `--ext-diff`, `--textconv`, `--output`, and the combined diff formats (`-c`, `--cc`), are dropped because `mdgit` renders the patch itself. `mdgit show` renders a blob such as `HEAD:docs/guide.md` in full, like `mdcat` renders a file.

```sh
git --no-pager diff --patch --word-diff=none --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/
```

With no file, `mdcat` reads stdin. Input that contains a file header followed by a hunk (`--- a/…`, `+++ b/…`, `@@ … @@`) is read as a unified diff, even when it is a Markdown document quoting one; anything else is rendered as a Markdown document. Diffs are accepted in the unified format, including `git diff --word-diff` output in the `plain` and `porcelain` formats. `mdcat` reads the pipe, then uses the controlling terminal for keyboard input. ANSI color sequences and non-Markdown files are ignored, so `--word-diff=color` cannot be read. With no arguments, `mdgit` prints its help, and so does `mdcat` when stdin is a terminal.

```sh
git diff --color=always | mdcat
git diff --word-diff | mdcat
```

Each file is rendered as a separate section. Hunk boundaries show the number of omitted lines because a diff does not contain the complete document.

Prose is compared block by block: paragraphs, headings, list items at any depth, quoted paragraphs, HTML comments, and the summary and body of `<details>` are paired between the old and new text and shown once with inline word diffs. Inline diffs wrap at the widest heading or paragraph line of their section (paragraphs in quotes and `<details>` count; list items do not), which runs from one heading to the next (at least 40 columns; a section without paragraphs uses the terminal width), so an edit does not stretch a hard-wrapped paragraph; an edit that does not fit on the current line starts on the next one. Sentences are compared one by one; a sentence with more than two separate edits is shown as one removed span followed by one added span, so each side stays readable. Pairs that keep less than 45% of their text, headings whose level changed, checkbox toggles, and other blocks such as HTML or rules are shown as a removed block and an added block. Fenced code blocks are diffed line by line; to know whether a hunk starts inside one, `mdcat` reads the whole old and new files through the blob ids on the diff's `index` line (from the repository, or from the working tree when it matches). When the files cannot be read and the hunk contains a fence, the hunk is shown as plain diff lines instead of guessing, and table rows are shown as a table even when the hunk starts in the middle of one. Changes that consist only of whitespace or inline styles such as bold and italics are rendered as unchanged; link destination changes still count. HTML `<br>` tags break the line, including inside table cells.

Changed table cells use inline word diffs, while added and removed rows use full-row backgrounds that continue through column rules. Level one and two headings use Leaf-style rules. Frontmatter is rendered as a compact metadata panel instead of a Markdown table.

HTML `<details>` blocks start expanded so diff content remains visible. Click the summary, or focus it and press Enter or Space, to toggle the body.

Use arrow keys or `j`/`k` to scroll, `g`/`G` to jump, and `q` or Escape to quit. Dragging across text selects and copies it to the clipboard.

## Development

Requires Bun 1.3 or later.

```sh
bun install
bun run check
bun src/mdgit.ts diff
```
