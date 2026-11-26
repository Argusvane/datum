import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * lit-html stays the live renderer's: it is imported only from render/live/lit.ts,
 * and nothing a DOM-free entry imports at run time reaches it (the engine's core, runtime and
 * registry entries, the PDF pipeline, the binding contract and registry, the PDF program's
 * entry), so the programs built from engine modules (the sandbox, the PDF program) never carry
 * lit-html's top level (`document`, `Math.random()`, a Trusted Types policy). The form element
 * draws with the live renderer, so the barrels that export it reach lit-html; the render
 * barrel's own re-exports from render/live/ are the DOM-free pieces only. The packages/datum
 * bundle guard (scripts/guards/16-lit-isolation.mjs) holds the same rules over the built files
 * as well.
 */

const engine = join(dirname(fileURLToPath(import.meta.url)), "..", "form-engine");
const ONE_COPY = join(engine, "render", "live", "lit.ts");

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/**
 * The source with its comments blanked (each a space, its line breaks kept); strings, template
 * literals and regular expressions read through as they are. A copy of `stripComments` in
 * packages/datum/scripts/guards/16-lit-isolation.mjs, kept in step.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const holes: number[] = [];
  let last = "";
  let word = "";
  let gap = false;
  const at = (index: number): string => source[index] ?? "";
  const template = (): void => {
    while (i < n) {
      const c = at(i);
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        out += c;
        i += 1;
        last = c;
        word = "";
        gap = false;
        return;
      } else if (c === "$" && at(i + 1) === "{") {
        out += "${";
        i += 2;
        holes.push(0);
        last = "{";
        word = "";
        gap = false;
        return;
      } else {
        out += c;
        i += 1;
      }
    }
  };
  while (i < n) {
    const c = at(i);
    const next = at(i + 1);
    if (c === "/" && next === "/") {
      while (i < n && at(i) !== "\n") {
        i += 1;
      }
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += ` ${source.slice(i, stop).replace(/[^\n]/g, "")}`;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && at(j) !== c && at(j) !== "\n") {
        j += at(j) === "\\" ? 2 : 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = c;
      word = "";
      gap = false;
      continue;
    }
    if (c === "`") {
      out += c;
      i += 1;
      template();
      continue;
    }
    if (c === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || REGEX_AFTER_WORD.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && at(j) !== "\n") {
        const ch = at(j);
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") {
          inClass = true;
        } else if (ch === "]") {
          inClass = false;
        } else if (ch === "/" && !inClass) {
          break;
        }
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(at(j))) {
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      last = ")";
      word = "";
      gap = false;
      continue;
    }
    const top = holes.length - 1;
    if (top >= 0 && c === "{") {
      holes[top] = (holes[top] ?? 0) + 1;
    } else if (top >= 0 && c === "}") {
      if (holes[top] === 0) {
        holes.pop();
        out += c;
        i += 1;
        template();
        continue;
      }
      holes[top] = (holes[top] ?? 0) - 1;
    }
    out += c;
    i += 1;
    if (/\s/.test(c)) {
      gap = true;
    } else {
      word = /[\w$]/.test(c) ? (!gap && /[\w$]/.test(last) ? word + c : c) : "";
      last = c;
      gap = false;
    }
  }
  return out;
}

/** The specifiers a module imports at run time: not `import type`, `export type`, or named imports that are all `type`. */
function runtimeSpecifiers(text: string): string[] {
  const source = stripComments(text);
  const out: string[] = [];
  for (const match of source.matchAll(/(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\w$*\s{},]*?)\s*from\s*["']([^"']+)["']/g)) {
    const [, , typeOnly, clause = "", specifier = ""] = match;
    if (typeOnly) {
      continue;
    }
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    const names = named?.[1]?.split(",").map((part) => part.trim()).filter((part) => part !== "") ?? [];
    if (named && names.length > 0 && names.every((part) => part.startsWith("type "))) {
      continue;
    }
    out.push(specifier);
  }
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    out.push(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    if (!(match[1] === "`" && (match[2] ?? "").includes("${"))) {
      out.push(match[2] ?? "");
    }
  }
  return out;
}

