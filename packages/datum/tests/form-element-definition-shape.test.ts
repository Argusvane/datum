import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const form = (content: unknown[]): Record<string, unknown> => ({
  id: "shared",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: { id: "root", type: "form", configuration: {}, children: { content } }
});
const keep = (): Record<string, unknown> => form([{ id: "keep", type: "text", configuration: { label: "Keep" } }]);

async function loaded(): Promise<{ element: DatumFormElement; errors: string[] }> {
  const element = document.createElement("datum-form") as DatumFormElement;
  element.definition = keep() as never;
  document.body.append(element);
  await until(() => element.runtime !== undefined);
  const errors: string[] = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  return { element, errors };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("<datum-form> given a definition no form tree can be read from", () => {
  const cases: Array<[string, unknown]> = [
    ["an empty object", {}],
    ["a root that is a string", { root: "x" }],
    ["a root with no type", { root: { id: "root" } }],
    ["a root that is not the form", { root: { id: "root", type: "text" } }],
    ["a slot holding null", form([null])],
    ["children that are a string", { id: "a", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: "x" } }]
  ];
  for (const [label, value] of cases) {
    it(`reports ${label} and keeps the form it had`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { element, errors } = await loaded();
      const before = element.definition;
      const runtime = element.runtime;
      element.definition = value as never;
      await settle();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^The form was not loaded: /);
      expect(element.definition).toBe(before);
      expect(element.runtime).toBe(runtime);
    });
  }

  it("reports one set through the attribute the same way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element, errors } = await loaded();
    const runtime = element.runtime;
    element.setAttribute("definition", JSON.stringify(form(["x"])));
    await settle();
    expect(errors.some((message) => message.startsWith("The form was not loaded: "))).toBe(true);
    expect(element.runtime).toBe(runtime);
  });

  it("reports a component holding a child with its own id, at once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element } = await loaded();
    const causes: string[] = [];
    element.addEventListener("datum-error", (event) => causes.push(String((event as CustomEvent<{ cause?: unknown }>).detail.cause)));
    const started = Date.now();
    element.definition = form([
      { id: "a", type: "container", configuration: {}, children: { default: [{ id: "a", type: "text", configuration: {} }] } }
    ]) as never;
    await until(() => causes.length > 0);
    expect(causes.join(" ")).toMatch(/own ancestors/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still takes a usable definition, and undefined to clear it", async () => {
    const { element, errors } = await loaded();
    element.definition = form([{ id: "other", type: "text", configuration: { label: "Other" } }]) as never;
    await until(() => element.runtime?.formValues !== undefined && element.definition?.root.children?.content?.[0]?.id === "other");
    element.definition = undefined;
    await settle();
    expect(element.definition).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
