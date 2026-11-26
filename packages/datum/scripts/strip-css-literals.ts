import MagicString from "magic-string";
// TypeScript 7 ships no JavaScript compiler API (only `typescript/unstable/*`); the AST walk below
// reads the last release that has one, installed under this alias beside the tsc the package builds with.
import ts from "typescript-api";
import type { Plugin } from "vite";

/**
 * Strips comments and indentation from the CSS the engine keeps in template literals, at build
 * time and on the source, never on bundle text.
 *
 * The engine writes its shadow-root CSS as template literals (`wrapperStyles()`, `DATUM_STYLES`,
 * `PROPERTIES_STYLES`, …) with long explanatory comments. esbuild minifies the code around them but
 * cannot see inside a string, so every comment and every indented line shipped: about 47 KB of
 * comments and 14 KB of indentation in `datum-builder.js`, 16 KB and 3 KB in `datum-form.js`.
 *
 * Why the source and not the bundle: in the bundle, `/*` also opens code (`"image/*"`, accept
 * lists, regular expressions), and the two largest `/* … *\/` spans in the builder bundle are code.
 * Here each literal is found by the TypeScript parser, so only template-literal text is touched,
 * and only in a literal that reads as CSS:
 *
 * - once its comments are gone it has a rule block (`{ … }`) and at least one `name: value;`
 *   declaration;
 * - it holds no markup (`<tag`, `</`, `<!`) and no script (`=>`, `function`, `return`, `const`,
 *   `let`, `import`, `def`);
 * - a comment counts only when `/*` starts the text or follows whitespace or one of `;{}(,`, and
 *   ends inside the same piece of text, never across a `${…}`.
 *
 * In such a literal each comment is dropped, and every run of whitespace that holds a line break
 * becomes one line break: CSS treats a line break as any other whitespace, so selectors and
 * values keep their meaning. Literals that fail any test are left exactly as written. The source
 * map is kept (magic-string), so a bundle still maps back to every line of the engine.
 *
 * Tests that read the engine's source read `src` files, not bundles, and run without this
 * plugin (it applies to `vite build` only).
 */

const COMMENT = /(^|[\s;{}(,])\/\*[\s\S]*?\*\//g;
const MARKUP = /<[a-zA-Z!/]/;
const SCRIPT = /=>|\bfunction\b|\breturn\b|\bconst\b|\blet\b|\bimport\b|\bdef\b/;
const RULE_BLOCK = /\{[^{}]*\}/;
const DECLARATION = /(^|[\s;{])-{0,2}[a-zA-Z][\w-]*\s*:\s*[^;{}]+;/;

/** A literal's pieces of text, raw as written, with where each sits in the file. */
interface Piece {
  start: number;
  end: number;
  raw: string;
}

function piecesOf(node: ts.TemplateLiteral, text: string, file: ts.SourceFile): Piece[] {
  const piece = (part: ts.TemplateLiteralLikeNode, open: number, close: number): Piece => {
    const start = part.getStart(file) + open;
    const end = part.end - close;
    return { start, end, raw: text.slice(start, end) };
  };
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [piece(node, 1, 1)];
  return [
    piece(node.head, 1, 2),
    ...node.templateSpans.map((span) => piece(span.literal, 1, ts.isTemplateTail(span.literal) ? 1 : 2))
  ];
}

/** Whether a literal (its pieces, comments already removed) reads as CSS. */
export function readsAsCss(pieces: readonly string[]): boolean {
  const joined = pieces.join(" ");
  return RULE_BLOCK.test(joined) && DECLARATION.test(joined) && !MARKUP.test(joined) && !SCRIPT.test(joined);
}

/** One piece of a CSS literal, comments dropped and line-broken whitespace collapsed. */
export function compactCss(raw: string): string {
  return raw.replace(COMMENT, "$1").replace(/[ \t]*\n\s*/g, "\n");
}

export interface StripResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  /** Literals rewritten, and bytes saved, for the build log. */
  literals: number;
  saved: number;
}

/** Rewrites the CSS literals in one TypeScript module; `undefined` when nothing changes. */
export function stripCssLiterals(code: string, id: string): StripResult | undefined {
  if (!code.includes("`")) return undefined;
  const file = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new MagicString(code);
  let literals = 0;
  let saved = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const pieces = piecesOf(node, code, file);
      const bare = pieces.map((p) => p.raw.replace(COMMENT, "$1"));
      if (readsAsCss(bare)) {
        let changed = false;
        for (const p of pieces) {
          const next = compactCss(p.raw);
          if (next !== p.raw) {
            if (p.end > p.start) out.overwrite(p.start, p.end, next);
            saved += p.raw.length - next.length;
            changed = true;
          }
        }
        if (changed) literals += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (literals === 0) return undefined;
  return { code: out.toString(), map: out.generateMap({ hires: true, source: id }), literals, saved };
}

/** The engine's own source and this repository's packages, themes and plugins; never node_modules. */
const OWN_SOURCE = /\/(engine\/form-engine|(?:packages|themes|plugins)\/[\w-]+\/src)\/.*\.ts$/;

export function stripCssLiteralsPlugin(): Plugin {
  let literals = 0;
  let saved = 0;
  return {
    name: "datum:strip-css-literals",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      if (!OWN_SOURCE.test(path) || path.includes("/node_modules/") || path.endsWith(".d.ts")) return null;
      const result = stripCssLiterals(code, path);
      if (!result) return null;
      literals += result.literals;
      saved += result.saved;
      return { code: result.code, map: result.map };
    },
    buildEnd() {
      if (literals > 0) this.info(`stripped ${literals} CSS literals, ${saved} bytes of comments and indentation`);
    }
  };
}
