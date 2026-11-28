// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderCallScope } from "../form-engine/agent/builder/context.js";
import type { DesignerSide, PdfActions } from "../form-engine/agent/builder/host.js";
import { OUTSIDE_JOURNAL_CAP } from "../form-engine/agent/builder/outside-journal.js";
import type { BuilderSessionHooks } from "../form-engine/agent/builder/session.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfBuilderMode, type PdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfGeneratedLayout, PdfLayoutDocument } from "../form-engine/core/schema/pdf-layout.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { fakePage, type FakePage } from "./fixtures/agent-builder-adapters.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, okOf, uiStub, type AgentBuilder, type UiStub } from "./fixtures/agent-builder.js";

/**
 * The builder catalogue's outside journal: every entry kind recorded after its act and reversed through the fake adapters and the
 * controllers; each kept reason; the cap of 100 with the drop counted; Undo all interleaved with
 * the form steps newest first by `depthAt`; a form step undone meanwhile skipped; the
 * save barrier on the result and the banner; the layout follower's agent-top count; and
 * the journal emptied on a reseed. The bodies are stubs, so each test plays the tool:
 * capture, act inside `shared.write`, record.
 *
 * The last describes hold the cases where what the person did since an entry stays theirs (a
 * default chosen after a removal, a translation written after a rename), a layout the person
 * removed is `history-gone`, the lifecycle cleanups, the banner's counts with journal entries,
 * the writing flag under the inverses, and a real PDF mode, whose rename pushes the name into a
 * built designer as a step on that layout's history (the fakes push none). jsdom: the real mode
 * mounts its designer.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

interface Page {
  builder: AgentBuilder;
  stub: UiStub;
  page: FakePage;
}

function setUp(options: { pdf?: PdfConfiguration; journeys?: JourneyConfiguration } = {}): Page {
  const stub = uiStub();
  const builder = agentBuilder({ ui: stub });
  const page = fakePage(builder.controller, { tryIt: false, ...(options.pdf !== undefined ? { pdf: options.pdf } : {}), ...(options.journeys !== undefined ? { journeys: options.journeys } : {}) });
  stub.state.journeys = page.journeys.side();
  stub.state.pdf = page.pdf.side();
  return { builder, stub, page };
}

function scopeOf(builder: AgentBuilder): BuilderCallScope {
  return builder.catalogue.shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
}

/** Runs `run` as a tool's write (the writing flag up). */
function asTool(builder: AgentBuilder, scope: BuilderCallScope, run: () => void): void {
  builder.catalogue.shared.write(scope, run);
}

