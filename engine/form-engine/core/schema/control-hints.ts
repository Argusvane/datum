
/**
 * The hints an author can put on a text control for the browser's benefit: what to
 * autocomplete it with, which virtual keyboard to raise, and whether to spell-check it.
 * They are configuration keys (`autocomplete`, `inputmode`, `spellcheck`) read by the render
 * model and written out as the attributes of the same name — nothing about the value or its
 * validation changes. The `autocomplete` and `inputMode` field capabilities are the way to
 * author them in the builder.
 *
 * Every government design system surveyed asks for at least one of these: GOV.UK and USWDS
 * want `autocomplete` on every field that has a matching token (name, email, postal code, a
 * date of birth's `bday-day`), all of them want `inputmode="numeric"` on a text box that
 * takes digits, and GOV.UK turns spell-checking off for references and codes.
 */

/** The `inputmode` values HTML defines. */
export const INPUT_MODES = ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"] as const;

export type InputMode = (typeof INPUT_MODES)[number];

export interface ControlHints {
  /** The `autocomplete` attribute's tokens, as authored (`"bday-day"`, `"section-blue shipping postal-code"`). */
  autocomplete?: string;
  /** The `inputmode` attribute, one of {@link INPUT_MODES}. */
  inputMode?: InputMode;
  /** The `spellcheck` attribute; `undefined` leaves the browser's default in place. */
  spellcheck?: boolean;
}

/**
 * `autocomplete` tokens are lower-case words joined by hyphens, separated by spaces (the
 * spec's grammar is stricter, but the browser ignores what it does not know, so the render
 * only needs to keep the attribute well-formed).
 */
const AUTOCOMPLETE_TOKENS = /^[a-z0-9-]+(?: [a-z0-9-]+)*$/i;

/** The control hints a component's configuration declares, each dropped when malformed. */
export function readControlHints(configuration: unknown): ControlHints {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return {};
  }
  const record = configuration as Record<string, unknown>;
  const hints: ControlHints = {};
  if (typeof record.autocomplete === "string") {
    const autocomplete = record.autocomplete.trim().replace(/\s+/g, " ");
    if (autocomplete.length > 0 && AUTOCOMPLETE_TOKENS.test(autocomplete)) {
      hints.autocomplete = autocomplete;
    }
  }
  if (typeof record.inputmode === "string") {
    const mode = record.inputmode.trim().toLowerCase();
    if ((INPUT_MODES as readonly string[]).includes(mode)) {
      hints.inputMode = mode as InputMode;
    }
  }
  // The inspector's select writes the strings; a hand-authored definition may use booleans.
  if (record.spellcheck === true || record.spellcheck === "true") {
    hints.spellcheck = true;
  } else if (record.spellcheck === false || record.spellcheck === "false") {
    hints.spellcheck = false;
  }
  return hints;
}

/**
 * The pattern the inspector's Email preset writes: something, an
 * at-sign, something, a dot, something, with no space or second at-sign in the pieces. Surrounding
 * spaces are allowed (a phone keyboard's autocomplete leaves one; the text input does not trim).
 * Not the RFC (nothing short of sending mail proves an address); just enough that "abc" and
 * "a@b" are refused. Unanchored: the constraints stage anchors a pattern as the browser's own
 * `pattern` attribute does, in the browser and in the sandbox kernel alike.
 *
 * Nothing applies it by itself. The Email keyboard (`inputmode: "email"`) is a device hint and
 * validates nothing, so a definition with that keyboard and no `pattern` accepts "abc" in the
 * browser and on the server alike; the inspector suggests the preset and writes it, with
 * {@link EMAIL_PRESET_MESSAGE}, into the stored definition when the author asks for it.
 */
export const EMAIL_PRESET_PATTERN = "\\s*[^\\s@]+@[^\\s@]+\\.[^\\s@]+\\s*";

/**
 * What a person reads when an address fails {@link EMAIL_PRESET_PATTERN}: the default-language
 * string. Its translations are the author's, written in the Languages workspace.
 */
export const EMAIL_PRESET_MESSAGE = "Enter an email address";
