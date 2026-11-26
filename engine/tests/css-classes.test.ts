import { describe, expect, it } from "vitest";

import { bindingClassChoices, bindingClassDeclarations, bindingClassNames, bindingClassVocabulary, clearCssClassGroup, toggleCssClass, validateComponentCssClasses } from "../form-engine/builder/property-editor/css-classes.js";
import { mergeCssClasses, PANEL_LOOK_CLASSES, PANEL_LOOK_GROUP } from "../form-engine/render/live/look-classes.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { styleOptionsHtml } from "../form-engine/builder/web-component/builder-shared.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";
import type { LiveBinding } from "../form-engine/render/live/contract.js";

/*
 * The `configuration.cssClass` vocabulary is the one the binding declares (`LiveBinding.cssClasses`): the Style tab offers
 * those classes, and the class check notes one outside them.
 */

describe("bindingClassNames", () => {
  it("reads the binding's declared classes, well-formed and once each, in its order", () => {
    const binding = { cssClasses: ["govuk-input--width-10", "govuk-label--l", 'x" onclick="y', "govuk-label--l", " padded "] } as Pick<LiveBinding, "cssClasses">;
    expect(bindingClassNames(binding)).toEqual(["govuk-input--width-10", "govuk-label--l", "padded"]);
    expect(bindingClassChoices(binding).map((choice) => [choice.name, choice.label])).toEqual([
      ["govuk-input--width-10", "govuk-input--width-10"],
      ["govuk-label--l", "govuk-label--l"],
      ["padded", "padded"]
    ]);
  });

  it("is empty for a binding that declares none", () => {
    expect(bindingClassNames(undefined)).toEqual([]);
    expect(bindingClassNames({})).toEqual([]);
    expect(bindingClassNames({ cssClasses: "wide" as unknown as string[] })).toEqual([]);
  });
});

describe("validateComponentCssClasses", () => {
  const vocabulary = ["highlight", "is-compact", "wide"];
  const clean = { error: undefined, warning: undefined };

  it("accepts classes the binding declares, in either authored shape", () => {
    expect(validateComponentCssClasses("wide is-compact", vocabulary)).toEqual(clean);
    expect(validateComponentCssClasses(["highlight"], vocabulary)).toEqual(clean);
    expect(validateComponentCssClasses("", vocabulary)).toEqual(clean);
    expect(validateComponentCssClasses(undefined, vocabulary)).toEqual(clean);
  });

  it("notes a class from outside the binding's, naming it", () => {
    expect(validateComponentCssClasses("wide print-only", vocabulary)).toEqual({
      error: undefined,
      warning: "\"print-only\" is not one of the binding's classes."
    });
    expect(validateComponentCssClasses("a b", vocabulary).warning).toBe("\"a\", \"b\" are not among the binding's classes.");
  });

  it("errors on a malformed token — the renderer would drop it silently", () => {
    expect(validateComponentCssClasses('x" onload="y', vocabulary).error).toMatch(/not a valid class name/);
    expect(validateComponentCssClasses("2cols", vocabulary).error).toMatch(/not a valid class name/);
  });

  it("reports both when a value carries both kinds of problem", () => {
    const check = validateComponentCssClasses("wide 2cols off-binding", vocabulary);
    expect(check.error).toContain('"2cols"');
    expect(check.warning).toContain('"off-binding"');
    expect(check.error).not.toContain('"wide"');
    expect(check.warning).not.toContain('"wide"');
  });

  it("checks only token syntax when the binding declares no class vocabulary", () => {
    expect(validateComponentCssClasses("anything-goes", [])).toEqual(clean);
    expect(validateComponentCssClasses("still not*valid", []).error).toMatch(/not a valid class name/);
    expect(validateComponentCssClasses("still not*valid", []).warning).toBeUndefined();
  });
});