/** A layout's own controller (one per layout, PBM), holding one field. */
function layoutController(): BuilderController {
  const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "field", type: "text", configuration: { label: "Field" } }] } };
  return new BuilderController({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
}

/** What the session hooks' `end()` returned the last time the registrar called it. */
function lastEnd(builder: AgentBuilder): ReturnType<BuilderSessionHooks["end"]> {
  const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
  return (hooks.end as unknown as { mock: { results: Array<{ value: ReturnType<BuilderSessionHooks["end"]> }> } }).mock.results.at(-1)?.value as ReturnType<BuilderSessionHooks["end"]>;
}

const JSON_OF = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("each entry kind is recorded after its act and reversed by Undo all", () => {
  it("catalog: a journey made, renamed and made the default; a PDF layout moved", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const journeysBefore = JSON_OF(page.journeys.configuration);
    const pdfBefore = JSON_OF(page.pdf.configuration);
    okOf(await builder.execute("begin_session", { purpose: "Documents" }));
    const scope = scopeOf(builder);
    // new
    let before = journal.captureCatalog("journeys", "short");
    asTool(builder, scope, () => page.journeys.actions.addJourney({ id: "short", name: "Short", pages: [{ id: "p1", components: [] }] }));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "new", id: "short", before: before! });
    // rename
    before = journal.captureCatalog("journeys", "intake");
    expect(before).toMatchObject({ document: { id: "intake", name: "Intake" }, index: 0, defaults: { defaultJourneyId: "intake", opensAs: "journey" } });
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Intake form"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: before! });
    // set_default
    before = journal.captureCatalog("journeys", "short");
    asTool(builder, scope, () => page.journeys.actions.chooseOpensAs("short"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "set_default", id: "short", before: before! });
    // move (PDF layouts only)
    before = journal.captureCatalog("pdf", "cra-t2125");
    asTool(builder, scope, () => page.pdf.actions.move("cra-t2125", 0));
    journal.record(scope, { kind: "catalog", side: "pdf", action: "move", id: "cra-t2125", before: before! });
    expect(journal.forCall(scope.call).map((entry) => entry.kind)).toEqual(["catalog", "catalog", "catalog", "catalog"]);

    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 4, undoable: 0 });
    expect(JSON_OF(page.journeys.configuration)).toEqual(journeysBefore);
    expect(JSON_OF(page.pdf.configuration)).toEqual(pdfBefore);
    // Through the adapters only, the catalog seam for each (what it made included: the mode's own
    // removal is a step of the form's history, the seam writes none; a rename back included, so
    // no designer history moves).
    expect(page.journeys.calls.map((call) => call.method)).toEqual(["addJourney", "rename", "chooseOpensAs", "applyCatalog", "applyCatalog", "applyCatalog"]);
    expect(page.pdf.calls.map((call) => call.method)).toEqual(["move", "applyCatalog"]);
    expect(builder.catalogue.shared.memory.outside).toEqual([]);
  });

  it("catalog round trips are exact, an undeclared default included", async () => {
    const { builder, page } = setUp({ pdf: { layouts: [{ id: "a", kind: "generated", name: "A", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } }, { id: "b", kind: "generated", name: "B", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } }] } });
    const journal = builder.catalogue.shared.journal;
    const before = JSON_OF(page.pdf.configuration);
    expect(before).not.toHaveProperty("defaultLayoutId");
    okOf(await builder.execute("begin_session", { purpose: "Order" }));
    const scope = scopeOf(builder);
    const moved = journal.captureCatalog("pdf", "b");
    asTool(builder, scope, () => page.pdf.actions.move("b", 0));
    // The move wrote the default down (layout-catalog.ts), as the real catalog does.
    expect(page.pdf.configuration.defaultLayoutId).toBe("a");
    journal.record(scope, { kind: "catalog", side: "pdf", action: "move", id: "b", before: moved! });
    const defaulted = journal.captureCatalog("pdf", "b");
    asTool(builder, scope, () => page.pdf.actions.setDefault("b"));
    journal.record(scope, { kind: "catalog", side: "pdf", action: "set_default", id: "b", before: defaulted! });
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(JSON_OF(page.pdf.configuration)).toEqual(before);
  });

  it("removed: a layout and a journey come back at their index with their default", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const journeysBefore = JSON_OF(page.journeys.configuration);
    const pdfBefore = JSON_OF(page.pdf.configuration);
    okOf(await builder.execute("begin_session", { purpose: "Remove" }));
    const scope = scopeOf(builder);
    for (const [side, id] of [
      ["pdf", "summary"],
      ["journeys", "intake"]
    ] as const) {
      const capture = journal.captureRemoval(side, id);
      expect(capture).toMatchObject({ side, id, index: 0 });
      asTool(builder, scope, () => (side === "pdf" ? page.pdf.actions.remove(id) : page.journeys.actions.remove(id)));
      journal.record(scope, { kind: "removed", ...capture! });
    }
    expect(journal.restorable("pdf_layout", "summary")).toMatchObject({ kind: "removed", id: "summary" });
    expect(journal.restorable("journey", "intake")).toMatchObject({ kind: "removed", id: "intake" });
    expect(journal.restorable("journey", "nothing")).toBeUndefined();
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(JSON_OF(page.pdf.configuration)).toEqual(pdfBefore);
    expect(JSON_OF(page.journeys.configuration)).toEqual(journeysBefore);
    // Undone: Undo all dropped the entries. restorable's own catalog check is pinned by the next
    // case, where the entry is still held.
    expect(journal.restorable("pdf_layout", "summary")).toBeUndefined();
  });

  it("removed: restorable answers nothing once the id is back in the catalog, though the entry is still held", () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const capture = journal.captureRemoval("pdf", "summary");
    asTool(builder, scope, () => page.pdf.actions.remove("summary"));
    const entry = journal.record(scope, { kind: "removed", ...capture! });
    expect(journal.restorable("pdf_layout", "summary")).toBe(entry);
    // restore_removed puts the layout back through the seam and never consumes the entry,
    // so Undo all over a remove and a restore nets out: only the catalog says it is back.
    asTool(builder, scope, () => page.pdf.actions.addLayout(capture!.json as PdfLayoutDocument));
    expect(builder.catalogue.shared.memory.outside).toContain(entry);
    expect(journal.restorable("pdf_layout", "summary")).toBeUndefined();
  });

  it("layout-steps: the agent's step on a layout's own history is undone there", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const layout = layoutController();
    page.pdf.state.layoutController = layout;
    page.pdf.state.mappings = 3;
    okOf(await builder.execute("begin_session", { purpose: "Map" }));
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "cra-t2125", layout);
    const mapped = page.pdf.actions.suggestMappings({ batch: true, around: builder.catalogue.shared.around(scope) });
    expect(mapped).toBe(3);
    expect(builder.catalogue.shared.memory.layoutTop.get("cra-t2125")).toBe(1);
    journal.record(scope, { kind: "layout-steps", layoutId: "cra-t2125", steps: 1 });
    expect(layout.canUndo()).toBe(true);
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(layout.canUndo()).toBe(false);
    expect(layout.snapshot().configuration).toEqual({});
    // No entry names the layout any more: its follower is gone.
    expect(builder.catalogue.shared.memory.layoutFollowers.size).toBe(0);
  });

  it("settings and identity: Try it's stand-in Submit, a stand-in list and the form's identity come back", async () => {
    const { builder } = setUp();
    const journal = builder.catalogue.shared.journal;
    const controller = builder.controller;
    const submissionBefore = JSON_OF(controller.trySubmission());
    const identityBefore = controller.identity();
    okOf(await builder.execute("begin_session", { purpose: "Settings" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => {
      controller.setTrySubmission({ outcome: "refuse", refusalMessage: "Closed." });
      controller.setSimulatedDataSource("provinces", [{ value: "on", label: "Ontario" }]);
    });
    journal.record(scope, { kind: "settings", trySubmission: { before: submissionBefore as never }, sources: [{ sourceId: "provinces", before: undefined }] });
    asTool(builder, scope, () => controller.setIdentity({ id: "contact-request", version: "2.0.0", schemaVersion: "1" }));
    journal.record(scope, { kind: "identity", before: identityBefore });
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(JSON_OF(controller.trySubmission())).toEqual(submissionBefore);
    expect(controller.simulatedDataSources().has("provinces")).toBe(false);
    expect(controller.identity()).toEqual(identityBefore);
  });

  it("save: a barrier with no inverse; Undo all still runs, and its result and the banner say what the site keeps", async () => {
    const { builder, stub } = setUp();
    const journal = builder.catalogue.shared.journal;
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "Save" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    const saved = journal.record(scope, { kind: "save", revision: builder.registration.revision() });
    expect(builder.catalogue.shared.memory.lastSave).toEqual({ revision: builder.registration.revision(), at: saved.at });
    const ended = okOf(await builder.execute("end_session", { undo: true, summary: "Saved." }));
    expect(ended.session).toMatchObject({ undone: 1, undoable: 0 });
    // The barrier stays (it is never undone) and is reported once on the hooks' result.
    expect(lastEnd(builder).note).toEqual([`The site keeps the version saved at ${new Date(saved.at).toISOString()}; save again to keep the undo.`]);
    const banner = stub.state.session as { open: false; summary?: string };
    expect(banner.summary).toMatch(/^Saved\. The site keeps the version saved at .+; save again to keep the undo\.$/u);
  });
});

