/**
 * The design system's own files, as the host serves them (`LiveAssets`): stylesheets adopted
 * into the form's shadow root, `@font-face` rules lifted to one document sheet per binding, and
 * the design system's scripts loaded once per page. Datum ships none of these files and reads no
 * version from them: the host names the addresses, and moves to another release by changing one.
 *
 * A stylesheet goes through four steps:
 * 1. fetched (`fetch()`, so it must be same-origin or served with CORS; `integrity` checked by
 *    the fetch), once per page per `(url, integrity)`;
 * 2. composed as text: every relative address (a `url()` in any case, a string in
 *    `image-set()`; none inside a comment or another string) resolved against the sheet's own
 *    address (a constructed sheet has no base of its own for text inlined from elsewhere), and
 *    the leading `@import` rules replaced by the text they name where they stand among the
 *    `@layer` statements, kept under their `layer`, `supports()` and media conditions (a
 *    constructed sheet drops `@import`);
 * 3. parsed by the browser into a constructed sheet, and its rules rewritten in place over the
 *    parsed `cssRules`: selectors that open with the page (`html`, `body`, `:root`, also inside a
 *    leading `:where()`/`:is()`) name the shadow host instead, page-only declarations on the bare
 *    page elements go, nested rules and grouping rules are walked the same way, `@font-face` rules
 *    are taken out, and `rem` lengths are rewritten when the design system expects another root
 *    font size than the page has;
 * 4. adopted into the root ahead of the renderer's own sheets, so the renderer's structure and
 *    the binding's CSS win a tie.
 * One constructed sheet per `(document, url, integrity, rewrite options)` is shared by every form
 * that names it and released with the last of them.
 *
 * A stylesheet or script that cannot be had (network, CORS, an HTTP error, integrity) fails the
 * mount loudly: {@link AssetLoadError} carries the address, the renderer puts an alert in the
 * form's place and emits `datum-binding-error {hook: "assets", url}`. A font sheet that cannot be
 * had is reported the same way but does not stop the form: text falls back to another face.
 *
 * Where the browser has Trusted Types, a script's address is set through Datum's own
 * `datum-assets` policy (made on the first script, passing only the addresses asked for here),
 * so a page that enforces them allows that name rather than a `default` policy.
 */
import { ASSETS_TRUSTED_TYPES_POLICY } from "./assets-policy.js";
import type { AssetSource, LiveAssets, ScriptSource } from "./contract.js";

// ── Errors ─────────────────────────────────────────────────────────────────────────────────

/** A design-system file that could not be had, with its address when there is one. */
export class AssetLoadError extends Error {
  readonly url: string | undefined;

  constructor(message: string, url?: string) {
    super(message);
    this.name = "AssetLoadError";
    this.url = url;
  }
}

/** Integrity is a list of `sha256-`/`sha384-`/`sha512-` digests; anything else would be checked against nothing. */
const INTEGRITY = /^\s*(?:sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}(?:\?\S*)?\s*)+$/;

function checkedIntegrity(integrity: string | undefined, what: string, address: string): string | undefined {
  if (integrity !== undefined && !INTEGRITY.test(integrity)) {
    throw new AssetLoadError(`${what} ${address} names integrity "${integrity}", which is not a sha256, sha384 or sha512 digest.`, address);
  }
  return integrity;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    throw new AssetLoadError(`"${url}" is not an address.`, url);
  }
}

function documentBase(doc: Document | undefined): string {
  return doc?.baseURI ?? (typeof document !== "undefined" ? document.baseURI : "about:blank");
}

// ── Fetching and composing a sheet's text ──────────────────────────────────────────────────

/** Fetched text by `(url, integrity)`, with its `url()`s resolved: never fetched twice on a page. */
const fetchedTexts = new Map<string, Promise<string>>();

const keyOf = (...parts: ReadonlyArray<string | undefined>): string => parts.map((part) => part ?? "").join("\u0000");

/** The deepest `@import` chain followed; a deeper one is an error, not a silent cut. */
const IMPORT_DEPTH = 16;

async function fetchText(address: string, integrity: string | undefined, importedBy?: string): Promise<string> {
  const what = importedBy === undefined ? `Stylesheet ${address}` : `Stylesheet ${address} (imported by ${importedBy})`;
  if (typeof fetch !== "function") {
    throw new AssetLoadError(`${what} could not be fetched: this page has no fetch().`, address);
  }
  let response: Response;
  try {
    response = await fetch(address, integrity !== undefined ? { integrity } : {});
  } catch (thrown) {
    const integrityNote = integrity !== undefined ? ", and that its integrity matches" : "";
    throw new AssetLoadError(
      `${what} could not be fetched (${messageOf(thrown)}). Check it is served from this page's origin or from an origin that allows CORS${integrityNote}.`,
      address
    );
  }
  if (!response.ok) {
    throw new AssetLoadError(`${what} answered ${response.status}.`, address);
  }
  try {
    return resolveUrls(await response.text(), address);
  } catch (thrown) {
    throw new AssetLoadError(`${what} could not be read (${messageOf(thrown)}).`, address);
  }
}

function fetchedText(address: string, integrity: string | undefined, importedBy?: string): Promise<string> {
  const key = keyOf(address, integrity);
  let text = fetchedTexts.get(key);
  if (!text) {
    text = fetchText(address, integrity, importedBy);
    fetchedTexts.set(key, text);
    // Forgotten on failure, so a corrected server or a retry is not answered from it.
    text.catch(() => {
      if (fetchedTexts.get(key) === text) {
        fetchedTexts.delete(key);
      }
    });
  }
  return text;
}

