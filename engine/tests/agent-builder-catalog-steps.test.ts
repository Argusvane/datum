// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { createPdfBuilderMode, type PdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { documentsBuilder, journeySide, pdfSide, type DocumentsBuilder } from "./fixtures/agent-builder-documents-fakes.js";
import { okOf, type AgentBuilder } from "./fixtures/agent-builder.js";

/**
 * An agent's catalog action over the real modes wired to the form:
 * every one (a journey or a PDF layout made, copied, renamed or removed, the default chosen, the
 * layouts' order changed) is a step of the form's history, and so it is taken back by the form's
 * Undo alone. Its outside-journal entry says so (`stepped`) and has no inverse of its own: Undo
 * all, `end_session { undo: true }` and the agent's counts see one record, and the person's Redo
 * afterwards makes it again once. The catalog seam a journal inverse goes through
 * (`restore_removed`) writes no step of its own unless wording comes back with the document: then
 * one step holds the whole restore, and either way the restore is one record.
 */

const JSON_OF = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const JOURNEYS: JourneyConfiguration = {
  journeys: [
    { id: "a", name: "A", pages: [{ id: "p", components: ["full_name"] }] },
    { id: "b", name: "B", pages: [{ id: "p", components: ["email"] }] },
    { id: "c", name: "C", pages: [{ id: "p", components: ["details"] }] }
  ],
  defaultJourneyId: "b",
  opensAs: "journey"
};

const MODE_FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: { content: [{ id: "firstName", type: "text", configuration: { label: "First name" } }] }
};

function layout(id: string, name: string): PdfGeneratedLayout {
  return { id, kind: "generated", name, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
}

const LAYOUTS: PdfConfiguration = { layouts: [layout("a", "Summary"), layout("b", "Full"), layout("c", "Third")], defaultLayoutId: "a" };

async function until(check: () => unknown): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
}

const modes: Array<JourneyBuilderMode | PdfBuilderMode> = [];
afterEach(() => {
  for (const mode of modes.splice(0)) {
    mode.dispose?.();
  }
  document.body.innerHTML = "";
});

function journeys(): { set: DocumentsBuilder; mode: JourneyBuilderMode } {
  const set = documentsBuilder();
  const mode = createJourneyBuilderMode({ form: set.builder.controller, journey: JSON_OF(JOURNEYS) });
  modes.push(mode);
  set.ui.journeys = () => journeySide(mode);
  return { set, mode };
}

