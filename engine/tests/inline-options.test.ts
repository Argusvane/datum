// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  createInlineOptionsCapability,
  parseInlineOptions,
  readInlineOptions,
  resolveInlineOptionItems
} from "../form-engine/core/schema/inline-options.js";
import {
  resolveComponentOptionState,
  resolveOptionStatesForTree,
  type DataSourceResolver
} from "../form-engine/render/core/component-options.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";

afterEach(unmountAll);

const noSources: DataSourceResolver = { resolveDataSource: async () => undefined };

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" }
];

/** The French for YES_NO, in the definition's map at `components › answer › options › <value> › label`. */
const FRENCH: FormTranslations = {
  "fr-CA": {
    components: {
      answer: {
        options: {
          yes: { label: { text: "Oui", source: sourceHash("Yes") } },
          no: { label: { text: "Non", source: sourceHash("No") } }
        }
      }
    }
  }
};

describe("inline options — reading", () => {
  it("reads value/label pairs in order, defaulting a missing label to the value", () => {
    expect(readInlineOptions({ options: [{ value: "a", label: "A" }, { value: "b" }] })).toEqual([
      { value: "a", label: "A" },
      { value: "b", label: "b" }
    ]);
  });

  it("skips entries that are not options rather than failing the list", () => {
    expect(
      parseInlineOptions([
        "loose string",
        { label: "no value" },
        { value: 3, label: "numeric value" },
        { value: "ok", label: "Fine" },
        { value: "bad-label", label: 7 },
        { value: "old-shape", label: { default: "Not a string", locales: { fr: "Pas une chaîne" } } },
        null
      ])
    ).toEqual([{ value: "ok", label: "Fine" }]);
    expect(readInlineOptions({ options: "nope" })).toEqual([]);
    expect(readInlineOptions(undefined)).toEqual([]);
  });

  it("resolves labels for a locale from the map by the option's value, the host's catalog winning", () => {
    expect(resolveInlineOptionItems(YES_NO, "answer", "fr-CA", { translations: FRENCH })).toEqual([
      { value: "yes", label: "Oui" },
      { value: "no", label: "Non" }
    ]);
    const catalog = { "fr-CA": { components: { answer: { options: { no: { label: "Non merci" } } } } } };
    expect(resolveInlineOptionItems(YES_NO, "answer", "fr-CA", { translations: FRENCH, catalog })).toEqual([
      { value: "yes", label: "Oui" },
      { value: "no", label: "Non merci" }
    ]);
    expect(resolveInlineOptionItems(YES_NO, "answer", "de", { translations: FRENCH }).map((item) => item.label)).toEqual(["Yes", "No"]);
    // Another component's translations are not this one's.
    expect(resolveInlineOptionItems(YES_NO, "other", "fr-CA", { translations: FRENCH }).map((item) => item.label)).toEqual(["Yes", "No"]);
  });

  it("keeps a translation on its option when the list is reordered", () => {
    const reordered = [...YES_NO].reverse();
    expect(resolveInlineOptionItems(reordered, "answer", "fr-CA", { translations: FRENCH })).toEqual([
      { value: "no", label: "Non" },
      { value: "yes", label: "Oui" }
    ]);
  });

  it("contributes an options-editor field for the builder", () => {
    const capability = createInlineOptionsCapability();
    const contribution = capability.configureEditor?.({
      component: { id: "answer", type: "radio", configuration: {} }
    });
    expect(contribution?.fields?.[0]).toMatchObject({ type: "options-editor", propertyPath: "options" });
    expect(createInlineOptionsCapability({ propertyPath: "choices" }).configureEditor?.({
      component: { id: "answer", type: "radio", configuration: {} }
    })?.fields?.[0]?.propertyPath).toBe("choices");
  });
});