describe("kept entries", () => {
  it("person-edited: the person changed the document, the stand-in Submit or the identity since; their change stays", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    const controller = builder.controller;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const renamed = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Intake form"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: renamed! });
    const submission = JSON_OF(controller.trySubmission());
    asTool(builder, scope, () => controller.setTrySubmission({ outcome: "fail" }));
    journal.record(scope, { kind: "settings", trySubmission: { before: submission as never } });
    const identity = controller.identity();
    asTool(builder, scope, () => controller.setIdentity({ id: "contact-request", version: "2.0.0", schemaVersion: "1" }));
    journal.record(scope, { kind: "identity", before: identity });
    // The person's own changes, outside any call.
    page.journeys.actions.rename("intake", "Their name");
    controller.setTrySubmission({ outcome: "accept" });
    controller.setIdentity({ id: "contact-request", version: "3.0.0", schemaVersion: "1" });
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Their name");
    expect(controller.trySubmission().outcome).toBe("accept");
    expect(controller.identity()?.version).toBe("3.0.0");
    expect(lastEnd(builder).warnings).toEqual([
      "kept: the form's identity was edited by the person",
      "kept: Try it's stand-in settings was edited by the person",
      "kept: journey intake was edited by the person"
    ]);
  });

  it("person-edited: a default the person chose after the agent's set_default stays", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    vi.spyOn(builder.catalogue.sessionHooks as BuilderSessionHooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const before = journal.captureCatalog("pdf", "cra-t2125");
    asTool(builder, scope, () => page.pdf.actions.setDefault("cra-t2125"));
    journal.record(scope, { kind: "catalog", side: "pdf", action: "set_default", id: "cra-t2125", before: before! });
    page.pdf.actions.addLayout({ id: "extra", kind: "generated", name: "Extra", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } });
    page.pdf.actions.setDefault("extra");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(page.pdf.configuration.defaultLayoutId).toBe("extra");
    expect(lastEnd(builder).warnings).toEqual(["kept: PDF layout cra-t2125 was edited by the person"]);
  });

  it("person-edited: a default the person chose after the agent's move stays (the move's check reads the default too)", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    vi.spyOn(builder.catalogue.sessionHooks as BuilderSessionHooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const before = journal.captureCatalog("pdf", "cra-t2125");
    asTool(builder, scope, () => page.pdf.actions.move("cra-t2125", 0));
    journal.record(scope, { kind: "catalog", side: "pdf", action: "move", id: "cra-t2125", before: before! });
    // The order is as the agent left it; only the default is the person's.
    page.pdf.actions.setDefault("cra-t2125");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(page.pdf.configuration.layouts?.map((layout) => layout.id)).toEqual(["cra-t2125", "summary"]);
    expect(page.pdf.configuration.defaultLayoutId).toBe("cra-t2125");
    expect(lastEnd(builder).warnings).toEqual(["kept: PDF layout cra-t2125 was edited by the person"]);
  });

  it("person-edited: a stand-in list the person replaced since stays theirs; the entry's other part still comes back", async () => {
    const { builder } = setUp();
    const journal = builder.catalogue.shared.journal;
    vi.spyOn(builder.catalogue.sessionHooks as BuilderSessionHooks, "end");
    const controller = builder.controller;
    const submissionBefore = JSON_OF(controller.trySubmission());
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => {
      controller.setTrySubmission({ outcome: "refuse", refusalMessage: "Closed." });
      controller.setSimulatedDataSource("provinces", [{ value: "on", label: "Ontario" }]);
    });
    journal.record(scope, { kind: "settings", trySubmission: { before: submissionBefore as never }, sources: [{ sourceId: "provinces", before: undefined }] });
    controller.setSimulatedDataSource("provinces", [{ value: "qc", label: "Quebec" }]);
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(controller.simulatedDataSources().get("provinces")).toEqual([{ value: "qc", label: "Quebec" }]);
    expect(JSON_OF(controller.trySubmission())).toEqual(submissionBefore);
    expect(lastEnd(builder).warnings).toEqual(["kept: Try it's stand-in settings was edited by the person"]);
  });

  it("id-taken: a removed document whose id is in use again is not put back", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const capture = journal.captureRemoval("pdf", "summary");
    asTool(builder, scope, () => page.pdf.actions.remove("summary"));
    journal.record(scope, { kind: "removed", ...capture! });
    page.pdf.actions.addLayout({ id: "summary", kind: "generated", name: "Theirs", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } });
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(page.pdf.configuration.layouts?.find((layout) => layout.id === "summary")?.name).toBe("Theirs");
    expect(lastEnd(builder).warnings).toEqual(["kept: PDF layout summary was not put back: its id is in use again"]);
  });

  it("history-gone and person-edited for layout steps, by the follower's agent-top count", async () => {
    const { builder } = setUp();
    const journal = builder.catalogue.shared.journal;
    const memory = builder.catalogue.shared.memory;
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    const step = (controller: BuilderController, value: string): void => {
      controller.setProperties([{ componentId: "field", propertyPath: "label", value }]);
    };
    const first = layoutController();
    const second = layoutController();
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    // Two layouts of the fixture's catalog, each with its own controller. Each is followed, stepped
    // and recorded in turn, as a tool call does: a record drops the followers no entry names yet.
    builder.catalogue.shared.followLayout(scope, "summary", first);
    asTool(builder, scope, () => step(first, "agent"));
    journal.record(scope, { kind: "layout-steps", layoutId: "summary", steps: 1 });
    builder.catalogue.shared.followLayout(scope, "cra-t2125", second);
    asTool(builder, scope, () => step(second, "agent"));
    journal.record(scope, { kind: "layout-steps", layoutId: "cra-t2125", steps: 1 });
    expect(memory.layoutTop.get("summary")).toBe(1);
    expect(memory.layoutTop.get("cra-t2125")).toBe(1);
    expect(memory.layoutFollowers.get("cra-t2125")?.gone).toBe(false);
    // The person's own step on top of the agent's: the agent's is no longer on top (0).
    step(first, "person");
    expect(memory.layoutTop.get("summary")).toBe(0);
    // The second layout's designer is rebuilt (an init change): its history is gone. The follower
    // says so at once: a reseeded controller the person goes on editing (PBM's rebuild on the
    // next visit reseeds the same one) would otherwise have steps an undo could take back, so the
    // canUndo() check at Undo all is not what reports it.
    second.setOptions({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } }, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    expect(memory.layoutTop.get("cra-t2125")).toBe(0);
    expect(memory.layoutFollowers.get("cra-t2125")?.gone).toBe(true);
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(first.snapshot().children?.content?.[0]?.configuration).toEqual({ label: "person" });
    expect(lastEnd(builder).warnings).toEqual([
      "kept: the steps on PDF layout cra-t2125: its designer's undo history is gone",
      "kept: the steps on PDF layout summary was edited by the person"
    ]);
    expect(memory.layoutFollowers.size).toBe(0);
  });

  it("the agent-top arithmetic: agent +1, the person's execute 0, an undo -1, a redo back up to the ceiling", () => {
    const { builder } = setUp();
    const memory = builder.catalogue.shared.memory;
    const layout = layoutController();
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "one", layout);
    builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "one", steps: 2 });
    const step = (value: string): void => layout.setProperties([{ componentId: "field", propertyPath: "label", value }]);
    asTool(builder, scope, () => step("a"));
    asTool(builder, scope, () => step("b"));
    expect(memory.layoutTop.get("one")).toBe(2);
    layout.undo();
    expect(memory.layoutTop.get("one")).toBe(1);
    layout.redo();
    expect(memory.layoutTop.get("one")).toBe(2);
    // Nothing left to redo: no mutation, the count stays.
    layout.redo();
    expect(memory.layoutTop.get("one")).toBe(2);
    step("person");
    expect(memory.layoutTop.get("one")).toBe(0);
    layout.undo();
    expect(memory.layoutTop.get("one")).toBe(0);
    // The ceiling: the person's step on top dropped it to 0, so their redo is never the agent's.
    layout.redo();
    expect(memory.layoutTop.get("one")).toBe(0);
  });

  it("an undo below the agent's steps drops the ceiling: the person's older step redone is not the agent's", () => {
    const { builder } = setUp();
    const memory = builder.catalogue.shared.memory;
    const layout = layoutController();
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "one", layout);
    const step = (value: string): void => layout.setProperties([{ componentId: "field", propertyPath: "label", value }]);
    step("person");
    asTool(builder, scope, () => step("agent"));
    builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "one", steps: 1 });
    expect(memory.layoutTop.get("one")).toBe(1);
    layout.undo(); // the agent's step
    expect(memory.layoutTop.get("one")).toBe(0);
    layout.undo(); // the person's, below the agent's
    expect(memory.layoutTop.get("one")).toBe(0);
    layout.redo(); // the person's again
    expect(memory.layoutTop.get("one")).toBe(0);
  });

  it("Undo all after the person undid and redid their own step on top keeps it and the agent's step under it", async () => {
    const { builder, page } = setUp();
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    const layout = layoutController();
    page.pdf.state.layoutController = layout;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const step = (value: string): void => layout.setProperties([{ componentId: "field", propertyPath: "label", value }]);
    builder.catalogue.shared.followLayout(scope, "cra-t2125", layout);
    asTool(builder, scope, () => step("agent"));
    builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "cra-t2125", steps: 1 });
    step("person");
    layout.undo();
    layout.redo();
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(layout.snapshot().children?.content?.[0]?.configuration).toEqual({ label: "person" });
    expect(lastEnd(builder).warnings).toEqual(["kept: the steps on PDF layout cra-t2125 was edited by the person"]);
  });

  it("a designer not on the page keeps its entry for the next Undo all", async () => {
    const { builder, stub, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    stub.state.journeys = { state: "loading" };
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0, undoable: 1 });
    expect(builder.catalogue.shared.memory.outside).toHaveLength(1);
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 1 });
    // The banner's Undo all while the designer is still loading: the entry stays, and the
    // banner drawn again still offers it (its count is the journal's too).
    (stub.state.session as { onUndoAll(): void }).onUndoAll();
    expect(builder.catalogue.shared.memory.outside).toHaveLength(1);
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 1 });
    // With the designer back, its Undo all takes it back.
    stub.state.journeys = page.journeys.side();
    (stub.state.session as { onUndoAll(): void }).onUndoAll();
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Intake");
    expect(builder.catalogue.shared.memory.outside).toHaveLength(0);
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 0 });
  });
});