/** An address that stands on its own: a scheme (`data:`, `blob:`, `https:`), protocol-relative, or a fragment. */
const STANDS_ALONE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
/** A character of a CSS name: what the function name before a `(` is made of. */
const FUNCTION_NAME_CHAR = /[-\w\\\u0080-￿]/;
/** The functions whose strings are addresses as a `url()` is. */
const IMAGE_SET = new Set(["image-set", "-webkit-image-set"]);

/** `path` resolved against `address`, or undefined when it stands on its own or is no address. */
function resolvedPath(path: string, address: string): string | undefined {
  const trimmed = path.trim();
  if (trimmed === "" || STANDS_ALONE.test(trimmed)) {
    return undefined;
  }
  try {
    return new URL(trimmed, address).href;
  } catch {
    return undefined;
  }
}

/** The name of the function whose `(` is at `open`, lowercased; empty for a bare parenthesis. */
function functionNameBefore(text: string, open: number): string {
  let from = open;
  while (from > 0 && FUNCTION_NAME_CHAR.test(text[from - 1] as string)) {
    from -= 1;
  }
  return text.slice(from, open).toLowerCase();
}

/**
 * Every relative address resolved against `address`: a `url()` (any case, quoted or not) and a
 * string inside `image-set()`. One that stands on its own is left as it is, and nothing inside a
 * comment or a string (a `content` naming `url(x)`) is touched.
 */
export function resolveUrls(text: string, address: string): string {
  let out = "";
  let copied = 0;
  /** The functions open around the scan, innermost last. */
  const open: string[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || text.startsWith("/*", i)) {
      const end = skipOpaque(text, i);
      const closed = text[end - 1] === c && end - i >= 2;
      if (c !== "/" && closed && IMAGE_SET.has(open[open.length - 1] ?? "")) {
        const resolved = resolvedPath(text.slice(i + 1, end - 1), address);
        if (resolved !== undefined) {
          out += `${text.slice(copied, i)}${c}${resolved}${c}`;
          copied = end;
        }
      }
      i = end;
      continue;
    }
    if (c === "(") {
      const name = functionNameBefore(text, i);
      if (name === "url") {
        // A url() runs to its own parenthesis: a quoted address may hold one, a bare one cannot.
        let at = i + 1;
        while (at < text.length && /\s/.test(text[at] as string)) {
          at += 1;
        }
        const quote = text[at] === '"' || text[at] === "'" ? (text[at] as string) : "";
        const pathEnd = quote !== "" ? skipOpaque(text, at) : text.indexOf(")", at);
        const close = quote !== "" ? text.indexOf(")", pathEnd) : pathEnd;
        if (close < 0) {
          break;
        }
        const path = quote !== "" ? text.slice(at + 1, pathEnd - 1) : text.slice(at, close);
        const wellFormed = quote !== "" ? text.slice(pathEnd, close).trim() === "" : !/[\s'"(]/.test(path.trim());
        const resolved = wellFormed ? resolvedPath(path, address) : undefined;
        if (resolved !== undefined) {
          out += `${text.slice(copied, i - name.length)}url(${quote}${resolved}${quote})`;
          copied = close + 1;
        }
        i = close + 1;
        continue;
      }
      open.push(name);
    } else if (c === ")") {
      open.pop();
    }
    i += 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Index just past the comment or string starting at `at`, or `at` when neither starts there. */
function skipOpaque(text: string, at: number): number {
  if (text.startsWith("/*", at)) {
    const end = text.indexOf("*/", at + 2);
    return end < 0 ? text.length : end + 2;
  }
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    let i = at + 1;
    while (i < text.length && text[i] !== quote) {
      i += text[i] === "\\" ? 2 : 1;
    }
    return Math.min(i + 1, text.length);
  }
  return at;
}

/** Index just past the `;` that ends the statement starting at `at` (strings, comments and `url(...)` skipped). */
function statementEnd(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; ) {
    const skipped = skipOpaque(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (/^url\(/i.test(text.slice(i, i + 4))) {
      // An unquoted url may hold a semicolon (a Google Fonts address does): to its parenthesis.
      const close = text.indexOf(")", i);
      i = close < 0 ? text.length : close + 1;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === ";" && depth <= 0) {
      return i + 1;
    } else if (c === "{" && depth <= 0) {
      return -1;
    }
    i += 1;
  }
  return text.length;
}

interface LeadingImport {
  target: string;
  conditions: string;
}

interface LeadingImports {
  /**
   * The `@layer a, b;` statements and the imports, in the order the sheet has them: a layer
   * statement fixes the layer order where it stands, so one after an import names its layers
   * after the imported one's.
   */
  prelude: Array<{ layer: string } | LeadingImport>;
  /** The imports alone, in order. */
  imports: LeadingImport[];
  /** The text after the imports. */
  rest: string;
}

const IMPORT_TARGET = /^@import\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')([\s\S]*);$/i;

/**
 * The `@import` rules a sheet opens with. Only those count: an `@import` after any other rule is
 * invalid CSS, and one inside a comment or a string is not a rule at all.
 */
export function leadingImports(text: string): LeadingImports {
  const prelude: LeadingImports["prelude"] = [];
  const imports: LeadingImport[] = [];
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at] as string)) {
      at += 1;
    }
    if (text.startsWith("/*", at)) {
      at = skipOpaque(text, at);
      continue;
    }
    const keyword = /^@([-\w]+)/.exec(text.slice(at, at + 32))?.[1]?.toLowerCase();
    if (keyword !== "charset" && keyword !== "import" && keyword !== "layer") {
      break;
    }
    const end = statementEnd(text, at);
    if (end < 0) {
      // `@layer name { ... }`, a block: the rules have started.
      break;
    }
    const statement = text.slice(at, end).trim();
    if (keyword === "layer") {
      prelude.push({ layer: statement });
    } else if (keyword === "import") {
      const match = IMPORT_TARGET.exec(statement);
      if (match) {
        const target = [match[1], match[2], match[3], match[4], match[5]].find((part) => part !== undefined) ?? "";
        const found = { target: target.trim(), conditions: (match[6] ?? "").trim() };
        prelude.push(found);
        imports.push(found);
      }
    }
    at = end;
  }
  return { prelude, imports, rest: text.slice(at) };
}

