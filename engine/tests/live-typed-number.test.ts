// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FieldAdapter, LiveBinding, NumberFieldState } from "../form-engine/render/live/contract.js";
import { createFieldsFeature } from "../form-engine/render/live/fields.js";
import { lit } from "../form-engine/render/live/lit.js";
import { cleanUp, definitionOf, mounted, quiet, settled, type, wrapper, type Mounted } from "./live-extras-kit.js";

/*
 * `on.input(text, { typed: "number" })` (contract.ts FieldInputOptions): a binding that draws a
 * number as a text box hands the renderer the text as typed, and the renderer's fields module
 * reads it with the form's locale, as Datum's own text-drawn number does. `standsFor` on the
 * number's state tells the binding whether the box's text already stands for the stored answer.
 */

afterEach(cleanUp);

/** What the adapter saw on its last draw. */
let last: NumberFieldState | undefined;

/** A design system's number as a text box: it reads nothing itself and keeps the text while it stands for the answer. */
function textNumber(final = false): FieldAdapter<NumberFieldState> {
  const { html } = lit;
  return {
    kind: "field",
    name: "kit-text-number",
    template: (s, on) => {
      last = s;
      return html`<label id=${s.labelId} for=${s.id}>${s.label}</label>
        <input
          id=${s.id}
          type="text"
          inputmode="decimal"
          @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, final ? { typed: "number" } : { interim: true, typed: "number" })}
          @change=${() => on.commit()}
        />`;
    },
    after: (field, s) => {
      const box = field.querySelector("input");
      if (box && !s.standsFor(box.value)) {
        box.value = s.value;
      }
    }
  };
}

const field: ComponentNode = { id: "total", type: "number", configuration: { label: "Total" } };

const french: Partial<FormDefinition> = { localization: { defaultLocale: "fr", supportedLocales: [{ code: "fr", label: "Français" }] } } as Partial<FormDefinition>;

async function draw(options: { final?: boolean; definition?: Partial<FormDefinition> } = {}): Promise<Mounted & { box: HTMLInputElement }> {
  quiet();
  last = undefined;
  const binding: LiveBinding = { id: "kit-ds", label: "Kit DS", components: { number: textNumber(options.final === true) } };
  const m = await mounted(definitionOf([field], options.definition ?? {}), { binding, features: [createFieldsFeature()] });
  return { ...m, box: wrapper(m.root, "total").querySelector("input") as HTMLInputElement };
}

describe("a number typed in a text box (typed: \"number\")", () => {
  it("stores grouped English digits as the number and keeps the text in the box", async () => {
    const m = await draw();
    type(m.box, "1,000");
    expect(m.runtime.state().values.total).toBe(1000);
    await settled(m.form);
    expect(m.box.value).toBe("1,000");
    expect(last?.value).toBe("1000");
    expect(last?.standsFor("1,000")).toBe(true);
    expect(last?.standsFor("1000")).toBe(true);
    expect(last?.standsFor("1,001")).toBe(false);
    type(m.box, "1,000.5");
    expect(m.runtime.state().values.total).toBe(1000.5);
  });

  it("reads French's decimal comma and its space grouping", async () => {
    const m = await draw({ definition: french });
    type(m.box, "2,5");
    expect(m.runtime.state().values.total).toBe(2.5);
    await settled(m.form);
    expect(last?.locale).toBe("fr");
    expect(m.box.value).toBe("2,5");
    type(m.box, "1 000");
    expect(m.runtime.state().values.total).toBe(1000);
    await settled(m.form);
    expect(m.box.value).toBe("1 000");
    expect(last?.standsFor("1 000")).toBe(true);
  });

  it("stores text that is no number as typed, so validation says number", async () => {
    const m = await draw();
    type(m.box, "abc");
    expect(m.runtime.state().values.total).toBe("abc");
    const errors = await m.runtime.validate();
    expect(errors.map((error) => error.code)).toContain("number");
    await settled(m.form);
    expect(m.box.value).toBe("abc");
  });

  it("stores an emptied box as the empty string, not 0", async () => {
    const m = await draw();
    type(m.box, "12");
    expect(m.runtime.state().values.total).toBe(12);
    type(m.box, "   ");
    expect(m.runtime.state().values.total).toBe("");
  });

  it("reads the text the same in an interim write and a final one, and keeps interim as interim", async () => {
    const interim = await draw();
    const writes = vi.spyOn(interim.runtime, "setValue");
    type(interim.box, "1,234");
    expect(writes).toHaveBeenLastCalledWith("total", 1234, { interim: true });
    interim.box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(interim.runtime.state().values.total).toBe(1234);
    cleanUp();

    const final = await draw({ final: true });
    const finalWrites = vi.spyOn(final.runtime, "setValue");
    type(final.box, "1,234");
    expect(finalWrites).toHaveBeenLastCalledWith("total", 1234, undefined);
  });

  it("writes the stored answer into the box when it changes elsewhere", async () => {
    const m = await draw();
    type(m.box, "0002");
    await settled(m.form);
    expect(m.box.value).toBe("0002");
    expect(m.runtime.state().values.total).toBe(2);
    m.runtime.setValue("total", 7);
    await settled(m.form);
    expect(m.box.value).toBe("7");
  });

  it("stores the text as it is without the option (the binding did not ask)", async () => {
    quiet();
    const { html } = lit;
    const plain: FieldAdapter<NumberFieldState> = {
      kind: "field",
      name: "kit-plain-number",
      template: (s, on) => html`<input id=${s.id} @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })} />`
    };
    const m = await mounted(definitionOf([field]), { binding: { id: "kit-ds", label: "Kit DS", components: { number: plain } }, features: [createFieldsFeature()] });
    type(wrapper(m.root, "total").querySelector("input") as HTMLInputElement, "1,000");
    expect(m.runtime.state().values.total).toBe("1,000");
  });
});
