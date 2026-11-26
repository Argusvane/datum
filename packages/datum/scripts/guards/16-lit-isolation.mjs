// lit-html stays out of everything a QuickJS context runs.
// The live renderer (engine/form-engine/render/live/) draws with lit-html, whose top level reads
// `document`, calls Math.random() and creates a Trusted Types policy named `lit-html`: reached
// in the sandbox or the PDF program, that is a ReferenceError in QuickJS or lost determinism.
//
// What the guard holds:
//   - no lit-html in datum-wasm.js (and its chunks), datum-sandbox-program.js or
//     datum-pdf-program.js: the browser's sandbox module and the two programs a server runs;
//   - nothing a DOM-free entry imports at run time, however deep, reaches render/live/lit.ts or
//     lit-html: the engine's core, runtime, registry, data, persistence, plugins, testing,
//     form tests, logic, tooling and verification entries, the browser's PDF pipeline chunk, the
//     binding contract, the live renderer's engine surface and its binding registry, and the PDF
//     program's own entry. The form element (render/web-component/form-renderer-element.ts) draws
//     with the live renderer, so the barrels that export it (render/index.ts, the builder's, the
//     engine entry, the agent subpath) reach lit-html: it is an element's dependency, and Node
//     imports it through lit-html's own `node` build;
//   - the render barrel's own re-exports from render/live/ are DOM-free (the frames, the binding
//     registry, the contract): it never re-exports the renderer;
//   - lit-html is imported only from render/live/lit.ts, the one copy: no other engine module
//     and no web-components source names the package (a binding is handed lit through
//     `createBinding(lit)` and imports it as a type only).
// The source checks read the source tree, not dist, so they hold before a build too. The
// engine's own test (engine/tests/live-lit-isolation.test.ts) holds the same source rules.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Strings lit-html's own code spells: its version registry and its Trusted Types policy. */
const LIT_SENTINELS = [/litHtmlVersions/, /createPolicy\(\s*["'`]lit-html["'`]/];

/** The bundles a QuickJS context runs, or that carry what it runs. */
const ISOLATED = [/^datum-wasm(-.+)?\.js$/, /^datum-sandbox-program\.js$/, /^datum-pdf-program\.js$/];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const engine = join(repo, "engine", "form-engine");
const ONE_COPY = join(engine, "render", "live", "lit.ts");
/** The entries that must never reach lit-html at run time: what a QuickJS program or a DOM-free host is built from. */
export const DOM_FREE_ROOTS = [
  "core/index.ts",
  "runtime/index.ts",
  "registry/index.ts",
  "data/index.ts",
  "persistence/index.ts",
  "plugins/index.ts",
  "testing/index.ts",
  "core/form-tests/index.ts",
  "builder/logic/index.ts",
  "tooling/index.ts",
  "verification/release-gates.ts",
  "verification/telemetry.ts",
  "render/pdf/pdf-service.ts",
  "render/live/contract.ts",
  "render/live/index.ts",
  "render/live/binding-registry.ts"
].map((path) => join(engine, ...path.split("/"))).concat([join(repo, "packages", "pdf-kernel", "src", "program", "main.ts")]);
/** The render barrel, whose own re-exports from render/live/ must be DOM-free. */
const RENDER_BARREL = join(engine, "render", "index.ts");
const LIVE_DIR = join(engine, "render", "live");

/** A module specifier naming lit-html, in an import, an export-from or a dynamic import (read with the comments blanked). */
const LIT_IMPORT = /(?:from\s*|import\s*\(\s*|import\s+)["'`]lit-html(?:\/[^"'`]*)?["'`]/;

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/**
 * The source with its comments blanked: each one becomes a space (its line breaks kept), so a
 * comment inside an import clause hides nothing from the scan. Strings, template literals (with
 * their `${}` expressions) and regular expressions are read through as they are, so a `//` or a
 * quote inside one is no comment and no string. The engine's test keeps a copy of this in step.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  /** For each `${` open around the code being read, the depth of the braces inside it. */
  const holes = [];
  /** The last character of code that is not white space, and the word it ends, if any. */
  let last = "";
  let word = "";
  /** White space since `last`. */
  let gap = false;
  const template = () => {
    while (i < n) {
      const c = source[i];
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
      } else if (c === "$" && source[i + 1] === "{") {
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
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
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
      while (j < n && source[j] !== c && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
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
      while (j < n && source[j] !== "\n") {
        const ch = source[j];
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
      while (j < n && /[a-z]/i.test(source[j])) {
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
      // A regular expression ends an operand: a `/` after it divides.
      last = ")";
      word = "";
      gap = false;
      continue;
    }
    if (holes.length > 0 && c === "{") {
      holes[holes.length - 1] += 1;
    } else if (holes.length > 0 && c === "}") {
      if (holes[holes.length - 1] === 0) {
        holes.pop();
        out += c;
        i += 1;
        template();
        continue;
      }
      holes[holes.length - 1] -= 1;
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

/**
 * The specifiers a module imports at run time: static imports and re-exports that are not
 * type-only (`import type`, `export type`, or every named binding marked `type`), side-effect
 * imports, and dynamic imports.
 */
export function runtimeSpecifiers(text) {
  const source = stripComments(text);
  const out = [];
  // An import or export-from clause holds only names, `*`, `as`, `type`, braces and commas: a
  // declaration (`export type A = B`) never reads as one.
  const statement = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\w$*\s{},]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    const [, , typeOnly, clause, specifier] = match;
    if (typeOnly) {
      continue;
    }
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (named) {
      const names = named[1].split(",").map((part) => part.trim()).filter((part) => part !== "");
      if (names.length > 0 && names.every((part) => part.startsWith("type "))) {
        continue;
      }
    }
    out.push(specifier);
  }
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) {
    out.push(match[1]);
  }
  // A dynamic import's specifier in quotes or backticks; a template with a `${}` in it names no one module.
  for (const match of source.matchAll(/import\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)) {
    if (!(match[1] === "`" && match[2].includes("${"))) {
      out.push(match[2]);
    }
  }
  return out;
}

/** A relative specifier as the source file it names (`./x.js` -> `x.ts`). */
function fileOf(from, specifier) {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [target.replace(/\.js$/, ".ts"), target, `${target}.ts`, join(target, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/** The first chain from `start` to lit-html (or the one copy), through run-time imports; `undefined` when none. */
export function chainToLit(start) {
  const seen = new Set();
  const walk = (file, chain) => {
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
      if (!specifier.startsWith(".")) {
        continue;
      }
      const next = fileOf(file, specifier);
      if (next) {
        const found = walk(next, [...chain, relative(repo, next)]);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(start, [relative(repo, start)]);
}

/** The modules under render/live/ a barrel names in its own run-time imports and re-exports. */
export function liveReexportsOf(barrel) {
  if (!existsSync(barrel)) {
    return [];
  }
  return runtimeSpecifiers(readFileSync(barrel, "utf8"))
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => fileOf(barrel, specifier))
    .filter((file) => file !== undefined && file.startsWith(`${LIVE_DIR}/`));
}

function sourcesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") {
        out.push(...sourcesUnder(full));
      }
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

export default function guard({ files, read, expect }) {
  for (const name of files.filter((file) => ISOLATED.some((pattern) => pattern.test(file)))) {
    const text = read(name);
    const hit = LIT_SENTINELS.find((pattern) => pattern.test(text));
    expect(hit === undefined, `${name} carries lit-html (${hit}); lit-html belongs to the live renderer alone and must never reach a QuickJS program or the sandbox module`);
  }

  for (const start of DOM_FREE_ROOTS.filter((file) => existsSync(file))) {
    const chain = chainToLit(start);
    expect(chain === undefined, `${relative(repo, start)} reaches lit-html at run time (${chain?.join(" -> ")}); a DOM-free entry stays free of the live renderer`);
  }

  for (const live of liveReexportsOf(RENDER_BARREL)) {
    const chain = chainToLit(live);
    expect(chain === undefined, `render/index.ts re-exports ${relative(repo, live)}, which reaches lit-html (${chain?.join(" -> ")}); the barrel re-exports the live renderer's DOM-free pieces only`);
  }

  const sources = [...sourcesUnder(engine), ...sourcesUnder(join(repo, "packages", "datum", "src"))];
  for (const file of sources) {
    if (file === ONE_COPY) {
      continue;
    }
    expect(!LIT_IMPORT.test(stripComments(readFileSync(file, "utf8"))), `${relative(repo, file)} imports lit-html; import it from engine/form-engine/render/live/lit.ts, the one copy (a binding takes it through createBinding(lit))`);
  }
}
