import { describe, expect, it } from "vitest";

import { ErrorStore } from "../form-engine/validation/core/error-store.js";

describe("error store", () => {
  it("stores and filters errors", () => {
    const store = new ErrorStore();

    store.setAll([
      {
        id: "e1",
        code: "validation.required",
        componentId: "firstName",
        stage: "field",
        source: "client"
      },
      {
        id: "e2",
        code: "validation.invalid",
        componentId: "firstName",
        stage: "field",
        source: "client"
      },
      {
        id: "e3",
        code: "form.inactiveCustomer",
        stage: "form",
        source: "server"
      }
    ]);

    expect(store.forComponent("firstName")).toHaveLength(2);
    expect(store.listAll()).toHaveLength(3);
  });

  it("aggregates by component", () => {
    const store = new ErrorStore();
    store.setAll([
      {
        id: "e1",
        code: "validation.required",
        componentId: "postalCode",
        stage: "field",
        source: "client"
      },
      {
        id: "e2",
        code: "validation.invalid",
        componentId: "postalCode",
        stage: "field",
        source: "client"
      }
    ]);

    const aggregate = store.aggregateByComponent();
    expect(aggregate.get("postalCode")).toBe(2);
  });
});