describe("the journal's scope and size", () => {
  it("drops the oldest past 100 entries and counts the drop in end_session's warnings", async () => {
    const { builder } = setUp();
    const journal = builder.catalogue.shared.journal;
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    for (let at = 0; at < OUTSIDE_JOURNAL_CAP + 2; at += 1) {
      const before = JSON_OF(builder.controller.trySubmission());
      asTool(builder, scope, () => builder.controller.setTrySubmission({ delayMs: at + 1 }));
      journal.record(scope, { kind: "settings", trySubmission: { before: before as never } });
    }
    expect(builder.catalogue.shared.memory.outside).toHaveLength(OUTSIDE_JOURNAL_CAP);
    okOf(await builder.execute("end_session", { summary: "Done." }));
    expect(lastEnd(builder).warnings).toEqual(["journal-full: the 2 oldest changes outside the undo history were dropped and cannot be undone"]);
    expect(lastEnd(builder).undoable).toBe(OUTSIDE_JOURNAL_CAP);
  });

  it("Undo all interleaves form steps and journal entries newest first by depthAt", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const order: string[] = [];
    builder.controller.on("mutation", (event) => order.push(`form:${event.action}`));
    const applyCatalog = page.journeys.actions.applyCatalog;
    page.journeys.actions.applyCatalog = (next, subjectId) => {
      order.push(`catalog:${String(next?.journeys?.[0]?.name)}`);
      applyCatalog(next, subjectId);
    };
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    const entry = journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    expect(entry.depthAt).toBe(1);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]));
    order.length = 0;
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 3 });
    expect(order).toEqual(["form:undo", "catalog:Intake", "form:undo"]);
  });

  it("skips a form step the person undid meanwhile (history or Ctrl+Z): the depth is read at replay time", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]));
    builder.controller.undo();
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Intake");
    const labels = (builder.controller.snapshot().children?.content ?? []).map((node) => (node.configuration as { label?: string }).label);
    expect(labels.slice(0, 3)).toEqual(["Full name", "Email", "Topic"]);
  });

  it("skips a form step the agent's own history { action: 'undo' } took back meanwhile", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "topic", propertyPath: "label", value: "Subject" }]));
    // history never runs journal entries: it takes back the form step alone.
    expect(okOf(await builder.execute("history", { action: "undo" })).done).toBe(1);
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Renamed");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Intake");
    expect(builder.controller.canUndo()).toBe(false);
  });

  it("an entry outside the session is not the session's: Undo all leaves it", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Before the session"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0, undoable: 0 });
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Before the session");
    expect(journal.forCall(scope.call)).toHaveLength(1);
  });

  it("empties on a reseed (reset()), its layout followers unsubscribed", () => {
    const { builder } = setUp();
    const journal = builder.catalogue.shared.journal;
    const memory = builder.catalogue.shared.memory;
    const layout = layoutController();
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "one", layout);
    journal.record(scope, { kind: "layout-steps", layoutId: "one", steps: 1 });
    journal.record(scope, { kind: "save", revision: 1 });
    memory.tried.set("full_name", "\"Ana\"");
    builder.registration.runtimeReplaced();
    expect(builder.catalogue.shared.memory.outside).toEqual([]);
    expect(builder.catalogue.shared.memory.layoutFollowers.size).toBe(0);
    expect(builder.catalogue.shared.memory.tried.size).toBe(0);
    expect(builder.catalogue.shared.memory.lastSave).toBeUndefined();
    // The follower no longer counts the layout's steps.
    asTool(builder, scopeOf(builder), () => layout.setProperties([{ componentId: "field", propertyPath: "label", value: "x" }]));
    expect(builder.catalogue.shared.memory.layoutTop.size).toBe(0);
  });
});

