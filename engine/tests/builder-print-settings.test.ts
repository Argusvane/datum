// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { languagesRows, languagesGroupsOf } from "../form-engine/builder/languages/languages-model.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import { addressOf, sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { readPrintConfiguration } from "../form-engine/core/schema/print.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { buildPrintDocument, buildPrintModel } from "../form-engine/render/print/index.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import { inspectorSectionRowsHtml } from "../form-engine/builder/web-component/builder-shared.js";
import { agentBuilder } from "./fixtures/agent-builder.js";

/**
 * The form's print settings are written through the controller by the Print workspace (no
 * inspector field declares them), a component's "On paper" choices by the inspector; a
 * component set to paper only that holds an answer is a Problem; the four slot texts are
 * authored form text that the Languages workspace lists and a translated slot prints.
 */

const def = (type: string, extra: Partial<ComponentDefinition> = {}): ComponentDefinition =>
  ({ type, version: "1.0.0", capabilities: standardFieldCapabilities(), ...extra }) as unknown as ComponentDefinition;

const html: ComponentNode = { id: "intro", type: "html", configuration: { tag: "div", content: "<p>Hi</p>" } };
const name: ComponentNode = { id: "name", type: "text", configuration: { label: "Name" } };

function controller(root?: Partial<ComponentNode>, localization?: LocalizationConfiguration): BuilderController {
  return new BuilderController({
    ...(localization ? { localization } : {}),
    componentTypes: [
      { type: "text", label: "Text" },
      { type: "html", label: "Html" }
    ],
    initialRoot: {
      id: "root",
      type: "form",
      configuration: { title: "Intake" },
      children: { content: [structuredClone(html), structuredClone(name), { id: "about", type: "panel", configuration: { label: "About" }, children: { content: [structuredClone(html)].map((node) => ({ ...node, id: "note" })) } }] },
      ...root
    },
    componentDefinitions: [
      def("form", { capabilities: [], children: { slots: [{ id: "content", multiple: true }] } }),
      def("text"),
      def("html"),
      def("panel", { children: { slots: [{ id: "content", multiple: true }] } })
    ]
  });
}

describe("the form root's print settings", () => {
  it("takes a write to every print path without an inspector field naming it, and undoes each", () => {
    const ctrl = controller();
    const root = ctrl.rootId();
    expect(ctrl.inspectorModel(root)?.sections.flatMap((section) => section.fields).some((field) => field.propertyPath.startsWith("print."))).toBe(false);
    const writes: Array<[string, unknown]> = [
      ["print.renditions", ["answers", "blank"]],
      ["print.defaultRendition", "blank"],
      ["print.titleOnFirstPage", false],
      ["print.scale", 0.8],
      ["print.header.start", "{{title}}"],
      ["print.header.end", "{{date}}"],
      ["print.footer.start", ""],
      ["print.footer.end", "Page {{page}} of {{pages}}"],
      ["print.journeyPageBreaks", true]
    ];
    for (const [path, value] of writes) {
      ctrl.setProperty(root, path, value);
      expect(ctrl.getProperty(root, path)).toEqual(value);
    }
    expect(readPrintConfiguration(ctrl.snapshot().configuration)).toMatchObject({
      renditions: ["answers", "blank"],
      defaultRendition: "blank",
      titleOnFirstPage: false,
      scale: 0.8,
      journeyPageBreaks: true,
      header: { start: "{{title}}", end: "{{date}}" },
      footer: { start: "", end: "Page {{page}} of {{pages}}" }
    });
    for (const [path] of [...writes].reverse()) {
      expect(ctrl.getProperty(root, path)).not.toBeUndefined();
      ctrl.undo();
      expect(ctrl.getProperty(root, path)).toBeUndefined();
    }
  });

  it("writes several at once as one undo step", () => {
    const ctrl = controller();
    const root = ctrl.rootId();
    ctrl.setProperties([
      { componentId: root, propertyPath: "print.scale", value: 0.9 },
      { componentId: root, propertyPath: "print.header.end", value: "{{date}}" }
    ]);
    expect(ctrl.getProperty(root, "print.header.end")).toBe("{{date}}");
    ctrl.undo();
    expect(ctrl.getProperty(root, "print.scale")).toBeUndefined();
    expect(ctrl.getProperty(root, "print.header.end")).toBeUndefined();
  });
});