/**
 * An `@import`'s conditions as the at-rules that wrap the imported text, outermost first:
 * `layer` / `layer(name)`, then `supports(...)`, then the media query list. Imported text is
 * inlined, so the conditions the import named must hold over it still.
 */
export function importWrappers(conditions: string): { open: string; close: string } {
  let rest = conditions.trim();
  const open: string[] = [];
  const layer = /^layer(?:\(\s*([^)]*?)\s*\))?(?=\s|$|supports\()/i.exec(rest);
  if (layer) {
    open.push(layer[1] ? `@layer ${layer[1]}{` : "@layer{");
    rest = rest.slice(layer[0].length).trim();
  }
  if (/^supports\(/i.test(rest)) {
    // The condition runs to the parenthesis that closes `supports(`.
    let depth = 0;
    let at = "supports".length;
    for (; at < rest.length; at += 1) {
      if (rest[at] === "(") {
        depth += 1;
      } else if (rest[at] === ")" && (depth -= 1) === 0) {
        break;
      }
    }
    const condition = rest.slice("supports(".length, at).trim();
    open.push(`@supports (${condition}){`);
    rest = rest.slice(at + 1).trim();
  }
  if (rest !== "") {
    open.push(`@media ${rest}{`);
  }
  return { open: open.join(""), close: "}".repeat(open.length) };
}

/**
 * A stylesheet's text with its `@import`s inlined under their conditions, every `url()` absolute.
 * An import that cannot be fetched fails the sheet; one that imports a sheet already on its own
 * chain is skipped, as a browser skips it.
 */
async function composedCss(address: string, integrity: string | undefined, chain: readonly string[] = []): Promise<string> {
  const text = await fetchedText(address, integrity, chain[chain.length - 1]);
  const { prelude, imports, rest } = leadingImports(text);
  if (imports.length === 0) {
    return text;
  }
  if (chain.length >= IMPORT_DEPTH) {
    throw new AssetLoadError(`Stylesheet ${address} imports sheets more than ${IMPORT_DEPTH} deep.`, address);
  }
  const onChain = [...chain, address];
  // Each import's text stands where the import stood, among the layer statements around it.
  const inlined = await Promise.all(
    prelude.map(async (item) => {
      if ("layer" in item) {
        return item.layer;
      }
      const { target, conditions } = item;
      const imported = absolute(target, address);
      if (onChain.includes(imported)) {
        return "";
      }
      const css = await composedCss(imported, undefined, onChain);
      const { open, close } = importWrappers(conditions);
      return open === "" ? css : `${open}\n${css}\n${close}`;
    })
  );
  return [...inlined, rest].join("\n");
}

// ── Rewriting the parsed rules for a shadow root ───────────────────────────────────────────

/** How a sheet's rules are rewritten; part of every cache key. */
export interface RewriteOptions {
  /**
   * `rem` lengths become `calc(n * var(--datum-rem))` when set: the root font size in px the
   * design system's sheet expects, and the one the host page has.
   */
  rem?: { expected: number; actual: number };
}

/** The ratio a rem is scaled by, or undefined when no rewrite is needed. */
function remRatio(options: RewriteOptions): number | undefined {
  const rem = options.rem;
  if (!rem || !(rem.expected > 0) || !(rem.actual > 0) || rem.expected === rem.actual) {
    return undefined;
  }
  return Math.round((rem.expected / rem.actual) * 1e6) / 1e6;
}

function rewriteKey(options: RewriteOptions): string {
  const ratio = remRatio(options);
  return ratio === undefined ? "" : `rem=${ratio}`;
}

/** Splits on commas outside parentheses, brackets and strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; ) {
    const skipped = skipOpaque(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i];
    if (c === "(" || c === "[") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
    i += 1;
  }
  parts.push(text.slice(from));
  return parts;
}

/** Index of the bracket that closes the one at `open`. */
function closingBracket(text: string, open: number): number {
  const opener = text[open] as string;
  const closer = opener === "[" ? "]" : ")";
  let depth = 0;
  for (let i = open; i < text.length; ) {
    const skipped = skipOpaque(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] === opener) {
      depth += 1;
    } else if (text[i] === closer && (depth -= 1) === 0) {
      return i;
    }
    i += 1;
  }
  return text.length - 1;
}

