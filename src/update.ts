import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@shqld/mdcat";

export type Installer = "bun" | "npm";

export async function update(name: string): Promise<number> {
  try {
    return await install(name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${name}: ${message}\n`);
    return 1;
  }
}

async function install(name: string): Promise<number> {
  const current = currentVersion();
  const latest = await latestVersion();
  if (compareVersions(latest, current) <= 0) {
    process.stdout.write(`${name} is up to date (${current})\n`);
    return 0;
  }

  const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const installer = detectInstaller(packageRoot, {
    bun: join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "global", "node_modules"),
    npm: npmGlobalRoot,
  });
  if (installer === null) {
    process.stderr.write(
      `${name}: ${latest} is available, but ${packageRoot} was not installed globally with Bun or npm. `
        + "Update it with the package manager that installed it.\n",
    );
    return 1;
  }

  process.stdout.write(`Updating ${PACKAGE} from ${current} to ${latest} with ${installer}\n`);
  return run(installer, ["install", "-g", `${PACKAGE}@${latest}`]);
}

export function detectInstaller(
  packageRoot: string,
  roots: { readonly bun: string; readonly npm: () => string | null },
): Installer | null {
  const inside = (root: string | null): boolean => root !== null && packageRoot.startsWith(realpath(root) + sep);
  if (inside(roots.bun)) {
    return "bun";
  }
  if (inside(roots.npm())) {
    return "npm";
  }
  return null;
}

export function compareVersions(a: string, b: string): number {
  const [leftRelease = "", leftPre] = a.split("-", 2);
  const [rightRelease = "", rightPre] = b.split("-", 2);
  const release = compareIdentifiers(leftRelease.split("."), rightRelease.split("."));
  if (release !== 0) {
    return release;
  }
  if (leftPre === undefined || rightPre === undefined) {
    return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  }
  return compareIdentifiers(leftPre.split("."), rightPre.split("."));
}

function compareIdentifiers(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return a === undefined ? -1 : 1;
    }
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
    const difference = numeric ? Number(a) - Number(b) : a.localeCompare(b);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function currentVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return versionOf(manifest, "package.json");
}

async function latestVersion(): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
  if (!response.ok) {
    throw new Error(`could not fetch the latest version: ${response.status} ${response.statusText}`);
  }
  return versionOf(await response.json(), "the npm registry");
}

function versionOf(manifest: unknown, source: string): string {
  if (typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string") {
    return manifest.version;
  }
  throw new Error(`no version in ${source}`);
}

function npmGlobalRoot(): string | null {
  const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
