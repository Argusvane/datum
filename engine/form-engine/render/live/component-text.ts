/**
 * A component's own configuration texts, worded for the form's locale: what
 * `FieldState.text` and `GroupState.text` answer. A plugin's or a design-system binding's adapter
 * reads a property of its own type through it (a card's `title`, a notice's `heading`) and gets
 * the form's translation, the host catalog's over it, else the authored string, the same address
 * and sources the engine's component model words its own texts from
 * (`components › <id> › <property>`). A worked-out value's read-only copy on a journey page words
 * its texts at its target's address (`workedOutTextOwner`).
 *
 * Pure: nothing here draws, and nothing reaches lit.
 */
import { workedOutTextOwner } from "../../core/journey/worked-out-text.js";
import { addressOf, resolveText, type TextSources } from "../../core/localization/translations.js";
import type { ComponentNode } from "../../core/schema/types.js";

/** One component's text of `property` in the locale; `undefined` when the component authors no such text. */
export type ComponentText = (property: string) => string | undefined;

/** The answer for a node that has no configuration to read (a hand-built state). */
const NO_TEXT: ComponentText = () => undefined;

/**
 * The text resolver of `node`: `configuration[property]` when it is a non-empty string (the form's
 * default language), worded through `sources` (the definition's translations and the host's
 * catalog) for `locale`. Anything else at the property (a number, a list, an object) is no text.
 */
export function componentTextOf(node: ComponentNode | undefined, locale: string, sources: TextSources | undefined): ComponentText {
  if (node === undefined || node === null || typeof node !== "object") {
    return NO_TEXT;
  }
  const from: TextSources = sources ?? {};
  return (property) => {
    const configuration: unknown = node.configuration;
    if (typeof property !== "string" || configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(configuration, property)) {
      return undefined;
    }
    const authored = (configuration as Record<string, unknown>)[property];
    return typeof authored === "string" && authored.length > 0
      ? resolveText(authored, addressOf.component(workedOutTextOwner(node, property), property), locale, from)
      : undefined;
  };
}
