// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { createPdfBuilderMode, type PdfBuilderMode, type PdfBuilderModeOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { BuilderModeContext } from "../form-engine/builder/web-component/builder-modes.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";

/**
 * The catalog actions of the Journeys and PDF designers over a real form controller: each is one entry of the form's history, whatever else moved with it, and the
 * designer on the page reaches it. A built designer's tree takes a document's new name with no
 * entry of its own, so its Undo never takes the name back alone, nor after the form's did.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Intake" },
  children: { content: [{ id: "province", type: "select", configuration: { label: "Province" } }] }
};

function layout(id: string, name: string): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "title", type: "pdf-text", configuration: { text: "Receipt", variant: "h1" } }], header: [], footer: [] } }
  };
}

const until = async (check: () => unknown): Promise<void> => {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
};

const modes: Array<PdfBuilderMode | JourneyBuilderMode> = [];
afterEach(() => {
  for (const mode of modes.splice(0)) {
    mode.dispose?.();
  }
  document.body.innerHTML = "";
});

function pdfMode(form: BuilderController, pdf: PdfConfiguration, options: Partial<PdfBuilderModeOptions> = {}): PdfBuilderMode {
  const mode = createPdfBuilderMode({ formRoot: () => FORM, runtime: () => ({}) as RenderableRuntime, pdf, locale: () => "en", form: () => form, ...options });
  modes.push(mode);
  return mode;
}

/** Puts the mode on a page of its own and waits for the layout on the page to be built. */
async function open(mode: PdfBuilderMode): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  await mode.activate!({ host, root: host.attachShadow({ mode: "open" }), showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) } as BuilderModeContext);
  await until(() => mode.ready);
}

const names = (mode: PdfBuilderMode): string[] => mode.layouts.map((entry) => `${entry.id}:${typeof entry.name === "string" ? entry.name : "-"}`);
const rootName = (controller: BuilderController): unknown => (controller.snapshot().configuration as { name?: unknown }).name;

/** The form's undo entries, newest first, read by walking the history down and back up. */
function entries(form: BuilderController): string[] {
  const ids: string[] = [];
  while (form.canUndo()) {
    ids.push((form.undoMark() as { id: string }).id);
    form.undo();
  }
  for (let step = 0; step < ids.length; step += 1) {
    form.redo();
  }
  return ids;
}