describe("the person always wins over an inverse", () => {
  it("removed: a default the person chose after the removal stays theirs; the document comes back and the entry says so", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    vi.spyOn(builder.catalogue.sessionHooks as BuilderSessionHooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "Remove" }));
    const scope = scopeOf(builder);
    // The agent removes the declared default; the removal clears it (removeLayout).
    const capture = journal.captureRemoval("pdf", "summary");
    asTool(builder, scope, () => page.pdf.actions.remove("summary"));
    journal.record(scope, { kind: "removed", ...capture! });
    expect(page.pdf.configuration.defaultLayoutId).toBeUndefined();
    // The person then makes the other layout the default.
    page.pdf.actions.setDefault("cra-t2125");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0 });
    expect(page.pdf.configuration.layouts?.map((layout) => layout.id)).toEqual(["summary", "cra-t2125"]);
    expect(page.pdf.configuration.defaultLayoutId).toBe("cra-t2125");
    expect(lastEnd(builder).warnings).toEqual(["kept: the default PDF layout the person chose since; PDF layout summary was put back without being made the default again"]);
  });

  it("removed: a journey's opens-as the person changed after the removal stays theirs", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const capture = journal.captureRemoval("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.remove("intake"));
    journal.record(scope, { kind: "removed", ...capture! });
    // The person has the form open as a form from now on.
    page.journeys.actions.chooseOpensAs("form");
    const out = journal.undo(undefined, journal.forCall(scope.call), "notice");
    expect(out.kept.map((item) => item.warning)).toEqual(["kept: the default journey the person chose since; journey intake was put back without being made the default again"]);
    expect(page.journeys.configuration.journeys?.map((journey) => journey.id)).toEqual(["intake"]);
    expect(page.journeys.configuration.opensAs).toBe("form");
    expect(page.journeys.configuration).not.toHaveProperty("defaultJourneyId");
  });

  it("removed: a removal that left the default alone puts none back over a default chosen since", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "Remove" }));
    const scope = scopeOf(builder);
    const capture = journal.captureRemoval("pdf", "cra-t2125");
    asTool(builder, scope, () => page.pdf.actions.remove("cra-t2125"));
    journal.record(scope, { kind: "removed", ...capture! });
    page.pdf.actions.addLayout({ id: "extra", kind: "generated", name: "Extra", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } });
    page.pdf.actions.setDefault("extra");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1 });
    expect(page.pdf.configuration.layouts?.map((layout) => layout.id)).toEqual(["summary", "cra-t2125", "extra"]);
    expect(page.pdf.configuration.defaultLayoutId).toBe("extra");
  });

  it("rename: the document's name goes back to the string it had (its translations are the definition's map, never the document's)", () => {
    const { builder, page } = setUp({ journeys: { journeys: [{ id: "intake", name: "Intake", pages: [] }], defaultJourneyId: "intake" } });
    const journal = builder.catalogue.shared.journal;
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => {
      page.journeys.configuration.journeys![0]!.name = "Intake form";
    });
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    const out = journal.undo(undefined, journal.forCall(scope.call), "notice");
    expect({ undone: out.undone, kept: out.kept }).toEqual({ undone: 1, kept: [] });
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Intake");
  });
});