describe("the controller's class vocabulary follows the chosen binding", () => {
  const def = (type: string, extra: Record<string, unknown> = {}): ComponentDefinition => ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;
  const controller = (binding?: LiveBinding) =>
    new BuilderController({
      componentTypes: [{ type: "text", label: "Text" }],
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "postcode", type: "text", configuration: {} }] } },
      componentDefinitions: [def("form", { children: { slots: [{ id: "content", multiple: true }] } }), def("text")],
      ...(binding ? { binding } : {})
    });
  const govuk = { ...createDatumBinding(), id: "govuk-test", label: "GOV.UK test", cssClasses: ["govuk-input--width-10", "govuk-label--l"] } as LiveBinding;

  it("offers the binding's classes on the Style tab and checks cssClass against them", () => {
    const ctrl = controller(govuk);
    expect(ctrl.styleOptions().map((choice) => choice.name)).toEqual(["govuk-input--width-10", "govuk-label--l"]);
    // The binding's own classes, and the shared panel looks accepted in addition.
    expect(ctrl.cssClassNames()).toEqual(["govuk-input--width-10", "govuk-label--l", "panel-plain", "panel-outlined", "panel-shaded", "panel-card"]);
    const html = styleOptionsHtml({ choices: ctrl.styleOptions(), active: ["govuk-label--l"] });
    expect(html).toContain("<legend>Style options</legend>");
    expect(html).toContain('data-style-option="govuk-label--l" checked');
    ctrl.select("postcode");
    ctrl.setDraftProperty("postcode", "cssClass", "govuk-label--l wide");
    expect(ctrl.cssClassWarning).toBe("\"wide\" is not one of the binding's classes.");
  });

  it("offers nothing and checks only syntax under Datum's binding, and follows a binding picked in the picker", () => {
    const ctrl = controller();
    expect(ctrl.styleOptions()).toEqual([]);
    expect(ctrl.cssClassNames()).toEqual([]);
    expect(styleOptionsHtml({ choices: [], active: [] })).toBe("");
    ctrl.select("postcode");
    ctrl.setDraftProperty("postcode", "cssClass", "wide");
    expect(ctrl.cssClassWarning).toBeUndefined();
    ctrl.setOptions({ availableBindings: [{ id: "govuk-test", label: "GOV.UK test", binding: govuk }] });
    ctrl.setBindingId("govuk-test");
    expect(ctrl.cssClassWarning).toBe("\"wide\" is not one of the binding's classes.");
    ctrl.setBindingId(undefined);
    expect(ctrl.cssClassWarning).toBeUndefined();
  });
});

describe("class declarations with a meaning", () => {
  const looks = [
    { name: "panel-plain", label: "Plain", description: "Heading only.", types: ["panel"], group: "panel-look" },
    { name: "panel-card", label: "Card", types: ["panel"], group: "panel-look" },
    "is-compact",
    { name: "gcds-wide", types: ["gcds-card"] },
    { name: "badge", label: "  ", types: [], group: " " },
    { name: "2bad" },
    { name: "is-compact", label: "Duplicate" }
  ];
  const binding = { cssClasses: looks } as unknown as Pick<LiveBinding, "cssClasses">;

  it("reads a bare name and a declaration into one shape, dropping the malformed; a later declaration of a name replaces the earlier one in its place", () => {
    expect(bindingClassNames(binding)).toEqual(["panel-plain", "panel-card", "is-compact", "gcds-wide", "badge"]);
    expect(bindingClassDeclarations(binding)).toEqual([
      { name: "panel-plain", label: "Plain", description: "Heading only.", types: ["panel"], group: "panel-look" },
      { name: "panel-card", label: "Card", types: ["panel"], group: "panel-look" },
      { name: "is-compact", label: "Duplicate" },
      { name: "gcds-wide", label: "gcds-wide", types: ["gcds-card"] },
      // A list that names no type is no component, not any.
      { name: "badge", label: "badge", types: [] }
    ]);
    // Normalised once per list.
    expect(bindingClassDeclarations(binding)).toBe(bindingClassDeclarations(binding));
  });

  it("offers a class on the component types it names, as written or as their base", () => {
    const names = (type?: string, base?: string) => bindingClassChoices(binding, type === undefined ? undefined : { type, base }).map((choice) => choice.name);
    expect(names("panel")).toEqual(["panel-plain", "panel-card", "is-compact"]);
    expect(names("text")).toEqual(["is-compact"]);
    expect(names("gcds-card")).toEqual(["is-compact", "gcds-wide"]);
    expect(names("fancy-card", "gcds-card")).toEqual(["is-compact", "gcds-wide"]);
    expect(names("fancy-panel", "panel")).toEqual(["panel-plain", "panel-card", "is-compact"]);
    // Without a component only the classes that name no type; "badge" names none at all (an empty list), so it is offered nowhere.
    expect(names()).toEqual(["is-compact"]);
  });

  it("ticking a class of a group takes the group's others away in the same value, and clearing returns to none", () => {
    const choices = bindingClassChoices(binding, { type: "panel" });
    expect(toggleCssClass("panel-card is-compact", "panel-plain", true, choices)).toBe("is-compact panel-plain");
    expect(toggleCssClass(["panel-card", "panel-plain"], "panel-card", true, choices)).toBe("panel-card");
    expect(toggleCssClass("panel-plain is-compact", "panel-plain", false, choices)).toBe("is-compact");
    expect(toggleCssClass(undefined, "is-compact", true, choices)).toBe("is-compact");
    expect(toggleCssClass("panel-plain", "panel-plain", false, choices)).toBeUndefined();
    expect(clearCssClassGroup("panel-card is-compact page-class", "panel-look", choices)).toBe("is-compact page-class");
    expect(clearCssClassGroup("panel-card", "panel-look", choices)).toBeUndefined();
  });
});

