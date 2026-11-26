/**
 * The look vocabulary every binding shares, so a form that chose a look stays portable: the same
 * class names mean the same four looks of a `panel` wherever the form is drawn. A binding declares
 * the ones it draws (`LiveBinding.cssClasses`) and writes the CSS for them from its own tokens;
 * one that declares none of them ignores the classes and draws its own panel. The classes sit in
 * one group, so a panel carries at most one, and none means the binding's own default (Datum's is
 * the card, the GC Design System's is plain).
 *
 * DOM-free and import-free of the renderer so the builder's Style tab, Datum's binding and a
 * binding package can all read the same names; a binding package that never imports the engine at
 * run time restates the names and keeps them equal with a test.
 */
import { readComponentClassNames } from "../../core/schema/component-classes.js";
import type { CssClassDeclaration, CssClassEntry } from "./contract.js";

/** The group the four panel looks share: choosing one takes the others away. */
export const PANEL_LOOK_GROUP = "panel-look";

/** The four looks, in the order the Style tab offers them. */
export const PANEL_LOOK_CLASSES: readonly CssClassDeclaration[] = Object.freeze([
  { name: "panel-plain", label: "Plain", description: "The heading with the fields under it: no border, no background, no header band.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-outlined", label: "Outlined", description: "A border around the panel, with no header band and no fill.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-shaded", label: "Shaded", description: "A light background behind the panel, with no border.", types: ["panel"], group: PANEL_LOOK_GROUP },
  { name: "panel-card", label: "Card", description: "A border, a header band behind the heading and a surface for the fields.", types: ["panel"], group: PANEL_LOOK_GROUP }
]);

/** The four looks by their short name: what paper carries (`PrintGroup.look`), the class name less its `panel-`. */
export type PanelLook = "plain" | "outlined" | "shaded" | "card";

const LOOK_PREFIX = "panel-";

/**
 * The look a `panel`'s `configuration` chose, from its `cssClass` tokens: the last look class
 * wins when several are written, and anything that is not one of the four (or is not a valid
 * class name) is ignored. `undefined` when none is chosen: the binding's own default.
 */
export function panelLookOf(configuration: unknown): PanelLook | undefined {
  const names = new Set(PANEL_LOOK_CLASSES.map((entry) => entry.name));
  const chosen = readComponentClassNames(configuration).filter((token) => names.has(token));
  const last = chosen[chosen.length - 1];
  return last === undefined ? undefined : (last.slice(LOOK_PREFIX.length) as PanelLook);
}

/**
 * `tokens` with only the last look class kept, every other class where it stood. CSS cannot take a
 * class list's order into account (two looks on one element resolve by the sheet's order), so a
 * panel whose hand-written list holds two is drawn with the one that paper and the Style tab pick:
 * the last.
 */
export function lastLookOnly(tokens: readonly string[]): string[] {
  const names = new Set(PANEL_LOOK_CLASSES.map((entry) => entry.name));
  const last = tokens.reduce((found, token, index) => (names.has(token) ? index : found), -1);
  return tokens.filter((token, index) => !names.has(token) || index === last);
}

const nameOf = (entry: CssClassEntry): string | undefined => (typeof entry === "string" ? entry : entry?.name);

/**
 * Class lists joined into one, a name once: a later declaration object for a name replaces the
 * earlier entry in its place, so a host's declaration of `panel-card` relabels the shared one
 * without a second row. A later bare name never downgrades a declaration: it keeps the one it
 * finds (`["panel-card"]` leaves the shared card with its group and types).
 */
export function mergeCssClasses(...lists: ReadonlyArray<readonly CssClassEntry[] | undefined>): CssClassEntry[] {
  const out: CssClassEntry[] = [];
  for (const list of lists) {
    for (const entry of list ?? []) {
      const name = nameOf(entry);
      const at = name === undefined ? -1 : out.findIndex((existing) => nameOf(existing) === name);
      if (at >= 0) {
        if (typeof entry !== "string") {
          out[at] = entry;
        }
      } else {
        out.push(entry);
      }
    }
  }
  return out;
}
