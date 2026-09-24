import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
const mdcat = join(import.meta.dir, "..", "src", "mdcat.ts");
const mdgit = join(import.meta.dir, "..", "src", "mdgit.ts");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("keeps the CLI entrypoints executable for global installs", () => {
  for (const cli of [mdcat, mdgit]) {
    expect(statSync(cli).mode & 0o111).not.toBe(0);
  }
});

test("reports when the normalized git diff has no Markdown changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mdcat-"));
  directories.push(directory);
  mkdirSync(join(directory, "docs"));
  writeFileSync(join(directory, "docs", "note.md"), "# Before\n");
  writeFileSync(join(directory, "source.ts"), "const value = 1;\n");

  const commit = ["git", "-c", "user.name=mdcat test", "-c", "user.email=mdcat@example.com", "commit"];
  run(["git", "init"], directory);
  run(["git", "add", "."], directory);
  run([...commit, "-m", "initial"], directory);

  writeFileSync(join(directory, "source.ts"), "const value = 2;\n");

  const empty = { exitCode: 0, stdout: "mdgit: no Markdown changes\n", stderr: "" };
  expect(await spawn(mdgit, ["diff", "--color=always", "--word-diff"], directory)).toEqual(empty);

  run([...commit, "-am", "source"], directory);
  expect(await spawn(mdgit, ["show", "--color=always", "HEAD"], directory)).toEqual(empty);
});

test("prints mdgit help when there is no command", async () => {
  const result = await spawn(mdgit, [], import.meta.dir, new Blob(["diff --git a/x.md b/x.md\n"]));
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toStartWith("Usage: mdgit diff");
});

test("rejects unknown mdgit commands", async () => {
  const result = await spawn(mdgit, ["--cached"], import.meta.dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("mdgit: '--cached' is not a mdgit command. See 'mdgit --help'.\n");
});

test("reads a piped diff with mdcat", async () => {
  const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
  expect(await spawn(mdcat, [], import.meta.dir, new Blob([diff]))).toEqual({
    exitCode: 0,
    stdout: "mdcat: no Markdown changes\n",
    stderr: "",
  });
});

test("fails when mdcat cannot read a file", async () => {
  const result = await spawn(mdcat, ["missing.md"], import.meta.dir);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toStartWith("mdcat: ENOENT");
});

async function spawn(
  cli: string,
  args: readonly string[],
  cwd: string,
  stdin: Blob = new Blob([]),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", cli, ...args], { cwd, stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