describe("the Style tab for a panel", () => {
  const def = (type: string, extra: Record<string, unknown> = {}): ComponentDefinition => ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;
  const controller = () =>
    new BuilderController({
      componentTypes: [{ type: "text", label: "Text" }, { type: "panel", label: "Panel" }],
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "box", type: "panel", configuration: { cssClass: "panel-card page-class" }, children: { content: [] } }, { id: "name", type: "text", configuration: {} }] }
      },
      componentDefinitions: [
        def("form", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("panel", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("text")
      ]
    });

  it("offers the four looks on a panel and none on a text field, under Datum's own binding", () => {
    const ctrl = controller();
    expect(ctrl.styleOptions("box").map((choice) => [choice.name, choice.label, choice.group])).toEqual([
      ["panel-plain", "Plain", PANEL_LOOK_GROUP],
      ["panel-outlined", "Outlined", PANEL_LOOK_GROUP],
      ["panel-shaded", "Shaded", PANEL_LOOK_GROUP],
      ["panel-card", "Card", PANEL_LOOK_GROUP]
    ]);
    expect(ctrl.styleOptions("name")).toEqual([]);
    // No vocabulary of its own: a page class is no mistake under Datum.
    expect(ctrl.cssClassNames()).toEqual([]);
  });

  it("sets one look per write, keeps the other classes, and one undo returns the panel", () => {
    const ctrl = controller();
    ctrl.select("box");
    ctrl.setStyleClass("box", "panel-plain", true);
    expect(ctrl.draftProperty("box", "cssClass")).toBe("page-class panel-plain");
    expect(ctrl.commitDraft("box")).toBe(true);
    expect(ctrl.getProperty("box", "cssClass")).toBe("page-class panel-plain");
    ctrl.undo();
    expect(ctrl.getProperty("box", "cssClass")).toBe("panel-card page-class");

    ctrl.select("box");
    ctrl.clearStyleGroup("box", PANEL_LOOK_GROUP);
    expect(ctrl.draftProperty("box", "cssClass")).toBe("page-class");
  });

  it("draws the looks as one radio group with a Default choice that is checked when none is set", () => {
    const ctrl = controller();
    const choices = ctrl.styleOptions("box");
    const none = styleOptionsHtml({ choices, active: ["page-class"] });
    expect(none).toContain('<legend>Look</legend>');
    expect(none).toContain('data-style-group="panel-look"');
    expect(none).toMatch(/<input type="radio" name="style-group-panel-look" data-style-group-clear="panel-look" checked/);
    expect(none.match(/type="radio"/g)).toHaveLength(5);
    expect(none).not.toMatch(/data-style-option="panel-[a-z]+" checked/);
    const card = styleOptionsHtml({ choices, active: ["panel-card"] });
    expect(card).toMatch(/data-style-option="panel-card" checked/);
    expect(card).not.toMatch(/data-style-group-clear="panel-look" checked/);
    // A group with one class offered has nothing to exclude: a toggle.
    const single = styleOptionsHtml({ choices: [choices[0]!], active: [] });
    expect(single).toContain('type="checkbox" data-style-option="panel-plain"');
    expect(single).not.toContain("radio");
  });
});

