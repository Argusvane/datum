import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/*
 * The files of the source tree, as the guards that read the whole repository see them. In a git work
 * tree that is what git tracks. A ZIP or a source tarball has no .git, so the tree is walked instead and
 * the paths the root .gitignore names are left out, which is what an export of the tracked files holds.
 */

interface IgnoreRule {
  pattern: RegExp;
  negated: boolean;
  /** The pattern ends in a slash: it names directories only. */
  directoryOnly: boolean;
}

/** Whether `root` is the top of a git work tree (a copy inside some other repository is not one). */
export function isGitWorkTree(root: string): boolean {
  if (!existsSync(join(root, ".git"))) {
    return false;
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

// One glob of a .gitignore line as a regular expression over a path relative to the root. The forms the
// root .gitignore uses are handled: *, **, ?, character classes, a leading slash and a trailing slash.
function globSource(glob: string): string {
  let source = "";
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at] ?? "";
    if (char === "*" && glob[at + 1] === "*") {
      const before = at === 0 || glob[at - 1] === "/";
      const after = glob[at + 2];
      if (before && after === "/") {
        source += "(?:.*/)?";
        at += 2;
      } else if (before && after === undefined) {
        source += ".*";
        at += 1;
      } else {
        source += "[^/]*";
        at += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const close = glob.indexOf("]", at + 2);
      if (close === -1) {
        source += "\\[";
      } else {
        source += `[${glob.slice(at + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        at = close;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return source;
}

export function parseIgnoreRules(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const negated = line.startsWith("!");
    line = negated ? line.slice(1) : line;
    const directoryOnly = line.endsWith("/");
    line = directoryOnly ? line.slice(0, -1) : line;
    // A slash anywhere but the end ties the pattern to the root; a bare name matches at any depth.
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const source = globSource(line);
    rules.push({ pattern: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`), negated, directoryOnly });
  }
  return rules;
}

/** A rule of the .gitignore in `base` (a directory path ending in "/", or "" for the root). */
interface ScopedRule extends IgnoreRule {
  base: string;
}

function ignored(rules: ScopedRule[], path: string, isDirectory: boolean): boolean {
  let result = false;
  // Rules apply in order, root first, so a deeper .gitignore overrides a shallower one, as in git.
  for (const rule of rules) {
    if (path.startsWith(rule.base) && (!rule.directoryOnly || isDirectory) && rule.pattern.test(path.slice(rule.base.length))) {
      result = !rule.negated;
    }
  }
  return result;
}

function rulesOf(root: string, directory: string): ScopedRule[] {
  const base = directory === "" ? "" : `${directory}/`;
  const ignorePath = join(root, base, ".gitignore");
  return existsSync(ignorePath) ? parseIgnoreRules(readFileSync(ignorePath, "utf8")).map((rule) => ({ ...rule, base })) : [];
}

/**
 * Every file under `root` that no .gitignore names, as sorted paths relative to it. Each directory's own
 * .gitignore applies below it, relative to that directory, after the rules of the directories above.
 */
export function walkTree(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, inherited: ScopedRule[]): void => {
    const rules = [...inherited, ...rulesOf(root, directory)];
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.name === ".git") {
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignored(rules, path, true)) {
          visit(path, rules);
        }
      } else if (entry.isFile() && !ignored(rules, path, false)) {
        files.push(path);
      }
    }
  };
  visit("", []);
  return files.sort();
}

/** The tracked files of a git work tree, or the walked files of a tree without one. */
export function repoFiles(root: string): string[] {
  if (!isGitWorkTree(root)) {
    return walkTree(root);
  }
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
  return out.split("\0").filter((path) => path !== "");
}
