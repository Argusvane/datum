// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { parseCssRules, styleRules } from "../form-engine/render/core/css-rules.js";
import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import { definitionOf, quiet, settled, unmountAll } from "./live-chrome-harness.js";
import { mountDatum } from "./live-datum-kit.js";

/*
 * An invalid box is drawn in the error colour whichever ARIA states the design system writes:
 * the rule keys on the control's aria-invalid and on the renderer's wrapper (data-invalid), so
 * under ariaStates "required" or "none", which write no aria-invalid, the box still says so.
 */

afterEach(unmountAll);

/** The selectors of the sheet's rules that draw a border in the error colour. */
const errorBorderSelectors = styleRules(parseCssRules(DATUM_STYLES))
  .filter((rule) => rule.declarations.some((declaration) => declaration.property === "border-color" && declaration.value.includes("--color-error")))
  .flatMap((rule) => rule.selectors);

const drawsErrorBorder = (element: Element): boolean => errorBorderSelectors.some((selector) => element.matches(selector));

describe("invalid box: the error border", () => {
  it.each(["marked", "required", "none"] as const)("draws an invalid box's error border under ariaStates %s", async (ariaStates) => {
    quiet();
    const definition = definitionOf([
      { id: "name", type: "text", configuration: { label: "Name", required: true } },
      { id: "qty", type: "number", configuration: { label: "Quantity", required: true } },
      { id: "pick", type: "select", configuration: { label: "Pick", required: true, options: [{ value: "a", label: "A" }] } }
    ] as never);
    const m = await mountDatum(definition, { fields: { controls: { ariaStates } } });
    const name = m.root.querySelector("#name") as HTMLInputElement;
    const quantity = m.root.querySelector("#qty") as HTMLInputElement;
    expect(drawsErrorBorder(name)).toBe(false);
    await m.runtime.validate();
    await settled(m.form);
    expect(drawsErrorBorder(name)).toBe(true);
    expect(drawsErrorBorder(quantity)).toBe(true);
  });

  it("leaves a valid box's border alone", async () => {
    quiet();
    const definition = definitionOf([{ id: "name", type: "text", configuration: { label: "Name" } }] as never);
    const m = await mountDatum(definition, { fields: { controls: { ariaStates: "none" } } });
    await m.runtime.validate();
    await settled(m.form);
    expect(drawsErrorBorder(m.root.querySelector("#name") as HTMLInputElement)).toBe(false);
  });
});