describe("Make default on a language that words a document's name", () => {
  it("is one step of the form's history: a built PDF layout's tree takes the new name with no entry, through Make default, its Undo and its Redo", async () => {
    const form = new BuilderController({ initialRoot: FORM, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations({ fr: { pdf: { receipt: { name: { text: "Reçu", source: sourceHash("Receipt layout") } } } } } as FormTranslations, { silent: true });
    const mode = pdfMode(form, { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] });
    form.setOutsideDocuments(() => [mode.localeDocument()]);
    await open(mode);
    const tree = mode.controller;
    expect(form.localizationActions.makeDefaultLocale("fr")).toBe(true);
    expect(names(mode)).toEqual(["receipt:Reçu", "other:Other"]);
    expect(rootName(tree)).toBe("Reçu");
    expect(tree.canUndo()).toBe(false);
    form.undo();
    expect(names(mode)).toEqual(["receipt:Receipt layout", "other:Other"]);
    expect(rootName(tree)).toBe("Receipt layout");
    expect(tree.canUndo()).toBe(false);
    form.redo();
    expect(rootName(tree)).toBe("Reçu");
    expect(tree.canUndo()).toBe(false);
    expect(form.localization()?.defaultLocale).toBe("fr");
  });

  it("is one step of the form's history for a journey's name too: the open journey's tree takes it with no entry", async () => {
    const form = new BuilderController({ initialRoot: FORM, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations({ fr: { journeys: { intake: { name: { text: "Accueil", source: sourceHash("Intake") } } } } } as FormTranslations, { silent: true });
    const mode = createJourneyBuilderMode({ form, journey: { journeys: [{ id: "intake", name: "Intake", pages: [{ id: "about", components: ["province"] }] }] } });
    modes.push(mode);
    form.setOutsideDocuments(() => [mode.localeDocument()]);
    await mode.activate!({ host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    await until(() => mode.ready);
    const tree = mode.controller;
    expect(form.localizationActions.makeDefaultLocale("fr")).toBe(true);
    expect(mode.journeys[0]!.name).toBe("Accueil");
    expect(rootName(tree)).toBe("Accueil");
    expect(tree.canUndo()).toBe(false);
    form.undo();
    expect(rootName(tree)).toBe("Intake");
    expect(tree.canUndo()).toBe(false);
  });
});

describe("a PDF layout's rename", () => {
  it("is one step of the form's history whether its designer is built or not, its tree taking the name with no entry", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = pdfMode(form, { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] });
    // Before its designer is built.
    mode.renameLayout("receipt", "R1");
    expect(entries(form)).toEqual(["PDF_LAYOUTS"]);
    await open(mode);
    const tree = mode.controller;
    expect(rootName(tree)).toBe("R1");
    // On the page, built: the form's step again, the tree's history untouched.
    mode.renameLayout("receipt", "R2");
    expect(rootName(tree)).toBe("R2");
    expect(tree.canUndo()).toBe(false);
    expect(entries(form)).toEqual(["PDF_LAYOUTS", "PDF_LAYOUTS"]);
    // The designer on the page reaches it; so does the form's own Undo (the Form workspace's), newest first.
    expect(mode.history!()?.canUndo()).toBe(true);
    form.undo();
    expect(names(mode)).toEqual(["receipt:R1", "other:Other"]);
    expect(rootName(tree)).toBe("R1");
    form.undo();
    expect(names(mode)).toEqual(["receipt:Receipt layout", "other:Other"]);
    expect(rootName(tree)).toBe("Receipt layout");
    expect(tree.canUndo()).toBe(false);
    form.redo();
    form.redo();
    expect(rootName(tree)).toBe("R2");
    expect(tree.canUndo()).toBe(false);
  });

  it("of a built designer off the page is the form's step too, held by the designer on the page", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = pdfMode(form, { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] });
    await open(mode);
    const receipt = mode.controller;
    await mode.selectLayout("other");
    await until(() => mode.ready && mode.layoutId === "other");
    mode.renameLayout("receipt", "Off the page");
    expect(rootName(receipt)).toBe("Off the page");
    expect(receipt.canUndo()).toBe(false);
    expect(mode.history!()?.undo()).toBe(true);
    expect(names(mode)).toEqual(["receipt:Receipt layout", "other:Other"]);
    expect(rootName(receipt)).toBe("Receipt layout");
  });

  it("typed in the designer's own Layout name box is that tree's edit, recorded once", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = pdfMode(form, { layouts: [layout("receipt", "Receipt layout"), layout("other", "Other")] });
    await open(mode);
    const tree = mode.controller;
    // What the inspector's Apply writes: the root's name, on the tree.
    tree.setProperty(tree.rootId(), "name", "Typed");
    expect(names(mode)).toEqual(["receipt:Typed", "other:Other"]);
    expect(form.canUndo()).toBe(false);
    tree.undo();
    expect(names(mode)).toEqual(["receipt:Receipt layout", "other:Other"]);
    expect(tree.canUndo()).toBe(false);
  });
});

