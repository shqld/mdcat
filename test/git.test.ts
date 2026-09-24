import { expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBlobReader, gitCommand, readGit } from "../src/git.ts";
import { loadShow } from "../src/mdgit.ts";

test("puts the normalizing options before the git arguments", () => {
  expect(gitCommand("diff", ["HEAD", "a.md"])).toEqual([
    "git",
    "--no-pager",
    "diff",
    "--patch",
    "--word-diff=none",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "HEAD",
    "a.md",
  ]);
});

test("hides the commit header of git show and diffs merges against the automatic merge", () => {
  expect(gitCommand("show", ["HEAD"]).slice(0, 6)).toEqual(["git", "--no-pager", "show", "--format=", "--diff-merges=remerge", "--patch"]);
});

test("drops options that only change how git prints the patch", () => {
  const args = [
    "--color=always",
    "--color-words=.",
    "--word-diff",
    "--src-prefix",
    "x/",
    "--dst-prefix=y/",
    "--no-prefix",
    "--ext-diff",
    "--cc",
    "--diff-merges",
    "dense-combined",
    "--output=out.patch",
    "-U1",
    "--diff-merges=first-parent",
    "HEAD",
    "--",
    "--color",
  ];
  expect(gitCommand("diff", args).slice(10)).toEqual(["-U1", "--diff-merges=first-parent", "HEAD", "--", "--color"]);
});

function withRepo(run: (repo: string, git: (...args: string[]) => string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "mdcat-git-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args: string[]): string =>
    Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const previous = process.cwd();
  try {
    git("init", "-q");
    process.chdir(repo);
    run(repo, git);
  } finally {
    process.chdir(previous);
    rmSync(base, { recursive: true, force: true });
  }
}

function blobsOf(diff: string): readonly [string, string] {
  const [, oldBlob = "", newBlob = ""] = diff.match(/index ([0-9a-f]+)\.\.([0-9a-f]+)/) ?? [];
  return [oldBlob, newBlob];
}

test("reads committed blobs and matching working tree files", () => {
  withRepo((repo, git) => {
    writeFileSync(join(repo, "doc.md"), "old\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(repo, "doc.md"), "new\n");
    const [oldBlob, newBlob] = blobsOf(git("diff"));

    const read = createBlobReader();
    expect(read(oldBlob, ["doc.md"])).toBe("old\n");
    expect(read(newBlob, ["doc.md", "b/doc.md"])).toBe("new\n");
    expect(read("0123456", ["doc.md"])).toBeNull();
  });
});

test("matches working tree files through git filters and stays inside the repository", () => {
  withRepo((repo, git) => {
    git("config", "core.autocrlf", "true");
    writeFileSync(join(repo, "doc.md"), "old\r\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(repo, "doc.md"), "new\r\n");
    const [, newBlob] = blobsOf(git("diff"));
    writeFileSync(join(repo, "..", "secret.md"), "new\r\n");
    mkdirSync(join(repo, "dir.md"));

    const read = createBlobReader();
    expect(read(newBlob, ["doc.md"])).toBe("new\r\n");
    expect(read(newBlob, ["../secret.md"])).toBeNull();
    expect(read("0123456", ["dir.md"])).toBeNull();
  });
});

async function withDocs(run: (repo: string) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "mdcat-git-"));
  const git = (...args: string[]): void => {
    Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" });
  };
  const previous = process.cwd();
  try {
    git("init", "-q");
    writeFileSync(join(repo, "a.md"), "# A\n");
    writeFileSync(join(repo, "b.md"), "# B\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    process.chdir(repo);
    await run(repo);
  } finally {
    process.chdir(previous);
    rmSync(repo, { recursive: true, force: true });
  }
}

test("diffs only the given pathspecs", async () => {
  await withDocs(async (repo) => {
    writeFileSync(join(repo, "a.md"), "# A2\n");
    writeFileSync(join(repo, "b.md"), "# B2\n");
    const output = await readGit("diff", ["HEAD", "--", "a.md"]);
    expect(output).toContain("+++ b/a.md");
    expect(output).not.toContain("b.md");
  });
});

test("shows a blob given as <rev>:<path> as a Markdown document", async () => {
  await withDocs(async () => {
    const blob = await loadShow(["HEAD:a.md"]);
    expect(blob.files.map((file) => [file.path, file.status])).toEqual([["HEAD:a.md", "unchanged"]]);

    const mixed = await loadShow(["HEAD:b.md", "HEAD"]);
    expect(mixed.files.map((file) => [file.path, file.status])).toEqual([
      ["HEAD:b.md", "unchanged"],
      ["a.md", "added"],
      ["b.md", "added"],
    ]);

    const filtered = await loadShow(["HEAD", "--", "a.md"]);
    expect(filtered.files.map((file) => file.path)).toEqual(["a.md"]);

    const head = await loadShow(["--", "b.md"]);
    expect(head.files.map((file) => file.path)).toEqual(["b.md"]);
  });
});
