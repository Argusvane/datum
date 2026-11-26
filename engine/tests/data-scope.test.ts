// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRowCollections,
  buildValuePaths,
  createValuePathResolver,
  hasDataScopes,
  isDataScopeContainer
} from "../form-engine/core/tree/data-scope.js";
import { buildComponentModels } from "../form-engine/render/core/component-model.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

afterEach(unmountAll);

const nested: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "reference", type: "text", configuration: { label: "Reference" } },
      {
        id: "applicant",
        type: "container",
        configuration: { label: "Applicant" },
        children: {
          content: [
            { id: "email", type: "text", configuration: { label: "Email" } },
            {
              id: "address",
              type: "container",
              configuration: {},
              children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] }
            },
            {
              // A plain grouping container inside a scope adds no level of its own.
              id: "names",
              type: "fieldset",
              configuration: {},
              children: { content: [{ id: "given", type: "text", configuration: {} }] }
            }
          ]
        }
      }
    ]
  }
};

describe("data scopes", () => {
  it("nests a container's descendants under its id, and nothing else", () => {
    const paths = buildValuePaths(nested);
    expect(paths.get("reference")).toBe("reference");
    expect(paths.get("email")).toBe("applicant.email");
    expect(paths.get("city")).toBe("applicant.address.city");
    // A `fieldset` groups visually; only a `container` is a level in the data.
    expect(paths.get("given")).toBe("applicant.given");
    // The container itself holds no value of its own.
    expect(paths.get("applicant")).toBe("applicant");
  });

  it("leaves a form with no container in it completely untouched", () => {
    const flat: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "a", type: "text", configuration: {} },
          { id: "b", type: "fieldset", configuration: {}, children: { content: [{ id: "c", type: "text", configuration: {} }] } }
        ]
      }
    };
    expect(hasDataScopes(flat)).toBe(false);
    const paths = buildValuePaths(flat);
    for (const [id, path] of paths) {
      expect(path).toBe(id);
    }
  });

  it("can be switched off, leaving a container as a plain grouping box", () => {
    const node: ComponentNode = {
      id: "group",
      type: "container",
      configuration: { scopeData: false },
      children: { content: [] }
    };
    expect(isDataScopeContainer(node)).toBe(false);
    expect(isDataScopeContainer({ ...node, configuration: {} })).toBe(true);
  });

  it("falls back to the component id for anything the map has not seen", () => {
    const resolve = createValuePathResolver(nested);
    expect(resolve("email")).toBe("applicant.email");
    expect(resolve("added_later")).toBe("added_later");
  });
});

describe("render model under a data scope", () => {
  it("reads a field's value from its path, not its id", () => {
    const store = new FormStateStore("en");
    const state = { ...store.snapshot(), values: { "applicant.email": "a@b.c", email: "WRONG" } };
    const models = buildComponentModels(nested, state, {}, { readOnlyByMode: false });
    const email = models.find((model) => model.id === "email")!;

    expect(email.valuePath).toBe("applicant.email");
    expect(email.value).toBe("a@b.c");
  });

  it("reads an answer by its own key, never a member every object inherits", () => {
    const tricky: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "constructor", type: "text", configuration: { label: "A" } },
          { id: "toString", type: "text", configuration: { label: "B" } }
        ]
      }
    };
    const store = new FormStateStore("en");
    const models = buildComponentModels(tricky, store.snapshot(), {}, { readOnlyByMode: false });

    expect(models.find((model) => model.id === "constructor")!.value).toBeUndefined();
    expect(models.find((model) => model.id === "toString")!.value).toBeUndefined();
  });

  it("keeps the component id as the field's identity", () => {
    const store = new FormStateStore("en");
    const models = buildComponentModels(nested, store.snapshot(), {}, { readOnlyByMode: false });
    const email = models.find((model) => model.id === "email")!;
    // Rules, errors and selection all address this; only the datum moved.
    expect(email.id).toBe("email");
    expect(email.accessibility.fieldId).toBe("email");
  });

  it("marks the field with its value path: the container's scope in front of its id", async () => {
    const html = (await markupOf(nested)).html;

    expect(html).toContain('data-component-id="email" data-value-path="applicant.email"');
    // A field outside every container carries the path of its own id, and no other.
    expect(html).toContain('data-component-id="reference" data-value-path="reference"');
    expect(html).not.toContain('data-value-path="applicant.reference"');
  });
});

describe("buildRowCollections", () => {
  it("names the section a component's rules read as row; a nested section reads the row it sits in", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "top", type: "text", configuration: {} },
          {
            id: "orders",
            type: "dataGrid",
            configuration: {},
            collection: { collectionPath: "orders" },
            children: {
              content: [
                { id: "ref", type: "text", configuration: {} },
                {
                  id: "box",
                  type: "container",
                  configuration: {},
                  children: { content: [{ id: "lines", type: "dataGrid", configuration: {}, collection: { collectionPath: "lines" }, children: { content: [{ id: "item", type: "text", configuration: {} }] } }] }
                }
              ]
            }
          }
        ]
      }
    };
    expect(Object.fromEntries(buildRowCollections(root))).toEqual({ ref: "orders", box: "orders", lines: "orders", item: "lines" });
  });
});