describe("a component's On paper choices", () => {
  it("are written with setProperty and read back by the print reader", () => {
    const ctrl = controller();
    ctrl.setProperty("name", "print.breakBefore", true);
    ctrl.setProperty("about", "print.keepTogether", true);
    ctrl.setProperty("intro", "print.on", "paper");
    expect(ctrl.getProperty("name", "print.breakBefore")).toBe(true);
    expect(ctrl.getProperty("about", "print.keepTogether")).toBe(true);
    expect(ctrl.getProperty("intro", "print.on")).toBe("paper");
  });

  it("the controller's inspector model offers Keep together to the panel only, and paper only to the static content only", () => {
    const ctrl = controller();
    const paths = (id: string): string[] => ctrl.inspectorModel(id)?.sections.find((section) => section.id === "print")?.fields.map((field) => field.propertyPath) ?? [];
    expect(paths("name")).not.toContain("print.keepTogether");
    expect(paths("intro")).not.toContain("print.keepTogether");
    const paperChoice = (id: string) =>
      ctrl.inspectorModel(id)?.sections.find((section) => section.id === "print")?.fields.find((field) => field.propertyPath === "print.on")?.choices.find((choice) => choice.value === "paper");
    expect(paperChoice("name")?.disabled).toBe(true);
    expect(paperChoice("intro")?.disabled).toBeUndefined();
    expect(paperChoice("about")?.disabled).toBeUndefined();
  });
});