describe("one rule for a name declared twice", () => {
  const card = { name: "panel-card", label: "Card", types: ["panel"], group: PANEL_LOOK_GROUP };

  it("keeps a declaration when a bare name of it comes later, in the merge and in the normalisation alike", () => {
    const merged = mergeCssClasses([card], ["panel-card"]);
    expect(merged).toEqual([card]);
    expect(bindingClassDeclarations({ cssClasses: merged })).toEqual(bindingClassDeclarations({ cssClasses: [card, "panel-card"] }));
    expect(bindingClassDeclarations({ cssClasses: [card, "panel-card"] })).toEqual([{ name: "panel-card", label: "Card", types: ["panel"], group: PANEL_LOOK_GROUP }]);
    // Shared looks then a host's bare name of one: the look keeps its group and types.
    expect(bindingClassChoices({ cssClasses: mergeCssClasses(PANEL_LOOK_CLASSES, ["panel-card"]) }, { type: "panel" }).map((choice) => [choice.name, choice.group])).toEqual(
      PANEL_LOOK_CLASSES.map((look) => [look.name, PANEL_LOOK_GROUP])
    );
  });

  it("lets a later declaration object replace the earlier entry in its place, bare or declared", () => {
    const relabelled = { name: "panel-card", label: "Panel with a band", types: ["panel"], group: PANEL_LOOK_GROUP };
    for (const lists of [
      [[card, "other"], [relabelled]],
      [["panel-card", "other"], [relabelled]]
    ] as const) {
      const merged = mergeCssClasses(...lists);
      expect(merged).toEqual([relabelled, "other"]);
      expect(bindingClassDeclarations({ cssClasses: merged })).toEqual(bindingClassDeclarations({ cssClasses: [...lists[0], ...lists[1]] }));
    }
    expect(bindingClassDeclarations({ cssClasses: [card, relabelled] }).map((choice) => choice.label)).toEqual(["Panel with a band"]);
  });

  it("reads an explicitly empty types list (or one of blanks) as no component, and an absent one as any", () => {
    const binding = { cssClasses: [{ name: "none-empty", types: [] }, { name: "none-blank", types: [" ", ""] }, { name: "any" }] };
    expect(bindingClassChoices(binding, { type: "panel" }).map((choice) => choice.name)).toEqual(["any"]);
    expect(bindingClassChoices(binding).map((choice) => choice.name)).toEqual(["any"]);
  });
});

describe("the class check's vocabulary beside the shared panel looks", () => {
  const def = (type: string, extra: Record<string, unknown> = {}): ComponentDefinition => ({ type, version: "1.0.0", ...extra }) as unknown as ComponentDefinition;
  const controller = (binding?: LiveBinding) =>
    new BuilderController({
      componentTypes: [{ type: "text", label: "Text" }],
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: {} }] } },
      componentDefinitions: [def("form", { children: { slots: [{ id: "content", multiple: true }] } }), def("text")],
      ...(binding ? { binding } : {})
    });
  const warning = (ctrl: BuilderController, value: string): string | undefined => {
    ctrl.select("name");
    ctrl.setDraftProperty("name", "cssClass", value);
    return ctrl.cssClassWarning;
  };

  it("is none for a binding that declares only the shared looks: the GC Design System's raises no new warning", () => {
    const looksOnly = { ...createDatumBinding(), id: "looks-only", cssClasses: PANEL_LOOK_CLASSES } as LiveBinding;
    expect(bindingClassVocabulary(looksOnly)).toEqual([]);
    const ctrl = controller(looksOnly);
    expect(ctrl.cssClassNames()).toEqual([]);
    expect(warning(ctrl, "page-class panel-card")).toBeUndefined();
  });

  it("is the same whether Datum is chosen as an object or is the default", () => {
    const asObject = controller(createDatumBinding());
    const asDefault = controller();
    expect(asObject.cssClassNames()).toEqual([]);
    expect(asDefault.cssClassNames()).toEqual(asObject.cssClassNames());
    expect(warning(asObject, "page-class")).toBeUndefined();
    expect(warning(asDefault, "page-class")).toBeUndefined();
    // A host that adds a class of its own gives Datum a vocabulary, the looks accepted with it.
    const own = controller(createDatumBinding({ cssClasses: ["highlight"] }));
    expect(own.cssClassNames()).toEqual(["panel-plain", "panel-outlined", "panel-shaded", "panel-card", "highlight"]);
    expect(warning(own, "highlight panel-shaded")).toBeUndefined();
    expect(warning(own, "page-class")).toBe("\"page-class\" is not one of the binding's classes.");
  });

  it("keeps a binding's own vocabulary, with the looks accepted in addition", () => {
    const quebec = { ...createDatumBinding(), id: "quebec-like", cssClasses: ["qc-size-xs", "qc-compact"] } as LiveBinding;
    const ctrl = controller(quebec);
    expect(ctrl.cssClassNames()).toEqual(["qc-size-xs", "qc-compact", "panel-plain", "panel-outlined", "panel-shaded", "panel-card"]);
    expect(warning(ctrl, "qc-compact panel-outlined")).toBeUndefined();
    expect(warning(ctrl, "page-class")).toBe("\"page-class\" is not one of the binding's classes.");
  });
});

