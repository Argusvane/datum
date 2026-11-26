import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormPlugin } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const SHOUT_PLUGIN: FormPlugin = {
  id: "shout-plugin",
  version: "1.0.0",
  formulaFunctions: [
    {
      name: "shout",
      params: ["text"],
      summary: "Upper-cases a text and adds a bang.",
      example: 'shout("hi")',
      returns: "text",
      evaluate: (args) => `${String(args[0]).toUpperCase()}!`
    }
  ]
};

const DOUBLE_PLUGIN: FormPlugin = {
  id: "double-plugin",
  version: "1.0.0",
  formulaFunctions: [
    {
      name: "double",
      params: ["n"],
      summary: "Twice a number.",
      example: "double(2)",
      returns: "number",
      evaluate: (args) => Number(args[0]) * 2
    }
  ]
};

/** A form with a number to read and a number to work out, for Try it. */
function feeDefinition(): ReturnType<typeof sampleDefinition> {
  const definition = sampleDefinition();
  definition.root.children!.content!.push(
    { id: "employees", type: "number", configuration: { label: "Employees" } },
    { id: "fee", type: "number", configuration: { label: "Fee" } }
  );
  return definition;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const logic = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-logic")!.shadowRoot!;
const fire = (target: Element, type: "input" | "change"): void => {
  target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
};

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => shell(element).querySelector("datum-builder-canvas"));
  return element;
}

const variableRefs = (element: DatumFormBuilderElement): string[] => {
  if (element.builder!.panel !== "variables") {
    shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="variables"]')!.click();
  }
  return [...shell(element).querySelector("datum-builder-variables-panel")!.shadowRoot!.querySelectorAll<HTMLElement>("[data-variable]")].map((row) => row.dataset.variable!);
};

describe("plugin formula functions in the builder", () => {
  it("lists a function a plugin contributes in the Variables panel, under Plugins", async () => {
    const element = await mount((el) => {
      el.plugins = [SHOUT_PLUGIN];
    });
    await until(() => variableRefs(element).some((ref) => ref.startsWith("shout(")));
    const panel = shell(element).querySelector("datum-builder-variables-panel")!.shadowRoot!;
    expect(panel.querySelector('[data-variables-group="functions:plugins"]')).not.toBeNull();
  });

  it("lists a host-set formulaFunctions source too, and lists only the built-ins without one", async () => {
    const plain = await mount();
    expect(variableRefs(plain).some((ref) => ref.startsWith("shout("))).toBe(false);
    const wired = await mount((el) => {
      el.formulaFunctions = {
        table: () => [{ name: "shout", params: ["text"], returns: "text", summary: "Loud.", example: "shout(a)", plugin: "p" }],
        signatures: () => [{ name: "shout", min: 1, max: 1 }]
      };
    });
    await until(() => variableRefs(wired).some((ref) => ref.startsWith("shout(")));
  });

  it("gives the Logic editor the function in its list", async () => {
    const element = await mount((el) => {
      el.plugins = [SHOUT_PLUGIN];
    });
    element.builder!.setWorkspace("logic");
    await until(() => shell(element).querySelector("datum-builder-logic")?.shadowRoot?.querySelector("[data-logic-rule]"));
    const logic = shell(element).querySelector("datum-builder-logic") as unknown as { functionRows(): Array<{ name: string; plugin?: string }> };
    const row = logic.functionRows().find((entry) => entry.name === "shout");
    expect(row?.plugin).toBe("shout-plugin");
  });

  it("evaluates a plugin function in Logic's Try it and prints the call in Reads as (the Chrome re-run's finding)", async () => {
    const element = await mount((el) => {
      el.definition = feeDefinition();
      el.plugins = [DOUBLE_PLUGIN];
    });
    element.builder!.setWorkspace("logic");
    await until(() => logic(element).querySelector("[data-logic-rule], [data-logic-new]"));
    // The plain box: the editor's chunk is kept out, since jsdom can type into a textarea only.
    (shell(element).querySelector("datum-builder-logic") as unknown as { formulaEditorLoader: () => Promise<never> }).formulaEditorLoader = () =>
      Promise.reject(new Error("offline"));
    logic(element).querySelector<HTMLButtonElement>("[data-logic-new]")!.click();
    logic(element).querySelector<HTMLButtonElement>('[data-logic-new-kind="calculate"]')!.click();
    const select = logic(element).querySelector<HTMLSelectElement>("[data-logic-target]")!;
    select.value = "fee";
    fire(select, "change");
    await until(() => logic(element).querySelector(".formula-textarea"));
    const box = logic(element).querySelector<HTMLTextAreaElement>(".formula-textarea")!;
    box.value = "double(employees)";
    fire(box, "input");
    const readsAs = [...logic(element).querySelector("[data-logic-reads]")!.children].map((token) => token.textContent).join(" ");
    expect(readsAs).toBe("Calculate Fee as double( Employees )");
    const employees = logic(element).querySelector<HTMLInputElement>('[data-logic-try="employees"]')!;
    employees.value = "21";
    fire(employees, "input");
    expect(logic(element).querySelector("[data-logic-try-result]")!.textContent).toBe("Fee is 42on both sides");
  });

  it("works a stored rule calling a plugin function out on the canvas preview", async () => {
    const definition = feeDefinition();
    const fee = definition.root.children!.content!.find((node) => node.id === "fee")!;
    fee.rules = { value: "double(employees)" };
    const element = await mount((el) => {
      el.definition = definition;
      el.plugins = [DOUBLE_PLUGIN];
    });
    const canvas = shell(element).querySelector("datum-builder-canvas") as unknown as { preview?: { setValue(id: string, value: unknown): void; state(): { values: Record<string, unknown> } } };
    await until(() => canvas.preview);
    canvas.preview!.setValue("employees", 21);
    expect(canvas.preview!.state().values.fee).toBe(42);
  });

  it("forwards the builder's text locale and catalog to the shell, before and after it mounts", async () => {
    const catalog = { xx: { "logic.diag.showThem": "[xx] show" } };
    const early = await mount((el) => {
      el.textLocale = "xx";
      el.textCatalog = catalog;
    });
    expect(early.builder!.textLocale).toBe("xx");
    expect(early.builder!.textCatalog).toBe(catalog);
    const late = await mount();
    late.textLocale = "yy";
    late.textCatalog = catalog;
    expect(late.builder!.textLocale).toBe("yy");
    expect(late.builder!.textCatalog).toBe(catalog);
  });
});
