/**
 * Token maps as CSS custom properties: the one place a token name and a token value are checked
 * before they reach an inline `style`, `setProperty` or a stylesheet. The Datum binding's token
 * sets and the builder themes (the studio look's `--db-*` tokens) both go through it.
 */

/** One viewport or container condition and the token values that hold under it. */
export interface ResponsiveTokens {
  /** The media query's condition, without the `@media` keyword: `"(min-width: 40.0625em)"`. */
  media?: string;
  /**
   * A condition on the form's own width instead, without the `@container datum-form` prefix:
   * `"(width < 24em)"` (the form root is a size container, so this follows the width the form
   * actually has, which the builder preview shows too). When both are given, the container
   * condition wins.
   */
  container?: string;
  /** Token name → value (with or without the `--`). */
  tokens: Record<string, string>;
}

/**
 * Text that must not reach the stylesheet from a token value or a media condition: braces and
 * semicolons (the declaration's own delimiters), `</` and `<!--` (the end of the `<style>`
 * element the sheet is written into), `@import` (assets are linked, never imported from inside
 * the sheet), and a `url()` whose scheme executes or carries a document rather than an image
 * (`javascript:`, `vbscript:`, `data:` other than `data:image/`). A token set is host-supplied,
 * but a host may have loaded it from data; the value is dropped, never emitted broken.
 */
const TOKEN_BREAKOUT =
  /[{};]|<\/|<!--|@import|url\(\s*["']?\s*(?:javascript|vbscript)\s*:|url\(\s*["']?\s*data\s*:(?!\s*image\/)/i;

/**
 * Normalizes a token map into CSS custom properties. Keys are prefixed with `--` when not
 * already, so the result can be applied directly to an element's inline style or emitted into a
 * `:host` / scoped-root block. A name that is not a custom property identifier, or a value that
 * breaks out of its declaration, is dropped.
 */
export function buildThemeStyleVars(theme: { tokens?: Readonly<Record<string, string>> | undefined }): Record<string, string> {
  const source = theme.tokens ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.startsWith("--") ? key : `--${key}`;
    if (!/^--[A-Za-z0-9_-]+$/.test(name) || typeof value !== "string" || TOKEN_BREAKOUT.test(value) || /[<>]/.test(value)) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Renders style vars as the body of a CSS rule (no selector), e.g. for a `:host {}` block. */
export function themeStyleVarsToCssText(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

/** A media condition the engine will put inside `@media (...)`: not blank, none of {@link TOKEN_BREAKOUT}. */
function isUsableMediaCondition(media: unknown): media is string {
  return typeof media === "string" && media.trim().length > 0 && !TOKEN_BREAKOUT.test(media);
}

/** A token value the engine will put inside a declaration: not blank, none of {@link TOKEN_BREAKOUT}. */
function isUsableTokenValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !TOKEN_BREAKOUT.test(value);
}

/**
 * Responsive tokens as css: one `@media` block per entry — or one `@container datum-form` block
 * for an entry that names a `container` condition, following the form's own width as the builder
 * preview shows it — each redefining its tokens on the form root with `!important`.
 *
 * The base tokens are a rule on `.datum-form` and the host may set them inline, and inline wins
 * over every ordinary stylesheet declaration, so a viewport-dependent value has to be an
 * important custom property, the one thing that outranks an inline non-important one. The block
 * goes ahead of the host's own css so a rule reading the token sees the viewport's value. An
 * entry with a malformed condition, or a token whose value could break out of its declaration,
 * is dropped whole or in part rather than emitted broken.
 */
export function responsiveTokensCss(options: { responsiveTokens?: readonly ResponsiveTokens[] | undefined } | undefined): string {
  const entries = Array.isArray(options?.responsiveTokens) ? options.responsiveTokens : [];
  const blocks: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const container = isUsableMediaCondition(entry.container) ? entry.container.trim() : undefined;
    const media = isUsableMediaCondition(entry.media) ? entry.media.trim() : undefined;
    if (container === undefined && media === undefined) {
      continue;
    }
    const tokens: Record<string, string> = entry.tokens && typeof entry.tokens === "object" ? entry.tokens : {};
    const declarations = Object.entries(tokens)
      .filter(([name, value]) => /^(--)?[a-zA-Z][\w-]*$/.test(name) && isUsableTokenValue(value))
      .map(([name, value]) => `${name.startsWith("--") ? name : `--${name}`}: ${value.trim()} !important;`);
    if (declarations.length === 0) {
      continue;
    }
    // The form root is the container (`container: datum-form / inline-size`); a container query
    // cannot match the container itself, so the tokens land on the root's children — which is
    // where every rule reads them from.
    blocks.push(
      container !== undefined
        ? `@container datum-form ${container} { .datum-form > * { ${declarations.join(" ")} } }`
        : `@media ${media} { .datum-form { ${declarations.join(" ")} } }`
    );
  }
  return blocks.join("\n");
}