describe("a catalog action a host's change handler calls while another runs", () => {
  it("is one entry with the action it came with: one Undo takes both back, one Redo makes both again", () => {
    const form = new BuilderController({ initialRoot: FORM });
    let once = true;
    const mode: PdfBuilderMode = pdfMode(
      form,
      { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] },
      {
        onChange: (detail) => {
          if (once && detail.reason === "layouts") {
            once = false;
            mode.removeLayout("c");
          }
        }
      }
    );
    mode.setDefaultLayout("b");
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(entries(form)).toHaveLength(1);
    form.undo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(mode.pdfConfiguration.defaultLayoutId).toBeUndefined();
    expect(form.canUndo()).toBe(false);
    form.redo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(mode.pdfConfiguration.defaultLayoutId).toBe("b");
    expect(form.canRedo()).toBe(false);
  });

  it("is one entry when the nested action's own translations rewrite made a step: Undo brings the layout, its wording and the default back together", () => {
    const form = new BuilderController({ initialRoot: FORM });
    const wording = { fr: { pdf: { c: { name: { text: "Cé", source: sourceHash("C") } } } } } as FormTranslations;
    form.replaceTranslations(structuredClone(wording), { silent: true });
    let once = true;
    const mode: PdfBuilderMode = pdfMode(
      form,
      { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] },
      {
        onChange: (detail) => {
          if (once && detail.reason === "layouts") {
            once = false;
            mode.removeLayout("c");
          }
        }
      }
    );
    const reasons: string[] = [];
    form.on("change", (event) => reasons.push(event.reason));
    mode.setDefaultLayout("b");
    expect(form.translations()?.fr?.pdf?.c).toBeUndefined();
    // One change of the form's told, the nested rewrite's: the default's part joins it unannounced.
    expect(reasons).toEqual(["edit"]);
    expect(entries(form)).toHaveLength(1);
    form.undo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(mode.pdfConfiguration.defaultLayoutId).toBeUndefined();
    expect(form.translations()).toEqual(wording);
    expect(form.canUndo()).toBe(false);
    form.redo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(mode.pdfConfiguration.defaultLayoutId).toBe("b");
    expect(form.translations()?.fr?.pdf?.c).toBeUndefined();
  });

  it("is one entry the other way round too: a default chosen while a translated layout's removal runs", () => {
    const form = new BuilderController({ initialRoot: FORM });
    const wording = { fr: { pdf: { c: { name: { text: "Cé", source: sourceHash("C") } } } } } as FormTranslations;
    form.replaceTranslations(structuredClone(wording), { silent: true });
    let once = true;
    const mode: PdfBuilderMode = pdfMode(
      form,
      { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] },
      {
        onChange: () => {
          if (once) {
            once = false;
            mode.setDefaultLayout("b");
          }
        }
      }
    );
    mode.removeLayout("c");
    expect(mode.pdfConfiguration.defaultLayoutId).toBe("b");
    expect(entries(form)).toHaveLength(1);
    form.undo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(mode.pdfConfiguration.defaultLayoutId).toBeUndefined();
    expect(form.translations()).toEqual(wording);
    expect(form.canUndo()).toBe(false);
  });

  it("is one entry on the journeys too", () => {
    const form = new BuilderController({ initialRoot: FORM });
    let once = true;
    const journeys: JourneyConfiguration = {
      journeys: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), pages: [{ id: "p", components: ["province"] }] })),
      defaultJourneyId: "a"
    };
    const mode: JourneyBuilderMode = createJourneyBuilderMode({
      form,
      journey: journeys,
      onChange: (detail) => {
        if (once && detail.reason === "journeys") {
          once = false;
          mode.removeJourney("c");
        }
      }
    });
    modes.push(mode);
    mode.setDefaultJourney("b");
    expect(mode.journeys.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(entries(form)).toHaveLength(1);
    form.undo();
    expect(mode.journeyConfiguration).toEqual(journeys);
    expect(form.canUndo()).toBe(false);
  });
});

describe("the steps a designer holds", () => {
  it("holds every step the form's history keeps: sixty catalog actions in a row come back from the designer one by one", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B")] });
    await open(mode);
    const start = JSON.stringify(mode.pdfConfiguration);
    for (let step = 0; step < 60; step += 1) {
      mode.setDefaultLayout(step % 2 === 0 ? "b" : "a");
    }
    for (let step = 0; step < 60; step += 1) {
      expect(mode.history!()?.undo()).toBe(true);
    }
    expect(JSON.stringify(mode.pdfConfiguration)).toBe(start);
    expect(form.canUndo()).toBe(false);
  });

  it("holds a journey removed by the host while a PDF layout is on the page, ahead of that layout's older edit", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const journeys = createJourneyBuilderMode({ form, journey: { journeys: [{ id: "intake", name: "Intake", pages: [{ id: "p", components: ["province"] }] }, { id: "quick", name: "Quick", pages: [{ id: "q", components: ["province"] }] }] } });
    modes.push(journeys);
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B")] });
    await open(mode);
    const tree = mode.controller;
    tree.setProperty(tree.rootId(), "name", "A edited");
    journeys.removeJourney("quick");
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(journeys.journeys.map((entry) => entry.id)).toEqual(["intake", "quick"]);
    expect(mode.layouts[0]!.name).toBe("A edited");
  });
});

describe("the Journeys Form panel's Opens as row", () => {
  it("commits the default as a journey is chosen, so a choice then its Save are two steps, and a Save alone one", () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = createJourneyBuilderMode({
      form,
      journey: { journeys: ["a", "b"].map((id) => ({ id, name: id.toUpperCase(), pages: [{ id: "p", components: ["province"] }] })), defaultJourneyId: "a", opensAs: "form" }
    });
    modes.push(mode);
    const row = mode.formSettings!.rows().find((entry) => entry.id === "journeys.opensAs")!;
    row.set!("b");
    expect(entries(form)).toHaveLength(1);
    form.undo();
    row.choose!("b");
    expect(mode.journeyConfiguration?.defaultJourneyId).toBe("b");
    row.set!("b");
    expect(entries(form)).toHaveLength(2);
  });
});