describe("layout steps whose designer the person took away", () => {
  /** One agent step on the template layout's own controller, recorded as `documents { map_fields }` would. */
  async function mapped(): Promise<Page & { layout: BuilderController }> {
    const set = setUp();
    const layout = layoutController();
    set.page.pdf.state.layoutController = layout;
    set.page.pdf.state.mappings = 1;
    okOf(await set.builder.execute("begin_session", { purpose: "Map" }));
    const scope = scopeOf(set.builder);
    set.builder.catalogue.shared.followLayout(scope, "cra-t2125", layout);
    set.page.pdf.actions.suggestMappings({ batch: true, around: set.builder.catalogue.shared.around(scope) });
    set.builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "cra-t2125", steps: 1 });
    vi.spyOn(set.builder.catalogue.sessionHooks as BuilderSessionHooks, "end");
    return { ...set, layout };
  }

  it("a layout the person removed (its designer disposed, which its controller never hears) is history-gone, not undone", async () => {
    const { builder, page, layout } = await mapped();
    page.pdf.actions.remove("cra-t2125");
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0, undoable: 0 });
    expect(layout.canUndo()).toBe(true);
    expect(lastEnd(builder).warnings).toEqual(["kept: the steps on PDF layout cra-t2125: its designer's undo history is gone"]);
  });

  it("the agent's own removal of the layout (remove_part) marks its steps history-gone when recorded: Undo all puts the layout back and keeps the steps", async () => {
    const { builder, page, layout } = await mapped();
    const journal = builder.catalogue.shared.journal;
    const memory = builder.catalogue.shared.memory;
    const scope = scopeOf(builder);
    const capture = journal.captureRemoval("pdf", "cra-t2125");
    asTool(builder, scope, () => page.pdf.actions.remove("cra-t2125"));
    journal.record(scope, { kind: "removed", ...capture! });
    expect(memory.layoutFollowers.get("cra-t2125")?.gone).toBe(true);
    expect(memory.layoutTop.get("cra-t2125")).toBe(0);
    // Newest first: the removal's inverse puts the layout back before the steps entry runs, so the
    // later checks (in the catalog, not open on another controller) would pass; the mark is what
    // keeps an undo off the disposed designer's old controller.
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1 });
    expect(page.pdf.configuration.layouts?.map((entry) => entry.id)).toEqual(["summary", "cra-t2125"]);
    expect(layout.canUndo()).toBe(true);
    expect(lastEnd(builder).warnings).toEqual(["kept: the steps on PDF layout cra-t2125: its designer's undo history is gone"]);
  });

  it("the open layout's designer on another controller (built anew) is history-gone", async () => {
    const { builder, page, layout } = await mapped();
    page.pdf.designer.openId = "cra-t2125";
    page.pdf.state.layoutController = layoutController();
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(layout.canUndo()).toBe(true);
    expect(lastEnd(builder).warnings).toEqual(["kept: the steps on PDF layout cra-t2125: its designer's undo history is gone"]);
  });

  it("waits while the PDF designer is not on the page, and is undone once it is back", async () => {
    const { builder, stub, page, layout } = await mapped();
    stub.state.pdf = { state: "loading" };
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 0, undoable: 1 });
    expect(layout.canUndo()).toBe(true);
    stub.state.pdf = page.pdf.side();
    (stub.state.session as { onUndoAll(): void }).onUndoAll();
    expect(layout.canUndo()).toBe(false);
  });
});