describe("the On paper rows outside the inspector", () => {
  it("draw the group's own boxes for a component, with the Problem under its box", () => {
    const ctrl = controller();
    ctrl.setProperty("name", "print.on", "paper");
    const section = ctrl.inspectorModel("name")!.sections.find((entry) => entry.id === "print")!;
    const markup = inspectorSectionRowsHtml(section, { problems: ctrl.problemsOf("name") });
    const host = document.createElement("div");
    host.innerHTML = markup;
    expect([...host.querySelectorAll("[data-prop]")].map((box) => box.getAttribute("data-prop"))).toEqual(["print.on", "print.breakBefore", "print.show", "print.note"]);
    const shown = host.querySelector<HTMLSelectElement>('select[data-prop="print.on"]')!;
    expect(shown.value).toBe("paper");
    expect(shown.getAttribute("aria-invalid")).toBe("true");
    expect(shown.querySelector('option[value="paper"]')?.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("still shown on screen");
  });
});

describe("the paper-only Problem", () => {
  it("appears for an answered component stored as paper only, and clears when the value changes", () => {
    const ctrl = controller();
    ctrl.setProperty("name", "print.on", "paper");
    const problems = ctrl.problemsOf("name");
    expect(problems.map((problem) => problem.target)).toEqual(["print.on"]);
    expect(problems[0]?.message).toContain("still shown on screen");
    // Static content takes paper only: no problem.
    ctrl.setProperty("intro", "print.on", "paper");
    expect(ctrl.problemsOf("intro")).toEqual([]);
    // The draft is read first, so choosing another value clears it before Save.
    ctrl.setDraftProperty("name", "print.on", "screen");
    expect(ctrl.problemsOf("name")).toEqual([]);
    ctrl.discardDraft("name");
    expect(ctrl.problemsOf("name").map((problem) => problem.target)).toEqual(["print.on"]);
    ctrl.setProperty("name", "print.on", "screen");
    expect(ctrl.problemsOf("name")).toEqual([]);
  });

  it("follows a container that comes to hold an answer", () => {
    const ctrl = controller();
    ctrl.setProperty("about", "print.on", "paper");
    expect(ctrl.problemsOf("about")).toEqual([]);
    ctrl.moveTo("name", "about", 0, "content");
    expect(ctrl.problemsOf("about").map((problem) => problem.target)).toEqual(["print.on"]);
  });

  it("is a problem the panel leads to, not one that stops a commit of an unrelated edit", () => {
    const ctrl = controller();
    ctrl.setProperty("name", "print.on", "paper");
    ctrl.setDraftProperty("name", "label", "Full name");
    expect(ctrl.problemsOf("name").map((problem) => problem.target)).toEqual(["print.on"]);
    expect(ctrl.commitDraft("name")).toBe(true);
    expect(ctrl.getProperty("name", "label")).toBe("Full name");
  });
});

describe("the slot texts in Languages", () => {
  const localization: LocalizationConfiguration = { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] };
  const withSlots = (): BuilderController =>
    controller(
      {
        configuration: {
          title: "Intake",
          print: { header: { start: "{{title}} — draft", end: "{{date}}" }, footer: { start: "", end: "Page {{page}}" } }
        }
      },
      localization
    );

  it("lists the slots the author wrote, each as form text under print.<band>.<slot>", () => {
    const slots = withSlots().translatableTexts().filter((text) => /^print\.(header|footer)\./.test(text.propertyPath));
    expect(slots.map((text) => [text.propertyPath, text.default])).toEqual([
      ["print.header.start", "{{title}} — draft"],
      ["print.header.end", "{{date}}"],
      ["print.footer.end", "Page {{page}}"]
    ]);
    expect(slots.map((text) => text.address)).toEqual([addressOf.printSlot("header", "start"), addressOf.printSlot("header", "end"), addressOf.printSlot("footer", "end")]);
    expect(slots.every((text) => text.componentId === "root")).toBe(true);
    // A slot left to its default has nothing of the author's to translate.
    expect(controller().translatableTexts().some((text) => /^print\.(header|footer)\./.test(text.propertyPath))).toBe(false);
  });

  it("groups them under Print in the Languages model", () => {
    const ctrl = withSlots();
    const rows = languagesRows({ texts: ctrl.translatableTexts(), translations: ctrl.translations(), localization });
    const printRows = rows.filter((row) => row.groupId === "print");
    expect(printRows.map((row) => row.propertyPath)).toEqual(["print.header.start", "print.header.end", "print.footer.end"]);
    expect(printRows.every((row) => row.inForm && Object.keys(row.cells).includes("fr"))).toBe(true);
    expect(languagesGroupsOf(rows).find((group) => group.id === "print")).toMatchObject({ label: "Print", count: 3 });
    expect(rows.filter((row) => row.groupId === "fields").some((row) => row.propertyPath?.startsWith("print."))).toBe(false);
  });

  it("stores a typed translation at the three-segment form address", () => {
    const ctrl = withSlots();
    ctrl.setTranslations([{ locale: "fr", address: addressOf.printSlot("header", "end"), text: "{{date}} (version française)" }]);
    const stored = ctrl.translations() as unknown as { fr?: { form?: { print?: { header?: { end?: { text?: string } } } } } };
    expect(stored.fr?.form?.print?.header?.end?.text).toBe("{{date}} (version française)");
  });
});

describe("a translated slot prints in its locale", () => {
  function runtimeOf(form: FormDefinition): FormRuntime {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  }

  it("shows the French header end in the French page CSS, its placeholders resolved", async () => {
    const source = "Printed {{date}} for {{title}}";
    const translations = {
      fr: {
        form: {
          title: { text: "Demande", source: sourceHash("Intake") },
          print: { header: { end: { text: "Imprimé le {{date}} pour {{title}}", source: sourceHash(source) } } }
        }
      }
    } as unknown as FormTranslations;
    const form = {
      id: "intake",
      version: "1",
      schemaVersion: "1",
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
      translations,
      root: { id: "root", type: "form", configuration: { title: "Intake", print: { header: { end: source } } }, children: { content: [structuredClone(name)] } }
    } as unknown as FormDefinition;

    const english = buildPrintDocument(await buildPrintModel(runtimeOf(form), { render: { journeyKit: EagerJourneyRenderKit } }));
    expect(english).toMatch(/@top-right \{ content: "Printed [^"]* for Intake";/);

    const runtime = runtimeOf(form);
    runtime.setLocale("fr");
    const french = buildPrintDocument(await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } }));
    expect(french).toMatch(/@top-right \{ content: "Imprimé le [^"]* pour Demande";/);
    expect(french).not.toContain("Printed");
  });
});

