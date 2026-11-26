import { describe, expect, it } from "vitest";

import { CollectionRuntime } from "../form-engine/runtime/browser/collection-runtime.js";

describe("collection runtime", () => {
  it("adds, removes, and reorders rows", () => {
    const runtime = new CollectionRuntime();
    runtime.initialize({
      collectionPath: "accounts",
      itemSchema: { id: "account", type: "container", configuration: {} },
      operations: { add: true, remove: true, reorder: true }
    });

    runtime.addRow("accounts", { id: "a", balance: 100 });
    runtime.addRow("accounts", { id: "b", balance: 200 });
    runtime.reorderRow("accounts", 1, 0);

    expect(runtime.list("accounts").map((r) => r.id)).toEqual(["b", "a"]);

    runtime.removeRow("accounts", 1);
    expect(runtime.list("accounts")).toHaveLength(1);
  });

  it("builds row context and item path", () => {
    const runtime = new CollectionRuntime();
    runtime.initialize({
      collectionPath: "addresses",
      itemSchema: { id: "address", type: "container", configuration: {} },
      operations: { add: true }
    });
    runtime.addRow("addresses", { city: "Montreal" });

    const context = runtime.rowContext("addresses", 0);
    expect(context.rowData.city).toBe("Montreal");

    expect(CollectionRuntime.buildItemPath("addresses", 0, "postalCode")).toBe(
      "addresses[0].postalCode"
    );
  });
});