/** The length of the compound selector `text` opens with. */
function compoundLength(text: string): number {
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s|[>+~,]/.test(c)) {
      break;
    }
    if (c === "[" || c === "(") {
      i = closingBracket(text, i) + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipOpaque(text, i);
      continue;
    }
    i += 1;
  }
  return i;
}

const NAME_CHAR = /[-_a-zA-Z0-9 -￿\\]/;

/** The page element a compound opens with (`html`, `body`, `:root`), and what follows it in the compound. */
function pageElementOf(compound: string): { element: string; rest: string } | undefined {
  const match = /^(html|body|:root)/i.exec(compound);
  if (!match || NAME_CHAR.test(compound[match[0].length] ?? "")) {
    return undefined;
  }
  return { element: match[0].toLowerCase(), rest: compound.slice(match[0].length) };
}

/** `:host` with what qualified the page element: `.x[y]:not(z)` -> `:host(.x[y]:not(z))`, a pseudo-element kept after it. */
function hostOf(rest: string): string {
  const pseudo = rest.indexOf("::");
  const inner = pseudo < 0 ? rest : rest.slice(0, pseudo);
  const after = pseudo < 0 ? "" : rest.slice(pseudo);
  return `:host${inner ? `(${inner})` : ""}${after}`;
}

/** `:root` -> `:host` outside strings (it never matches in a shadow tree; `:host` is its stand-in there). */
function rootAsHost(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const skipped = skipOpaque(text, i);
    if (skipped !== i) {
      out += text.slice(i, skipped);
      i = skipped;
      continue;
    }
    if (text.startsWith(":root", i) && !NAME_CHAR.test(text[i + 5] ?? "")) {
      out += ":host";
      i += 5;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** One selector of a list: its leading page element (and an `html body` pair) as the host. */
function rewriteSelector(selector: string): { text: string; pageOnly: boolean } {
  const lead = /^(\s*)/.exec(selector)?.[1] ?? "";
  const body = selector.slice(lead.length);
  const compound = body.slice(0, compoundLength(body));
  const first = pageElementOf(compound);
  if (!first) {
    // `:where(html)`, `:is(:root, body)`: the page inside a leading `:where()`/`:is()` names the
    // host too, kept inside it so the selector's specificity stays what the sheet chose.
    const functional = /^:(where|is)\(/i.exec(compound);
    if (functional) {
      const open = functional[0].length - 1;
      const close = closingBracket(compound, open);
      const inner = rewriteSelectorList(compound.slice(open + 1, close));
      const after = compound.slice(close + 1);
      const tail = body.slice(compound.length);
      return {
        text: `${lead}${functional[0]}${inner.text})${rootAsHost(after)}${rootAsHost(tail)}`,
        pageOnly: inner.pageOnly && after === "" && tail.trim() === ""
      };
    }
    return { text: lead + rootAsHost(body), pageOnly: false };
  }
  let consumed = first.element.length + first.rest.length;
  let rest = first.rest;
  // `html body …` / `html > body …`: the two page elements are one host here.
  if (first.element !== "body") {
    const between = /^(\s*>?\s*)/.exec(body.slice(consumed))?.[1] ?? "";
    const next = body.slice(consumed + between.length);
    const second = between !== "" ? pageElementOf(next.slice(0, compoundLength(next))) : undefined;
    if (second && second.element === "body") {
      consumed += between.length + second.element.length + second.rest.length;
      rest += second.rest;
    }
  }
  const tail = body.slice(consumed);
  return {
    text: lead + hostOf(rootAsHost(rest)) + rootAsHost(tail),
    pageOnly: rest === "" && tail.trim() === "" && first.element !== ":root"
  };
}

/**
 * A selector list with every selector that opens with the page made to name the shadow host:
 * `:root`, `html` and `body` match nothing in a shadow tree. A qualified page element keeps its
 * qualifier on the host (`:root[data-theme=dark]` -> `:host([data-theme=dark])`,
 * `body.modal-open` -> `:host(.modal-open)`, `html[dir=rtl] .x` -> `:host([dir=rtl]) .x`).
 * `pageOnly` when every selector is a bare `html` or `body`.
 */
export function rewriteSelectorList(selectors: string): { text: string; pageOnly: boolean } {
  const parts = splitTopLevel(selectors).map(rewriteSelector);
  return { text: parts.map((part) => part.text).join(","), pageOnly: parts.every((part) => part.pageOnly) };
}

/**
 * What a page's bare `html` and `body` rules say about the page itself, not about what is in it:
 * scrolling, overflow, height, margins. On the form's host they would do harm (USWDS's
 * `body { overflow-x: hidden }` makes the host its own formatting context, so the first field's
 * margin no longer collapses through it). Face, colour, line height and background stay: they
 * are what a page hands down.
 */
const PAGE_ONLY_PROPERTIES = [
  "overflow",
  "overflow-x",
  "overflow-y",
  "overscroll-behavior",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "scroll-behavior",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left"
] as const;

const REM_LENGTH = /(^|[^\w.\\-])([+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?)rem(?![\w-])/gi;

/** `rem` lengths in a declaration block's text as multiples of `var(--datum-rem)`; strings and `url()`s untouched. */
export function remAsVariable(declarations: string): string {
  let out = "";
  let from = 0;
  const flush = (to: number): void => {
    out += declarations.slice(from, to).replace(REM_LENGTH, (_match, before: string, number: string) => `${before}calc(${number} * var(--datum-rem))`);
  };
  for (let i = 0; i < declarations.length; ) {
    const skipped = skipOpaque(declarations, i);
    if (skipped !== i) {
      flush(i);
      out += declarations.slice(i, skipped);
      from = i = skipped;
      continue;
    }
    if (/^url\(/i.test(declarations.slice(i, i + 4))) {
      flush(i);
      const close = declarations.indexOf(")", i);
      const end = close < 0 ? declarations.length : close + 1;
      out += declarations.slice(i, end);
      from = i = end;
      continue;
    }
    i += 1;
  }
  flush(declarations.length);
  return out;
}

/** The rules of a sheet or of a rule that holds rules (grouping, nested). */
interface RuleList {
  readonly cssRules: CSSRuleList;
  deleteRule(index: number): void;
}

const ruleName = (rule: CSSRule): string => (rule as { constructor?: { name?: string } }).constructor?.name ?? "";

/** CSSRule.type numbers, read where the constructor's name is not the standard one. */
const FONT_FACE_RULE_TYPE = 5;
const STYLE_RULE_TYPE = 1;

function isFontFace(rule: CSSRule): boolean {
  return ruleName(rule) === "CSSFontFaceRule" || rule.type === FONT_FACE_RULE_TYPE;
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return (ruleName(rule) === "CSSStyleRule" || rule.type === STYLE_RULE_TYPE) && typeof (rule as CSSStyleRule).selectorText === "string";
}

function styleOf(rule: CSSRule): CSSStyleDeclaration | undefined {
  const style = (rule as { style?: unknown }).style;
  return typeof style === "object" && style !== null && typeof (style as CSSStyleDeclaration).cssText === "string" ? (style as CSSStyleDeclaration) : undefined;
}

function childRules(rule: CSSRule): RuleList | undefined {
  const holder = rule as unknown as Partial<RuleList>;
  return holder.cssRules !== undefined && typeof holder.deleteRule === "function" ? (holder as RuleList) : undefined;
}

/** Rewrites `list` in place (see the module comment); the `@font-face` rules it held, in order. */
function rewriteRules(list: RuleList, ratio: number | undefined, faces: string[]): void {
  for (let i = 0; i < list.cssRules.length; ) {
    const rule = list.cssRules[i] as CSSRule;
    if (isFontFace(rule)) {
      faces.push(rule.cssText);
      list.deleteRule(i);
      continue;
    }
    if (isStyleRule(rule)) {
      const { text, pageOnly } = rewriteSelectorList(rule.selectorText);
      if (text !== rule.selectorText) {
        rule.selectorText = text;
      }
      if (pageOnly) {
        for (const property of PAGE_ONLY_PROPERTIES) {
          rule.style.removeProperty(property);
        }
      }
    }
    if (ratio !== undefined) {
      const style = styleOf(rule);
      if (style) {
        const before = style.cssText;
        const after = remAsVariable(before);
        if (after !== before) {
          style.cssText = after;
        }
      }
    }
    const children = childRules(rule);
    if (children) {
      rewriteRules(children, ratio, faces);
    }
    i += 1;
  }
}

type SheetConstructor = new (options?: { baseURL?: string }) => CSSStyleSheet;

function sheetConstructorOf(doc: Document): SheetConstructor {
  const view = doc.defaultView as (Window & { CSSStyleSheet?: SheetConstructor }) | null;
  const made = view?.CSSStyleSheet ?? (typeof CSSStyleSheet === "function" ? (CSSStyleSheet as unknown as SheetConstructor) : undefined);
  if (made === undefined || typeof made.prototype.replaceSync !== "function") {
    throw new AssetLoadError("This browser cannot construct stylesheets, so the design system's stylesheets cannot be adopted.");
  }
  return made;
}

function constructSheet(doc: Document, baseURL?: string): CSSStyleSheet {
  const Sheet = sheetConstructorOf(doc);
  if (baseURL !== undefined) {
    try {
      return new Sheet({ baseURL });
    } catch {
      // A browser without the option: every url() is already absolute.
    }
  }
  return new Sheet();
}

/**
 * A stylesheet's composed text parsed and made to work inside a shadow root, in `doc`. The
 * `@font-face` rules it held come back apart: a face declared inside a shadow root is never
 * registered, so they go to the document's font sheet.
 */
export function shadowSheet(text: string, doc: Document, options: RewriteOptions = {}, baseURL?: string): { sheet: CSSStyleSheet; faces: string[] } {
  const sheet = constructSheet(doc, baseURL);
  sheet.replaceSync(text);
  const faces: string[] = [];
  rewriteRules(sheet, remRatio(options), faces);
  // A face goes to the document's sheet, which has no base of its own: a relative address in it
  // would be read against the page.
  return { sheet, faces: baseURL === undefined ? faces : faces.map((face) => resolveUrls(face, baseURL)) };
}

/** The `@font-face` rules of a sheet's text, without keeping the sheet, every address resolved against `address`. */
function fontFacesOf(text: string, doc: Document, address: string): string[] {
  const sheet = constructSheet(doc);
  sheet.replaceSync(text);
  const faces: string[] = [];
  const collect = (list: RuleList): void => {
    for (const rule of Array.from(list.cssRules)) {
      if (isFontFace(rule)) {
        faces.push(resolveUrls(rule.cssText, address));
      } else {
        const children = childRules(rule);
        if (children) {
          collect(children);
        }
      }
    }
  };
  collect(sheet);
  return faces;
}

// ── Shared sheets, counted ─────────────────────────────────────────────────────────────────

interface SheetEntry {
  users: number;
  made: Promise<{ sheet: CSSStyleSheet; faces: string[] }>;
}

/** Constructed sheets by `(url, integrity, rewrite options)`, per document (a constructed sheet is adopted only in its own). */
let sheetsByDocument = new WeakMap<Document, Map<string, SheetEntry>>();

function sheetsOf(doc: Document): Map<string, SheetEntry> {
  let sheets = sheetsByDocument.get(doc);
  if (!sheets) {
    sheets = new Map();
    sheetsByDocument.set(doc, sheets);
  }
  return sheets;
}

/** One user's hold on a shared sheet: `release` gives it back, and the last release forgets it. */
function acquireSheet(doc: Document, source: AssetSource, options: RewriteOptions): { key: string; made: SheetEntry["made"]; release(): void } {
  const address = absolute(source.url, documentBase(doc));
  const key = keyOf(address, source.integrity, rewriteKey(options));
  const sheets = sheetsOf(doc);
  let entry = sheets.get(key);
  if (!entry) {
    const integrity = checkedIntegrity(source.integrity, "Stylesheet", address);
    const made = composedCss(address, integrity).then((text) => {
      try {
        return shadowSheet(text, doc, options, address);
      } catch (thrown) {
        throw new AssetLoadError(`Stylesheet ${address} could not be adopted (${messageOf(thrown)}).`, address);
      }
    });
    const fresh: SheetEntry = { users: 0, made };
    entry = fresh;
    sheets.set(key, fresh);
    made.catch(() => {
      if (sheets.get(key) === fresh) {
        sheets.delete(key);
      }
    });
  }
  entry.users += 1;
  const held = entry;
  let released = false;
  return {
    key,
    made: held.made,
    release() {
      if (released) {
        return;
      }
      released = true;
      held.users -= 1;
      if (held.users <= 0 && sheets.get(key) === held) {
        sheets.delete(key);
      }
    }
  };
}

// ── The document's font sheet, one per binding ─────────────────────────────────────────────

interface FontSheet {
  users: number;
  faces: Set<string>;
  /** A constructed sheet in `document.adoptedStyleSheets`, or a `<style>` in the head where the document has none. */
  sheet?: CSSStyleSheet;
  element?: HTMLStyleElement;
}

let fontSheetsByDocument = new WeakMap<Document, Map<string, FontSheet>>();

/** Whether `target` takes constructed sheets (jsdom's shadow roots and documents do not). */
function hasAdoptedSheets(target: Document | ShadowRoot): boolean {
  return Array.isArray((target as { adoptedStyleSheets?: unknown }).adoptedStyleSheets);
}

/**
 * The one page-level sheet a binding adds: its faces and nothing else. A face declared inside a
 * shadow root is never registered, so the faces a design system's stylesheets declare are
 * declared here, once per binding however many forms use it, and taken away with the last form.
 */
export function acquireFontSheet(doc: Document, bindingId: string): { add(faces: readonly string[]): void; release(): void } {
  let sheets = fontSheetsByDocument.get(doc);
  if (!sheets) {
    sheets = new Map();
    fontSheetsByDocument.set(doc, sheets);
  }
  const all = sheets;
  let entry = all.get(bindingId);
  if (!entry) {
    entry = { users: 0, faces: new Set() };
    all.set(bindingId, entry);
  }
  entry.users += 1;
  const held = entry;
  let released = false;
  return {
    add(faces) {
      if (released) {
        return;
      }
      const fresh = faces.filter((face) => !held.faces.has(face));
      if (fresh.length === 0) {
        return;
      }
      for (const face of fresh) {
        held.faces.add(face);
      }
      if (hasAdoptedSheets(doc)) {
        if (!held.sheet) {
          held.sheet = constructSheet(doc);
          doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, held.sheet];
        }
        for (const face of fresh) {
          try {
            held.sheet.insertRule(face, held.sheet.cssRules.length);
          } catch {
            // A face this browser cannot read is one it would not have used.
          }
        }
        return;
      }
      let element = held.element;
      if (!element) {
        element = doc.createElement("style");
        element.setAttribute("data-datum-binding-fonts", bindingId);
        (doc.head ?? doc.documentElement).append(element);
        held.element = element;
      }
      element.textContent = [...held.faces].join("\n");
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      held.users -= 1;
      if (held.users > 0 || all.get(bindingId) !== held) {
        return;
      }
      all.delete(bindingId);
      const sheet = held.sheet;
      if (sheet && hasAdoptedSheets(doc)) {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
      }
      held.element?.remove();
    }
  };
}

// ── Scripts ────────────────────────────────────────────────────────────────────────────────

interface ScriptLoad {
  integrity: string | undefined;
  loaded: Promise<void>;
}

/** Scripts asked for, by document and absolute address: a second form waits on the same load. */
let scriptsByDocument = new WeakMap<Document, Map<string, ScriptLoad>>();

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface ScriptUrlPolicyFactory {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): ScriptUrlPolicy;
}

/**
 * The `datum-assets` policy of a window, made on its first script (a second `createPolicy` of a
 * name throws), with the addresses it passes: only those `loadScript` was asked for, which are
 * the host's `assets.scripts`. `policy` is null where the page refused the name.
 */
let scriptPoliciesByWindow = new WeakMap<object, { policy: ScriptUrlPolicy | null; listed: Set<string> }>();

/**
 * What a script's `src` is set to: a `TrustedScriptURL` from the `datum-assets` policy where the
 * browser has Trusted Types, else the address itself. A page that enforces Trusted Types and does
 * not allow the policy refuses the plain address when it is set (the caller names the policy).
 */
function scriptSourceOf(address: string, doc: Document): unknown {
  const win = doc.defaultView;
  const factory = win ? (win as { trustedTypes?: ScriptUrlPolicyFactory }).trustedTypes : undefined;
  if (!win || !factory || typeof factory.createPolicy !== "function") {
    // No Trusted Types in this browser: nothing enforces them either.
    return address;
  }
  let made = scriptPoliciesByWindow.get(win);
  if (!made) {
    const listed = new Set<string>();
    let policy: ScriptUrlPolicy | null = null;
    try {
      policy = factory.createPolicy(ASSETS_TRUSTED_TYPES_POLICY, {
        createScriptURL: (input) => {
          if (!listed.has(input)) {
            throw new TypeError(`The "${ASSETS_TRUSTED_TYPES_POLICY}" policy passes only the scripts a binding's assets list; ${input} is not one.`);
          }
          return input;
        }
      });
    } catch {
      // The page's trusted-types directive does not name it: a page that enforces them refuses the address below.
      policy = null;
    }
    made = { policy, listed };
    scriptPoliciesByWindow.set(win, made);
  }
  if (!made.policy) {
    return address;
  }
  made.listed.add(address);
  return made.policy.createScriptURL(address);
}

function refusedScript(address: string, thrown: unknown): AssetLoadError {
  if (thrown instanceof TypeError && /trusted/i.test(thrown.message)) {
    return new AssetLoadError(
      `Script ${address} could not be loaded: this page enforces Trusted Types and does not allow the "${ASSETS_TRUSTED_TYPES_POLICY}" policy a design system's scripts are loaded through. Add it to the page's trusted-types directive (trusted-types lit-html datum-print ${ASSETS_TRUSTED_TYPES_POLICY}).`,
      address
    );
  }
  return new AssetLoadError(`Script ${address} could not be loaded: ${messageOf(thrown)}`, address);
}

/**
 * Loads one of the design system's scripts and resolves when it has run; rejects, naming the
 * address, when it cannot be loaded. A module unless `classic`; classic scripts run in the order
 * they are asked for. `integrity` is checked by the browser (and the script fetched with CORS so
 * it can be). A script runs once per page: it defines custom elements, which nothing undoes, so
 * no unmount takes it away. A script the page already carries is the page's own and counts as run;
 * when the host names an `integrity`, the page's tag must carry the same one (else the load is
 * refused), and what is remembered is the tag's own.
 */
export function loadScript(entry: ScriptSource, doc: Document = document): Promise<void> {
  let address: string;
  try {
    address = absolute(entry.url, documentBase(doc));
    checkedIntegrity(entry.integrity, "Script", address);
  } catch (thrown) {
    return Promise.reject(thrown);
  }
  let loads = scriptsByDocument.get(doc);
  if (!loads) {
    loads = new Map();
    scriptsByDocument.set(doc, loads);
  }
  const all = loads;
  const known = all.get(address);
  if (known) {
    if (entry.integrity !== undefined && known.integrity !== entry.integrity) {
      return Promise.reject(new AssetLoadError(`Script ${address} is already loaded on this page with another integrity, so it cannot be checked against ${entry.integrity}.`, address));
    }
    return known.loaded;
  }
  const onPage = Array.from(doc.scripts).find((script) => script.src === address && !script.hasAttribute("data-datum-binding-script"));
  // What the page's own tag says is what was checked, whatever the host asked for.
  const pageIntegrity = onPage?.getAttribute("integrity")?.trim() || undefined;
  if (onPage && entry.integrity !== undefined && pageIntegrity !== entry.integrity) {
    return Promise.reject(
      new AssetLoadError(
        `Script ${address} is already on this page ${pageIntegrity === undefined ? "without an integrity" : "with another integrity"}, so it cannot be checked against ${entry.integrity}.`,
        address
      )
    );
  }
  let script: HTMLScriptElement | undefined;
  if (!onPage) {
    script = doc.createElement("script");
    try {
      for (const [name, value] of Object.entries(entry.attributes ?? {})) {
        script.setAttribute(name, value);
      }
      if (entry.classic === true) {
        script.async = false;
      } else {
        script.type = "module";
      }
      if (entry.integrity !== undefined) {
        script.setAttribute("integrity", entry.integrity);
        if (!script.hasAttribute("crossorigin")) {
          script.setAttribute("crossorigin", "anonymous");
        }
      }
      script.setAttribute("data-datum-binding-script", "");
      // A page that enforces Trusted Types without allowing the policy refuses the address here,
      // before anything is added or remembered.
      script.src = scriptSourceOf(address, doc) as string;
    } catch (thrown) {
      return Promise.reject(refusedScript(address, thrown));
    }
  }
  const added = script;
  const loaded = !added
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        added.addEventListener("load", () => resolve(), { once: true });
        added.addEventListener(
          "error",
          () => {
            // Forgotten, so a corrected address or a retry is not answered from this failure.
            if (all.get(address)?.loaded === loaded) {
              all.delete(address);
            }
            added.remove();
            const integrityNote = entry.integrity !== undefined ? " (or its integrity does not match)" : "";
            reject(new AssetLoadError(`Script ${address} could not be loaded${integrityNote}.`, address));
          },
          { once: true }
        );
        (doc.head ?? doc.documentElement).append(added);
      });
  all.set(address, { integrity: onPage ? pageIntegrity : entry.integrity, loaded });
  return loaded;
}

// ── Adopting a binding's files into one root ───────────────────────────────────────────────

export interface AdoptOptions {
  /** The binding the files are for: its font sheet is shared by every form drawn with it. */
  bindingId: string;
  /** The root font size in px the design system's stylesheets expect (`designSystem.rootFontSize`). */
  expectedRootFontSize?: number;
  /** A font sheet that could not be had: reported, never failing the form. */
  onFontError?(error: AssetLoadError): void;
}

export interface AdoptedAssets {
  /** The sheets adopted into the root, in order. */
  readonly sheets: readonly CSSStyleSheet[];
  /** Takes the sheets out of the root and gives back the shared sheets and the font sheet; once. */
  release(): void;
}

/** The rem rewrite for a design system's expectation and the host's page; the page is the browser's 16px when the host does not say. */
function rewriteOptionsFor(assets: LiveAssets, expected: number | undefined): RewriteOptions {
  return expected === undefined ? {} : { rem: { expected, actual: assets.rootFontSize ?? 16 } };
}

function placeSheets(root: ShadowRoot, sheets: readonly CSSStyleSheet[]): () => void {
  if (sheets.length === 0) {
    return () => undefined;
  }
  if (hasAdoptedSheets(root)) {
    // Ahead of what the root holds already: the renderer's structure and the binding's own CSS
    // come after the design system's and win a tie.
    root.adoptedStyleSheets = [...sheets, ...root.adoptedStyleSheets.filter((sheet) => !sheets.includes(sheet))];
    return () => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => !sheets.includes(sheet));
    };
  }
  // A root without adoptedStyleSheets: the parsed rules as <style> elements, first.
  const owner = root.ownerDocument;
  const elements = sheets.map((sheet) => {
    const style = owner.createElement("style");
    style.setAttribute("data-datum-binding-sheet", "");
    style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
    return style;
  });
  root.prepend(...elements);
  return () => {
    for (const element of elements) {
      element.remove();
    }
  };
}