describe("the agent writes the form's print settings", () => {
  const configOf = (builder: ReturnType<typeof agentBuilder>): Record<string, any> => (builder.controller.snapshot().configuration ?? {}) as Record<string, any>;
  const set = (builder: ReturnType<typeof agentBuilder>, propertyPath: string, value: unknown): Promise<any> =>
    builder.execute("set_properties", { edits: [{ componentId: builder.controller.rootId(), propertyPath, value }] });

  it("accepts every print path without an unknown-property warning, coercing a switch and a number", async () => {
    const builder = agentBuilder();
    for (const [path, value] of [
      ["print.renditions", ["answers", "filled"]],
      ["print.defaultRendition", "filled"],
      ["print.titleOnFirstPage", "false"],
      ["print.scale", "0.9"],
      ["print.header.start", "{{title}}"],
      ["print.header.end", "{{date}}"],
      ["print.footer.start", ""],
      ["print.footer.end", "{{page}}"],
      ["print.journeyPageBreaks", true]
    ] as Array<[string, unknown]>) {
      const result = await set(builder, path, value);
      expect(result.ok, `${path}: ${JSON.stringify(result)}`).toBe(true);
      expect((result.warnings ?? []).filter((warning: string) => warning.startsWith("unknown-property")), path).toEqual([]);
    }
    expect(configOf(builder).print).toMatchObject({
      renditions: ["answers", "filled"],
      defaultRendition: "filled",
      titleOnFirstPage: false,
      scale: 0.9,
      header: { start: "{{title}}", end: "{{date}}" },
      footer: { start: "", end: "{{page}}" },
      journeyPageBreaks: true
    });
    // One undo step per call, and the whole object can be cleared.
    expect((await set(builder, "print", null)).ok).toBe(true);
    expect(configOf(builder).print).toBeUndefined();
  });

  it("refuses a rendition the form cannot print and a header written as a number", async () => {
    const builder = agentBuilder();
    const before = JSON.stringify(configOf(builder));
    for (const [path, value] of [
      ["print.renditions", ["answers", "nope"]],
      ["print.renditions", []],
      ["print.renditions", "answers"],
      ["print.defaultRendition", "nope"],
      ["print.header.start", 5],
      ["print.scale", "wide"],
      ["print.header", "x"]
    ] as Array<[string, unknown]>) {
      const result = await set(builder, path, value);
      expect(result.ok, path).toBe(false);
      expect(result.code, path).toBe("bad-input");
    }
    expect(JSON.stringify(configOf(builder))).toBe(before);
  });

  it("takes a component's print.on and print.breakBefore as known inspector properties", async () => {
    const builder = agentBuilder();
    const result = await builder.execute("set_properties", {
      edits: [
        { componentId: "message", propertyPath: "print.breakBefore", value: true },
        { componentId: "message", propertyPath: "print.on", value: "screen" }
      ]
    });
    expect(result.ok).toBe(true);
    expect((result.warnings ?? []).filter((warning: string) => warning.startsWith("unknown-property"))).toEqual([]);
  });

  it("lists the form's print settings when it reads the root, with what each does while unset", async () => {
    const builder = agentBuilder();
    const read = async (): Promise<Array<Record<string, unknown>>> => {
      const result: any = await builder.execute("get_component", { componentId: builder.controller.rootId() });
      expect(result.ok).toBe(true);
      return (result.component?.properties ?? result.properties ?? []).filter((property: Record<string, unknown>) => property.section === "print");
    };
    const unset = await read();
    expect(unset.map((property) => property.propertyPath)).toEqual([
      "print.renditions",
      "print.defaultRendition",
      "print.titleOnFirstPage",
      "print.scale",
      "print.header.start",
      "print.header.end",
      "print.footer.start",
      "print.footer.end",
      "print.journeyPageBreaks"
    ]);
    expect(unset.find((property) => property.propertyPath === "print.titleOnFirstPage")).toMatchObject({ kind: "checkbox", value: true });
    expect(unset.find((property) => property.propertyPath === "print.header.start")).toMatchObject({ kind: "localized-text", value: "{{title}}" });
    expect((await set(builder, "print.scale", 0.5)).ok).toBe(true);
    expect((await read()).find((property) => property.propertyPath === "print.scale")).toMatchObject({ value: 0.5 });
  });
});

