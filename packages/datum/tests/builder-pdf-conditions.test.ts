import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement, DatumPdfLayoutChangeDetail } from "../src/builder.js";
import type { Expression, FormDefinition, PdfConfiguration, PdfGeneratedLayout, PdfRenderProvider, PdfTemplateLayout } from "@argusvane/datum-engine";

import { sampleDefinition, until, pdfAlone } from "./helpers.js";

/**
 * Authoring "print this layout when…" in the builder's PDF mode, in
 * jsdom: the Rules tab on a layout's root only, a saved condition landing in the layout's
 * top-level `when`, Move up / Move down keeping the page and its history, the Conditional
 * badge, the Form panel's read-only PDF group, a form rename followed into the conditions, and
 * datum-14's "Create form fields" still on the bar. The badge's look and the notes' reading
 * order are for the real-browser pass.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

// jsdom lays nothing out. A Save held by a problem focuses the formula box's CodeMirror editor,
// which measures text through a Range's rects and takes jsdom for Safari, placing a shadow
// root's selection with execCommand: both are stubbed for the tests and put back after.
const restore: Array<() => void> = [];
beforeEach(() => {
  const range = Range.prototype as unknown as Record<string, unknown>;
  for (const name of ["getClientRects", "getBoundingClientRect"]) {
    if (typeof range[name] !== "function") {
      range[name] = name === "getClientRects" ? () => [] : () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
      restore.push(() => delete range[name]);
    }
  }
  const doc = document as unknown as Record<string, unknown>;
  if (typeof doc.execCommand !== "function") {
    doc.execCommand = () => false;
    restore.push(() => delete doc.execCommand);
  }
});
afterEach(() => {
  for (const undo of restore.splice(0)) {
    undo();
  }
});

const SUBSCRIBED: Expression = { kind: "path", path: "subscribe" };
const CANADA: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "country" }, right: { kind: "literal", value: "CA" } };

function generated(id: string, name: string, when?: Expression): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: {
      id: "document",
      type: "pdf-document",
      configuration: {},
      children: { body: [{ id: `${id}-field`, type: "pdf-field", configuration: { componentId: "fullName" } }], header: [], footer: [] }
    },
    ...(when ? { when } : {})
  };
}

function paper(): PdfTemplateLayout {
  return {
    id: "paper",
    kind: "template",
    name: "Paper form",
    template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 8, data: "JVBERi0xLjQK" },
    fields: []
  };
}

function withPdf(pdf: PdfConfiguration): FormDefinition {
  return { ...sampleDefinition(), pdf };
}

/** An executor whose `inspect` reads a one-page PDF with no fields, so a populated form comes up without the kernel. */
function provider(): PdfRenderProvider {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  return {
    id: "fake",
    abiVersion: "1.0.0",
    render: async () => ({ bytes: bytes("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" }),
    inspect: async () => ({ pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: [], hasXfa: false, encrypted: false })
  } as unknown as PdfRenderProvider;
}

function designer(pdf: PdfConfiguration): DatumFormBuilderElement {
  const element = pdfAlone();
  element.definition = withPdf(pdf);
  element.pdfSupport = { provider: provider() };
  document.body.append(element);
  return element;
}

function formBuilder(pdf: PdfConfiguration, setup?: (element: DatumFormBuilderElement) => void): DatumFormBuilderElement {
  const element = document.createElement("datum-form-builder");
  element.definition = withPdf(pdf);
  setup?.(element);
  document.body.append(element);
  return element;
}

/** The engine builder's shadow root: the bar, the dropdown, the panels. */
function shell(element: DatumFormBuilderElement): ShadowRoot {
  return element.builder!.shadowRoot!;
}

/** The strip's Form panel — where a layout's root is edited — opened the way an author opens it. */
function formPanel(element: DatumFormBuilderElement): ShadowRoot {
  const panel = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  if (panel.hidden) {
    shell(element).querySelector<HTMLElement>('[data-strip] [data-panel="form"]')!.click();
  }
  return panel.shadowRoot!;
}

function inspector(element: DatumFormBuilderElement): ShadowRoot {
  return shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
}

/** The bar's label for the document on the page, as read: its name and its badges. */
function label(element: DatumFormBuilderElement): { name: string | null; badges: Array<string | null> } {
  const face = shell(element).querySelector<HTMLElement>("[data-document-face]")!;
  return {
    name: face.querySelector("[data-document-picker-name]")!.textContent,
    badges: [...face.querySelectorAll(".document-face-badge")].map((badge) => badge.textContent)
  };
}

function menuItem(element: DatumFormBuilderElement, action: string): HTMLButtonElement {
  return shell(element).querySelector<HTMLButtonElement>(`[data-document-menu-popover] [data-document-action="${action}"]`)!;
}

function layoutChanges(element: HTMLElement): DatumPdfLayoutChangeDetail[] {
  const changes: DatumPdfLayoutChangeDetail[] = [];
  element.addEventListener("datum-pdf-layout-change", (event) => changes.push((event as CustomEvent<DatumPdfLayoutChangeDetail>).detail));
  return changes;
}

/** Opens the Rules tab of the Form panel — on a PDF layout, its root's. */
async function rulesTab(element: DatumFormBuilderElement): Promise<ShadowRoot> {
  const panel = formPanel(element);
  await until(() => panel.querySelector('[data-inspector-tab="rules"]'));
  panel.querySelector<HTMLElement>('[data-inspector-tab="rules"]')!.click();
  return panel;
}

/** The formula box of the layout's condition on the Form panel's Rules tab: the plain textarea (hidden once the editor mounts over it, still the markup's box). */
function conditionBox(element: DatumFormBuilderElement): HTMLTextAreaElement {
  return formPanel(element).querySelector<HTMLTextAreaElement>('[data-rule="when"][data-rule-formula]')!;
}

/** Writes a condition on the Form panel's Rules tab as a formula, the way an author types one. */
async function typeCondition(element: DatumFormBuilderElement, formula: string): Promise<void> {
  const panel = await rulesTab(element);
  panel.querySelector<HTMLElement>('[data-rule="when"][data-rule-mode="formula"]')!.click();
  const box = panel.querySelector<HTMLTextAreaElement>('[data-rule="when"][data-rule-formula]')!;
  box.value = formula;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("conditions on PDF layouts in the builder", () => {
  it("offers the Rules tab on a layout's root only, for a custom layout and a populated form alike", async () => {
    const element = designer({ layouts: [generated("letter", "Letter"), paper()], defaultLayoutId: "letter" });
    await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));

    // The layout's root, on the Form panel: its condition, and nothing else.
    const panel = await rulesTab(element);
    expect([...panel.querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection)).toEqual(["when"]);
    expect(panel.querySelector("[data-rule-section] summary")!.textContent).toContain("Print this layout when");
    expect(panel.querySelector(".rules-note")!.textContent).toContain("by component id");
    expect(panel.querySelector(".rules-note")!.textContent).toContain("It is the default: a download that names no layout prints it.");
    // A layout's condition is Off | Formula.
    expect([...panel.querySelectorAll<HTMLElement>('[data-rule="when"][data-rule-mode]')].map((pill) => pill.dataset.ruleMode)).toEqual(["off", "formula"]);
    // The formula box offers the form's answers by id (the "Try one" chips over an empty box), never the layout's own nodes.
    panel.querySelector<HTMLElement>('[data-rule="when"][data-rule-mode="formula"]')!.click();
    const tries = [...panel.querySelectorAll<HTMLElement>('[data-rule="when"][data-rule-try]')].map((entry) => entry.dataset.ruleTry!);
    expect(tries.join(" ")).toContain("fullName");
    expect(tries.join(" ")).not.toContain("letter-field");
    // A mode's condition gets no Runs control: it keeps its side by design.
    expect(panel.querySelector('[data-rule-run-menu="when"]')).toBeNull();
    panel.querySelector<HTMLElement>('[data-rule="when"][data-rule-mode="off"]')!.click();

    // Any other node of the layout: no Rules tab.
    element.pdfMode!.controller.select("letter-field");
    await until(() => inspector(element).querySelector('[data-inspector-tab="properties"]'));
    expect(inspector(element).querySelector('[data-inspector-tab="rules"]')).toBeNull();

    // A populated form's root has it too.
    element.pdfMode!.selectLayout("paper");
    await until(() => element.layoutId === "paper" && element.pdfMode!.ready);
    await rulesTab(element);
    expect([...formPanel(element).querySelectorAll<HTMLElement>("[data-rule-section]")].map((section) => section.dataset.ruleSection)).toEqual(["when"]);
    expect(formPanel(element).querySelector(".rules-note")!.textContent).toContain(
      "With no condition, it prints only when a host asks for it by id; when no condition holds, Letter prints."
    );
  });

  it("saves a condition into the layout's top-level when, writes the default down, badges the layout and reports the change", async () => {
    const element = designer({ layouts: [generated("letter", "Letter"), generated("a4", "A4")] });
    await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));
    const changes = layoutChanges(element);
    const controller = element.pdfMode!.controller;

    await typeCondition(element, "subscribe and host.role");
    // Advice while typing, never a hold on Save: a condition that reads host. reads nothing.
    await until(() => formPanel(element).querySelector('[data-note="rules:when"]'));
    expect(formPanel(element).querySelector('[data-note="rules:when"]')!.textContent).toContain("reads host.role");
    // Named by the box, so a screen reader moving by Tab hears it with the condition.
    const noteIds = [...formPanel(element).querySelectorAll<HTMLElement>('[data-note="rules:when"]')].map((note) => note.id);
    expect(conditionBox(element).getAttribute("aria-describedby")!.split(" ")).toEqual(noteIds);
    expect(element.definition.pdf?.layouts?.[0]?.when).toBeUndefined();
    formPanel(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();

    await until(() => changes.length > 0);
    const pdf = element.definition.pdf!;
    // Written as the formula string the author typed.
    expect(pdf.layouts![0]!.when).toBe("subscribe and host.role");
    // One copy, at the top level: the root the designer edits carries none in the definition.
    expect((pdf.layouts![0] as PdfGeneratedLayout).root.configuration).not.toHaveProperty("when");
    // The default layout is recorded by name, not left implicit as the first layout.
    expect(pdf.defaultLayoutId).toBe("letter");
    expect(changes.at(-1)).toMatchObject({ reason: "edit", layout: { id: "letter" }, pdf: { defaultLayoutId: "letter" } });
    expect(changes.at(-1)!.definition.pdf?.layouts?.[0]?.when).toBeDefined();
    // The page stayed on the layout it showed.
    expect(element.layoutId).toBe("letter");
    expect(element.pdfMode!.controller).toBe(controller);

    // The bar's label badges it beside the name, after the default's badge.
    await until(() => label(element).badges.includes("Conditional"));
    expect(label(element)).toEqual({ name: "Letter", badges: ["Default", "Conditional"] });
    // The Rules tab says where the layout stands now.
    expect(formPanel(element).querySelector(".rules-note")!.textContent).toContain("Its condition is tried 1st of 1; when none holds, this layout prints anyway: it is the default.");
    // The other layout, with no condition and not the default, carries no badge.
    element.pdfMode!.selectLayout("a4");
    await until(() => element.layoutId === "a4" && label(element).name === "A4");
    expect(label(element)).toEqual({ name: "A4", badges: [] });
  });

  it("moves a layout up and down from its menu, off at the ends, keeping the page, its undo history and the default", async () => {
    const element = designer({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4"), generated("legal", "Legal")], defaultLayoutId: "a4" });
    await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));
    const changes = layoutChanges(element);
    // The page opens on the default; the layout to move is put there.
    element.pdfMode!.selectLayout("letter");
    await until(() => element.layoutId === "letter" && element.pdfMode!.ready);
    const controller = element.pdfMode!.controller;
    // An edit on the layout on the page: its history must survive the move.
    controller.setProperty("letter-field", "componentId", "email");
    expect(controller.canUndo()).toBe(true);
    await rulesTab(element);
    expect(formPanel(element).querySelector(".rules-note")!.textContent).toContain("tried 1st of 1; when none holds, A4 prints.");

    const menuButton = shell(element).querySelector<HTMLElement>("[data-document-menu]")!;
    menuButton.click();
    expect([...shell(element).querySelectorAll<HTMLElement>("[data-document-menu-popover] [data-document-action]")].map((item) => item.dataset.documentAction)).toEqual([
      "rename",
      "duplicate",
      "move-up",
      "move-down",
      "default",
      "remove"
    ]);
    expect(menuItem(element, "move-up").disabled).toBe(true);
    expect(menuItem(element, "move-down").disabled).toBe(false);
    menuItem(element, "move-down").click();

    await until(() => element.definition.pdf?.layouts?.[1]?.id === "letter");
    expect(element.definition.pdf!.layouts!.map((layout) => layout.id)).toEqual(["a4", "letter", "legal"]);
    expect(element.definition.pdf!.defaultLayoutId).toBe("a4");
    expect(changes.at(-1)).toMatchObject({ reason: "layouts", layout: { id: "letter" } });
    // The page, its controller and its history stayed; the layouts are in the new order.
    expect(element.layoutId).toBe("letter");
    expect(element.pdfMode!.controller).toBe(controller);
    expect(controller.canUndo()).toBe(true);
    expect(element.pdfMode!.layouts.map((layout) => layout.id)).toEqual(["a4", "letter", "legal"]);
    // The menu came back on the same item, so it can go on moving; both ways are open in the middle.
    expect(menuItem(element, "move-up").disabled).toBe(false);
    expect(menuItem(element, "move-down").disabled).toBe(false);
    menuItem(element, "move-down").click();
    await until(() => element.definition.pdf?.layouts?.[2]?.id === "letter");
    expect(menuItem(element, "move-down").disabled).toBe(true);
    // At the end, focus takes the other move item, not Rename… (a repeated Enter would start a
    // rename), and the move items say where the layout now stands.
    expect(shell(element).activeElement).toBe(menuItem(element, "move-up"));
    expect(menuItem(element, "move-up").getAttribute("aria-describedby")).toBe("document-place-note");
    expect(shell(element).getElementById("document-place-note")!.textContent).toBe("Letter is layout 3 of 3");
    shell(element).querySelector<HTMLElement>("[data-document-menu]")!.click();

    // The element's own API does the same, and a place past the end is the end.
    element.pdfMode!.moveLayout("letter", -5);
    expect(element.pdfMode!.layouts.map((layout) => layout.id)).toEqual(["letter", "a4", "legal"]);
    expect(element.layoutId).toBe("letter");
    controller.undo();
    expect((controller.snapshot().children!.body![0]!.configuration as { componentId: string }).componentId).toBe("fullName");
  });

  it("follows a form rename into every layout's condition, an unsaved one on the Rules tab included", async () => {
    const element = formBuilder({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4", CANADA), generated("plain", "Plain")], defaultLayoutId: "plain" });
    await until(() => element.pdfMode !== undefined);
    const changes = layoutChanges(element);
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    // The page opened on the default; the conditional layout is put there.
    await element.pdfMode!.selectLayout("letter");
    await until(() => element.pdfMode!.layoutId === "letter" && element.pdfMode!.ready);
    const layout = element.pdfMode!.controller;
    // The Rules tab holds an unsaved condition of its own on the layout on the page.
    layout.setDraftProperty(layout.rootId(), "when", { kind: "unary", operator: "not", operand: SUBSCRIBED });

    // Renamed by the host while the PDF side is up (on the Form tab, the leave prompt settles drafts first).
    element.controller!.renameId("subscribe", "wantsNews");
    await until(() => changes.some((change) => change.reason === "layouts"));
    const layouts = element.definition.pdf!.layouts!;
    expect(layouts[0]!.when).toEqual({ kind: "path", path: "wantsNews" });
    // A condition that names something else is left as it was; so is a binding to another component.
    expect(layouts[1]!.when).toEqual(CANADA);
    expect(((layouts[0] as PdfGeneratedLayout).root.children!.body![0]!.configuration as { componentId: string }).componentId).toBe("fullName");
    expect(changes.filter((change) => change.reason === "layouts").map((change) => change.layout.id)).toEqual(["letter"]);
    // The open tree followed in place, and its draft was renamed rather than overwritten.
    expect((layout.snapshot().configuration as { when?: unknown }).when).toEqual({ kind: "path", path: "wantsNews" });
    expect(layout.draftProperty(layout.rootId(), "when")).toEqual({ kind: "unary", operator: "not", operand: { kind: "path", path: "wantsNews" } });
    expect(layout.hasPendingChanges(layout.rootId())).toBe(true);
  });

  it("follows a form rename into a layout's pdf-field binding, so the field keeps printing", async () => {
    const element = formBuilder({ layouts: [generated("plain", "Plain")] });
    await until(() => element.pdfMode !== undefined);
    element.controller!.renameId("fullName", "legalName");
    const bound = (): string => ((element.definition.pdf!.layouts![0] as PdfGeneratedLayout).root.children!.body![0]!.configuration as { componentId: string }).componentId;
    await until(() => bound() === "legalName");
    expect(bound()).toBe("legalName");
  });

  it("says the order in words on the Form panel of the form's tab, read-only, with a way to the layouts", async () => {
    const element = formBuilder({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4")], defaultLayoutId: "a4" });
    await until(() => element.pdfMode !== undefined);
    const panel = formPanel(element);
    const section = (): HTMLElement | null => panel.querySelector<HTMLElement>('[data-mode-settings="pdf"]');
    await until(() => section());
    expect(section()!.querySelector("summary")!.textContent).toBe("PDF");
    expect(section()!.querySelector('[data-root-setting-readonly="pdf.order"]')!.textContent).toContain("Which layout prints");
    expect(section()!.querySelector('[data-root-setting-note="pdf.order"]')!.textContent).toBe(
      "Chosen by the answers: 1. Letter, when Subscribe is checked / true. Otherwise: A4."
    );
    // Nothing to choose, so nothing drafted: the default is set from the documents menu.
    expect(section()!.querySelector("select")).toBeNull();
    expect(element.controller!.hasPendingChanges(element.controller!.rootId())).toBe(false);

    // A form label edited since reads as it now stands; a new default does too.
    element.controller!.setProperty("subscribe", "label", "Newsletter");
    await until(() => section()!.querySelector('[data-root-setting-note="pdf.order"]')!.textContent!.includes("Newsletter"));
    element.pdfMode!.setDefaultLayout("letter");
    await until(() => section()!.querySelector('[data-root-setting-note="pdf.order"]')!.textContent!.endsWith("Otherwise: Letter."));

    // Its button opens the layouts.
    section()!.querySelector<HTMLElement>('[data-root-setting-open="pdf"]')!.click();
    await until(() => element.mode === "pdf");
  });

  it("keeps datum-14's Create form fields in the canvas's toolbar beside Suggest mappings and Preview PDF", async () => {
    const element = designer({ layouts: [generated("letter", "Letter")] });
    await until(() => element.pdfMode!.ready);
    const canvasRoot = shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
    const actions = [...canvasRoot.querySelectorAll<HTMLElement>("[data-canvas-bar] button")];
    const keys = actions.map((button) => (button.hasAttribute("data-suggest-mappings") ? "suggest" : button.hasAttribute("data-create-form-fields") ? "create" : button.hasAttribute("data-preview-pdf") ? "preview" : "other"));
    expect(keys.filter((key) => key !== "other")).toEqual(["suggest", "create", "preview"]);
    // Offered on a populated form with fields only: a custom layout leaves it hidden.
    expect(canvasRoot.querySelector<HTMLButtonElement>("[data-create-form-fields]")!.hidden).toBe(true);
    expect(typeof element.pdfMode!.createFormFields).toBe("function");
  });

  it("starts each layout's Rules tab afresh: a condition saved on one, or a box left unparsed, stays with its own layout", async () => {
    // Both roots are "document": only the controller tells the two layouts apart.
    const element = designer({ layouts: [generated("letter", "Letter"), generated("a4", "A4")], defaultLayoutId: "letter" });
    await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));

    // Letter: a condition typed as a formula, and saved.
    let panel = await rulesTab(element);
    await typeCondition(element, "subscribe");
    // The default with a condition is advised on, and the box names the advice.
    await until(() => formPanel(element).querySelector('[data-note="rules:when"]'));
    const noteId = formPanel(element).querySelector<HTMLElement>('[data-note="rules:when"]')!.id;
    expect(conditionBox(element).getAttribute("aria-describedby")).toContain(noteId);
    formPanel(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => element.definition.pdf?.layouts?.[0]?.when !== undefined);
    expect(element.definition.pdf!.layouts![0]!.when).toBe("subscribe");

    // A4: its own condition — none — and nothing of Letter's.
    element.pdfMode!.selectLayout("a4");
    await until(() => element.layoutId === "a4" && element.pdfMode!.ready);
    panel = await rulesTab(element);
    expect(panel.querySelector('[data-rule-section="when"] .rule-state')!.textContent).toBe("off");
    expect(panel.querySelector('[data-rule="when"][data-rule-mode="off"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(panel.querySelector('[data-rule="when"][data-rule-formula]')).toBeNull();

    // A box left unparsed on A4 stays with A4: its draft holds the text as typed, its
    // Save is held by the problem, the definition keeps no condition, and nothing holds Letter back.
    await typeCondition(element, "subscribe +");
    await until(() => formPanel(element).querySelector('[data-problem="rules:when"]'));
    const a4 = element.pdfMode!.controller;
    expect(a4.hasPendingChanges(a4.rootId())).toBe(true);
    expect(a4.draftProperty(a4.rootId(), "when")).toBe("subscribe +");
    formPanel(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(formPanel(element).querySelector("[data-inspector-problems]")!.textContent).toContain("1 problem");
    expect(element.definition.pdf!.layouts![1]).not.toHaveProperty("when");
    expect(a4.hasPendingChanges(a4.rootId())).toBe(true);
    element.pdfMode!.selectLayout("letter");
    await until(() => element.layoutId === "letter" && element.pdfMode!.ready);
    const letter = element.pdfMode!.controller;
    letter.setDraftProperty(letter.rootId(), "name", "Letter (US)");
    formPanel(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    await until(() => element.definition.pdf?.layouts?.[0]?.name === "Letter (US)");
    expect(letter.hasPendingChanges(letter.rootId())).toBe(false);
    expect(formPanel(element).querySelector("[data-problem]")).toBeNull();
    // Letter's own condition is what its tab shows.
    expect(conditionBox(element).value).toBe("subscribe");
  });

  it("opens a conditional definition that declares no default as it is: nothing written, and the Rules tab says so", async () => {
    const element = designer({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4")] });
    const changes = layoutChanges(element);
    await until(() => element.pdfMode!.ready && element.pdfMode?.controller.componentTypes().some((entry) => entry.type === "pdf-field"));
    // Opening a layout is no edit: the default is written by the author's Rules save, a
    // Duplicate or a copy, never quietly by the designer coming up.
    expect(element.definition.pdf).not.toHaveProperty("defaultLayoutId");
    expect(changes).toEqual([]);
    const panel = await rulesTab(element);
    expect([...panel.querySelectorAll('[data-note="rules:when"]')].map((note) => note.textContent).join(" ")).toContain("declares no default");
  });

  it("keeps the formula box in step with a form rename followed into the layout's unsaved condition", async () => {
    const element = formBuilder({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4")], defaultLayoutId: "letter" });
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    const layout = element.pdfMode!.controller;
    // Typed on the Rules tab, unsaved: subscribe = "yes".
    await typeCondition(element, 'subscribe = "yes"');
    expect(layout.draftProperty(layout.rootId(), "when")).toBe('subscribe = "yes"');

    element.controller!.renameId("subscribe", "wantsNews");
    // The formula follows the rename in place, the author's spelling kept.
    expect(layout.draftProperty(layout.rootId(), "when")).toBe('wantsNews = "yes"');
    // The box shows the new id, and the next edit keeps it rather than writing the old one back.
    await until(() => conditionBox(element)?.value === 'wantsNews = "yes"');
    const box = conditionBox(element);
    box.value = 'wantsNews = "no"';
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(layout.draftProperty(layout.rootId(), "when")).toBe('wantsNews = "no"');
  });

  it("keeps a form rename that lands while a custom layout's designer is still being built", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const element = formBuilder({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4")], defaultLayoutId: "letter" }, (builder) => {
      // The host's profile list is what the build waits on here.
      builder.pdfTemplates = {
        resolve: async () => new Uint8Array(),
        listProfiles: async () => {
          asked += 1;
          await gate;
          return [];
        }
      };
    });
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => asked > 0);
    element.controller!.renameId("subscribe", "wantsNews");
    expect(element.definition.pdf!.layouts![0]!.when).toEqual({ kind: "path", path: "wantsNews" });
    release();
    await until(() => element.mode === "pdf" && element.pdfMode?.ready);
    // The build did not put the old id back, in the catalog or in the tree it seeded.
    expect(element.definition.pdf!.layouts![0]!.when).toEqual({ kind: "path", path: "wantsNews" });
    const layout = element.pdfMode!.controller;
    expect((layout.snapshot().configuration as { when?: unknown }).when).toEqual({ kind: "path", path: "wantsNews" });
  });

  it("keeps a form rename that lands while a populated form's PDF is still being read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const base = provider();
    const slow = {
      ...base,
      inspect: async (...args: unknown[]) => {
        asked += 1;
        await gate;
        return (base.inspect as (...inner: unknown[]) => Promise<unknown>)(...args);
      }
    } as unknown as PdfRenderProvider;
    const element = formBuilder({ layouts: [{ ...paper(), when: SUBSCRIBED }, generated("a4", "A4")], defaultLayoutId: "paper" }, (builder) => {
      builder.pdfSupport = { provider: slow };
    });
    await until(() => element.pdfMode !== undefined);
    element.mode = "pdf";
    await until(() => asked > 0);
    element.controller!.renameId("subscribe", "wantsNews");
    release();
    await until(() => element.mode === "pdf" && element.pdfMode?.ready && element.pdfMode.controller.componentTypes().length > 0);
    expect(element.definition.pdf!.layouts![0]!.when).toEqual({ kind: "path", path: "wantsNews" });
    const layout = element.pdfMode!.controller;
    expect((layout.snapshot().configuration as { when?: unknown }).when).toEqual({ kind: "path", path: "wantsNews" });
  });

  it("Form Try it's Preview PDF picks the layout by the answers through the PDF mode", async () => {
    const calls: unknown[] = [];
    const base = provider();
    const recording = { ...base, render: async (request: unknown) => (calls.push(request), (base.render as (r: unknown) => Promise<unknown>)(request)) } as unknown as PdfRenderProvider;
    const element = formBuilder({ layouts: [generated("letter", "Letter", SUBSCRIBED), generated("a4", "A4")], defaultLayoutId: "a4" }, (builder) => {
      builder.pdfSupport = { provider: recording };
    });
    await until(() => element.pdfMode !== undefined);
    const mode = element.pdfMode!;
    const spy = vi.spyOn(mode, "renderPdf");
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & {
      previewing: boolean;
      previewRuntime(): { setValue(path: string, value: unknown): void };
    };
    await until(() => canvas.previewRuntime?.());
    canvas.previewing = true;
    canvas.previewRuntime().setValue("subscribe", true);
    const button = () => canvas.shadowRoot!.querySelector<HTMLElement>("[data-try-pdf]");
    await until(() => button());
    button()!.click();
    await until(() => spy.mock.calls.length > 0);
    expect(spy.mock.calls[0]![0]).toMatchObject({ byAnswers: true });
    const result = await spy.mock.results[0]!.value;
    expect(result.layoutId).toBe("letter");
    expect(result.layoutChoice).toBe("condition");
    // The dialog is the PDF mode's own, mounted in the shell's root though the Form is the page's.
    const dialog = shell(element).querySelector<HTMLDialogElement>("[data-preview-dialog]")!;
    await until(() => dialog.querySelector("[data-preview-layout]"));
    expect(dialog.querySelector("[data-preview-layout]")!.textContent).toContain("Letter, chosen by the answers");
  });
});
