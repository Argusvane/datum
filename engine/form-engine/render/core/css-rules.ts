/**
 * A small css rule parser shared by everything in the engine that reads a stylesheet's
 * selectors, such as the tests that read the Datum binding's sheet.
 *
 * Each of those used to carry a regex of its own, and the regexes disagreed on the cases a
 * real stylesheet has: a comma inside `:is(a, b)` split a selector in two, `@charset "…";`
 * before the first rule swallowed the `:root` block, a dot inside a `url("…")` read as a class,
 * an at-rule nested in an at-rule was skipped. One tokenizer here understands comments,
 * strings, parentheses, braces and at-rule statements, and every consumer reads its output.
 *
 * It is deliberately not a css object model: a style rule keeps its body as the raw text
 * between its braces (so a consumer that rewrites the sheet emits exactly what it read), with
 * the declarations parsed beside it for the consumers that look at properties.
 */

export interface CssDeclaration {
  /** The property name as written, trimmed. */
  property: string;
  /** The value as written, trimmed; `!important` left in. */
  value: string;
}

export interface CssStyleRule {
  type: "style";
  /** The selector list as written before the `{`, trimmed. */
  selectorText: string;
  /** The list split on the commas outside parentheses and strings, each trimmed. */
  selectors: string[];
  /** The raw text between the braces, exactly as written. */
  body: string;
  declarations: CssDeclaration[];
}

/**
 * An at-rule: a statement (`@charset "utf-8";`, `@import …;`) has no block; a conditional
 * group (`@media`, `@supports`, `@container`, `@layer`, `@scope`) holds rules; anything else
 * (`@keyframes`, `@font-face`, `@page`, `@property`) holds text the parser leaves opaque,
 * because what is inside is not a selector list.
 */
export interface CssAtRule {
  type: "at";
  /** The name after the `@`, lower-cased: `media`, `charset`. */
  name: string;
  /** The text between the name and the `{` or `;`, trimmed. */
  prelude: string;
  /** The header as written, from `@` through the opening `{` — for a rewriter that keeps the author's spacing. */
  header: string;
  /** The rules inside a conditional group. Absent for a statement or an opaque block. */
  rules?: CssRule[] | undefined;
  /** The raw text between the braces of an opaque block. Absent for a statement or a group. */
  body?: string | undefined;
}

export type CssRule = CssStyleRule | CssAtRule;

/** At-rules whose block is a list of rules rather than declarations or keyframe selectors. */
const GROUPING_AT_RULES: ReadonlySet<string> = new Set(["media", "supports", "container", "layer", "scope", "document", "starting-style"]);

/** Index just past the comment or string that starts at `index`, or `index` when none does. */
function skipCommentOrString(text: string, index: number): number {
  const char = text[index];
  if (char === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (char === '"' || char === "'") {
    let cursor = index + 1;
    while (cursor < text.length) {
      const current = text[cursor];
      if (current === "\\") {
        cursor += 2;
        continue;
      }
      if (current === char) {
        return cursor + 1;
      }
      cursor += 1;
    }
    return text.length;
  }
  return index;
}

/**
 * Splits `text` on `separator` wherever it sits outside parentheses, brackets, strings and
 * comments — a selector list on its commas, a declaration block on its semicolons.
 */
export function splitOutsideGroups(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index]!;
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/** A selector list's members, trimmed, empties dropped: `:is(a, b), c` → `[":is(a, b)", "c"]`. */
export function splitSelectorList(selectorText: string): string[] {
  return splitOutsideGroups(selectorText, ",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/** The declarations of a rule body: `property: value` pairs split on the semicolons outside groups. */
export function parseDeclarations(body: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  for (const chunk of splitOutsideGroups(stripComments(body), ";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const property = chunk.slice(0, colon).trim();
    const value = chunk.slice(colon + 1).trim();
    if (property.length > 0) {
      out.push({ property, value });
    }
  }
  return out;
}

/** `text` with every `/* … *\/` comment removed (strings left intact). */
export function stripComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index) {
      out += text.slice(index, skipped);
      index = skipped;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

/** Index of the `}` that closes the block opened just before `from`, or the text's length when unbalanced. */
function findBlockEnd(text: string, from: number): number {
  let depth = 1;
  let index = from;
  while (index < text.length) {
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  return text.length;
}

/**
 * Parses a stylesheet (or the inside of a grouping at-rule) into rules, in source order.
 * Unbalanced input never throws: a block with no closing brace runs to the end of the text.
 */
export function parseCssRules(text: string): CssRule[] {
  const rules: CssRule[] = [];
  let index = 0;
  while (index < text.length) {
    // Skip whitespace and comments between rules.
    const skipped = skipCommentOrString(text, index);
    if (skipped !== index && text[index] === "/") {
      index = skipped;
      continue;
    }
    if (/\s/.test(text[index]!)) {
      index += 1;
      continue;
    }
    // A stray closing brace (unbalanced input) is skipped rather than parsed.
    if (text[index] === "}") {
      index += 1;
      continue;
    }
    // Read the prelude: up to the first `{` or, for a statement, the first `;` — outside strings.
    const preludeStart = index;
    let cursor = index;
    let open = -1;
    let statementEnd = -1;
    while (cursor < text.length) {
      const jump = skipCommentOrString(text, cursor);
      if (jump !== cursor) {
        cursor = jump;
        continue;
      }
      const char = text[cursor];
      if (char === "{") {
        open = cursor;
        break;
      }
      if (char === ";" || char === "}") {
        statementEnd = cursor;
        break;
      }
      cursor += 1;
    }
    const isAtRule = text[preludeStart] === "@";
    if (open === -1) {
      // A statement at-rule, or trailing text with no block: keep a statement, drop the rest.
      const end = statementEnd === -1 ? text.length : statementEnd;
      const raw = text.slice(preludeStart, end).trim();
      if (isAtRule && raw.length > 0) {
        const name = raw.slice(1).match(/^[\w-]+/)?.[0] ?? "";
        rules.push({
          type: "at",
          name: name.toLowerCase(),
          prelude: raw.slice(1 + name.length).trim(),
          header: text.slice(preludeStart, statementEnd === -1 ? end : end + 1)
        });
      }
      index = statementEnd === -1 ? text.length : end + 1;
      continue;
    }
    const close = findBlockEnd(text, open + 1);
    const preludeRaw = text.slice(preludeStart, open);
    const body = text.slice(open + 1, close);
    if (isAtRule) {
      const name = (preludeRaw.slice(1).match(/^[\w-]+/)?.[0] ?? "").toLowerCase();
      const prelude = preludeRaw.slice(1 + name.length).trim();
      const header = text.slice(preludeStart, open + 1);
      rules.push(
        GROUPING_AT_RULES.has(name)
          ? { type: "at", name, prelude, header, rules: parseCssRules(body) }
          : { type: "at", name, prelude, header, body }
      );
    } else {
      const selectorText = stripComments(preludeRaw).trim();
      rules.push({
        type: "style",
        selectorText,
        selectors: splitSelectorList(selectorText),
        body,
        declarations: parseDeclarations(body)
      });
    }
    index = close + 1;
  }
  return rules;
}

/** Every style rule in `rules`, grouping at-rules opened in place, in source order. */
export function styleRules(rules: readonly CssRule[]): CssStyleRule[] {
  const out: CssStyleRule[] = [];
  for (const rule of rules) {
    if (rule.type === "style") {
      out.push(rule);
    } else if (rule.rules) {
      out.push(...styleRules(rule.rules));
    }
  }
  return out;
}