describe("inline options — resolution", () => {
  const withInline: ComponentNode = {
    id: "answer",
    type: "radio",
    configuration: { label: "Answer", options: YES_NO }
  };

  it("feeds a component that names no data source", async () => {
    const state = await resolveComponentOptionState(noSources, withInline, undefined, undefined, {
      locale: "fr-CA",
      translations: FRENCH
    });
    expect(state.status).toBe("ready");
    expect(state.items).toEqual([
      { value: "yes", label: "Oui" },
      { value: "no", label: "Non" }
    ]);
  });

  it("yields to a data source the component names", async () => {
    const sourced: DataSourceResolver = {
      resolveDataSource: async () => ({ items: [{ value: "x", label: "From the source" }] })
    };
    const state = await resolveComponentOptionState(sourced, withInline);
    expect(state.items).toEqual([{ value: "x", label: "From the source" }]);
  });

  it("does not paper over a data source that failed", async () => {
    const failing: DataSourceResolver = {
      resolveDataSource: async () => {
        throw new Error("lookup service down");
      }
    };
    const state = await resolveComponentOptionState(failing, withInline);
    expect(state.status).toBe("error");
    expect(state.items).toEqual([]);
    expect(state.error).toBe("lookup service down");
  });

  it("leaves a component with neither route not-applicable", async () => {
    const state = await resolveComponentOptionState(noSources, {
      id: "name",
      type: "text",
      configuration: { label: "Name" }
    });
    expect(state.status).toBe("not-applicable");
  });

  it("resolves every node of a tree in the requested locale", async () => {
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [withInline] } };
    const states = await resolveOptionStatesForTree(noSources, root, {}, {}, { locale: "en", translations: FRENCH });
    expect(states["answer"]?.items.map((item) => item.label)).toEqual(["Yes", "No"]);
    const french = await resolveOptionStatesForTree(noSources, root, {}, {}, { locale: "fr-CA", translations: FRENCH });
    expect(french["answer"]?.items.map((item) => item.label)).toEqual(["Oui", "Non"]);
    expect(states["root"]?.status).toBe("not-applicable");
  });

  it("draws inline options into a select, a radio group and a checkboxes group", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "one", type: "select", configuration: { label: "One", options: YES_NO } },
          { id: "two", type: "radio", configuration: { label: "Two", options: YES_NO } },
          { id: "three", type: "checkboxes", configuration: { label: "Three", options: YES_NO } }
        ]
      }
    };
    const options = Object.fromEntries(
      ["one", "two", "three"].map((id) => [id, { options: { yes: { label: { text: "Oui", source: sourceHash("Yes") } }, no: { label: { text: "Non", source: sourceHash("No") } } } }])
    );
    const html = (await markupOf(root, { locale: "fr-CA", translations: { "fr-CA": { components: options } } })).html;
    expect(html).toContain('<option value="yes">Oui</option>');
    expect(html).toMatch(/<input type="radio"[^>]*value="no"[^>]*><span>Non<\/span>/);
    expect(html).toMatch(/<input type="checkbox"[^>]*value="yes"[^>]*><span>Oui<\/span>/);
  });
});

describe("inline options — descriptions", () => {
  it("reads a description as a string, and drops a blank one", () => {
    expect(
      parseInlineOptions([
        { value: "personal", label: "Personal", description: "For you or your family" },
        { value: "business", label: "Business", description: "For a company" },
        { value: "other", label: "Other", description: "" },
        { value: "none", label: "None" }
      ])
    ).toEqual([
      { value: "personal", label: "Personal", description: "For you or your family" },
      { value: "business", label: "Business", description: "For a company" },
      { value: "other", label: "Other" },
      { value: "none", label: "None" }
    ]);
    // A description that is not text makes the entry unusable, like a label that is not.
    expect(parseInlineOptions([{ value: "x", label: "X", description: 7 }])).toEqual([]);
  });

  it("resolves a description for the locale beside the label, and leaves it out when there is none", () => {
    const options = parseInlineOptions([
      { value: "business", label: "Business", description: "For a company" },
      { value: "none", label: "None" }
    ]);
    const translations: FormTranslations = {
      "fr-CA": { components: { kind: { options: { business: { description: { text: "Pour une entreprise", source: sourceHash("For a company") } } } } } }
    };
    expect(resolveInlineOptionItems(options, "kind", "fr-CA", { translations })).toEqual([
      { value: "business", label: "Business", description: "Pour une entreprise" },
      { value: "none", label: "None" }
    ]);
    expect(resolveInlineOptionItems(options, "kind", "en", { translations })[0]!.description).toBe("For a company");
  });
});