/** The real PDF mode wired to the agent builder's form, on a page, its first layout's designer built. */
async function layouts(pdf: PdfConfiguration = LAYOUTS): Promise<{ set: DocumentsBuilder; mode: PdfBuilderMode }> {
  const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
  let mode: PdfBuilderMode | undefined;
  const state: FormState = {
    values: {},
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
  const runtime: RenderableRuntime = {
    formRoot: () => MODE_FORM,
    state: () => state,
    errors: () => [],
    effectiveStatesMap: () => new Map(),
    requiredMap: () => new Map(),
    componentTree: () => new ComponentTree(MODE_FORM),
    resolveDataSource: async () => undefined,
    pdfConfiguration: () => mode?.pdfConfiguration
  };
  const made = createPdfBuilderMode({ formRoot: () => structuredClone(MODE_FORM), runtime: () => runtime, locale: () => "en", pdf: JSON_OF(pdf), form: () => set.builder.controller });
  mode = made;
  modes.push(made);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.append(...(made.overlays ?? []));
  await made.activate!({ host, root, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
  await until(() => made.ready);
  set.ui.pdfLayouts = () => pdfSide(made);
  set.ui.selectDocument = () => Promise.resolve({ status: "opened" });
  set.stub.state.activeController = made.controller;
  return { set, mode: made };
}

type Act = (set: DocumentsBuilder) => ReturnType<AgentBuilder["execute"]>;

const JOURNEY_ACTS: Record<string, Act> = {
  new: (set) => set.builder.execute("documents", { action: "new", kind: "journey", name: "Nu" }),
  duplicate: (set) => set.builder.execute("documents", { action: "duplicate", kind: "journey", id: "b" }),
  rename: (set) => set.builder.execute("documents", { action: "rename", kind: "journey", id: "b", name: "Bee" }),
  remove: (set) => set.builder.execute("remove_part", { kind: "journey", id: "b" }),
  "set default": (set) => set.builder.execute("documents", { action: "set_default", kind: "journey", id: "c" }),
  "opens whole": (set) => set.builder.execute("documents", { action: "set_default", kind: "journey", id: "form" })
};

const LAYOUT_ACTS: Record<string, Act> = {
  "new from the form": (set) => set.builder.execute("documents", { action: "new", kind: "pdf_layout", name: "Fresh", from: "form" }),
  "new blank": (set) => set.builder.execute("documents", { action: "new", kind: "pdf_layout", name: "Fresh", from: "blank" }),
  duplicate: (set) => set.builder.execute("documents", { action: "duplicate", kind: "pdf_layout", id: "b" }),
  // "b" has no designer built: the new name is the form's step, not a tree's.
  rename: (set) => set.builder.execute("documents", { action: "rename", kind: "pdf_layout", id: "b", name: "Bee" }),
  "set default": (set) => set.builder.execute("documents", { action: "set_default", kind: "pdf_layout", id: "b" }),
  move: (set) => set.builder.execute("documents", { action: "move", kind: "pdf_layout", id: "c", toIndex: 0 }),
  remove: (set) => set.builder.execute("remove_part", { kind: "pdf_layout", id: "b" })
};

describe("an agent's catalog action that is a form step has one record", () => {
  for (const [action, act] of Object.entries(JOURNEY_ACTS)) {
    it(`journey ${action}: reported as one form step, taken back by end_session { undo: true } once, made again by one Redo`, async () => {
      const { set, mode } = journeys();
      const form = set.builder.controller;
      okOf(await set.builder.execute("begin_session", { purpose: "Journeys" }));
      const result = okOf(await act(set));
      expect(result.undo).toMatchObject({ steps: 1 });
      const after = JSON_OF(mode.journeyConfiguration);
      expect(after).not.toEqual(JOURNEYS);
      const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
      expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
      expect(JSON_OF(mode.journeyConfiguration)).toEqual(JOURNEYS);
      expect(form.canUndo()).toBe(false);
      // The person's Redo makes the agent's action again, once.
      form.redo();
      expect(JSON_OF(mode.journeyConfiguration)).toEqual(after);
      expect(form.canRedo()).toBe(false);
    });
  }

  for (const [action, act] of Object.entries(LAYOUT_ACTS)) {
    it(`PDF layout ${action}: reported as one form step, taken back by end_session { undo: true } once, made again by one Redo`, async () => {
      const { set, mode } = await layouts();
      const form = set.builder.controller;
      const before = JSON_OF(mode.pdfConfiguration);
      okOf(await set.builder.execute("begin_session", { purpose: "Layouts" }));
      const result = okOf(await act(set));
      expect(result.undo).toMatchObject({ steps: 1 });
      expect(result.undo).not.toHaveProperty("journaled");
      const after = JSON_OF(mode.pdfConfiguration);
      expect(after).not.toEqual(before);
      const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
      expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
      expect(JSON_OF(mode.pdfConfiguration)).toEqual(before);
      expect(form.canUndo()).toBe(false);
      form.redo();
      expect(JSON_OF(mode.pdfConfiguration)).toEqual(after);
      expect(form.canRedo()).toBe(false);
    });
  }

  /** Each side over the real mode, "b" worded in French: the catalog, its translations and a restore's step. */
  const TRANSLATED = {
    journey: async () => {
      const { set, mode } = journeys();
      set.builder.controller.setOptions({ translations: { "fr-CA": { journeys: { b: { name: { text: "Bé", source: sourceHash("B") } } } } } });
      return { set, catalog: () => JSON_OF(mode.journeyConfiguration), wording: () => set.builder.controller.translations()?.["fr-CA"]?.journeys?.b };
    },
    pdf_layout: async () => {
      const { set, mode } = await layouts();
      set.builder.controller.setOptions({ translations: { "fr-CA": { pdf: { b: { name: { text: "Complet", source: sourceHash("Full") } } } } } });
      return { set, catalog: () => JSON_OF(mode.pdfConfiguration), wording: () => set.builder.controller.translations()?.["fr-CA"]?.pdf?.b };
    }
  } as const;
  const labelOf = (set: DocumentsBuilder): unknown => ((set.builder.controller.snapshot().children?.content ?? []).find((node) => node.id === "full_name")?.configuration as { label?: unknown } | undefined)?.label;
  const removeB = (set: DocumentsBuilder, kind: "journey" | "pdf_layout") => set.builder.execute("remove_part", { kind, id: "b" });
  const restoreB = (set: DocumentsBuilder, kind: "journey" | "pdf_layout") => set.builder.execute("documents", { action: "restore_removed", kind, id: "b" });

  for (const kind of ["journey", "pdf_layout"] as const) {
    it(`a translated ${kind} removed and restored in one session: Undo all brings back what was there, and the person's Redo makes both again, the wording with it`, async () => {
      const { set, catalog, wording } = await TRANSLATED[kind]();
      const form = set.builder.controller;
      const start = catalog();
      const worded = wording();
      expect(worded).toBeDefined();
      // The person's own step under the session: Undo all stops at it, so the count is the session's.
      form.setProperty("full_name", "label", "Person's label");
      const personMark = form.undoMark();
      okOf(await set.builder.execute("begin_session", { purpose: "Documents" }));
      expect(okOf(await removeB(set, kind)).undo).toMatchObject({ steps: 1 });
      expect(wording()).toBeUndefined();
      // The restore with its wording is one form step: the step holds the document too.
      expect(okOf(await restoreB(set, kind)).undo).toMatchObject({ steps: 1 });
      expect(wording()).toEqual(worded);
      const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
      expect(ended.session).toMatchObject({ undone: 2, undoable: 0 });
      expect(catalog()).toEqual(start);
      expect(wording()).toEqual(worded);
      expect(form.undoMark()).toBe(personMark);
      expect(labelOf(set)).toBe("Person's label");
      form.redo();
      expect(wording()).toBeUndefined();
      form.redo();
      expect(catalog()).toEqual(start);
      expect(wording()).toEqual(worded);
      expect(form.canRedo()).toBe(false);
    });

    it(`a translated ${kind} restored in a later session: that session's Undo all takes the restore back, the document and its wording together`, async () => {
      const { set, catalog, wording } = await TRANSLATED[kind]();
      const form = set.builder.controller;
      const worded = wording();
      okOf(await set.builder.execute("begin_session", { purpose: "Remove" }));
      okOf(await removeB(set, kind));
      okOf(await set.builder.execute("end_session", { summary: "Done." }));
      const removed = catalog();
      okOf(await set.builder.execute("begin_session", { purpose: "Restore" }));
      okOf(await restoreB(set, kind));
      expect(wording()).toEqual(worded);
      const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
      expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
      expect(catalog()).toEqual(removed);
      expect(wording()).toBeUndefined();
      // The person's Redo makes the restore again, whole.
      form.redo();
      expect(wording()).toEqual(worded);
      expect(form.canRedo()).toBe(false);
    });

    it(`a ${kind} restored with no wording to bring back is one record, the journal's: Undo all takes it away once`, async () => {
      const { set } = kind === "journey" ? journeys() : await layouts();
      const form = set.builder.controller;
      okOf(await set.builder.execute("begin_session", { purpose: "Remove" }));
      okOf(await removeB(set, kind));
      okOf(await set.builder.execute("end_session", { summary: "Done." }));
      const depth = form.undoMark();
      okOf(await set.builder.execute("begin_session", { purpose: "Restore" }));
      const restored = okOf(await restoreB(set, kind));
      expect(restored.undo).toMatchObject({ steps: 0, journaled: true });
      expect(form.undoMark()).toBe(depth);
      const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
      expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
      expect(form.undoMark()).toBe(depth);
    });
  }

  it("the agent's own history undo takes the step back, and a later Undo all has nothing left of it", async () => {
    const { set, mode } = journeys();
    okOf(await set.builder.execute("begin_session", { purpose: "Journeys" }));
    okOf(await JOURNEY_ACTS.remove!(set));
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(JSON_OF(mode.journeyConfiguration)).toEqual(JOURNEYS);
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(JSON_OF(mode.journeyConfiguration)).toEqual(JOURNEYS);
  });
});

describe("an agent's PDF layout made is a form step like every catalog action", () => {
  it("a PDF layout made: one form step, no journal inverse; end_session { undo: true } takes it away once and the person's Redo brings it back", async () => {
    const { set, mode } = await layouts();
    const form = set.builder.controller;
    okOf(await set.builder.execute("begin_session", { purpose: "Layouts" }));
    const made = okOf(await set.builder.execute("documents", { action: "new", kind: "pdf_layout", name: "Fresh", from: "blank" }));
    expect(made.undo).toMatchObject({ steps: 1, canUndo: true });
    expect(made.undo).not.toHaveProperty("journaled");
    expect(mode.layouts).toHaveLength(4);
    const fresh = JSON_OF(mode.layouts[3]);
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
    expect(mode.layouts.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(form.canUndo()).toBe(false);
    form.redo();
    expect(JSON_OF(mode.layouts[3])).toEqual(fresh);
    expect(form.canRedo()).toBe(false);
  });
});

/*
 * A catalog action whose wording moves with it is one joined entry of the form's history, however
 * many parts it took (the wording's rewrite, the block's change): the agent counts that one step,
 * and Undo all takes back that one, never the person's step under the session.
 */
describe("an agent's translated catalog action over a person's earlier step", () => {
  const TRANSLATIONS = {
    journey: { "fr-CA": { journeys: { b: { name: { text: "Bé", source: sourceHash("B") } } } } },
    pdf_layout: { "fr-CA": { pdf: { b: { name: { text: "Complet", source: sourceHash("Full") } } } } }
  } as const;
  const label = (set: DocumentsBuilder): unknown => ((set.builder.controller.snapshot().children?.content ?? []).find((node) => node.id === "full_name")?.configuration as { label?: unknown } | undefined)?.label;

  for (const kind of ["journey", "pdf_layout"] as const) {
    for (const op of ["remove", "duplicate"] as const) {
      it(`${kind} ${op}: one step, and end_session { undo: true } takes back that one and leaves the person's edit`, async () => {
        const { set } = kind === "journey" ? journeys() : await layouts();
        const form = set.builder.controller;
        form.setOptions({ translations: structuredClone(TRANSLATIONS[kind]) as never });
        form.setProperty("full_name", "label", "Person's label");
        const personMark = form.undoMark();
        okOf(await set.builder.execute("begin_session", { purpose: "Documents" }));
        const done = okOf(await (op === "remove" ? set.builder.execute("remove_part", { kind, id: "b" }) : set.builder.execute("documents", { action: "duplicate", kind, id: "b" })));
        expect(done.undo).toMatchObject({ steps: 1, ownSteps: 1 });
        const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
        expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
        expect(form.undoMark()).toBe(personMark);
        expect(label(set)).toBe("Person's label");
      });
    }
  }

  it("a field renamed that a built PDF layout follows: the layout's follow-up joins the rename's entry, one step, and Undo all leaves the person's edit", async () => {
    const bound: PdfGeneratedLayout = {
      id: "a",
      kind: "generated",
      name: "Summary",
      when: { kind: "path", path: "email" },
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "field", type: "pdf-field", configuration: { componentId: "email" } }], header: [], footer: [] } }
    };
    const { set, mode } = await layouts({ layouts: [bound, layout("b", "Full")], defaultLayoutId: "a" });
    const form = set.builder.controller;
    // As the shell wires it: the rename a change announces, never an Undo's or a Redo's, reaches the mode.
    form.on("change", (event) => {
      if (event.renamed && event.historyStep === undefined) {
        mode.formRenamed!(event.renamed);
      }
    });
    form.setProperty("full_name", "label", "Person's label");
    const personMark = form.undoMark();
    // The rename is made on the Form workspace; the layout's designer stays built behind it.
    Object.assign(set.stub.state, { mode: "form", workspace: "form", activeController: undefined });
    okOf(await set.builder.execute("begin_session", { purpose: "Rename" }));
    const renamed = okOf(await set.builder.execute("rename_component", { componentId: "email", newId: "contact_email" }));
    expect(renamed.undo).toMatchObject({ steps: 1, ownSteps: 1 });
    expect((mode.layouts[0] as PdfGeneratedLayout).when).toEqual({ kind: "path", path: "contact_email" });
    expect(mode.controller.canUndo()).toBe(false);
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
    expect((mode.layouts[0] as PdfGeneratedLayout).when).toEqual({ kind: "path", path: "email" });
    expect(form.undoMark()).toBe(personMark);
    expect(label(set)).toBe("Person's label");
  });
});