/*
 * A form rename a built PDF layout follows (its condition and its field's binding) is one step of
 * the form's history, as the journeys' follow-up is: the tree takes the new id with no entry of
 * its own, one Undo of the form takes back the id and every layout's follow-up, built or not, and
 * Redo makes them all again. The tree's own Undo never meets a "follow the rename" step.
 */
describe("a form rename a built PDF layout follows", () => {
  /** A layout that prints when `province` is answered and prints `province`. */
  function bound(id: string, name: string): PdfGeneratedLayout {
    return {
      id,
      kind: "generated",
      name,
      when: "province",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "field", type: "pdf-field", configuration: { componentId: "province" } }], header: [], footer: [] } }
    };
  }

  /** As the shell wires it: the rename a change announces, never an Undo's or a Redo's, reaches the mode. */
  function setUp(pdf: PdfConfiguration): { form: BuilderController; mode: PdfBuilderMode; reported: string[] } {
    const form = new BuilderController({ initialRoot: structuredClone(FORM) });
    const reported: string[] = [];
    const mode = pdfMode(form, pdf, { formRoot: () => form.snapshot(), onChange: (detail) => reported.push(`${detail.reason}:${detail.layout.id}`) });
    form.on("change", (event) => {
      if (event.renamed && event.historyStep === undefined) {
        mode.formRenamed!(event.renamed);
      }
    });
    return { form, mode, reported };
  }

  const formIds = (form: BuilderController): string[] => (form.snapshot().children?.content ?? []).map((node) => node.id);
  /** The layout's condition and binding as the catalog has them. */
  const inCatalog = (mode: PdfBuilderMode, id: string): string => {
    const found = mode.layouts.find((entry) => entry.id === id) as PdfGeneratedLayout;
    return `${String(found.when)}/${(found.root.children!.body![0]!.configuration as { componentId: string }).componentId}`;
  };
  /** The same as the layout's open tree has them. */
  const inTree = (tree: BuilderController): string => {
    const root = tree.snapshot();
    return `${String((root.configuration as { when?: unknown }).when)}/${(root.children!.body![0]!.configuration as { componentId: string }).componentId}`;
  };

  it("takes the tree along with no entry of its own: one Undo puts back the id, the condition and the binding, and Redo renames them all again", async () => {
    const { form, mode, reported } = setUp({ layouts: [bound("receipt", "Receipt")] });
    await open(mode);
    const tree = mode.controller;
    const changes: string[] = [];
    form.on("change", (event) => changes.push(event.reason));
    form.renameId("province", "region");
    expect(formIds(form)).toEqual(["region"]);
    expect(inCatalog(mode, "receipt")).toBe("region/region");
    expect(inTree(tree)).toBe("region/region");
    // One change of the form's; the layout said once.
    expect(changes).toEqual(["edit"]);
    expect(reported).toEqual(["layouts:receipt"]);
    // No entry on the tree: the form's rename is the one step, which the designer on the page reaches.
    expect(tree.canUndo()).toBe(false);
    expect(mode.history!()?.canUndo()).toBe(true);
    form.undo();
    expect(formIds(form)).toEqual(["province"]);
    expect(inCatalog(mode, "receipt")).toBe("province/province");
    expect(inTree(tree)).toBe("province/province");
    expect(tree.canUndo()).toBe(false);
    expect(tree.canRedo()).toBe(false);
    expect(form.canUndo()).toBe(false);
    // The designer was not built again over the change: the same controller, still on the page.
    expect(mode.controller).toBe(tree);
    form.redo();
    expect(formIds(form)).toEqual(["region"]);
    expect(inCatalog(mode, "receipt")).toBe("region/region");
    expect(inTree(tree)).toBe("region/region");
    expect(tree.canUndo()).toBe(false);
    expect(entries(form)).toEqual(["RENAME_COMPONENT"]);
  });

  it("takes every built tree along, on the page and off it, and a layout never opened, in the same one step", async () => {
    const { form, mode } = setUp({ layouts: [bound("receipt", "Receipt"), bound("other", "Other"), bound("closed", "Closed")] });
    await open(mode);
    const receipt = mode.controller;
    await mode.selectLayout("other");
    await until(() => mode.ready && mode.layoutId === "other");
    const other = mode.controller;
    expect(other).not.toBe(receipt);
    form.renameId("province", "region");
    expect([inTree(receipt), inTree(other)]).toEqual(["region/region", "region/region"]);
    expect(["receipt", "other", "closed"].map((id) => inCatalog(mode, id))).toEqual(["region/region", "region/region", "region/region"]);
    expect([receipt.canUndo(), other.canUndo()]).toEqual([false, false]);
    expect(entries(form)).toEqual(["RENAME_COMPONENT"]);
    form.undo();
    expect([inTree(receipt), inTree(other)]).toEqual(["province/province", "province/province"]);
    expect(["receipt", "other", "closed"].map((id) => inCatalog(mode, id))).toEqual(["province/province", "province/province", "province/province"]);
    expect([receipt.canUndo(), other.canUndo()]).toEqual([false, false]);
    expect(form.canUndo()).toBe(false);
    form.redo();
    expect([inTree(receipt), inTree(other)]).toEqual(["region/region", "region/region"]);
    expect(inCatalog(mode, "closed")).toBe("region/region");
    expect([receipt.canUndo(), other.canUndo()]).toEqual([false, false]);
  });

  it("keeps the order across the two histories: an edit in the layout since is taken back first, then the rename, and Redo goes the other way", async () => {
    const { form, mode } = setUp({ layouts: [bound("receipt", "Receipt")] });
    await open(mode);
    const tree = mode.controller;
    form.renameId("province", "region");
    tree.setProperty(tree.rootId(), "name", "Edited");
    // The edit on the page is newer: the form's step is not live until it is taken back.
    expect(mode.history!()?.canUndo() ?? false).toBe(false);
    tree.undo();
    expect(rootName(tree)).toBe("Receipt");
    expect(inTree(tree)).toBe("region/region");
    // No stray "follow the rename" step on the tree: what is left to undo is the form's rename.
    expect(tree.canUndo()).toBe(false);
    expect(mode.history!()?.undo()).toBe(true);
    expect(formIds(form)).toEqual(["province"]);
    expect(inTree(tree)).toBe("province/province");
    expect(inCatalog(mode, "receipt")).toBe("province/province");
    // Redo: the rename, then the edit, which still names the layout.
    expect(mode.history!()?.redo()).toBe(true);
    expect(inTree(tree)).toBe("region/region");
    expect(tree.canRedo()).toBe(true);
    tree.redo();
    expect(rootName(tree)).toBe("Edited");
    expect(inTree(tree)).toBe("region/region");
    expect(mode.layouts[0]!.name).toBe("Edited");
  });

  it("leaves the trees and the catalog with the form's id when a host's change listener throws on the rename's Undo", async () => {
    const form = new BuilderController({ initialRoot: structuredClone(FORM) });
    let failing = false;
    const mode = pdfMode(form, { layouts: [bound("a", "A"), bound("b", "B")] }, {
      formRoot: () => form.snapshot(),
      onChange: () => {
        if (failing) {
          throw new Error("host");
        }
      }
    });
    form.on("change", (event) => {
      if (event.renamed && event.historyStep === undefined) {
        mode.formRenamed!(event.renamed);
      }
    });
    await open(mode);
    const tree = mode.controller;
    form.renameId("province", "region");
    failing = true;
    try {
      form.undo();
    } catch {
      // Whether the bar's Undo says the failure is the controller's; what stands after it is the point.
    }
    failing = false;
    expect(formIds(form)).toEqual(["region"]);
    expect(inTree(tree)).toBe("region/region");
    expect(["a", "b"].map((id) => inCatalog(mode, id))).toEqual(["region/region", "region/region"]);
  });
});

