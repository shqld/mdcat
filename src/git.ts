import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type GitSubcommand = "diff" | "show";

// Options that only change how git prints the patch; mdgit renders the patch itself.
const FORMAT_FLAGS = new Set(["--no-prefix", "--default-prefix", "--ext-diff", "--textconv", "-c", "--cc"]);
const FORMAT_OPTIONAL_VALUES = new Set(["--color", "--color-words", "--word-diff"]);
const FORMAT_VALUES = new Set([
  "--src-prefix",
  "--dst-prefix",
  "--line-prefix",
  "--output",
  "--output-indicator-new",
  "--output-indicator-old",
  "--output-indicator-context",
]);
const COMBINED_MERGES = new Set(["c", "cc", "combined", "dense-combined"]);

export function gitCommand(subcommand: GitSubcommand, args: readonly string[]): string[] {
  return [
    "git",
    "--no-pager",
    subcommand,
    ...(subcommand === "show" ? ["--format=", "--diff-merges=remerge"] : []),
    "--patch",
    "--word-diff=none",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...withoutFormatOptions(args),
  ];
}

function withoutFormatOptions(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      kept.push(...args.slice(index));
      break;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1);
    if (name === "--diff-merges" && value !== undefined && COMBINED_MERGES.has(value)) {
      index += equals === -1 ? 1 : 0;
    } else if (FORMAT_VALUES.has(name)) {
      index += equals === -1 ? 1 : 0;
    } else if (!FORMAT_FLAGS.has(arg) && !FORMAT_OPTIONAL_VALUES.has(name)) {
      kept.push(arg);
    }
  }
  return kept;
}

export async function readGit(subcommand: GitSubcommand, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(gitCommand(subcommand, args), {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exitCode > 1) {
    throw new Error(stderr.trim() || `git ${subcommand} exited with status ${exitCode}`);
  }

  return stdout;
}

export function readBlobObject(object: string): string | null {
  if (object.startsWith("-")) {
    return null;
  }
  const result = Bun.spawnSync(["git", "cat-file", "blob", object], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

export function createBlobReader(): (blob: string, paths: readonly string[]) => string | null {
  const toplevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  if (toplevel.exitCode !== 0) {
    return () => null;
  }
  const root = realpathSync(toplevel.stdout.toString().trim());
  const cwd = realpathSync(process.cwd());
  const cache = new Map<string, string | null>();

  return (blob, paths) => {
    const key = `${blob}:${paths.join("\0")}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const content = readObject(root, blob)
      ?? paths.flatMap((path) => [join(root, path), join(cwd, path)])
        .map((file) => readWorkingTree(root, blob, file))
        .find((text) => text !== null)
      ?? null;
    cache.set(key, content);
    return content;
  };
}

function readObject(root: string, blob: string): string | null {
  const result = Bun.spawnSync(["git", "cat-file", "blob", blob], { cwd: root, stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function readWorkingTree(root: string, blob: string, candidate: string): string | null {
  const file = resolve(candidate);
  const inside = relative(root, file);
  if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
    return null;
  }
  try {
    if (!statSync(file).isFile()) {
      return null;
    }
    const hash = Bun.spawnSync(["git", "hash-object", `--path=${inside}`, file], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    });
    return hash.exitCode === 0 && hash.stdout.toString().trim().startsWith(blob)
      ? readFileSync(file, "utf8")
      : null;
  } catch {
    return null;
  }
}
