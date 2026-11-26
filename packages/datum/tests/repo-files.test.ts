// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { isGitWorkTree, repoFiles, walkTree } from "./support/repo-files.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The two cases that need git itself skip where it is not installed; the walk needs nothing.
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A small tree with a .gitignore of every form the root one uses, and no .git.
const FIXTURE: Record<string, string> = {
  ".gitignore": [
    "# build output",
    "node_modules/",
    "dist/",
    "/build/",
    "*.log",
    "!keep.log",
    "target/",
    ".venv/",
    "docs/**/cache/",
    "packages/*/generated/",
    "CLAUDE.md",
    ".claude/"
  ].join("\n"),
  "README.md": "readme",
  "src/a.ts": "a",
  "src/nested/deep/b.ts": "b",
  "node_modules/dep/index.js": "ignored",
  "packages/p/node_modules/dep/index.js": "ignored",
  "dist/out.js": "ignored",
  "packages/p/dist/out.js": "ignored",
  "packages/p/src/c.ts": "c",
  "packages/p/generated/g.ts": "ignored",
  "packages/p/other/g.ts": "kept",
  "build/z.txt": "ignored",
  "sub/build/y.txt": "kept: the slash ties /build/ to the root",
  "debug.log": "ignored",
  "src/trace.log": "ignored",
  "keep.log": "kept: negated",
  "target/x.class": "ignored",
  ".venv/bin/python": "ignored",
  "docs/guide/cache/page.json": "ignored",
  "docs/guide/page.md": "kept",
  "CLAUDE.md": "ignored",
  ".claude/notes.md": "ignored",
  "packages/q/.gitignore": "out/\n/report/\n",
  "packages/q/out/r.txt": "ignored by the nested .gitignore",
  "packages/q/report/r.txt": "ignored: /report/ is tied to packages/q",
  "packages/q/sub/report/r.txt": "kept",
  "out/top.txt": "kept: the nested rule does not reach the root"
};

const made: string[] = [];

function copyOfFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "datum-repo-files-"));
  made.push(root);
  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterAll(() => {
  for (const root of made) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the files the repository guards read", () => {
  it("walks a copy without .git and leaves out what the root .gitignore names", () => {
    const root = copyOfFixture();
    expect(isGitWorkTree(root)).toBe(false);
    expect(repoFiles(root)).toEqual([
      ".gitignore",
      "README.md",
      "docs/guide/page.md",
      "keep.log",
      "out/top.txt",
      "packages/p/other/g.ts",
      "packages/p/src/c.ts",
      "packages/q/.gitignore",
      "packages/q/sub/report/r.txt",
      "src/a.ts",
      "src/nested/deep/b.ts",
      "sub/build/y.txt"
    ]);
  });

  it("walks a tree with no .gitignore at all", () => {
    const root = copyOfFixture();
    rmSync(join(root, ".gitignore"));
    expect(walkTree(root)).toContain("node_modules/dep/index.js");
  });

  it.skipIf(!hasGit)("treats a tree inside another repository, with no .git of its own, as a copy", () => {
    const outer = copyOfFixture();
    execFileSync("git", ["init", "--quiet"], { cwd: outer });
    const inner = join(outer, "src");
    expect(isGitWorkTree(outer)).toBe(true);
    expect(isGitWorkTree(inner)).toBe(false);
    expect(repoFiles(inner)).toEqual(["a.ts", "nested/deep/b.ts", "trace.log"]);
  });

  it.skipIf(!isGitWorkTree(REPO))("reads git's list in a work tree, and a walk of the same tree holds every tracked file", () => {
    expect(isGitWorkTree(REPO)).toBe(true);
    const tracked = repoFiles(REPO);
    expect(tracked.length).toBeGreaterThan(100);
    const walked = new Set(walkTree(REPO));
    expect(tracked.filter((path) => !walked.has(path))).toEqual([]);
  });
});