describe("a slot emptied or put back to its default", () => {
  const localization: LocalizationConfiguration = { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] };
  const form = (print: Record<string, unknown>, translations: FormTranslations): FormDefinition =>
    ({
      id: "intake",
      version: "1",
      schemaVersion: "1",
      localization,
      translations,
      root: { id: "root", type: "form", configuration: { title: "Intake", print }, children: { content: [structuredClone(name)] } }
    }) as unknown as FormDefinition;
  const stale = (): FormTranslations =>
    ({
      fr: {
        form: {
          title: { text: "Demande", source: sourceHash("Intake") },
          print: {
            header: { start: { text: "Brouillon {{title}}", source: sourceHash("Draft {{title}}") } },
            footer: { end: { text: "Feuille {{page}}", source: sourceHash("Sheet {{page}}") } }
          }
        }
      }
    }) as unknown as FormTranslations;
  async function frenchCss(definition: FormDefinition): Promise<string> {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    runtime.setLocale("fr");
    return buildPrintDocument(await buildPrintModel(runtime, { render: { journeyKit: EagerJourneyRenderKit } }));
  }

  it("prints no stored translation: an emptied slot draws nothing, a reset one its default", async () => {
    // Written, the slots print their French.
    const written = await frenchCss(form({ header: { start: "Draft {{title}}" }, footer: { end: "Sheet {{page}}" } }, stale()));
    expect(written).toMatch(/@top-left \{ content: "Brouillon Demande";/);
    expect(written).toMatch(/@bottom-right \{ content: "Feuille " counter\(page\)/);
    // Emptied: nothing at all, whatever the French says.
    const emptied = await frenchCss(form({ header: { start: "" }, footer: { end: "" } }, stale()));
    expect(emptied).not.toContain("@top-left");
    expect(emptied).not.toContain("@bottom-right");
    expect(emptied).not.toContain("Brouillon");
    expect(emptied).not.toContain("Feuille");
    // Reset (the key gone): the default, the title in its French and the engine's own page number line.
    const reset = await frenchCss(form({}, stale()));
    expect(reset).toMatch(/@top-left \{ content: "Demande";/);
    expect(reset).toMatch(/@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\)/);
    expect(reset).not.toContain("Brouillon");
    expect(reset).not.toContain("Feuille");
  });

  it("takes the slot's translations with it in the same undo step, put back by Undo", () => {
    const ctrl = controller({ configuration: { title: "Intake", print: { header: { start: "Draft {{title}}", end: "Ref {{receipt.reference}}" } } } }, localization);
    const root = ctrl.rootId();
    ctrl.setTranslations([
      { locale: "fr", address: addressOf.printSlot("header", "start"), text: "Brouillon {{title}}" },
      { locale: "fr", address: addressOf.printSlot("header", "end"), text: "Réf {{receipt.reference}}" }
    ]);
    type Stored = { fr?: { form?: { print?: { header?: { start?: { text?: string }; end?: { text?: string } } } } } } | undefined;
    const stored = (): Stored => ctrl.translations() as unknown as Stored;
    expect(stored()?.fr?.form?.print?.header?.start?.text).toBe("Brouillon {{title}}");
    // Reset: the key goes, and so does its French.
    ctrl.setProperties([{ componentId: root, propertyPath: "print.header.start", value: undefined }]);
    expect(stored()?.fr?.form?.print?.header?.start).toBeUndefined();
    expect(stored()?.fr?.form?.print?.header?.end?.text).toBe("Réf {{receipt.reference}}");
    ctrl.undo();
    expect(ctrl.getProperty(root, "print.header.start")).toBe("Draft {{title}}");
    expect(stored()?.fr?.form?.print?.header?.start?.text).toBe("Brouillon {{title}}");
    // Emptied: the same.
    ctrl.setProperty(root, "print.header.end", "");
    expect(stored()?.fr?.form?.print?.header?.end).toBeUndefined();
    ctrl.undo();
    expect(stored()?.fr?.form?.print?.header?.end?.text).toBe("Réf {{receipt.reference}}");
    // A change of wording keeps the entry (it goes stale on its own).
    ctrl.setProperty(root, "print.header.end", "Ref. {{receipt.reference}}");
    expect(stored()?.fr?.form?.print?.header?.end?.text).toBe("Réf {{receipt.reference}}");
  });
});

describe("the navigable containers on paper", () => {
  function stepped(): BuilderController {
    return new BuilderController({
      componentTypes: ["text", "html", "panel", "fieldset", "steps", "step", "tabs"].map((type) => ({ type, label: type })),
      initialRoot: {
        id: "root",
        type: "form",
        configuration: { title: "Intake" },
        children: {
          content: [
            {
              id: "wizard",
              type: "steps",
              configuration: {},
              children: {
                content: [
                  { id: "one", type: "step", configuration: { label: "One" }, children: { content: [structuredClone(name)] } },
                  { id: "office", type: "step", configuration: { label: "Office" }, children: { content: [structuredClone(html)] } }
                ]
              }
            },
            { id: "sheets", type: "tabs", configuration: { tabs: [{ id: "a", label: "A" }] }, children: { a: [{ ...structuredClone(html), id: "inA" }] } },
            { id: "bare", type: "panel", configuration: {}, children: { content: [{ ...structuredClone(html), id: "inBare" }] } }
          ]
        }
      },
      componentDefinitions: [
        def("form", { capabilities: [], children: { slots: [{ id: "content", multiple: true }] } }),
        def("text"),
        def("html"),
        def("panel", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("steps", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("step", { children: { slots: [{ id: "content", multiple: true }] } }),
        def("tabs", { children: { slots: [{ id: "a", multiple: true }] } })
      ]
    });
  }
  const printFields = (ctrl: BuilderController, id: string) => ctrl.inspectorModel(id)?.sections.find((section) => section.id === "print")?.fields ?? [];
  const paperChoice = (ctrl: BuilderController, id: string) => printFields(ctrl, id).find((field) => field.propertyPath === "print.on")?.choices.find((choice) => choice.value === "paper");

  it("never offers paper only to a step, a steps container or a tabs container, and flags one written by hand", () => {
    const ctrl = stepped();
    expect(paperChoice(ctrl, "office")?.disabled).toBe(true);
    expect(paperChoice(ctrl, "wizard")?.disabled).toBe(true);
    expect(paperChoice(ctrl, "sheets")?.disabled).toBe(true);
    // Static content inside them still takes it.
    expect(paperChoice(ctrl, "bare")?.disabled).toBeUndefined();
    ctrl.setProperty("office", "print.on", "paper");
    expect(ctrl.problemsOf("office").map((problem) => problem.target)).toEqual(["print.on"]);
    expect(ctrl.problemsOf("office")[0]?.message).toContain("step or tabs");
  });

  it("offers Keep together where print keeps a component whole: a step and an unnamed panel, never a tabs or steps container", () => {
    const ctrl = stepped();
    const keeps = (id: string): boolean => printFields(ctrl, id).some((field) => field.propertyPath === "print.keepTogether");
    expect(keeps("office")).toBe(true);
    expect(keeps("bare")).toBe(true);
    expect(keeps("wizard")).toBe(false);
    expect(keeps("sheets")).toBe(false);
    expect(keeps("name")).toBe(false);
  });
});
