import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compareVersions, detectInstaller } from "../src/update.ts";

test("compares versions the way semver orders them", () => {
  expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.1", "1.0.1")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
  expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
});

test("detects the package manager from the global directory that holds the package", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "mdcat-")));
  try {
    const bun = join(directory, "bun", "node_modules");
    const npm = join(directory, "npm", "node_modules");
    for (const root of [bun, npm]) {
      mkdirSync(join(root, "@shqld", "mdcat"), { recursive: true });
    }
    const roots = { bun, npm: () => npm };

    expect(detectInstaller(join(bun, "@shqld", "mdcat"), roots)).toBe("bun");
    expect(detectInstaller(join(npm, "@shqld", "mdcat"), roots)).toBe("npm");
    expect(detectInstaller(join(directory, "checkout"), roots)).toBeNull();
    expect(detectInstaller(join(directory, "checkout"), { bun, npm: () => null })).toBeNull();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
