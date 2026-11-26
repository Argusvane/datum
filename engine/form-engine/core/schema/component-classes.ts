/**
 * `configuration.cssClass` — author-supplied class names carried onto a component's rendered
 * element.
 *
 * The escape hatch that keeps a binding from having to anticipate everything: a form needs one
 * field laid out differently, or picked out for a print stylesheet, and the alternative to
 * this is either a bespoke component type or inline styles in the schema. Classes are better
 * than either, because what they *mean* still lives in the design system's CSS, beside the
 * binding that declares them (`LiveBinding.cssClasses`), rather than in the form definition.
 *
 * Authored as a space-separated string or a list; either way it reduces to a token list.
 */

/**
 * A CSS identifier the renderer will emit. Deliberately narrower than what CSS permits:
 * enough for `is-compact` / `print_only` / `col-6`, and nothing that needs escaping in an
 * attribute or a selector.
 */
const CLASS_TOKEN = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Whether one token is a class name the renderer would emit. The builder validates with the
 * same test the renderer filters with, so "accepted while authoring" and "rendered at runtime"
 * cannot drift apart.
 */
export function isValidComponentClassToken(token: string): boolean {
  return CLASS_TOKEN.test(token);
}

/**
 * The class tokens configured on a component, de-duplicated and in authored order. Anything
 * that is not a plain identifier is dropped rather than escaped — a class name with a quote or
 * a space in it is a mistake, and silently rendering a mangled version of it helps nobody.
 */
export function readComponentClassNames(configuration: unknown): string[] {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return [];
  }
  const raw = (configuration as { cssClass?: unknown }).cssClass;
  const parts =
    typeof raw === "string"
      ? raw.split(/\s+/)
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === "string")
        : [];
  const out: string[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (token.length > 0 && CLASS_TOKEN.test(token) && !out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

/** `base` plus any configured classes, ready for a `class="..."` attribute. */
export function withComponentClasses(base: string, classNames: readonly string[]): string {
  return classNames.length === 0 ? base : `${base} ${classNames.join(" ")}`;
}
