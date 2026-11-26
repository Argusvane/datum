import { describe, expect, it } from "vitest";

import { BuilderController, type ComponentNode } from "@argusvane/datum-engine";
import { languagesTexts } from "../../../engine/form-engine/builder/languages/languages-model.js";
import { standardComponentDefinitions, standardComponentTypes } from "../src/standard-components.js";

/*
 * Every text the renderer resolves through the translations map
 * (component-model.ts, container-shells.ts, print-options.ts, field-constraints.ts) must be
 * listed by the controller's translatableTexts() and by the Languages model, for each type the
 * real registry registers, or an author cannot translate it in the workspace.
 */

const text = (id: string, key: string) => `${id}:${key}`;

/** The translatable paths each standard type's renderer resolves and the type shows. */
const RESOLVED: Record<string, string[]> = {
  text: ["label", "description", "tooltip", "placeholder", "prefix", "suffix", "patternMessage", "print.note"],
  number: ["label", "description", "tooltip", "placeholder", "prefix", "suffix", "print.note"],
  textarea: ["label", "description", "tooltip", "placeholder", "patternMessage", "print.note"],
  checkbox: ["label", "description", "tooltip", "print.note"],
  select: ["label", "description", "tooltip", "placeholder", "print.note"],
  date: ["label", "description", "tooltip", "print.note"],
  file: ["label", "description", "tooltip", "print.note"],
  radio: ["label", "description", "tooltip", "print.note"],
  checkboxes: ["label", "description", "tooltip", "print.note"],
  html: ["content"],
  image: ["alt"],
  button: ["label", "tooltip", "print.note"],
  fieldset: ["label", "print.note"],
  panel: ["label", "print.note"],
  // A data grid's heading and the three captions its rows draw; each falls back to a form text when blank.
  dataGrid: ["label", "description", "addLabel", "removeLabel", "emptyText", "print.note"],
  step: ["label", "print.note"],
  grid: ["label"],
  container: ["label"]
};

function seed(id: string, paths: string[]): Record<string, unknown> {
  const configuration: Record<string, unknown> = {};
  for (const path of paths) {
    if (path === "print.note") {
      configuration.print = { note: text(id, path) };
    } else {
      configuration[path] = text(id, path);
    }
  }
  return configuration;
}

describe("the texts the renderer resolves are the texts the builder lists", () => {
  const definitions = standardComponentDefinitions();
  const children: ComponentNode[] = [];
  const expected = new Map<string, string[]>();
  for (const [type, paths] of Object.entries(RESOLVED)) {
    const id = `n_${type}`;
    const configuration = seed(id, paths);
    if (type === "select" || type === "radio" || type === "checkboxes") {
      configuration.options = [
        { value: "a", label: text(id, "options.0.label"), description: text(id, "options.0.description") },
        { value: "b", label: text(id, "options.1.label") }
      ];
    }
    if (type === "text") {
      configuration.messages = { required: text(id, "messages.required") };
    }
    children.push({ id, type, configuration });
    expected.set(id, paths);
  }
  // A tabs container with three tabs: the third is past the two the registry's editor declares.
  const tabPaths = [0, 1, 2].map((index) => `tabs.${index}.label`);
  children.push({
    id: "n_tabs",
    type: "tabs",
    configuration: { tabs: [0, 1, 2].map((index) => ({ id: `t${index}`, label: text("n_tabs", `tabs.${index}.label`) })) },
    children: { t0: [], t1: [], t2: [] }
  });
  expected.set("n_tabs", tabPaths);
  // The printed form's four running header and footer slots are form texts the print model resolves.
  const slotPaths = ["print.header.start", "print.header.end", "print.footer.start", "print.footer.end"];
  const rootPrint = {
    header: { start: text("root", slotPaths[0]!), end: text("root", slotPaths[1]!) },
    footer: { start: text("root", slotPaths[2]!), end: text("root", slotPaths[3]!) }
  };
  expected.set("root", slotPaths);
  const root: ComponentNode = { id: "root", type: "form", configuration: { title: text("root", "title"), print: rootPrint }, children: { content: children } };
  const controller = new BuilderController({
    initialRoot: root,
    componentDefinitions: definitions,
    componentTypes: standardComponentTypes(),
    localization: { supportedLocales: [{ code: "fr", label: "Français" }] }
  } as never);

  it("covers every registered type this test knows the reads of, and none are forgotten", () => {
    const registered = definitions.map((definition) => definition.type).filter((type) => type !== "form");
    const known = new Set([...Object.keys(RESOLVED), "tabs", "steps", "button-group", "data-container", "step"]);
    expect(registered.filter((type) => !known.has(type) && !known.has(type.replace(/-/g, "")))).toEqual([]);
  });

  it("lists each of them in translatableTexts()", () => {
    const listed = new Set(controller.translatableTexts().map((entry) => `${entry.componentId}.${entry.propertyPath}`));
    const missing = [...expected].flatMap(([id, paths]) => paths.map((path) => `${id}.${path}`)).filter((entry) => !listed.has(entry));
    expect(missing).toEqual([]);
  });

  it("lists each of them, the options and the messages in the Languages model", () => {
    const { rows } = languagesTexts({
      texts: controller.translatableTexts(),
      translations: controller.translations(),
      localization: controller.localization()
    });
    const listed = new Set(rows.map((row) => `${row.componentId}.${row.propertyPath}`));
    const missing = [...expected].flatMap(([id, paths]) => paths.map((path) => `${id}.${path}`)).filter((entry) => !listed.has(entry));
    expect(missing).toEqual([]);
    for (const id of ["n_select", "n_radio", "n_checkboxes"]) {
      expect(listed.has(`${id}.options.0.label`)).toBe(true);
      expect(listed.has(`${id}.options.0.description`)).toBe(true);
      expect(listed.has(`${id}.options.1.label`)).toBe(true);
    }
    expect(listed.has("n_text.messages.required")).toBe(true);
    // The four print slots form their own group, apart from the fields.
    expect(rows.filter((row) => row.groupId === "print").map((row) => row.propertyPath)).toEqual(["print.header.start", "print.header.end", "print.footer.start", "print.footer.end"]);
  });
});
