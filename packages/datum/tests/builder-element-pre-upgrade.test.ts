import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";
import { sampleDefinition, until } from "./helpers.js";

// Same plant as the form element's test: own data properties a page script left before upgrade.
function plant(element: object, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(element, name, { value, writable: true, configurable: true, enumerable: true });
  }
}

describe("builder properties set before the element upgrades", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("adopts definition, fileActions and features through their setters", async () => {
    const builder = document.createElement("datum-form-builder") as DatumFormBuilderElement;
    const fileActions = { new: () => undefined };
    plant(builder, { definition: sampleDefinition(), fileActions, features: ["pdf"] });
    const errors: unknown[] = [];
    window.addEventListener("error", (event) => errors.push(event.error));
    document.body.append(builder);
    await until(() => builder.definition !== undefined);
    for (const name of ["definition", "fileActions", "features"]) {
      expect(Object.prototype.hasOwnProperty.call(builder, name)).toBe(false);
    }
    expect(builder.definition?.id).toBe(sampleDefinition().id);
    expect(builder.fileActions?.new).toBe(fileActions.new);
    expect(builder.features).toBe("pdf");
    expect(errors).toEqual([]);
  });
});
