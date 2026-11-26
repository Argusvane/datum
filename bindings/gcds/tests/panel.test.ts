// Not type-checked with the package (it uses vitest and the engine's sources): run with the kernel's vitest, `npm run test:panel`.
// The GC Design System binding's panel: a section named by a real gcds-heading, its hint the design system's gcds-hint, plain unless the
// author ticks a look, and the four looks it declares equal to the engine's shared vocabulary. What the browser makes of the CSS is
// the kit's; this holds the markup (the adapter drawn into text by a stand-in for lit's html) and the declarations.
import { describe, expect, it } from "vitest";
import type { GroupState } from "../../../engine/form-engine/render/live/contract.js";
import { PANEL_LOOK_CLASSES } from "../../../engine/form-engine/render/live/look-classes.js";
import { bindingClassChoices } from "../../../engine/form-engine/builder/property-editor/css-classes.js";
import { createContainers, GCDS_PANEL_LOOKS } from "../src/containers.js";
import { GCDS_CSS } from "../src/css.js";

/** lit's html reduced to text: `nothing` and an unset `ifDefined` leave no attribute, a nested template is its text. */
const NOTHING = { nothing: true };
const UNSET = { unset: true };
const lit = {
  html: (strings: TemplateStringsArray, ...values: unknown[]): string => {
    let out = strings[0] ?? "";
    values.forEach((value, index) => {
      const chunk = strings[index + 1] ?? "";
      if (value === UNSET) {
        // An attribute whose value is unset is dropped, name and all (the quote that followed it too).
        out = out.replace(/\s*[\w-]+="?$/, "");
        out += chunk.startsWith('"') ? chunk.slice(1) : chunk;
      } else if (out.endsWith("=")) {
        out += `"${String(value)}"${chunk}`;
      } else {
        out += (value === NOTHING ? "" : String(value)) + chunk;
      }
    });
    return out;
  },
  nothing: NOTHING,
  ifDefined: (value: unknown) => (value === undefined ? UNSET : value),
  ref: () => NOTHING
};

const panel = createContainers(lit as never).panel;

const state = (over: Partial<GroupState> = {}): GroupState =>
  ({ id: "applicant", key: "applicant", type: "panel", base: "panel", legend: "Applicant", hideLegend: false, level: 1, classNames: [], locale: "en", ...over }) as GroupState;
const draw = (over: Partial<GroupState> = {}): string => (panel.template(state(over), "<i>fields</i>" as never) as unknown as string).replace(/\s+/g, " ");

describe("the GC Design System panel", () => {
  it("is a section named by a real gcds-heading one level under the form, the fields in its body", () => {
    const out = draw();
    expect(out).toContain('<section class="datum-gcds-panel"');
    expect(out).toContain('aria-labelledby="applicant__group-label"');
    expect(out).toContain('<gcds-heading tag="h2" id="applicant__group-label" margin-top="0">Applicant</gcds-heading>');
    expect(out).toContain('<div class="datum-gcds-panel__body"><i>fields</i></div>');
    expect(draw({ level: 2 })).toContain('tag="h3"');
    expect(draw({ level: 9 })).toContain('tag="h6"');
  });

  it("is plain with no look: no look class, no band", () => {
    const out = draw();
    expect(out).not.toMatch(/panel-(plain|outlined|shaded|card)/);
    expect(out).not.toContain("margin-bottom");
  });

  it("carries the author's classes, each look a class on the section", () => {
    for (const look of ["panel-plain", "panel-outlined", "panel-shaded", "panel-card"]) {
      expect(draw({ classNames: ["acme", look] })).toContain(`<section class="datum-gcds-panel acme ${look}"`);
    }
    // The card's band sits flush: its heading carries no margin of its own below.
    expect(draw({ classNames: ["panel-card"] })).toContain('margin-bottom="0"');
  });

  it("draws the hint as the design system's gcds-hint and describes the section by it", () => {
    const out = draw({ hint: "As on your passport" });
    expect(out).toContain('<gcds-hint hint-id="applicant">As on your passport</gcds-hint>');
    expect(out).toContain('aria-describedby="hint-applicant"');
    expect(draw()).not.toContain("gcds-hint");
  });

  it("keeps a hidden heading as the section's name, visually hidden, and draws no heading for a panel with no name", () => {
    expect(draw({ hideLegend: true })).toContain('<div class="datum-gcds-sr-only"> <gcds-heading');
    const bare = draw({ legend: undefined });
    expect(bare).not.toContain("gcds-heading");
    expect(bare).not.toContain("aria-labelledby");
    expect(bare).toContain('<div class="datum-gcds-panel__body">');
  });

  it("names its hint and its description by the instance, so a panel repeated in a grid's rows has one hint id per row", () => {
    const rows = [draw({ id: "applicant", key: "rows[0].applicant", hint: "As on your passport" }), draw({ id: "applicant", key: "rows[1].applicant", hint: "As on your passport" })];
    expect(rows[0]).toContain('<gcds-hint hint-id="rows[0].applicant">');
    expect(rows[0]).toContain('aria-describedby="hint-rows[0].applicant"');
    expect(rows[1]).toContain('<gcds-hint hint-id="rows[1].applicant">');
    expect(rows[1]).toContain('aria-describedby="hint-rows[1].applicant"');
    expect(rows.join("")).not.toContain("hint-applicant");
    // A state that carries its own hint id is named by it, as Datum's panel is.
    const own = draw({ id: "applicant", key: "k", hintId: "k__description", hint: "Hint" });
    expect(own).toContain('<gcds-hint hint-id="k__description">');
    expect(own).toContain('aria-describedby="hint-k__description"');
  });

  it("draws no empty band for a card whose heading is hidden and that has no hint: the whole header is visually hidden, the heading still the section's name", () => {
    const hidden = draw({ hideLegend: true, classNames: ["panel-card"] });
    expect(hidden).toContain('<div class="datum-gcds-panel__header datum-gcds-sr-only">');
    expect(hidden).toContain('aria-labelledby="applicant__group-label"');
    expect(hidden).toContain("<gcds-heading");
    // A hint beside the hidden heading is something to draw: the band stays.
    expect(draw({ hideLegend: true, hint: "Hint", classNames: ["panel-card"] })).toContain('<div class="datum-gcds-panel__header">');
    expect(draw({ classNames: ["panel-card"] })).toContain('<div class="datum-gcds-panel__header">');
    expect(GCDS_CSS).toMatch(/\.datum-gcds-panel\.panel-card > \.datum-gcds-panel__header\.datum-gcds-sr-only \{[^}]*padding: 0[^}]*background: none/);
  });

  it("draws only the last look of a hand-written list, the one paper and the Style tab pick, and leaves the other classes alone", () => {
    expect(draw({ classNames: ["panel-shaded", "acme", "panel-card"] })).toContain('<section class="datum-gcds-panel acme panel-card"');
    expect(draw({ classNames: ["panel-card", "panel-shaded"] })).toContain('<section class="datum-gcds-panel panel-shaded"');
    expect(draw({ classNames: ["panel-shaded", "panel-card"] })).toContain('margin-bottom="0"');
    expect(draw({ classNames: ["panel-card", "panel-shaded"] })).not.toContain('margin-bottom="0"');
  });

  it("declares the engine's four looks as one group for a panel, and styles the three boxes from gcds tokens only", () => {
    expect(GCDS_PANEL_LOOKS).toEqual(PANEL_LOOK_CLASSES);
    expect(bindingClassChoices({ cssClasses: GCDS_PANEL_LOOKS }, { type: "panel" }).map((choice) => choice.name)).toEqual(["panel-plain", "panel-outlined", "panel-shaded", "panel-card"]);
    expect(bindingClassChoices({ cssClasses: GCDS_PANEL_LOOKS }, { type: "text" })).toEqual([]);
    const rules = GCDS_CSS.split("\n").filter((line) => line.includes(".datum-gcds-panel"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const [, value] of rule.matchAll(/(?:var\(|:\s*)(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)) {
        throw new Error(`a bare colour ${value} in ${rule.trim()}`);
      }
    }
    for (const look of ["panel-outlined", "panel-shaded", "panel-card"]) {
      expect(GCDS_CSS).toContain(`.datum-gcds-panel.${look}`);
    }
    // Plain has no rule of its own: nothing to inset, nothing to clip.
    expect(GCDS_CSS).not.toContain(".datum-gcds-panel.panel-plain");
    expect(GCDS_CSS).not.toMatch(/\.datum-gcds-panel[^{]*\{[^}]*overflow:\s*hidden/);
  });
});
