// @vitest-environment node
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * What the index records about files, which a clone carries to every machine: a script that starts
 * with a shebang line is stored executable (a mode that is lost in the index cannot be restored by
 * a checkout), and a placeholder file keeps a directory only where nothing else does. A tree with
 * no .git (a ZIP or a tarball) has no index to read, so these guards have nothing to say there.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// The top of a git work tree (a copy inside some other repository is not one).
function isGitWorkTree(root: string): boolean {
  if (!existsSync(join(root, ".git"))) {
    return false;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

const inGit = isGitWorkTree(REPO);

interface Entry {
  mode: string;
  path: string;
}

function indexEntries(): Entry[] {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  return out
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return { mode: line.slice(0, line.indexOf(" ")), path: line.slice(tab + 1) };
    });
}

function startsWithShebang(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(join(REPO, path), "r");
  } catch {
    // A path the index names but the work tree no longer holds is not a script to judge.
    return false;
  }
  try {
    const head = Buffer.alloc(2);
    const read = readSync(fd, head, 0, 2, 0);
    return read === 2 && head.toString("latin1") === "#!";
  } finally {
    closeSync(fd);
  }
}

describe.skipIf(!inGit)("repository index hygiene", () => {
  // A skipped describe still runs its body while tests are collected, so the index is read only in a work tree.
  const entries = inGit ? indexEntries() : [];

  it("stores every tracked file that starts with a shebang line as executable (mode 100755)", () => {
    const notExecutable = entries.filter((entry) => entry.mode === "100644" && startsWithShebang(entry.path)).map((entry) => entry.path);
    expect(notExecutable).toEqual([]);
  });

  it("keeps a .gitkeep only in a directory that holds no other tracked file", () => {
    const paths = entries.map((entry) => entry.path);
    const redundant = paths
      .filter((path) => path === ".gitkeep" || path.endsWith("/.gitkeep"))
      .filter((path) => {
        const directory = path.slice(0, -".gitkeep".length);
        return paths.some((other) => other !== path && other.startsWith(directory));
      });
    expect(redundant).toEqual([]);
  });

  it("has a root .gitattributes that pins text to LF and keeps binaries binary", () => {
    expect(entries.map((entry) => entry.path)).toContain(".gitattributes");
    const attribute = (name: string, path: string) =>
      execFileSync("git", ["check-attr", name, "--", path], { cwd: REPO }).toString("utf8").trim().split(": ").pop();
    expect(attribute("eol", "integrations/jvm/mvnw")).toBe("lf");
    expect(attribute("eol", "scripts/setup.mjs")).toBe("lf");
    expect(attribute("text", "bindings/alberta/tests/tier2/baseline/date-disabled.png")).toBe("unset");
  });
});
