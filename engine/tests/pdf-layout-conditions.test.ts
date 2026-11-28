import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  PDF_LAYOUT_CONDITION_RULES,
  PDF_TEMPLATE_ROOT_TYPE,
  followRenameInLayoutTree,
  pdfConditionFieldOptions,
  pdfLayoutConditionFindings,
  pdfLayoutOrderInWords,
  pdfLayoutRuleDescriptors,
  pdfLayoutRulesNote,
  renamePdfLayoutConditions,
  withPdfLayoutCondition,
  type PdfLayoutConditionContext,
  type PdfLayoutFindingCode
} from "../form-engine/builder/pdf-designer/layout-conditions.js";
import { conditionInWords } from "../form-engine/builder/property-editor/condition-words.js";
import type { Expression, RuleSource } from "../form-engine/core/expressions/expression.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  readPdfLayoutCondition,
  validatePdfLayout,
  type PdfConfiguration,
  type PdfGeneratedLayout,
  type PdfTemplateLayout
} from "../form-engine/core/schema/pdf-layout.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { PDF_TEMPLATE_COMPONENT_TYPE } from "../form-engine/render/pdf/pdf-template-components.js";

/**
 * Authoring a PDF layout's condition, under Node: the Rules tab on a
 * layout's root only, the field box's suggestions ("Label (id)", answers outside repeating
 * sections), the advisory findings — one fixture raises each code once — the order in words,
 * the Rules tab's line about the layout's place, and a form rename followed into `when`.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake" },
  children: {
    content: [
      { id: "province", type: "select", configuration: { label: "Province" } },
      { id: "largePrint", type: "checkbox", configuration: { label: "Large print" } },
      { id: "notes", type: "text", configuration: {} },
      { id: "intro", type: "html", configuration: { html: "<p>Hello</p>" } },
      { id: "send", type: "button", configuration: { label: "Send" } },
      {
        id: "details",
        type: "panel",
        configuration: { label: "Details" },
        children: { content: [{ id: "email", type: "text", configuration: { label: "Email" } }] }
      },
      {
        // Data-scoping: its answers nest under its key, but are read by their own ids.
        id: "mailing",
        type: "container",
        configuration: { label: "Mailing address" },
        children: { content: [{ id: "city", type: "text", configuration: { label: "City" } }] }
      },
      {
        id: "applicants",
        type: "panel",
        configuration: { label: "Applicants" },
        collection: {},
        children: { content: [{ id: "applicantName", type: "text", configuration: { label: "Applicant name" } }] }
      }
    ]
  }
};

const CONTEXT: PdfLayoutConditionContext = { formRoot: FORM, locale: "en" };

const QUEBEC = 'province = "QC"';
const LARGE = "largePrint";

function generated(id: string, name: string, when?: unknown): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: {
      id: "document",
      type: PDF_DOCUMENT_COMPONENT_TYPE,
      configuration: {},
      children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "province" } }], header: [], footer: [] }
    },
    ...(when !== undefined ? { when: when as RuleSource } : {})
  };
}

function template(id: string, name: string, storage: string, when?: RuleSource): PdfTemplateLayout {
  return {
    id,
    kind: "template",
    name,
    template: storage === "base64" ? { storage, name: `${id}.pdf`, type: "application/pdf", size: 4, data: "JVBERg==" } : { storage, name: `${id}.pdf`, type: "application/pdf", size: 4, ref: `/${id}.pdf` },
    fields: [{ pdfField: "Province", source: { kind: "component", componentId: "province" } }],
    ...(when !== undefined ? { when } : {})
  };
}

describe("the Rules tab on a layout", () => {
  it("spells a populated form's root type the way the designer's component table does (the shell cannot import that table)", () => {
    expect(PDF_TEMPLATE_ROOT_TYPE).toBe(PDF_TEMPLATE_COMPONENT_TYPE);
  });

  it("offers the condition on a layout's root only — a custom layout's document, a populated form's template", () => {
    expect(pdfLayoutRuleDescriptors("pdf-document")).toBe(PDF_LAYOUT_CONDITION_RULES);
    expect(pdfLayoutRuleDescriptors("pdf-template")).toBe(PDF_LAYOUT_CONDITION_RULES);
    expect(PDF_LAYOUT_CONDITION_RULES).toEqual([
      expect.objectContaining({ key: "when", label: "Print this layout when", kind: "condition", target: { propertyPath: "when" } })
    ]);
    expect(PDF_LAYOUT_CONDITION_RULES[0]!.description).toContain("whose condition holds; otherwise the default prints");
    for (const type of ["pdf-field", "pdf-text", "pdf-section", "pdf-table", "pdf-widget", "pdf-area", "form", "text"]) {
      expect(pdfLayoutRuleDescriptors(type)).toEqual([]);
    }
  });

  it("suggests the form's answers outside repeating sections, as Label (id), in the outline's order", () => {
    expect(pdfConditionFieldOptions(CONTEXT)).toEqual([
      { value: "province", label: "Province (province)" },
      { value: "largePrint", label: "Large print (largePrint)" },
      // No label of its own: the id alone, not "notes (notes)".
      { value: "notes", label: "notes" },
      { value: "email", label: "Email (email)" },
      // Its field, not the data-scoping container: the container's own id reads as nothing.
      { value: "city", label: "City (city)" }
    ]);
    // The label in the builder's locale; no static text, button, group, repeating section or entry field.
    const translations = { fr: { components: { province: { label: { text: "Province (fr)", source: sourceHash("Province") } } } } };
    expect(pdfConditionFieldOptions({ ...CONTEXT, locale: "fr", translations })[0]).toEqual({ value: "province", label: "Province (fr) (province)" });
    expect(pdfConditionFieldOptions({ ...CONTEXT, locale: "en", translations })[0]).toEqual({ value: "province", label: "Province (province)" });
    // A host's own valueless leaves stay out too.
    expect(pdfConditionFieldOptions({ ...CONTEXT, isValueless: (node) => node.id === "notes" || node.type === "button" || node.type === "html" }).map((choice) => choice.value)).toEqual([
      "province",
      "largePrint",
      "email",
      "city"
    ]);
  });
});

describe("advisory findings on the layouts' conditions", () => {
  it("raise each code once over one fixture, and nothing without a condition", () => {
    const configuration: PdfConfiguration = {
      layouts: [
        // Reads host., an entry field and no component.
        generated("quebec", "Quebec copy", `${QUEBEC} and (host.role or (applicantName or missing))`),
        generated("broken", "Broken", "province ="),
        template("paper", "Paper form", "url", LARGE),
        // The same condition as "Paper form" before it: never prints by its own condition. And the default.
        generated("standard", "Standard", LARGE)
      ],
      defaultLayoutId: "standard"
    };
    const findings = pdfLayoutConditionFindings(CONTEXT, configuration);
    const codes = findings.map((finding) => finding.code).sort();
    const all: PdfLayoutFindingCode[] = [
      "pdf-layout.condition.entry-field",
      "pdf-layout.condition.invalid",
      "pdf-layout.condition.scope",
      "pdf-layout.condition.shadowed",
      "pdf-layout.condition.template-source",
      "pdf-layout.condition.unknown-field",
      "pdf-layout.default-conditional"
    ];
    expect(codes).toEqual(all);
    const byCode = new Map(findings.map((finding) => [finding.code, finding]));
    expect(byCode.get("pdf-layout.condition.invalid")).toMatchObject({ layoutId: "broken" });
    expect(byCode.get("pdf-layout.condition.invalid")!.message).toContain('"Broken" is not one the engine can evaluate, so it never holds');
    expect(byCode.get("pdf-layout.condition.scope")).toMatchObject({ layoutId: "quebec" });
    expect(byCode.get("pdf-layout.condition.scope")!.message).toContain("reads host.role");
    expect(byCode.get("pdf-layout.condition.entry-field")!.message).toContain("applicantName, which is part of each entry of applicants");
    // Never advice to count the entries: len() of a section is 0 in a layout's condition.
    expect(byCode.get("pdf-layout.condition.entry-field")!.message).toContain(
      "so it always reads as unanswered. A layout's condition cannot read a field of each entry, or count a section's entries, today."
    );
    expect(byCode.get("pdf-layout.condition.entry-field")!.message).not.toContain("len(");
    expect(byCode.get("pdf-layout.condition.unknown-field")!.message).toContain("reads missing, which is not a component of the form");
    expect(byCode.get("pdf-layout.condition.shadowed")).toMatchObject({ layoutId: "standard" });
    expect(byCode.get("pdf-layout.condition.shadowed")!.message).toContain('"Standard" is tried after "Paper form", whose condition is the same, so "Standard" never prints by its own condition.');
    expect(byCode.get("pdf-layout.condition.template-source")).toMatchObject({ layoutId: "paper" });
    expect(byCode.get("pdf-layout.condition.template-source")!.message).toContain("url: paper.pdf");
    expect(byCode.get("pdf-layout.default-conditional")).toMatchObject({ layoutId: "standard" });

    // No declared default: the eighth code, about the form as a whole.
    const undeclared = pdfLayoutConditionFindings(CONTEXT, { layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard")] });
    expect(undeclared).toEqual([expect.objectContaining({ code: "pdf-layout.no-default", message: expect.stringContaining('the first layout, "Quebec copy", prints') })]);
    expect(undeclared[0]!.layoutId).toBeUndefined();

    // A condition that always holds pre-empts every one after it.
    const always = pdfLayoutConditionFindings(CONTEXT, {
      layouts: [generated("always", "Always", "true"), generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard")],
      defaultLayoutId: "standard"
    });
    expect(always).toEqual([expect.objectContaining({ code: "pdf-layout.condition.shadowed", layoutId: "quebec", message: expect.stringContaining('after "Always", whose condition always holds') })]);

    // A copy (Duplicate keeps the condition) is shadowed by its original until edited.
    const copied = pdfLayoutConditionFindings(CONTEXT, {
      layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("quebec-copy", "Quebec copy (copy)", QUEBEC), generated("standard", "Standard")],
      defaultLayoutId: "standard"
    });
    expect(copied).toEqual([expect.objectContaining({ code: "pdf-layout.condition.shadowed", layoutId: "quebec-copy", message: expect.stringContaining("is the same") })]);

    // Counting the entries reads nothing: the section has no key, so len() of it is 0.
    const many = "len(applicants) > 1";
    const counted = pdfLayoutConditionFindings(CONTEXT, { layouts: [generated("many", "Many", many), generated("standard", "Standard")], defaultLayoutId: "standard" });
    expect(counted).toEqual([
      expect.objectContaining({
        code: "pdf-layout.condition.entry-field",
        layoutId: "many",
        message:
          'The condition on "Many" reads applicants, a repeating section, which reads as nothing here: its entries travel one by one, so len(applicants) is 0. A layout\'s condition cannot count a section\'s entries today.'
      })
    ]);
    // One entry's answer by its instance path is a key of its own: nothing to say.
    const first = "`applicants[0].applicantName`";
    expect(pdfLayoutConditionFindings(CONTEXT, { layouts: [generated("first", "First", first), generated("standard", "Standard")], defaultLayoutId: "standard" })).toEqual([]);

    // Inline template bytes, conditions over plain answers and a plain default: nothing to say.
    const clean: PdfConfiguration = { layouts: [template("paper", "Paper", "base64", QUEBEC), generated("standard", "Standard")], defaultLayoutId: "standard" };
    expect(pdfLayoutConditionFindings(CONTEXT, clean)).toEqual([]);
    // Nothing is said about a form with no condition, whatever its templates.
    expect(pdfLayoutConditionFindings(CONTEXT, { layouts: [template("paper", "Paper", "url"), generated("standard", "Standard")] })).toEqual([]);
  });
});

describe("the conditions in words", () => {
  it("says a simple condition the way the Rules tab's editor reads it", () => {
    const labels = (path: string): string | undefined => ({ province: "Province", largePrint: "Large print" })[path];
    expect(conditionInWords(QUEBEC, labels)).toBe("Province equals “QC”");
    expect(conditionInWords(`${QUEBEC} or ${LARGE}`, labels)).toBe("Province equals “QC” or Large print is checked / true");
    expect(conditionInWords("not(other)", labels)).toBe("other is unchecked / false");
    // A shape the sentence cannot word is the printed formula with labels.
    expect(conditionInWords("len(applicants)", labels)).toBe("len(applicants)");
    expect(conditionInWords('province = "QC" and len(applicants) > 1', labels)).toBe('len(applicants) > 1 and Province equals “QC”'.replace("len(applicants) > 1 and Province equals “QC”", 'Province = "QC" and len(applicants) > 1'));
    expect(conditionInWords('province = "QC"', labels)).toBe("Province equals “QC”");
    // One that does not parse, or cannot be evaluated, has no words.
    expect(conditionInWords("x +", labels)).toBeUndefined();
    expect(conditionInWords(7, labels)).toBeUndefined();
  });

  it("says the automatic order for the Form panel, else what prints with no condition", () => {
    const configuration: PdfConfiguration = {
      layouts: [
        generated("standard", "Standard"),
        generated("quebec", "Quebec copy", QUEBEC),
        generated("large", "Large print", "len(applicants)"),
        // A string is a formula: one the parser rejects never holds.
        generated("broken", "Broken", "x +")
      ],
      defaultLayoutId: "standard"
    };
    expect(pdfLayoutOrderInWords(CONTEXT, configuration)).toBe(
      "Chosen by the answers: 1. Quebec copy, when Province equals “QC”. 2. Large print, when len(Applicants). 3. Broken, a condition that never holds. Otherwise: Standard."
    );
    expect(pdfLayoutOrderInWords(CONTEXT, { layouts: [generated("a", "A"), generated("b", "B")], defaultLayoutId: "b" })).toBe(
      "No layout has a condition: a download that names none prints B, the default."
    );
  });

  it("says on the Rules tab where the layout stands: its turn, the default, or asked for by id", () => {
    const configuration: PdfConfiguration = {
      layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard"), generated("large", "Large print", LARGE), generated("office", "Office")],
      defaultLayoutId: "standard"
    };
    const note = (id: string, pdf: PdfConfiguration = configuration): string => pdfLayoutRulesNote(CONTEXT, pdf, id);
    expect(note("quebec")).toContain("by component id — not which journey was taken");
    expect(note("large")).toMatch(/Its condition is tried 2nd of 2; when none holds, Standard prints\.$/);
    expect(note("quebec")).toMatch(/tried 1st of 2;/);
    expect(note("standard")).toMatch(/It has no condition and is the default: it prints when no layout's condition holds\.$/);
    expect(note("office")).toMatch(/With no condition, it prints only when a host asks for it by id; when no condition holds, Standard prints\.$/);
    // A default with a condition of its own still prints when none holds.
    expect(note("quebec", { ...configuration, defaultLayoutId: "quebec" })).toMatch(/tried 1st of 2; when none holds, this layout prints anyway: it is the default\.$/);
    expect(note("office", { layouts: [generated("office", "Office")] })).toMatch(/It is the default: a download that names no layout prints it\.$/);
  });
});

describe("following a form rename, and a draft laid over the catalog", () => {
  it("rewrites every layout's when that names the old id, and nothing else", () => {
    const configuration: PdfConfiguration = {
      layouts: [generated("quebec", "Quebec copy", QUEBEC), template("paper", "Paper", "base64", "province.code"), generated("large", "Large print", LARGE)],
      defaultLayoutId: "large"
    };
    const followed = renamePdfLayoutConditions(configuration, "province", "region");
    expect(followed.renamed).toEqual(["quebec", "paper", "large"]);
    const [quebec, paper, large] = followed.configuration.layouts!;
    expect(quebec!.when).toBe('region = "QC"');
    expect(paper!.when).toBe("region.code");
    // Bindings follow: the template fills from region now, and the generated layouts' fields bind it.
    expect((paper as PdfTemplateLayout).fields[0]!.source).toEqual({ kind: "component", componentId: "region" });
    expect((quebec as PdfGeneratedLayout).root.children!.body![0]!.configuration).toEqual({ componentId: "region" });
    expect((large as PdfGeneratedLayout).root.children!.body![0]!.configuration).toEqual({ componentId: "region" });
    expect(followed.configuration.defaultLayoutId).toBe("large");
    // Nothing named: the configuration itself.
    expect(renamePdfLayoutConditions(configuration, "nobody", "somebody").configuration).toBe(configuration);
    expect(renamePdfLayoutConditions(configuration, "province", "province").renamed).toEqual([]);
  });

  it("follows a rename into an open layout's tree: the committed condition in one undo step, an unsaved one renamed rather than overwritten", () => {
    const controller = new BuilderController({
      initialRoot: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: { name: "Quebec copy", when: QUEBEC }, children: { body: [], header: [], footer: [] } }
    });
    const when = (): unknown => (controller.snapshot().configuration as Record<string, unknown>).when;

    // Nothing named: nothing written, nothing to undo.
    expect(followRenameInLayoutTree(controller, "nobody", "somebody")).toBe(false);
    expect(controller.canUndo()).toBe(false);

    // No draft: the committed condition follows, as one step a later Undo takes back.
    expect(followRenameInLayoutTree(controller, "province", "region")).toBe(true);
    expect(when()).toBe('region = "QC"');
    controller.undo();
    expect(when()).toEqual(QUEBEC);

    // An unsaved condition of the Rules tab's own, beside another drafted edit: both conditions
    // follow, the draft keeps its own, and its other edit stays.
    controller.setDraftProperty("document", "when", "province.code");
    controller.setDraftProperty("document", "name", "Quebec (draft)");
    expect(followRenameInLayoutTree(controller, "province", "region")).toBe(true);
    expect(when()).toBe('region = "QC"');
    expect(controller.draftProperty("document", "when")).toBe("region.code");
    expect(controller.draftProperty("document", "name")).toBe("Quebec (draft)");
    expect(controller.commitDraft("document")).toBe(true);
    expect(when()).toBe("region.code");

    // A draft that only renamed the layout: its condition is the committed one, renamed with it.
    controller.setDraftProperty("document", "name", "Renamed");
    expect(followRenameInLayoutTree(controller, "region", "area")).toBe(true);
    expect(controller.draftProperty("document", "when")).toBe("area.code");
    expect(controller.draftProperty("document", "name")).toBe("Renamed");
    controller.discardDraft("document");

    // An unsaved clearing of the condition stays cleared; the committed one still follows.
    controller.setDraftProperty("document", "when", undefined);
    expect(followRenameInLayoutTree(controller, "area", "zone")).toBe(true);
    expect(when()).toBe("zone.code");
    expect(controller.draftProperty("document", "when")).toBeUndefined();
    expect(controller.hasPendingChanges("document")).toBe(true);
  });

  it("lays a draft's condition over the catalog, and takes one away", () => {
    const configuration: PdfConfiguration = { layouts: [generated("quebec", "Quebec copy", QUEBEC), generated("standard", "Standard")], defaultLayoutId: "standard" };
    expect(withPdfLayoutCondition(configuration, "quebec", QUEBEC)).toBe(configuration);
    expect(withPdfLayoutCondition(configuration, "missing", LARGE)).toBe(configuration);
    expect(withPdfLayoutCondition(configuration, "standard", LARGE).layouts![1]!.when).toEqual(LARGE);
    const cleared = withPdfLayoutCondition(configuration, "quebec", undefined);
    expect("when" in cleared.layouts![0]!).toBe(false);
    expect(withPdfLayoutCondition(configuration, "quebec", null).layouts![0]!.when).toBeUndefined();
    expect(configuration.layouts![0]!.when).toEqual(QUEBEC);
  });
});

describe("a layout's when as a formula", () => {
  const QC: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } };

  it("reads a string, the object form and a compiled copy's tree alike, and keeps what the author wrote when it cannot be read", () => {
    expect(readPdfLayoutCondition({ when: 'province = "QC"' })).toEqual({ evaluable: true, expression: QC });
    expect(readPdfLayoutCondition({ when: { formula: 'province = "QC"', run: "both" } })).toEqual({ evaluable: true, expression: QC });
    expect(readPdfLayoutCondition({ when: { expression: QC } })).toEqual({ evaluable: true, expression: QC });
    expect(readPdfLayoutCondition({ when: QC })).toEqual({ evaluable: true, expression: QC });
    expect(readPdfLayoutCondition({ when: "province = " })).toEqual({ evaluable: false, written: "province = " });
    expect(readPdfLayoutCondition({ when: { formula: "province = " } })).toEqual({ evaluable: false, written: { formula: "province = " } });
    expect(readPdfLayoutCondition({ when: "" })).toEqual({ evaluable: false, written: "" });
    expect(readPdfLayoutCondition({})).toBeUndefined();
    expect(readPdfLayoutCondition({ when: null })).toBeUndefined();
  });

  it("is no schema fault however it is written, a formula string or the object form included", () => {
    const layout = (when: unknown): unknown => ({
      id: "l",
      kind: "generated",
      when,
      root: { id: "d", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [] } }
    });
    for (const when of ['province = "QC"', "not a formula (((", { formula: "x" }, { formula: "x", run: "server" }, undefined, 5]) {
      expect(validatePdfLayout(layout(when))).toEqual([]);
    }
    const template = (expression: unknown): unknown => ({
      id: "t",
      kind: "template",
      template: { storage: "base64", data: "" },
      fields: [{ pdfField: "Name", source: { kind: "expression", expression } }],
      areas: [{ id: "a", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "expression", expression } }]
    });
    for (const expression of ["firstName", { formula: "firstName" }, "firstName +"]) {
      expect(validatePdfLayout(template(expression))).toEqual([]);
    }
  });
});

describe("a form rename followed into a template layout's expression sources", () => {
  it("renames a field's and an area's expression source, in every shape, follows the bindings, and leaves the rest as written", () => {
    const paper: PdfTemplateLayout = {
      ...template("paper", "Paper", "base64"),
      fields: [
        { pdfField: "Province", source: { kind: "component", componentId: "province" } },
        { pdfField: "Code", source: { kind: "path", path: "province.code" } },
        { pdfField: "Upper", source: { kind: "expression", expression: "upper(province.code)" } },
        { pdfField: "Other", source: { kind: "expression", expression: "upper(notes)" } }
      ],
      areas: [
        { name: "Stamp", page: 1, x: 1, y: 1, width: 10, height: 10, kind: "text", source: { kind: "expression", expression: { formula: "`province` = \"QC\"", run: "server" } } }
      ] as unknown as NonNullable<PdfTemplateLayout["areas"]>
    };
    const configuration: PdfConfiguration = { layouts: [paper, generated("large", "Large print", LARGE)] };
    const followed = renamePdfLayoutConditions(configuration, "province", "region");
    expect(followed.renamed).toEqual(["paper", "large"]);
    expect(followed.unparsed).toEqual([]);
    const [renamed, large] = followed.configuration.layouts! as [PdfTemplateLayout, PdfGeneratedLayout];
    expect(renamed.fields.map((field) => field.source)).toEqual([
      { kind: "component", componentId: "region" },
      { kind: "path", path: "region.code" },
      { kind: "expression", expression: "upper(region.code)" },
      { kind: "expression", expression: "upper(notes)" }
    ]);
    expect(renamed.fields[3]).toBe(paper.fields[3]);
    expect(renamed.areas?.[0]?.source).toEqual({ kind: "expression", expression: { formula: 'region = "QC"', run: "server" } });
    expect(renamed.template).toBe(paper.template);
    // The generated layout's field binds the renamed component too.
    expect(large.root.children!.body![0]!.configuration).toEqual({ componentId: "region" });
  });

  it("leaves a formula that does not parse as written and reports it", () => {
    const paper: PdfTemplateLayout = {
      ...template("paper", "Paper", "base64", "province = "),
      fields: [{ pdfField: "Broken", source: { kind: "expression", expression: "upper(province" } }]
    };
    const followed = renamePdfLayoutConditions({ layouts: [paper] }, "province", "region");
    expect(followed.renamed).toEqual([]);
    expect(followed.configuration.layouts![0]).toBe(paper);
    expect(followed.unparsed).toEqual([
      { layoutId: "paper", where: "when", formula: "province = " },
      { layoutId: "paper", where: "fields[0]", formula: "upper(province" }
    ]);
  });
});

describe("a form rename follows without substring traps", () => {
  const cfg: PdfConfiguration = {
    layouts: [
      generated("g1", "G1", 'name = "name" and username = "x" and a2 = 1 and a = 2'),
      generated("g2", "G2", "name and username")
    ]
  };

  it("renames only the exact path in a formula string, quoted strings untouched", () => {
    const out = renamePdfLayoutConditions(cfg, "name", "label2");
    expect((out.configuration.layouts![0] as PdfGeneratedLayout).when).toBe('label2 = "name" and username = "x" and a2 = 1 and a = 2');
    expect((out.configuration.layouts![1] as PdfGeneratedLayout).when).toBe("label2 and username");
  });

  it("renaming a leaves a2 and a quoted a alone", () => {
    const out = renamePdfLayoutConditions({ layouts: [generated("g", "G", 'a = "a" and a2 = 1 and a.b = 3')] }, "a", "z");
    expect((out.configuration.layouts![0] as PdfGeneratedLayout).when).toBe('z = "a" and a2 = 1 and z.b = 3');
  });

  it("an unparseable formula spelling the old id is reported, never silently stale", () => {
    const out = renamePdfLayoutConditions({ layouts: [generated("g", "G", "name = ")] }, "name", "z");
    expect(out.unparsed.length).toBe(1);
  });

  it("ruleTargets [when] holds a Save back on an unparseable condition and survives a later setOptions", () => {
    const root: ComponentNode = { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } };
    const c = new BuilderController();
    c.setOptions({ initialRoot: root, ruleTargets: ["when"] });
    c.setOptions({ localization: undefined, notes: () => [] });
    c.setDraftProperty("document", "when", "name = ");
    expect(c.commitDraft("document")).toBe(false);
    c.setDraftProperty("document", "when", "a = 1");
    expect(c.commitDraft("document")).toBe(true);
  });
});

describe("a form rename follows into the PDF bindings", () => {
  const field = (id: string, componentId: string): ComponentNode => ({ id, type: "pdf-field", configuration: { componentId } });
  const layoutWith = (body: ComponentNode[]): PdfGeneratedLayout => ({
    id: "g",
    kind: "generated",
    name: "G",
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body, header: [], footer: [] } }
  });

  it("rewrites pdf-field componentId and the collectionPath of a repeat and a table, exact names only", () => {
    const layout = layoutWith([
      field("f1", "name"),
      field("f2", "name2"),
      { id: "r", type: "pdf-repeat", configuration: { collectionPath: "name" }, children: { row: [field("f3", "name")] } },
      { id: "t", type: "pdf-table", configuration: { rows: 1, columns: 1, collectionPath: "name" } }
    ]);
    const out = renamePdfLayoutConditions({ layouts: [layout] }, "name", "label");
    expect(out.renamed).toEqual(["g"]);
    const body = (out.configuration.layouts![0] as PdfGeneratedLayout).root.children!.body!;
    expect(body[0]!.configuration).toEqual({ componentId: "label" });
    expect(body[1]!.configuration).toEqual({ componentId: "name2" });
    expect(body[2]!.configuration).toEqual({ collectionPath: "label" });
    expect(body[2]!.children!.row![0]!.configuration).toEqual({ componentId: "label" });
    expect(body[3]!.configuration).toMatchObject({ collectionPath: "label" });
    // The input is not mutated.
    expect((layout.root.children!.body![0]!.configuration as { componentId: string }).componentId).toBe("name");
  });

  it("rewrites a template layout's component and path sources, leaving others", () => {
    const template: PdfTemplateLayout = {
      id: "paper",
      kind: "template",
      template: { storage: "url", name: "p.pdf", type: "application/pdf", size: 1, ref: "/p.pdf" },
      fields: [
        { pdfField: "A", source: { kind: "component", componentId: "name" } },
        { pdfField: "B", source: { kind: "path", path: "name.first" } },
        { pdfField: "C", source: { kind: "component", componentId: "other" } }
      ]
    };
    const out = renamePdfLayoutConditions({ layouts: [template] }, "name", "label");
    const fields = (out.configuration.layouts![0] as PdfTemplateLayout).fields;
    expect(fields.map((f) => f.source)).toEqual([
      { kind: "component", componentId: "label" },
      { kind: "path", path: "label.first" },
      { kind: "component", componentId: "other" }
    ]);
  });

  it("follows in an open layout tree in one undo step per node, and undo restores the old binding", () => {
    const layout = layoutWith([field("f1", "name")]);
    const c = new BuilderController();
    c.setOptions({ initialRoot: layout.root, ruleTargets: ["when"] });
    const before = JSON.stringify(c.snapshot());
    expect(followRenameInLayoutTree(c, "name", "label")).toBe(true);
    expect(JSON.stringify(c.snapshot())).toContain('"componentId":"label"');
    c.undo();
    expect(JSON.stringify(c.snapshot())).toBe(before);
  });
});

// `withPluginCallsMasked` (spliced into the PDF program) walks the
// left spine of a chain with a list, so a 20,000-term `when` that calls a plugin function is read.
describe("a 20,000-term layout condition", () => {
  it("is read, with and without plugin functions registered", () => {
    let when = "isMember(province)";
    const parts = [when];
    for (let at = 1; at < 20_000; at += 1) {
      parts.push(`province = "p${at % 7}"`);
    }
    when = parts.join(" or ");
    const withPlugin = readPdfLayoutCondition({ when }, ["isMember"]);
    expect(withPlugin?.evaluable).toBe(true);
    const without = readPdfLayoutCondition({ when: parts.slice(1).join(" or ") });
    expect(without?.evaluable).toBe(true);
  });

  it("a built tree of 20,000 terms with a plugin call at its foot is evaluable; a non-evaluable plugin argument still is not", () => {
    let tree: Expression = { kind: "call", name: "isMember", args: [{ kind: "path", path: "province" }] };
    for (let at = 0; at < 20_000; at += 1) {
      tree = { kind: "logical", operator: "and", left: tree, right: { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "ON" } } };
    }
    expect(readPdfLayoutCondition({ when: tree }, ["isMember"])?.evaluable).toBe(true);
    const bad = { kind: "logical", operator: "and", left: { kind: "call", name: "isMember", args: [{ kind: "call", name: "noSuchBuiltin", args: [] }] }, right: { kind: "literal", value: true } } as unknown as Expression;
    expect(readPdfLayoutCondition({ when: bad }, ["isMember"])?.evaluable).toBe(false);
  });
});
