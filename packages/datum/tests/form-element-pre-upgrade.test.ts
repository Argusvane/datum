import { afterEach, describe, expect, it } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";
import { until } from "./helpers.js";

// A page script that runs before the bundle upgrades <datum-form> leaves its assignments as own
// data properties that shadow the accessors. Own properties are planted here the same way.
function plant(element: object, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(element, name, { value, writable: true, configurable: true, enumerable: true });
  }
}

const definition = {
  id: "pre-upgrade",
  version: "1.0.0",
  schemaVersion: "1",
  root: {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "countries" } } },
        { id: "name", type: "text", configuration: { label: "Name" } }
      ]
    }
  }
};

describe("properties set before the element upgrades", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("adopts definition, dataSources and values, so the select lists its options with no datum-error", async () => {
    const form = document.createElement("datum-form") as DatumFormElement;
    plant(form, {
      definition,
      dataSources: { countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }] },
      values: { name: "Ada" }
    });
    const errors: string[] = [];
    form.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail.message));
    document.body.append(form);
    await until(() => form.runtime !== undefined);
    expect(Object.prototype.hasOwnProperty.call(form, "definition")).toBe(false);
    await until(() => form.values.name === "Ada");
    expect(form.definition?.id).toBe("pre-upgrade");
    expect(form.values.name).toBe("Ada");
    expect(errors).toEqual([]);
  });
});