/*
 * A catalog step held by the designer on the page against what the page does since, its own edits
 * and their follow-ups on the form: a page edit whose wording leaves the form writes a follow-up
 * there, which the page's own Undo and Redo take back and make again with the edit, so the order
 * across the two histories stays whole and the held step is live again once the page is back.
 */
describe("a catalog step held by the designer, after a page edit with a follow-up on the form", () => {
  const FRENCH: FormTranslations = { fr: { pdf: { a: { nodes: { title: { text: { text: "Reçu", source: sourceHash("Receipt") } } } } } } } as FormTranslations;

  function translatedForm(map: FormTranslations): BuilderController {
    const form = new BuilderController({ initialRoot: FORM, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations(structuredClone(map), { silent: true });
    return form;
  }

  const bodyIds = (tree: BuilderController): string[] => (tree.snapshot().children?.body ?? []).map((node) => node.id);

  it("PDF: a layout deleted, then a translated node deleted and its deletion undone on the page: the designer's Undo takes the layout deletion back, and Redo goes the same way", async () => {
    const form = translatedForm(FRENCH);
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] });
    await open(mode);
    const page = mode.controller;
    mode.removeLayout("c");
    page.remove("title");
    expect(form.translations()?.fr?.pdf?.a).toBeUndefined();
    // The page's edit is newer than the deletion: the shell undoes the page first.
    expect(mode.history!()?.canUndo() ?? false).toBe(false);
    page.undo();
    expect(bodyIds(page)).toEqual(["title"]);
    expect(form.translations()).toEqual(FRENCH);
    expect(page.canUndo()).toBe(false);
    // The page is back where it stood: the deletion is the next thing to take back, from here.
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(form.translations()).toEqual(FRENCH);
    expect(form.canUndo()).toBe(false);
    expect(mode.controller).toBe(page);
    // Redo: the deletion first, then the page's edit with its follow-up, then nothing.
    expect(mode.history!()?.canRedo()).toBe(true);
    expect(mode.history!()?.redo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(mode.history!()?.canRedo() ?? false).toBe(false);
    expect(page.canRedo()).toBe(true);
    page.redo();
    expect(bodyIds(page)).toEqual([]);
    expect(form.translations()?.fr?.pdf?.a).toBeUndefined();
    expect(form.canRedo()).toBe(false);
    // And back down again in order: the page's edit, then the deletion.
    page.undo();
    expect(form.translations()).toEqual(FRENCH);
    expect(mode.history!()?.undo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(form.canUndo()).toBe(false);
  });

  it("Journeys: a journey deleted, then a translated page deleted and its deletion undone on the page: the designer's Undo takes the journey deletion back, and Redo goes the same way", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Intake" },
      children: { content: ["fullName", "notes", "email"].map((id) => ({ id, type: "text", configuration: { label: id } })) }
    };
    const wording = { fr: { journeys: { intake: { pages: { more: { title: { text: "Plus", source: sourceHash("More") } } } } } } } as FormTranslations;
    const form = new BuilderController({ initialRoot: root, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations(structuredClone(wording), { silent: true });
    const mode = createJourneyBuilderMode({
      form,
      journey: {
        journeys: [
          { id: "intake", name: "Intake", pages: [{ id: "about", title: "About", components: ["fullName"] }, { id: "more", title: "More", components: ["notes"] }] },
          { id: "quick", name: "Quick", pages: [{ id: "all", components: ["email"] }] }
        ]
      }
    });
    modes.push(mode);
    await mode.activate!({ host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    await until(() => mode.ready);
    const page = mode.controller;
    const pageIds = (): string[] => (page.snapshot().children?.pages ?? []).map((node) => (node.configuration as { pageId: string }).pageId);
    mode.removeJourney("quick");
    expect(mode.journeyId).toBe("intake");
    const more = (page.snapshot().children?.pages ?? []).find((node) => (node.configuration as { pageId: string }).pageId === "more")!;
    page.remove(more.id);
    expect(pageIds()).toEqual(["about"]);
    expect(form.translations()?.fr?.journeys?.intake).toBeUndefined();
    expect(mode.history!()?.canUndo() ?? false).toBe(false);
    page.undo();
    expect(pageIds()).toEqual(["about", "more"]);
    expect(form.translations()).toEqual(wording);
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(mode.journeys.map((entry) => entry.id)).toEqual(["intake", "quick"]);
    expect(form.translations()).toEqual(wording);
    expect(form.canUndo()).toBe(false);
    expect(mode.history!()?.redo()).toBe(true);
    expect(mode.journeys.map((entry) => entry.id)).toEqual(["intake"]);
    expect(mode.history!()?.canRedo() ?? false).toBe(false);
    page.redo();
    expect(pageIds()).toEqual(["about"]);
    expect(form.translations()?.fr?.journeys?.intake).toBeUndefined();
    expect(form.canRedo()).toBe(false);
  });
});

/*
 * A page edit's follow-up the page's Undo took back sits on the form's redo side for the page's
 * Redo to make again with the edit. A new edit on the page ends the page's Redo, so it ends the
 * form's too: the Form workspace's Redo must not prune wording the layout or journey still uses.
 */
describe("a follow-up the page's Undo took back, after a new edit on the page", () => {
  function twoNodes(id: string): PdfGeneratedLayout {
    const made = layout(id, id.toUpperCase());
    made.root.children!.body!.push({ id: "sub", type: "pdf-text", configuration: { text: "Sub" } });
    return made;
  }

  function translatedForm(map: FormTranslations): BuilderController {
    const form = new BuilderController({ initialRoot: FORM, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations(structuredClone(map), { silent: true });
    return form;
  }

  const bodyIds = (tree: BuilderController): string[] => (tree.snapshot().children?.body ?? []).map((node) => node.id);
  const TITLE = { title: { text: { text: "Reçu", source: sourceHash("Receipt") } } };
  const SUB = { sub: { text: { text: "Sous", source: sourceHash("Sub") } } };

  it("PDF: a translated node deleted and undone on the page, another node edited: the Form workspace's Redo has nothing to make, and the wording stays", async () => {
    const wording = { fr: { pdf: { a: { nodes: TITLE } } } } as FormTranslations;
    const form = translatedForm(wording);
    const mode = pdfMode(form, { layouts: [twoNodes("a"), layout("b", "B")] });
    await open(mode);
    const page = mode.controller;
    let heard = 0;
    mode.subscribeHistory!(() => (heard += 1));
    page.remove("title");
    expect(form.translations()?.fr?.pdf?.a).toBeUndefined();
    page.undo();
    expect(form.translations()).toEqual(wording);
    expect(form.canRedo()).toBe(true);
    heard = 0;
    page.setProperty("sub", "text", "Sub edited");
    expect(page.canRedo()).toBe(false);
    expect(form.canRedo()).toBe(false);
    // The bar on the page hears that the form's history moved.
    expect(heard).toBeGreaterThan(0);
    expect(mode.history!()?.canRedo() ?? false).toBe(false);
    mode.deactivate!();
    form.redo();
    expect(form.translations()).toEqual(wording);
    expect(bodyIds(page)).toEqual(["title", "sub"]);
  });

  it("PDF: the new edit has a follow-up of its own: it alone ends the form's redo side, and the page's Undo takes it back with the edit", async () => {
    const wording = { fr: { pdf: { a: { nodes: { ...TITLE, ...SUB } } } } } as FormTranslations;
    const form = translatedForm(wording);
    const mode = pdfMode(form, { layouts: [twoNodes("a")] });
    await open(mode);
    const page = mode.controller;
    page.remove("title");
    page.undo();
    expect(form.canRedo()).toBe(true);
    let changes = 0;
    form.on("change", () => (changes += 1));
    page.remove("sub");
    expect(form.translations()?.fr?.pdf?.a?.nodes).toEqual(TITLE);
    expect(form.canRedo()).toBe(false);
    // One change of the form's, its follow-up's own entry.
    expect(changes).toBe(1);
    expect((form.undoMark() as { id: string }).id).toBe("TRANSLATIONS");
    page.undo();
    expect(bodyIds(page)).toEqual(["title", "sub"]);
    expect(form.translations()).toEqual(wording);
    expect(form.canUndo()).toBe(false);
  });

  it("Journeys: a translated page deleted and undone on the page, another page edited: the Form workspace's Redo has nothing to make, and the wording stays", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Intake" },
      children: { content: ["fullName", "notes"].map((id) => ({ id, type: "text", configuration: { label: id } })) }
    };
    const wording = { fr: { journeys: { intake: { pages: { more: { title: { text: "Plus", source: sourceHash("More") } } } } } } } as FormTranslations;
    const form = new BuilderController({ initialRoot: root, localization: { supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "en" } });
    form.replaceTranslations(structuredClone(wording), { silent: true });
    const mode = createJourneyBuilderMode({
      form,
      journey: { journeys: [{ id: "intake", name: "Intake", pages: [{ id: "about", title: "About", components: ["fullName"] }, { id: "more", title: "More", components: ["notes"] }] }] }
    });
    modes.push(mode);
    await mode.activate!({ host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    await until(() => mode.ready);
    const page = mode.controller;
    const node = (pageId: string): ComponentNode => (page.snapshot().children?.pages ?? []).find((entry) => (entry.configuration as { pageId: string }).pageId === pageId)!;
    page.remove(node("more").id);
    expect(form.translations()?.fr?.journeys?.intake).toBeUndefined();
    page.undo();
    expect(form.translations()).toEqual(wording);
    expect(form.canRedo()).toBe(true);
    page.setProperty(node("about").id, "title", "About you");
    expect(mode.journeys[0]!.pages.map((entry) => entry.title)).toEqual(["About you", "More"]);
    expect(form.canRedo()).toBe(false);
    mode.deactivate!();
    form.redo();
    expect(form.translations()).toEqual(wording);
    expect(mode.journeys[0]!.pages.map((entry) => entry.id)).toEqual(["about", "more"]);
  });
});

describe("a catalog step held by a PDF designer off the page", () => {
  it("a layout removed, the page edited, the removal undone from the Form workspace: back on the page, Redo makes the removal again", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] });
    await open(mode);
    const page = mode.controller;
    mode.removeLayout("c");
    page.setProperty("title", "text", "Hi there");
    mode.deactivate!();
    // The Form workspace's Undo takes the removal back while the PDF page is not up.
    form.undo();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    await open(mode);
    expect(mode.controller).toBe(page);
    expect(mode.history!()?.canRedo()).toBe(true);
    expect(mode.history!()?.redo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect((page.snapshot().children?.body?.[0]?.configuration as { text: string }).text).toBe("Hi there");
  });
});

describe("a restore that brings wording back through the agent's catalog seam", () => {
  it("PDF: is held by the designer on the page, ahead of the page's older edit", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    form.replaceTranslations({ fr: { pdf: { b: { name: { text: "Bé", source: sourceHash("B") } } } } } as FormTranslations, { silent: true });
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] });
    await open(mode);
    const page = mode.controller;
    page.setProperty("title", "text", "Hi there");
    const withB = structuredClone(mode.pdfConfiguration);
    mode.removeLayout("b");
    expect(form.translations()?.fr?.pdf?.b).toBeUndefined();
    mode.applyCatalogForAgent(withB, "b");
    expect(form.translations()?.fr?.pdf?.b).toBeDefined();
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(form.translations()?.fr?.pdf?.b).toBeUndefined();
    // The page's own edit is still there for its own Undo.
    expect((page.snapshot().children?.body?.[0]?.configuration as { text: string }).text).toBe("Hi there");
    expect(page.canUndo()).toBe(true);
  });

  it("Journeys: is held by the designer on the page too, as one entry however many journeys come back worded", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const wording = { fr: { journeys: { b: { name: { text: "Bé", source: sourceHash("B") } }, c: { name: { text: "Cé", source: sourceHash("C") } } } } } as FormTranslations;
    form.replaceTranslations(structuredClone(wording), { silent: true });
    const mode = createJourneyBuilderMode({ form, journey: { journeys: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), pages: [{ id: "p", components: ["province"] }] })) } });
    modes.push(mode);
    await mode.activate!({ host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    await until(() => mode.ready);
    const all = structuredClone(mode.journeyConfiguration);
    mode.removeJourney("b");
    mode.removeJourney("c");
    const top = form.undoMark();
    mode.applyCatalogForAgent(all, "b");
    expect(form.translations()).toEqual(wording);
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(form.undoMark()).toBe(top);
    expect(mode.journeys.map((entry) => entry.id)).toEqual(["a"]);
    expect(form.translations()?.fr?.journeys).toBeUndefined();
  });
});