describe("the journal's lifecycle and the banner's counts", () => {
  it("unregister drops the layout followers: a later agent step on the layout is counted nowhere", () => {
    const { builder } = setUp();
    const memory = builder.catalogue.shared.memory;
    const layout = layoutController();
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "summary", layout);
    asTool(builder, scope, () => layout.setProperties([{ componentId: "field", propertyPath: "label", value: "agent" }]));
    builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "summary", steps: 1 });
    expect(memory.layoutTop.get("summary")).toBe(1);
    builder.connection.abort();
    expect(memory.layoutFollowers.size).toBe(0);
    expect(memory.outside).toEqual([]);
    asTool(builder, scope, () => layout.setProperties([{ componentId: "field", propertyPath: "label", value: "later" }]));
    expect(memory.layoutTop.size).toBe(0);
  });

  it("a reseed of the form (the host loads another definition) empties the journal, its followers, the tried answers, the last save and Try it's last check", () => {
    const { builder } = setUp();
    const memory = builder.catalogue.shared.memory;
    const layout = layoutController();
    const scope = scopeOf(builder);
    builder.catalogue.shared.followLayout(scope, "summary", layout);
    builder.catalogue.shared.journal.record(scope, { kind: "layout-steps", layoutId: "summary", steps: 1 });
    builder.catalogue.shared.journal.record(scope, { kind: "save", revision: 1 });
    memory.tried.set("full_name", "\"Ana\"");
    memory.tryLast.lastCheck = { at: 1, problemCount: 0 };
    memory.tryLast.lastSubmit = { at: 2, outcome: "accepted" };
    expect(memory.lastSave).toEqual({ revision: 1, at: expect.any(Number) });
    builder.controller.setOptions({ initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [] } } });
    expect(memory.outside).toEqual([]);
    expect(memory.layoutFollowers.size).toBe(0);
    expect(memory.tried.size).toBe(0);
    expect(memory.lastSave).toBeUndefined();
    expect(memory.tryLast).toEqual({});
    asTool(builder, scope, () => layout.setProperties([{ componentId: "field", propertyPath: "label", value: "later" }]));
    expect(memory.layoutTop.size).toBe(0);
  });

  it("the ended banner counts the session's form steps and its journal entries: the person's undo and redo move only the form part", async () => {
    const { builder, stub, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    asTool(builder, scope, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    okOf(await builder.execute("end_session", { summary: "Done." }));
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 2 });
    builder.controller.undo();
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 1 });
    builder.controller.redo();
    expect(stub.state.session).toMatchObject({ open: false, undoAvailable: 2 });
  });

  it("runs every inverse with the writing flag up, so what it causes is the agent's", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    const memory = builder.catalogue.shared.memory;
    const controller = builder.controller;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Renamed"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    const identity = controller.identity();
    asTool(builder, scope, () => controller.setIdentity({ id: "contact-request", version: "2.0.0", schemaVersion: "1" }));
    journal.record(scope, { kind: "identity", before: identity });
    const seen: string[] = [];
    const applyCatalog = page.journeys.actions.applyCatalog;
    page.journeys.actions.applyCatalog = (next, subjectId) => {
      seen.push(`applyCatalog:${String(memory.writing)}`);
      applyCatalog(next, subjectId);
    };
    const setIdentity = controller.setIdentity.bind(controller);
    vi.spyOn(controller, "setIdentity").mockImplementation((next) => {
      seen.push(`setIdentity:${String(memory.writing)}`);
      setIdentity(next);
    });
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(seen).toEqual(["setIdentity:true", "applyCatalog:true"]);
    expect(memory.writing).toBe(false);
  });

  /**
   * The registrar merges the hook's `warnings` (after its own) and
   * `note` into end_session's own result, so the kept entries and the save barrier reach the model.
   */
  it("end_session's own result carries the kept warnings and the save barrier note", async () => {
    const { builder, page } = setUp();
    const journal = builder.catalogue.shared.journal;
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    const scope = scopeOf(builder);
    const capture = journal.captureCatalog("journeys", "intake");
    asTool(builder, scope, () => page.journeys.actions.rename("intake", "Agent name"));
    journal.record(scope, { kind: "catalog", side: "journeys", action: "rename", id: "intake", before: capture! });
    page.journeys.actions.rename("intake", "Their name");
    const saved = journal.record(scope, { kind: "save", revision: builder.registration.revision() });
    const ended = okOf<{ warnings?: string[]; note?: string[] }>(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.warnings).toContain("kept: journey intake was edited by the person");
    expect(ended.note).toEqual([`The site keeps the version saved at ${new Date(saved.at).toISOString()}; save again to keep the undo.`]);
  });
});

// ---- the real PDF mode: a rename is a step on the layout's own history -----------------------

const MODE_FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: { content: [{ id: "firstName", type: "text", configuration: { label: "First name" } }] }
};

function modeLayout(id: string, name: string): PdfGeneratedLayout {
  return { id, kind: "generated", name, root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } } };
}

