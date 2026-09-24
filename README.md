# mdcat

Render Markdown files and Markdown diffs as rich text in the terminal. In a diff, added blocks are green, removed blocks are red, and edited paragraphs, list items, and table cells show inline word diffs.

## Installation

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install -g @shqld/mdcat
```

`npm install -g @shqld/mdcat` also works when `bun` is on `PATH`.

## Usage

`mdcat` renders Markdown files, or Markdown or a unified diff from stdin:

```sh
mdcat README.md docs/*.md
git diff | mdcat
```

`mdgit diff` and `mdgit show` take the same arguments as `git diff` and `git show`, and render only the Markdown files in the result:

```sh
mdgit diff --cached
mdgit diff HEAD~3..HEAD -- docs/
mdgit show HEAD~1
mdgit show HEAD:docs/guide.md
```

Scroll with the arrow keys or `j`/`k`, jump with `g`/`G`, and quit with `q`. Dragging selects and copies text. Click a `<details>` summary to toggle it.

## Development

```sh
bun install
bun run check
```

To release, bump the version and push the tag; GitHub Actions publishes it to npm:

```sh
npm version patch
git push --follow-tags
```

## License

MIT
