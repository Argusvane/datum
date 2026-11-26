import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import {
  computeEffectiveNodeState,
  type EffectiveNodeState
} from "../form-engine/core/state/effective-state.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { FormTranslations } from "../form-engine/core/localization/translations.js";
import type { TranslationCatalog } from "../form-engine/core/schema/contracts.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function root(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "step1",
          type: "step",
          configuration: {},
          children: {
            content: [
              { id: "name", type: "text", configuration: { description: "Legal name" } },
              { id: "hiddenField", type: "text", configuration: {} }
            ]
          }
        }
      ]
    }
  };
}

function effective(overrides: Partial<EffectiveNodeState>): EffectiveNodeState {
  return {
    visible: true,
    disabled: false,
    readonly: false,
    runValidation: true,
    requiredApplies: true,
    submitValue: true,
    clearValue: false,
    ...overrides
  };
}

describe("render orchestrator meta + model enrichment", () => {
  it("groups errors onto components and summarizes them in meta", async () => {
    const tree = new ComponentTree(root());
    const errors: FormError[] = [
      { id: "e1", code: "required", componentId: "name", stage: "field", source: "client" },
      { id: "e2", code: "format", componentId: "name", stage: "field", source: "client" }
    ];

    const output = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      errors,
      componentTree: tree
    });

    const nameModel = output.components.find((c) => c.id === "name");
    expect(nameModel?.errors).toHaveLength(2);
    expect(nameModel?.accessibility.invalid).toBe(true);
    expect(nameModel?.accessibility.ariaDescribedBy).toContain("name__error");
    expect(nameModel?.accessibility.ariaDescribedBy).toContain("name__description");

    expect(output.meta.errorSummary).toMatchObject({ total: 2, byComponent: { name: 2 }, formErrors: [] });
    expect(output.meta.firstErrorFocus).toMatchObject({
      componentId: "name",
      activateStepIds: ["step1"]
    });
  });

  it("keeps an error that names no component as a form-level entry of the summary", async () => {
    const tree = new ComponentTree(root());
    const formLevel: FormError = {
      id: "host_0",
      code: "delivery.failed",
      message: "The form could not be sent.",
      stage: "host",
      source: "server"
    };
    const onField: FormError = { id: "e1", code: "required", componentId: "name", stage: "field", source: "client" };

    const output = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      errors: [formLevel, onField],
      componentTree: tree
    });

    // Counted, listed, attached to no component; focus still goes to the first field error.
    expect(output.meta.errorSummary).toMatchObject({ total: 2, byComponent: { name: 1 }, formErrors: [formLevel] });
    expect(output.components.find((c) => c.id === "name")?.errors).toEqual([onField]);
    expect(output.meta.firstErrorFocus?.componentId).toBe("name");

    const alone = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      errors: [formLevel],
      componentTree: tree
    });
    expect(alone.meta.errorSummary.total).toBe(1);
    expect(alone.meta.firstErrorFocus).toBeUndefined();
  });

  it("derives visible/disabled/readOnly from effective state", async () => {
    const states = new Map<string, EffectiveNodeState>([
      ["name", effective({ disabled: true })],
      ["hiddenField", effective({ visible: false })]
    ]);

    const output = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      effectiveStates: states
    });

    expect(output.components.find((c) => c.id === "name")?.disabled).toBe(true);
    expect(output.components.find((c) => c.id === "hiddenField")?.visible).toBe(false);
  });

  it("marks a required component from requiredByComponent", async () => {
    const output = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      requiredByComponent: new Map([["name", true]])
    });
    expect(output.components.find((c) => c.id === "name")?.accessibility.required).toBe(true);
  });

  it("keeps a ticked component's marker when requiredByComponent says false: Required OR Required when", async () => {
    const ticked = root();
    const name = ticked.children!.content![0]!.children!.content![0]!;
    name.configuration = { ...(name.configuration as Record<string, unknown>), required: true };
    const output = await buildRenderOutput({
      mode: "interactive",
      root: ticked,
      state: new FormStateStore("en").snapshot(),
      resolver,
      requiredByComponent: new Map([
        ["name", false],
        ["hiddenField", false]
      ])
    });
    expect(output.components.find((c) => c.id === "name")?.accessibility.required).toBe(true);
    expect(output.components.find((c) => c.id === "hiddenField")?.accessibility.required).toBe(false);
    // Without any map, the tick alone.
    const bare = await buildRenderOutput({ mode: "interactive", root: ticked, state: new FormStateStore("en").snapshot(), resolver });
    expect(bare.components.find((c) => c.id === "name")?.accessibility.required).toBe(true);
  });

  // The canonical form in the definition's translations-map shape: strings in English, translations in one map.
  const intake = JSON.parse(readFileSync(new URL("./fixtures/customer-intake.translations.json", import.meta.url), "utf8")) as FormDefinition;

  async function intakeModels(locale: string, extra: { translationCatalog?: TranslationCatalog } = {}) {
    const output = await buildRenderOutput({
      mode: "interactive",
      root: intake.root,
      state: new FormStateStore(locale).snapshot(),
      resolver,
      translations: intake.translations!,
      ...extra
    });
    return (id: string) => output.components.find((component) => component.id === id);
  }

  it("words a component's label and description for the state locale from the definition's map", async () => {
    const model = await intakeModels("fr-CA");
    expect(model("fullName")?.label).toBe("Nom complet");
    expect(model("fullName")?.description).toBe("Tel qu'il apparaît sur une pièce d'identité");
    // A text with no entry reads in the default language, and so does the default locale.
    expect(model("newsletterEmail")?.label).toBe("Courriel de l'infolettre");
    expect((await intakeModels("en"))("fullName")?.label).toBe("Full name");
    // A locale the form has no entry for reads the defaults too.
    expect((await intakeModels("de"))("fullName")?.label).toBe("Full name");
  });

  it("serves fr-CA to a French Canadian and fr to nobody else's entry", async () => {
    // The map's `fr-CA` entry is not read for plain `fr`: only a primary-subtag entry serves its regions.
    expect((await intakeModels("fr"))("fullName")?.label).toBe("Full name");
    const frOnly: FormTranslations = { fr: { components: { fullName: { label: { text: "Nom (fr)", source: "x" } } } } };
    const output = await buildRenderOutput({
      mode: "interactive",
      root: intake.root,
      state: new FormStateStore("fr-CA").snapshot(),
      resolver,
      translations: frOnly
    });
    expect(output.components.find((c) => c.id === "fullName")?.label).toBe("Nom (fr)");
  });

  it("lets the host's catalog win over the map, and still resolves a stale entry", async () => {
    const translationCatalog: TranslationCatalog = { "fr-CA": { components: { fullName: { label: "Nom (catalogue)" } } } };
    const model = await intakeModels("fr-CA", { translationCatalog });
    expect(model("fullName")?.label).toBe("Nom (catalogue)");
    expect(model("contact")?.label).toBe("Mode de contact préféré");
    // Staleness is the builder's concern: an entry that answered other wording still resolves.
    const stale: FormTranslations = { "fr-CA": { components: { fullName: { label: { text: "Nom complet (ancien)", source: "0" } } } } };
    const output = await buildRenderOutput({
      mode: "interactive",
      root: intake.root,
      state: new FormStateStore("fr-CA").snapshot(),
      resolver,
      translations: stale
    });
    expect(output.components.find((c) => c.id === "fullName")?.label).toBe("Nom complet (ancien)");
  });

  it("words the inline options of a select through the same map, by each option's value", async () => {
    const output = await buildRenderOutput({
      mode: "interactive",
      root: intake.root,
      state: new FormStateStore("fr-CA").snapshot(),
      resolver,
      translations: intake.translations!
    });
    // Inline options are resolved with the owner's id and each option's value (never its index).
    expect(output.components.find((c) => c.id === "contact")?.optionState.items.map((item) => item.label)).toEqual([
      "Courriel",
      "Téléphone",
      "Text message"
    ]);
  });

  it("derives meta.textDirection from the state locale", async () => {
    const ltr = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver
    });
    expect(ltr.meta.textDirection).toBe("ltr");

    const rtl = await buildRenderOutput({
      mode: "interactive",
      root: root(),
      state: new FormStateStore("ar-EG").snapshot(),
      resolver
    });
    expect(rtl.meta.textDirection).toBe("rtl");
  });

  it("readonly mode forces readOnly regardless of effective state", async () => {
    const output = await buildRenderOutput({
      mode: "readonly",
      root: root(),
      state: new FormStateStore("en").snapshot(),
      resolver,
      effectiveStates: new Map([["name", effective({ readonly: false })]])
    });
    expect(output.components.find((c) => c.id === "name")?.readOnly).toBe(true);
  });
});

describe("effective-state helper sanity", () => {
  it("keeps computeEffectiveNodeState importable for the render layer", () => {
    expect(computeEffectiveNodeState({ visible: true, disabled: false, readonly: false }, []).visible).toBe(true);
  });
});