describe("a catalog action whose change a host's listener throws on", () => {
  it("still records the whole action as one entry held by the designer: one Undo brings the layout and its wording back", async () => {
    const form = new BuilderController({ initialRoot: FORM });
    const wording = { fr: { pdf: { b: { name: { text: "Bé", source: sourceHash("B") } } } } } as FormTranslations;
    form.replaceTranslations(structuredClone(wording), { silent: true });
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] });
    await open(mode);
    const off = form.on("change", (event) => {
      if (event.reason === "edit") {
        throw new Error("host listener");
      }
    });
    expect(() => mode.removeLayout("b")).toThrow("host listener");
    off();
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(form.translations()?.fr?.pdf?.b).toBeUndefined();
    expect(mode.history!()?.canUndo()).toBe(true);
    expect(mode.history!()?.undo()).toBe(true);
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(form.translations()).toEqual(wording);
    expect(form.canUndo()).toBe(false);
  });
});

describe("a joined entry's parts", () => {
  it("are announced as one step: a translated layout removed publishes one execute", () => {
    const form = new BuilderController({ initialRoot: FORM });
    form.replaceTranslations({ fr: { pdf: { b: { name: { text: "Bé", source: sourceHash("B") } } } } } as FormTranslations, { silent: true });
    const mode = pdfMode(form, { layouts: [layout("a", "A"), layout("b", "B"), layout("c", "C")] });
    const executes: string[] = [];
    form.on("mutation", (event) => {
      if (event.action === "execute") {
        executes.push(event.commandId);
      }
    });
    mode.removeLayout("b");
    expect(executes).toHaveLength(1);
    expect(entries(form)).toHaveLength(1);
  });
});