function fileOf(from: string, specifier: string): string | undefined {
  const target = resolve(dirname(from), specifier);
  return [target.replace(/\.js$/, ".ts"), target, `${target}.ts`, join(target, "index.ts")].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** The first run-time import chain from `start` to lit-html or its one copy. */
function chainToLit(start: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): string[] | undefined => {
    if (seen.has(file)) {
      return undefined;
    }
    seen.add(file);
    if (file === ONE_COPY) {
      return chain;
    }
    for (const specifier of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier === "lit-html" || specifier.startsWith("lit-html/")) {
        return [...chain, specifier];
      }
      const next = specifier.startsWith(".") ? fileOf(file, specifier) : undefined;
      const found = next !== undefined ? walk(next, [...chain, relative(engine, next)]) : undefined;
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return walk(start, [relative(engine, start)]);
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourcesUnder(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("lit-html isolation", () => {
  it("is imported from render/live/lit.ts alone", () => {
    const importers = sourcesUnder(engine).filter((file) => /(?:from\s*|import\s*\(\s*|import\s+)["'`]lit-html(?:\/[^"'`]*)?["'`]/.test(stripComments(readFileSync(file, "utf8"))));
    expect(importers.map((file) => relative(engine, file))).toEqual(["render/live/lit.ts"]);
  });

  it("is never reached from a DOM-free entry", () => {
    const roots = [
      "core/index.ts",
      "runtime/index.ts",
      "registry/index.ts",
      "data/index.ts",
      "persistence/index.ts",
      "plugins/index.ts",
      "testing/index.ts",
      "core/form-tests/index.ts",
      "builder/logic/index.ts",
      "verification/release-gates.ts",
      "verification/telemetry.ts",
      // The browser's PDF pipeline chunk, and the PDF program's own entry, which runs in QuickJS.
      "render/pdf/pdf-service.ts",
      "../../packages/pdf-kernel/src/program/main.ts",
      // The contract is types and pure functions: a binding reads it without lit at run time; so is the registry.
      "render/live/contract.ts",
      "render/live/index.ts",
      "render/live/binding-registry.ts"
    ];
    for (const root of roots) {
      expect([root, chainToLit(join(engine, ...root.split("/")))]).toEqual([root, undefined]);
    }
  });

  it("is reached from the render barrel only through the form element, never through a re-export of the renderer", () => {
    // The element draws with the live renderer: the barrels that export it reach lit-html.
    const chain = chainToLit(join(engine, "render", "index.ts")) ?? [];
    expect(chain).toContain("render/live/lit.ts");
    const barrel = join(engine, "render", "index.ts");
    const live = runtimeSpecifiers(readFileSync(barrel, "utf8"))
      .map((specifier) => (specifier.startsWith("./live/") ? fileOf(barrel, specifier) : undefined))
      .filter((file): file is string => file !== undefined);
    expect(live.map((file) => relative(engine, file)).sort()).toEqual([
      "render/live/assets-policy.ts",
      "render/live/binding-registry.ts",
      "render/live/contract.ts",
      "render/live/datum/frames.ts",
      "render/live/datum/icons.ts",
      "render/live/datum/tokens.ts"
    ]);
    for (const file of live) {
      expect([relative(engine, file), chainToLit(file)]).toEqual([relative(engine, file), undefined]);
    }
  });

  it("is reached from the renderer itself, so the walk above would see it", () => {
    expect(chainToLit(join(engine, "render", "live", "mount.ts"))).toEqual(["render/live/mount.ts", "render/live/lit.ts"]);
    expect(runtimeSpecifiers('import type { A } from "./a.js";\nimport { type B } from "./b.js";\nexport type C = D\nimport { e, type F } from "./e.js";')).toEqual(["./e.js"]);
  });

  it("reads an import clause that holds a comment, and a dynamic import in backticks", () => {
    expect(runtimeSpecifiers('export {\n  // the renderer, for the element\n  mountLive\n} from "./live/mount.js";\n')).toEqual(["./live/mount.js"]);
    expect(runtimeSpecifiers('import {\n  a, /* b */ c\n} from "./x.js";')).toEqual(["./x.js"]);
    expect(runtimeSpecifiers("const m = await import(`./lazy.js`);\nconst n = await import(`./${name}.js`);")).toEqual(["./lazy.js"]);
    // What a comment, a string or a regular expression holds is no import, and hides none.
    expect(runtimeSpecifiers('// import { a } from "./gone.js";\n/* import "./gone2.js" */')).toEqual([]);
    expect(runtimeSpecifiers('const u = "https://example.com"; const r = /["`]/g;\nimport { a } from "./y.js";')).toEqual(["./y.js"]);
    expect(runtimeSpecifiers('const t = `a ${`b ${1}`} // not`;\nimport "./side.js";')).toEqual(["./side.js"]);
  });
});