async function until(check: () => unknown): Promise<void> {
  for (let tries = 0; tries < 400 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBeTruthy();
}

/** The real PDF mode on a page (its overlays in a shadow root, as the shell mounts them), activated, its first layout's designer built. */
async function realPdfMode(pdf: PdfConfiguration): Promise<PdfBuilderMode> {
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
  const made = createPdfBuilderMode({ formRoot: () => structuredClone(MODE_FORM), runtime: () => runtime, locale: () => "en", pdf });
  mode = made;
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.append(...(made.overlays ?? []));
  await made.activate!({ host, root, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
  await until(() => made.ready);
  return made;
}

/** `ui.pdfLayouts()` over the real mode: each member one call on it, as the element host's adapter. */
function pdfSide(mode: PdfBuilderMode): DesignerSide<PdfActions> {
  const actions = {
    configuration: () => mode.pdfConfiguration,
    applyCatalog: (next: PdfConfiguration, subjectId: string) => mode.applyCatalogForAgent(next, subjectId),
    rename: (id: string, name: string) => mode.renameLayout(id, name),
    remove: (id: string) => mode.removeLayout(id),
    layoutController: () => mode.controller
  } as unknown as PdfActions;
  return { state: "ready", workspace: () => "pdf", openId: () => mode.openState().id, controller: () => mode.controller, actions };
}

describe("over the real PDF mode (the fakes push no name step)", () => {
  const modes: PdfBuilderMode[] = [];
  afterEach(() => {
    for (const mode of modes.splice(0)) {
      mode.dispose?.();
    }
    document.body.innerHTML = "";
  });

  /** An agent's mapping step on layout `a`, then its rename of `a` through the mode, both journaled. */
  async function mappedThenRenamed(): Promise<{ builder: AgentBuilder; mode: PdfBuilderMode; layout: BuilderController; bodyBefore: string; call: string }> {
    const mode = await realPdfMode({ layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" });
    modes.push(mode);
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    stub.state.pdf = pdfSide(mode);
    const shared = builder.catalogue.shared;
    const layout = mode.controller;
    const bodyBefore = JSON.stringify(layout.snapshot());
    const scope = scopeOf(builder);
    // documents { map_fields }: one agent step on the layout's own history.
    shared.followLayout(scope, "a", layout);
    shared.around(scope)(() => layout.add("pdf-text", "document", "body"));
    shared.journal.record(scope, { kind: "layout-steps", layoutId: "a", steps: 1 });
    // documents { rename } through the mode: PBM writes the new name into the built designer's
    // tree with no entry of its own, so the agent's top there stays the mapping.
    const capture = shared.journal.captureCatalog("pdf", "a")!;
    const top = layout.undoMark();
    asTool(builder, scope, () => mode.renameLayout("a", "Agent name"));
    expect((layout.snapshot().configuration as { name?: unknown }).name).toBe("Agent name");
    expect(layout.undoMark()).toBe(top);
    expect(shared.memory.layoutTop.get("a")).toBe(1);
    shared.journal.record(scope, { kind: "catalog", side: "pdf", action: "rename", id: "a", before: capture });
    return { builder, mode, layout, bodyBefore, call: scope.call };
  }

  it("a rename writes no step on the designer's tree: its inverse goes through the catalog seam, and the agent's older mapping step is undone as well", async () => {
    const { builder, mode, layout, bodyBefore, call } = await mappedThenRenamed();
    const journal = builder.catalogue.shared.journal;
    const out = journal.undo(undefined, journal.forCall(call), "notice");
    expect({ undone: out.undone, kept: out.kept.map((item) => item.warning) }).toEqual({ undone: 2, kept: [] });
    expect(mode.layouts.find((layout) => layout.id === "a")?.name).toBe("Summary");
    expect(JSON.stringify(layout.snapshot())).toBe(bodyBefore);
    expect(layout.canUndo()).toBe(false);
  });

  it("a person's rename of a layout the agent mapped leaves the agent's step on top of that layout's history", async () => {
    const { builder, mode, layout, bodyBefore, call } = await mappedThenRenamed();
    const shared = builder.catalogue.shared;
    // The person's own rename from the documents menu: the name goes into the tree with no entry.
    mode.renameLayout("a", "Person's name");
    expect(shared.memory.layoutTop.get("a")).toBe(1);
    const out = shared.journal.undo(undefined, shared.journal.forCall(call), "notice");
    // The mapping is taken back; the rename's inverse finds the person's name and keeps it.
    expect({ undone: out.undone, kept: out.kept.map((item) => item.warning) }).toEqual({ undone: 1, kept: ["kept: PDF layout a was edited by the person"] });
    expect(mode.layouts.find((layout) => layout.id === "a")?.name).toBe("Person's name");
    expect(JSON.stringify({ ...layout.snapshot(), configuration: { ...(layout.snapshot().configuration as object), name: "Summary" } })).toBe(bodyBefore);
  });

  it("a layout the person removed in the designer is history-gone: nothing is reported undone", async () => {
    const mode = await realPdfMode({ layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" });
    modes.push(mode);
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    stub.state.pdf = pdfSide(mode);
    const shared = builder.catalogue.shared;
    const layout = mode.controller;
    const scope = scopeOf(builder);
    shared.followLayout(scope, "a", layout);
    shared.around(scope)(() => layout.add("pdf-text", "document", "body"));
    shared.journal.record(scope, { kind: "layout-steps", layoutId: "a", steps: 1 });
    mode.removeLayout("a");
    expect(mode.controller).not.toBe(layout);
    const out = shared.journal.undo(undefined, shared.journal.forCall(scope.call), "notice");
    expect({ undone: out.undone, kept: out.kept.map((item) => item.warning) }).toEqual({ undone: 0, kept: ["kept: the steps on PDF layout a: its designer's undo history is gone"] });
  });
});
