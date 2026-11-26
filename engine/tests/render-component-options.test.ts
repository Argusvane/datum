import { describe, expect, it, vi } from "vitest";

import {
  DataSourcePending,
  MAX_DATA_SOURCE_ITEMS,
  resolveComponentOptionState,
  resolveOptionStatesForTree,
  type DataSourceResolver
} from "../form-engine/render/core/component-options.js";

describe("render component options", () => {
  it("returns ready status when resolver yields items", async () => {
    const resolver: DataSourceResolver = {
      resolveDataSource: async ({ componentId }) => ({
        items: [{ value: componentId, label: `label-${componentId}` }]
      })
    };

    const state = await resolveComponentOptionState(resolver, {
      id: "country",
      type: "select",
      configuration: {}
    });

    expect(state.status).toBe("ready");
    expect(state.items[0]?.value).toBe("country");
  });

  it("returns not-applicable when no source exists", async () => {
    const resolver: DataSourceResolver = {
      resolveDataSource: async () => undefined
    };

    const state = await resolveComponentOptionState(resolver, {
      id: "freeText",
      type: "text",
      configuration: {}
    });

    expect(state.status).toBe("not-applicable");
    expect(state.items).toEqual([]);
  });

  it("returns error status when resolver throws", async () => {
    const resolver: DataSourceResolver = {
      resolveDataSource: async () => {
        throw new Error("provider unavailable");
      }
    };

    const state = await resolveComponentOptionState(resolver, {
      id: "country",
      type: "select",
      configuration: {}
    });

    expect(state.status).toBe("error");
    expect(state.error).toMatch(/provider unavailable/);
  });

  it("resolves option states for the whole tree", async () => {
    const resolver: DataSourceResolver = {
      resolveDataSource: async ({ componentId }) => {
        if (componentId === "country") {
          return { items: [{ value: "CA", label: "Canada" }] };
        }
        return undefined;
      }
    };

    const root = {
      id: "root",
      type: "container",
      configuration: {},
      children: {
        children: [
          { id: "country", type: "select", configuration: {} },
          { id: "notes", type: "text", configuration: {} }
        ]
      }
    };

    const states = await resolveOptionStatesForTree(resolver, root);

    expect(states.country?.status).toBe("ready");
    expect(states.notes?.status).toBe("not-applicable");
    expect(states.root?.status).toBe("not-applicable");
  });
});

describe("render component options: wrong-shaped answers", () => {
  const node = { id: "country", type: "select", configuration: {} } as never;
  const answering = (items: unknown): DataSourceResolver => ({ resolveDataSource: async () => ({ items }) as never });

  it.each<[string, unknown]>([
    ["a string", "abc"],
    ["null", null],
    ["numbers", [1, 2]],
    ["an item without a label", [{ value: "a" }]],
    ["an item whose value is an object", [{ value: { a: 1 }, label: "o" }]],
    ["a null item", [null]]
  ])("items that are %s give an empty error state and a console warning, never a throw", async (_name, items) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = await resolveComponentOptionState(answering(items), node);
    expect(state.status).toBe("error");
    expect(state.items).toEqual([]);
    expect(state.error).toContain("country");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a well-formed answer keeps its extra fields", async () => {
    const items = [{ value: "a", label: "A", description: "first", meta: { n: 1 } }];
    const state = await resolveComponentOptionState(answering(items), node);
    expect(state.status).toBe("ready");
    expect(state.items).toEqual(items);
  });
});

describe("render component options: a configured source never falls back to the inline list", () => {
  const configured = {
    id: "country",
    type: "select",
    configuration: { data: { sourceId: "countries" }, options: [{ value: "inline", label: "Inline author list" }] }
  } as never;
  const plain = { id: "plain", type: "select", configuration: { options: [{ value: "inline", label: "Inline author list" }] } } as never;
  const answering = (answer: unknown): DataSourceResolver => ({ resolveDataSource: async () => answer as never });

  it("a throw names the source too, and the inline list stays out of it", async () => {
    const state = await resolveComponentOptionState({ resolveDataSource: async () => { throw new Error("boom"); } }, configured);
    expect(state).toMatchObject({ status: "error", items: [], error: "boom", sourceId: "countries" });
  });

  it("a component naming no source still gets its inline options when the resolver answers nothing", async () => {
    const state = await resolveComponentOptionState(answering(undefined), plain);
    expect(state.status).toBe("ready");
    expect(state.items).toEqual([{ value: "inline", label: "Inline author list" }]);
    expect(state.sourceId).toBeUndefined();
  });

  it("a pending source is loading, for a component naming one; a component naming none is unaffected", async () => {
    const pending: DataSourceResolver = { resolveDataSource: () => Promise.reject(new DataSourcePending()) };
    expect(await resolveComponentOptionState(pending, configured)).toEqual({ componentId: "country", status: "loading", items: [], sourceId: "countries" });
    expect((await resolveComponentOptionState(pending, plain)).status).toBe("ready");
  });

  it("a list longer than MAX_DATA_SOURCE_ITEMS is cut to it with a warning and the full count kept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const items = Array.from({ length: MAX_DATA_SOURCE_ITEMS + 3 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
    const state = await resolveComponentOptionState(answering({ items }), configured);
    expect(state.status).toBe("ready");
    expect(state.items).toHaveLength(MAX_DATA_SOURCE_ITEMS);
    expect(state.truncated).toEqual({ total: MAX_DATA_SOURCE_ITEMS + 3 });
    expect(warn).toHaveBeenCalledTimes(1);
    const exact = await resolveComponentOptionState(answering({ items: items.slice(0, MAX_DATA_SOURCE_ITEMS) }), configured);
    expect(exact.truncated).toBeUndefined();
    warn.mockRestore();
  });
});