/**
 * Loads a binding's files for one shadow root and resolves when the form can be drawn with them:
 * every script has run and every stylesheet is adopted, so a form is never shown half-dressed.
 * Rejects with an {@link AssetLoadError} naming the file when a stylesheet or script cannot be
 * had, having given back whatever it took. Fonts load beside the rest: a font sheet that is slow
 * never holds the form back, and one that fails is reported through `onFontError`.
 */
export async function adoptInto(root: ShadowRoot, assets: LiveAssets, options: AdoptOptions): Promise<AdoptedAssets> {
  const doc = root.ownerDocument;
  const base = documentBase(doc);
  const rewrite = rewriteOptionsFor(assets, options.expectedRootFontSize);
  const ratio = remRatio(rewrite);
  const fonts = acquireFontSheet(doc, options.bindingId);
  const holds: Array<ReturnType<typeof acquireSheet>> = [];
  let unplace: () => void = () => undefined;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    unplace();
    for (const hold of holds) {
      hold.release();
    }
    fonts.release();
  };

  for (const source of assets.fonts ?? []) {
    void (async () => {
      let address: string | undefined;
      try {
        address = absolute(source.url, base);
        const text = await composedCss(address, checkedIntegrity(source.integrity, "Font sheet", address));
        if (!released) {
          fonts.add(fontFacesOf(text, doc, address));
        }
      } catch (thrown) {
        if (!released) {
          options.onFontError?.(thrown instanceof AssetLoadError ? thrown : new AssetLoadError(messageOf(thrown), address));
        }
      }
    })();
  }

  try {
    const seen = new Set<string>();
    for (const source of assets.stylesheets ?? []) {
      const hold = acquireSheet(doc, source, rewrite);
      if (seen.has(hold.key)) {
        hold.release();
        continue;
      }
      seen.add(hold.key);
      holds.push(hold);
    }
    const [made] = await Promise.all([Promise.all(holds.map((hold) => hold.made)), Promise.all((assets.scripts ?? []).map((script) => loadScript(script, doc)))]);
    fonts.add(made.flatMap((entry) => entry.faces));
    const sheets = made.map((entry) => entry.sheet);
    if (ratio !== undefined && sheets.length > 0) {
      const scale = constructSheet(doc);
      scale.replaceSync(`:host { --datum-rem: calc(1rem * ${ratio}); }`);
      sheets.unshift(scale);
    }
    unplace = placeSheets(root, sheets);
    return { sheets, release };
  } catch (thrown) {
    release();
    throw thrown instanceof AssetLoadError ? thrown : new AssetLoadError(messageOf(thrown));
  }
}

/** Forgets every fetched text, shared sheet, font sheet, script load and script policy (what is adopted stays). For tests. */
export function resetAssetCaches(): void {
  fetchedTexts.clear();
  sheetsByDocument = new WeakMap();
  fontSheetsByDocument = new WeakMap();
  scriptsByDocument = new WeakMap();
  scriptPoliciesByWindow = new WeakMap();
}