describe("the Style tab's words and last-wins choice", () => {
  const choices = bindingClassChoices({ cssClasses: PANEL_LOOK_CLASSES }, { type: "panel" });

  it("words the four shared looks through the builder's text tables, so a host's translation reaches the radios", () => {
    const html = styleOptionsHtml(
      { choices, active: [] },
      {
        locale: "fr",
        catalog: {
          fr: {
            "inspector.styleGroup.panelLook": "Apparence",
            "inspector.styleLook.plain": "Simple",
            "inspector.styleLook.cardHelp": "Une bordure, un bandeau et une surface."
          }
        }
      }
    );
    expect(html).toContain("<legend>Apparence</legend>");
    expect(html).toContain("<span>Simple</span>");
    expect(html).toContain("Une bordure, un bandeau et une surface.");
    // Untranslated words stay the English of the table.
    expect(html).toContain("<span>Outlined</span>");
    expect(styleOptionsHtml({ choices, active: [] })).toContain("<span>Plain</span>");
  });

  it("words a look the binding relabelled, and any other class, as the binding declares it", () => {
    const relabelled = bindingClassChoices(
      { cssClasses: [{ name: "panel-plain", label: "Bare", description: "Nothing around it.", types: ["panel"], group: PANEL_LOOK_GROUP }, ...PANEL_LOOK_CLASSES.slice(1), { name: "x-width", label: "Wide", description: "Full width." }] },
      { type: "panel" }
    );
    const html = styleOptionsHtml({ choices: relabelled, active: [] }, { locale: "fr", catalog: { fr: { "inspector.styleLook.plain": "Simple" } } });
    expect(html).toContain("<span>Bare</span>");
    expect(html).toContain("Nothing around it.");
    expect(html).not.toContain("Simple");
    expect(html).toContain("<span>Wide</span>");
    expect(html).toContain("Full width.");
  });

  it("heads a group of the binding's own with its groupLabel, else Choose one", () => {
    const own = bindingClassChoices(
      {
        cssClasses: [
          { name: "x-narrow", label: "Narrow", group: "x-width", groupLabel: "Width" },
          { name: "x-wide", label: "Wide", group: "x-width" },
          { name: "y-a", group: "y-set" },
          { name: "y-b", group: "y-set" }
        ]
      }
    );
    const html = styleOptionsHtml({ choices: own, active: [] });
    expect(html).toContain('<fieldset class="style-option-group" data-style-group="x-width"><legend>Width</legend>');
    expect(html).toContain('<fieldset class="style-option-group" data-style-group="y-set"><legend>Choose one</legend>');
  });

  it("checks the last active class of a group when a hand-written list holds two", () => {
    const html = styleOptionsHtml({ choices, active: ["panel-shaded", "page-class", "panel-card"] });
    expect(html).toMatch(/data-style-option="panel-card" checked/);
    expect(html).not.toMatch(/data-style-option="panel-shaded" checked/);
    const reversed = styleOptionsHtml({ choices, active: ["panel-card", "panel-shaded"] });
    expect(reversed).toMatch(/data-style-option="panel-shaded" checked/);
    expect(reversed).not.toMatch(/data-style-option="panel-card" checked/);
  });
});
