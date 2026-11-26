import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { definitionLoadProblem, formDefinitionProblem } from "../src/support.js";
import { until } from "./helpers.js";

/*
 * Two components under one id do not stop a form from opening: Open, the `definition` property
 * and `src` load it, and the twins are the Problems list's to name (under the id box of each),
 * never a refusal at the door. Save is never held back by a problem.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const twins = () => ({
  id: "twins",
  version: "1.0.0",
  schemaVersion: "1",
  root: {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "city", type: "text", configuration: { label: "City" } },
        { id: "box", type: "section", configuration: {}, children: { content: [{ id: "city", type: "text", configuration: { label: "Town" } }] } }
      ]
    }
  }
});

describe("twin component ids at the door", () => {
  it("are no load problem", () => {
    expect(formDefinitionProblem(twins() as never)).toBeUndefined();
    expect(definitionLoadProblem(twins() as never)).toBeUndefined();
  });

  it("open from a file, and the twins are listed as a problem rather than refused", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const errors: string[] = [];
    el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    document.body.append(el);
    await until(() => el.controller);
    const apply = el.fileActions.open!({ name: "twins.json", text: JSON.stringify(twins()) }) as () => void;
    apply();
    await until(() => el.definition.id === "twins");
    const content = el.controller!.snapshot().children?.content ?? [];
    expect(content.map((child) => child.id)).toEqual(["city", "box"]);
    expect(content[1]!.children?.content?.map((child) => child.id)).toEqual(["city"]);
    expect(errors).toEqual([]);
    const problems = (el.controller as unknown as { problemsOf?: (id: string) => Array<{ message: string }> }).problemsOf?.("city") ?? [];
    expect(problems.map((problem) => problem.message).join(" ")).toMatch(/2 components have the id "city"/);
  });

  it("load from the definition property", async () => {
    const el = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const errors: string[] = [];
    el.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    el.definition = twins() as never;
    document.body.append(el);
    await until(() => el.controller?.snapshot().children?.content?.length === 2);
    expect(errors).toEqual([]);
  });
});
