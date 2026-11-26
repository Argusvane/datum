// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { createPdfBuilderMode, type PdfBuilderMode, type PdfPreviewReportOptions } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { PdfConfiguration, PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import { AGENT_BUILDER_JOURNEYS, CRA_T2125_SOURCE } from "./fixtures/agent-builder-definitions.js";
import { documentController, documentsBuilder, gate, journeySide, pdfSide, type DocumentsBuilder } from "./fixtures/agent-builder-documents-fakes.js";
import { okOf, refusalOf, type AgentBuilder } from "./fixtures/agent-builder.js";

/**
 * The `documents` tool's body over
 * The fake designers: the grammar of the folded convention, the designer states, `open` only
 * through the shell's `selectDocument`, `new` / `duplicate` that open what they made or say why
 * not, every list change journaled with the call that reverses it, `map_fields` and
 * `create_form_fields` on the open template layout, `preview_pdf`'s metadata; the last ones over the real modes
 * (jsdom: the PDF mode mounts its designer).
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const JSON_OF = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function call(builder: AgentBuilder, input: Record<string, unknown>): ReturnType<AgentBuilder["execute"]> {
  return builder.execute("documents", input);
}

function contentIds(builder: AgentBuilder): string[] {
  return (builder.controller.snapshot().children?.content ?? []).map((node) => node.id);
}

/** The template layout `cra-t2125` open in the PDF designer, its PDF read (`fields` fields), over `layout`. */
function openTemplate(set: DocumentsBuilder, options: { fields?: number; layout?: BuilderController; mappings?: number } = {}): BuilderController {
  const layout = options.layout ?? documentController();
  set.page.pdf.designer.openId = "cra-t2125";
  set.page.pdf.state.open = { id: "cra-t2125", ready: true, template: { fields: options.fields ?? 5 } };
  set.page.pdf.state.layoutController = layout;
  set.page.pdf.state.mappings = options.mappings ?? 3;
  return layout;
}

/** A layout with no declared default: two generated layouts. */
const UNDECLARED: PdfConfiguration = {
  layouts: [
    { id: "a", kind: "generated", name: "A", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } },
    { id: "b", kind: "generated", name: "B", root: { id: "root", type: "pdf-document", configuration: {}, children: { content: [] } } }
  ]
};

/** Three journeys, the middle one the default. */
const THREE_JOURNEYS: JourneyConfiguration = {
  journeys: [
    { id: "a", name: "A", pages: [{ id: "p", components: ["full_name"] }] },
    { id: "b", name: "B", pages: [{ id: "p", components: ["email"] }, { id: "q", components: ["topic"] }] },
    { id: "c", name: "C", pages: [{ id: "p", components: ["details"] }] }
  ],
  defaultJourneyId: "b",
  opensAs: "journey"
};

describe("list (a read: answers during Stop, never queues)", () => {
  it("lists the journeys with their pages, what the form opens as and the designer", async () => {
    const { builder } = documentsBuilder();
    const result = okOf(await call(builder, { action: "list", kind: "journey" }));
    expect(result).toMatchObject({
      kind: "journey",
      action: "list",
      changed: false,
      documents: [{ id: "intake", name: "Intake", isDefault: true, open: false, pages: 2 }],
      opensAs: "journey",
      designer: { state: "ready", workspace: "journeys" },
      findings: { checked: false },
      next: ["documents { action: 'open', kind, id } shows one to the person."]
    });
    expect(result).not.toHaveProperty("templates");
  });

  it("lists the PDF layouts in try order with their kind, the site's templates and the findings when loaded", async () => {
    const { builder, ui } = documentsBuilder();
    ui.pdfFindings = () => [{ code: "pdf-layout.no-default", message: "no default" }];
    const result = okOf(await call(builder, { action: "list", kind: "pdf_layout" }));
    expect(result.documents).toEqual([
      { id: "summary", name: "Summary", isDefault: true, open: false, layoutKind: "generated", conditional: false },
      { id: "cra-t2125", name: "CRA T2125", isDefault: false, open: false, layoutKind: "template", conditional: false }
    ]);
    expect(result.templates).toEqual([{ templateId: "t2125-2026", label: "T2125 Statement of business activities (2026)" }]);
    expect(result.findings).toEqual({ errors: 0, warnings: 1 });
    // The template's source (its storage, file name) never reaches the agent.
    expect(JSON.stringify(result)).not.toContain("t2125-fill-25e.pdf");
  });

  it("counts the journey diagnostics by severity when their chunk is on the page", async () => {
    const { builder, ui } = documentsBuilder();
    ui.journeyDiagnostics = () =>
      [
        { severity: "error", code: "x", journeyId: "intake", message: "m" },
        { severity: "warning", code: "y", journeyId: "intake", message: "m" },
        { severity: "warning", code: "z", journeyId: "intake", message: "m" }
      ] as unknown as ReturnType<NonNullable<typeof ui.journeyDiagnostics>>;
    expect(okOf(await call(builder, { action: "list", kind: "journey" })).findings).toEqual({ errors: 1, warnings: 2 });
  });

  it("leaves the templates out with a warning when the site's list does not answer in 5 s", async () => {
    vi.useFakeTimers();
    const { builder, ui } = documentsBuilder();
    ui.pdfTemplates = () => new Promise(() => undefined);
    const pending = call(builder, { action: "list", kind: "pdf_layout" });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = okOf(await pending);
    expect(result).not.toHaveProperty("templates");
    expect(result.warnings).toEqual(["templates-unanswered: the site's template list did not answer"]);
  });

  it("answers list during Stop and reports it as a read, while a write action is stopped", async () => {
    const { builder, stub } = documentsBuilder();
    okOf(await builder.execute("begin_session", { purpose: "Documents" }));
    (stub.state.session as { onStop(): void }).onStop();
    const before = builder.host.calls.length;
    okOf(await call(builder, { action: "list", kind: "journey" }));
    const action = builder.host.calls.slice(before).find((entry) => entry.method === "emit" && entry.args[0] === "datum-agent-action")?.args[1];
    expect(action).toMatchObject({ tool: "documents", readOnly: true });
    expect(refusalOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name: "X" })).code).toBe("stopped");
  });
});

describe("designer states and the folded grammar", () => {
  it("answers each designer state: off and the feature off, hidden, loading and failed (retryable), no page", async () => {
    const set = documentsBuilder();
    set.page.journeys.designer.state = "off";
    expect(refusalOf(await call(set.builder, { action: "list", kind: "journey" }))).toMatchObject({ code: "feature-off", details: { feature: "journeys" } });
    set.page.journeys.designer.state = "hidden";
    expect(refusalOf(await call(set.builder, { action: "list", kind: "journey" }))).toMatchObject({ code: "feature-off", details: { feature: "journeys", hidden: true } });
    for (const state of ["loading", "failed"] as const) {
      set.page.pdf.designer.state = state;
      const refused = refusalOf(await call(set.builder, { action: "list", kind: "pdf_layout" }));
      expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "pdf", state } });
    }
    const off = documentsBuilder({ featureOn: { journeys: false } });
    expect(refusalOf(await call(off.builder, { action: "list", kind: "journey" }))).toMatchObject({ code: "feature-off", details: { feature: "journeys" } });
    const { agentBuilder } = await import("./fixtures/agent-builder.js");
    expect(refusalOf(await call(agentBuilder(), { action: "list", kind: "journey" })).code).toBe("no-ui");
  });

  it("refuses a PDF-only action and a PDF-only argument on a journey in one bad-input naming the kind (example 3)", async () => {
    const { builder, page } = documentsBuilder();
    const refused = refusalOf(await call(builder, { action: "move", kind: "journey", id: "intake", toIndex: 0 }));
    expect(refused).toMatchObject({
      code: "bad-input",
      retryable: false,
      message: "The arguments do not fit documents for kind 'journey'.",
      hint: "Fix the arguments listed in details.problems; the tool's inputSchema says what each takes.",
      details: {
        problems: [
          { key: "action", expected: "an action for kind 'journey': list, open, new, duplicate, rename, set_default, restore_removed" },
          { key: "toIndex", expected: "kind 'pdf_layout' only" }
        ]
      }
    });
    expect(refusalOf(await call(builder, { action: "new", kind: "pdf_layout", shape: "questions" })).details).toEqual({ problems: [{ key: "shape", expected: "kind 'journey' only" }] });
    expect(page.journeys.calls).toEqual([]);
    expect(page.pdf.calls).toEqual([]);
  });

  it("asks for what an action needs, templateId with from 'template', and warns of arguments the action does not read", async () => {
    const { builder } = documentsBuilder();
    const rename = refusalOf(await call(builder, { action: "rename", kind: "journey", id: "intake" }));
    expect(rename).toMatchObject({ message: "The arguments do not fit documents for action 'rename'.", details: { problems: [{ key: "name", expected: "required for action 'rename'" }] } });
    expect(refusalOf(await call(builder, { action: "move", kind: "pdf_layout" })).details).toEqual({
      problems: [
        { key: "id", expected: "required for action 'move'" },
        { key: "toIndex", expected: "required for action 'move'" }
      ]
    });
    expect(refusalOf(await call(builder, { action: "new", kind: "pdf_layout", from: "template" })).details).toEqual({
      problems: [{ key: "templateId", expected: "required for action 'new' with from 'template'" }]
    });
    const listed = okOf(await call(builder, { action: "list", kind: "journey", name: "x", discardTriedAnswers: true }));
    expect(listed.warnings).toEqual(["ignored argument for action 'list': name", "ignored argument for action 'list': discardTriedAnswers"]);
  });
});

describe("open: through the shell's document waiter only", () => {
  it("opens a journey and a template layout through selectDocument, never a mode's own select, and says what to call next", async () => {
    const { builder, page } = documentsBuilder();
    const journey = okOf(await call(builder, { action: "open", kind: "journey", id: "intake" }));
    expect(journey).toMatchObject({
      action: "open",
      changed: false,
      opened: true,
      document: { id: "intake", name: "Intake", isDefault: true },
      designer: { openId: "intake" },
      documents: [{ id: "intake", open: true }],
      next: ["try_it { action: 'fill' } tries it page by page."]
    });
    const layout = okOf(await call(builder, { action: "open", kind: "pdf_layout", id: "cra-t2125" }));
    expect(layout.next).toEqual(["documents { action: 'map_fields', kind: 'pdf_layout' } fills its PDF fields from matching form fields."]);
    expect(page.calls.filter((entry) => entry.method === "selectDocument").map((entry) => entry.args)).toEqual([
      ["journeys", "intake"],
      ["pdf", "cra-t2125"]
    ]);
    // Nothing reached the catalogs: opening is no list change.
    expect(page.journeys.calls).toEqual([]);
    expect(page.pdf.calls).toEqual([]);
    expect(builder.catalogue.shared.memory.outside).toEqual([]);
  });

  it("refuses an unknown id with the ids there are", async () => {
    const { builder } = documentsBuilder();
    expect(refusalOf(await call(builder, { action: "open", kind: "pdf_layout", id: "nope" }))).toMatchObject({
      code: "unknown-document",
      hint: "Use an id from documents { action: 'list', kind }.",
      details: { kind: "pdf_layout", id: "nope", known: [{ id: "summary", name: "Summary" }, { id: "cra-t2125", name: "CRA T2125" }] }
    });
  });

  it("refuses on the active controller's draft without raising a prompt", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const designer = documentController();
    set.stub.state.activeController = designer;
    set.page.pdf.designer.openId = "summary";
    set.page.pdf.state.layoutController = designer;
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    const refused = refusalOf(await call(set.builder, { action: "open", kind: "pdf_layout", id: "cra-t2125" }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "summary/title" } });
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
    expect(set.builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(set.page.calls.filter((entry) => entry.method === "selectDocument")).toEqual([]);
  });

  it("ends Try it first: refuses tried-answers over the person's typed answers, clears them with the flag; the agent's own need none", async () => {
    const set = documentsBuilder({ stub: { trying: true, triedAnswers: { full_name: "Ana", email: "ana@example.org" } } });
    set.builder.catalogue.shared.memory.tried.set("email", JSON.stringify("ana@example.org"));
    const refused = refusalOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" }));
    expect(refused).toMatchObject({
      code: "tried-answers",
      hint: "The person typed 1 answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true.",
      details: { byPerson: 1, byAssistant: 1 }
    });
    expect(set.stub.state.trying).toBe(true);
    okOf(await call(set.builder, { action: "open", kind: "journey", id: "intake", discardTriedAnswers: true }));
    expect(set.stub.callsOf("clearTriedAnswers")).toHaveLength(1);
    expect(set.stub.state.trying).toBe(false);

    const own = documentsBuilder({ stub: { trying: true, triedAnswers: { full_name: "Ana" } } });
    own.builder.catalogue.shared.memory.tried.set("full_name", JSON.stringify("Ana"));
    expect(okOf(await call(own.builder, { action: "open", kind: "journey", id: "intake" })).opened).toBe(true);
    expect(own.stub.state.trying).toBe(false);
  });

  it("counts the tried runtime's answers as the try body does: the agent's still holding its value, the person's typed keys and table cells", async () => {
    const set = documentsBuilder({ tryIt: { trying: true }, stub: { trying: true } });
    const runtime = set.page.tryIt?.runtime;
    runtime?.replaceValues({ full_name: "Ana", email: "ana@example.org", topic: "sales", subscribe: false }, ["full_name", "email"]);
    // The agent's value for email, a calculated-looking topic nobody typed, an unticked box.
    set.builder.catalogue.shared.memory.tried.set("email", JSON.stringify("ana@example.org"));
    expect(refusalOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" })).details).toEqual({ byPerson: 1, byAssistant: 1 });
    // The person changed the agent's answer since: theirs now.
    runtime?.replaceValues({ full_name: "", email: "ana@other.example" }, ["email"]);
    expect(refusalOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" })).details).toEqual({ byPerson: 1, byAssistant: 0 });
  });

  it("answers a designer that did not load chunk-unavailable, a waiter past its time timeout, a prompt raised in the race unsaved-draft", async () => {
    const set = documentsBuilder();
    set.page.state.select = { status: "failed", message: "The designer could not load" };
    expect(refusalOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" }))).toMatchObject({
      code: "chunk-unavailable",
      retryable: true,
      details: { what: "journey-designer", state: "failed" }
    });
    set.page.state.select = { status: "timeout" };
    expect(refusalOf(await call(set.builder, { action: "open", kind: "pdf_layout", id: "summary" }))).toMatchObject({ code: "timeout", retryable: true, details: { afterMs: 10_000, stillRunning: true } });
    // The person's edit came up while the shell asked to leave: the prompt is answered stay, and refused.
    const form = set.builder.controller;
    set.ui.selectDocument = () => {
      form.select("email");
      form.setDraftProperty("email", "label", "typed");
      form.requestSelect("topic");
      return Promise.resolve({ status: "failed", message: "held" });
    };
    expect(refusalOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(form.unsavedChangesPrompt()).toBeUndefined();
  });
});

describe("new and duplicate: made, journaled, opened unless something holds it", () => {
  it("makes a journey, opens it, journals it and gives remove_part as the reverse; Undo all takes it back", async () => {
    const { builder, page } = documentsBuilder();
    const before = JSON_OF(page.journeys.configuration);
    okOf(await builder.execute("begin_session", { purpose: "Journeys" }));
    const made = okOf(await call(builder, { action: "new", kind: "journey", name: "Short version", shape: "questions" }));
    expect(made).toMatchObject({
      action: "new",
      changed: true,
      document: { id: "journey-1", name: "Short version", isDefault: false },
      opened: true,
      reverse: { tool: "remove_part", input: { kind: "journey", id: "journey-1" } },
      undo: { steps: 0, journaled: true },
      next: ["try_it { action: 'fill' } tries it page by page; check_form reports journey problems."]
    });
    expect(made).not.toHaveProperty("note");
    expect(page.journeys.calls[0]).toEqual({ method: "newJourney", args: [{ name: "Short version", from: "questions", select: false, around: true }] });
    expect(page.calls.filter((entry) => entry.method === "selectDocument").map((entry) => entry.args)).toEqual([["journeys", "journey-1"]]);
    expect(builder.catalogue.shared.memory.outside.map((entry) => entry.kind)).toEqual(["catalog"]);
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(JSON_OF(page.journeys.configuration)).toEqual(before);
  });

  it("says the form now opens as a first journey", async () => {
    const { builder } = documentsBuilder({ journeys: { journeys: [] } });
    const made = okOf(await call(builder, { action: "new", kind: "journey" }));
    expect(made.note).toEqual(["The form now opens as this journey (its first journey); documents { action: 'set_default', kind: 'journey', id: 'form' } opens it on one page again."]);
  });

  it("leaves the first-journey note out when a declared opensAs 'form' keeps the form opening whole", async () => {
    const { builder } = documentsBuilder({ journeys: { journeys: [], opensAs: "form" } });
    const made = okOf(await call(builder, { action: "new", kind: "journey" }));
    expect(made).toMatchObject({ opensAs: "form", document: { id: "journey-1" } });
    expect(made).not.toHaveProperty("note");
  });

  it("reading (f): answers timeout { afterMs: 20000, stillRunning: true } past 20 s of a journey's make, and journals the journey when it lands late", async () => {
    vi.useFakeTimers();
    const { builder, page } = documentsBuilder();
    const memory = builder.catalogue.shared.memory;
    const loaded = gate();
    const original = page.journeys.actions.newJourney;
    let work: Promise<unknown> | undefined;
    page.journeys.actions.newJourney = (options) => {
      const late = (async () => {
        await loaded.promise;
        return original(options);
      })();
      work = late;
      return late;
    };
    const pending = call(builder, { action: "new", kind: "journey", name: "Late" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refusalOf(await pending)).toMatchObject({ code: "timeout", details: { afterMs: 20_000, stillRunning: true } });
    expect(memory.outside).toEqual([]);
    expect(page.journeys.configuration.journeys?.map((journey) => journey.id)).not.toContain("journey-1");
    loaded.open();
    await work;
    await vi.advanceTimersByTimeAsync(0);
    expect(page.journeys.configuration.journeys?.map((journey) => journey.id)).toContain("journey-1");
    expect(memory.outside.map((entry) => ({ kind: entry.kind, id: (entry as { id?: string }).id, action: (entry as { action?: string }).action }))).toEqual([{ kind: "catalog", id: "journey-1", action: "new" }]);
  });

  it("still makes it but answers opened: false with the note while the person's typed Try it answers hold the page", async () => {
    const set = documentsBuilder({ stub: { trying: true, triedAnswers: { full_name: "Ana" } } });
    const made = okOf(await call(set.builder, { action: "new", kind: "pdf_layout", from: "blank" }));
    expect(made).toMatchObject({ changed: true, opened: false, note: ["Made; open it with documents { action: 'open' } when the person is free."] });
    expect(set.page.pdf.configuration.layouts?.map((layout) => layout.id)).toContain("layout-1");
    expect(set.stub.state.trying).toBe(true);
    expect(set.page.calls.filter((entry) => entry.method === "selectDocument")).toEqual([]);
  });

  it("clears the person's typed answers with discardTriedAnswers: true, ends Try it and opens what it made", async () => {
    const set = documentsBuilder({ stub: { trying: true, triedAnswers: { full_name: "Ana" } } });
    const made = okOf(await call(set.builder, { action: "duplicate", kind: "journey", id: "intake", discardTriedAnswers: true }));
    expect(made).toMatchObject({ opened: true, document: { id: "intake-copy" } });
    expect(set.stub.callsOf("clearTriedAnswers")).toHaveLength(1);
    expect(set.stub.state.trying).toBe(false);
  });

  it("runs only the journey's catalog write with the flag up; a person's edit during the designer's load is theirs", async () => {
    const { builder, page } = documentsBuilder();
    const memory = builder.catalogue.shared.memory;
    const loaded = gate();
    const original = page.journeys.actions.newJourney;
    let inStep: boolean | undefined;
    let duringLoad: boolean | undefined;
    page.journeys.actions.newJourney = async (options) => {
      duringLoad = memory.writing;
      await loaded.promise;
      return original({ ...options, around: (step) => options.around?.(() => ((inStep = memory.writing), step())) });
    };
    const before = contentIds(builder);
    const pending = call(builder, { action: "new", kind: "journey" });
    await vi.waitFor(() => expect(duringLoad).toBeDefined());
    builder.controller.add("text");
    const personId = contentIds(builder).find((id) => !before.includes(id));
    loaded.open();
    const made = okOf(await pending);
    expect({ duringLoad, inStep }).toEqual({ duringLoad: false, inStep: true });
    expect(made.alsoChanged).toEqual([personId]);
    expect(memory.writing).toBe(false);
  });

  it("a PDF layout without a name takes the builder's default words; a template comes from the site's list only", async () => {
    const set = documentsBuilder();
    okOf(await call(set.builder, { action: "new", kind: "pdf_layout" }));
    okOf(await call(set.builder, { action: "new", kind: "pdf_layout", from: "blank", name: "  " }));
    expect(set.page.pdf.calls.filter((entry) => entry.method === "newLayout").map((entry) => entry.args[0])).toEqual([
      { name: "Custom layout", from: "form", select: false },
      { name: "Blank layout", from: "blank", select: false }
    ]);
    const template = okOf(await call(set.builder, { action: "new", kind: "pdf_layout", from: "template", templateId: "t2125-2026" }));
    expect(set.page.pdf.calls.find((entry) => entry.method === "addTemplate")?.args).toEqual([CRA_T2125_SOURCE, ""]);
    expect(template).toMatchObject({ document: { id: "template-3", name: "Paper form" }, next: ["documents { action: 'map_fields', kind: 'pdf_layout' } fills its PDF fields from matching form fields."] });
    expect(refusalOf(await call(set.builder, { action: "new", kind: "pdf_layout", from: "template", templateId: "upload.pdf" }))).toMatchObject({
      code: "unknown-template",
      hint: "Use a templateId from documents { action: 'list', kind: 'pdf_layout' }; files cannot be uploaded by an assistant.",
      details: { templateId: "upload.pdf", known: [{ templateId: "t2125-2026", label: "T2125 Statement of business activities (2026)" }] }
    });
    // A copy is of the layout open in the designer: none is open now.
    set.page.pdf.designer.openId = undefined;
    expect(refusalOf(await call(set.builder, { action: "new", kind: "pdf_layout", from: "copy" })).code).toBe("bad-input");
    expect(refusalOf(await call(set.builder, { action: "new", kind: "journey", shape: "copy" })).code).toBe("bad-input");
  });

  it("duplicates and opens the copy, journaled, reversed through remove_part", async () => {
    const { builder, page } = documentsBuilder();
    const before = JSON_OF(page.pdf.configuration);
    const copy = okOf(await call(builder, { action: "duplicate", kind: "pdf_layout", id: "summary", name: "Summary 2" }));
    expect(copy).toMatchObject({ action: "duplicate", document: { id: "summary-copy", name: "Summary 2" }, opened: true, reverse: { tool: "remove_part", input: { kind: "pdf_layout", id: "summary-copy" } } });
    okOf(await builder.execute("remove_part", (copy.reverse as { input: Record<string, unknown> }).input));
    expect(JSON_OF(page.pdf.configuration)).toEqual(before);
  });

  it("maps the catalogs' own errors: a bad id, a taken one, a reserved one; anything else refused, never internal", async () => {
    const { builder, page } = documentsBuilder();
    for (const [message, code] of [
      ['"9a" cannot be a journey id: start with a letter, then letters, digits, _ or -', "invalid-id"],
      ['"form" cannot be a journey id: a host names the whole form by it', "invalid-id"],
      ['A journey with the id "intake-copy" already exists', "duplicate-id"],
      ["Something else went wrong", "refused"]
    ] as const) {
      page.journeys.actions.duplicate = () => {
        throw new Error(message);
      };
      expect(refusalOf(await call(builder, { action: "duplicate", kind: "journey", id: "intake" })), message).toMatchObject({ code });
    }
    expect(builder.catalogue.shared.memory.outside).toEqual([]);
  });
});

describe("rename, set_default, move and restore_removed: list changes on no history, journaled", () => {
  it("renames, journals it and gives the rename back; the same name changes nothing", async () => {
    const { builder, page } = documentsBuilder();
    const before = JSON_OF(page.journeys.configuration);
    const renamed = okOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name: "Intake form" }));
    expect(renamed).toMatchObject({
      changed: true,
      document: { id: "intake", name: "Intake form" },
      reverse: { tool: "documents", input: { action: "rename", kind: "journey", id: "intake", name: "Intake" } },
      undo: { journaled: true },
      next: ["documents { action: 'list', kind } shows the list as it is now."]
    });
    expect(builder.catalogue.shared.memory.outside).toHaveLength(1);
    okOf(await call(builder, (renamed.reverse as { input: Record<string, unknown> }).input));
    expect(JSON_OF(page.journeys.configuration)).toEqual(before);
    const same = okOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name: "Intake" }));
    expect(same).toMatchObject({ changed: false });
    expect(same).not.toHaveProperty("reverse");
    expect(builder.catalogue.shared.memory.outside).toHaveLength(2);
  });

  it("refuses a blank name on rename as bad-input, writing nothing (the modes would delete the name); surrounding spaces go", async () => {
    const { builder, page } = documentsBuilder();
    for (const name of ["", "   "]) {
      expect(refusalOf(await call(builder, { action: "rename", kind: "pdf_layout", id: "summary", name })), JSON.stringify(name)).toMatchObject({
        code: "bad-input",
        message: "The arguments do not fit documents for action 'rename'.",
        details: { problems: [{ key: "name", expected: "a name that is not empty" }] }
      });
      expect(refusalOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name })), JSON.stringify(name)).toMatchObject({ code: "bad-input" });
    }
    expect(page.pdf.calls.filter((entry) => entry.method === "rename")).toEqual([]);
    expect(page.journeys.calls.filter((entry) => entry.method === "rename")).toEqual([]);
    expect(builder.catalogue.shared.memory.outside).toEqual([]);
    okOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name: "  Intake form " }));
    expect(page.journeys.calls.at(-1)).toEqual({ method: "rename", args: ["intake", "Intake form"] });
  });

  it("yields to the person before an unknown id, an unknown template and the no-op answer (the documented guard order)", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const designer = documentController();
    set.stub.state.activeController = designer;
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    const current = (okOf(await call(set.builder, { action: "list", kind: "pdf_layout" })).documents as Array<{ id: string; isDefault: boolean }>).find((doc) => doc.isDefault)?.id;
    expect(current).toBeDefined();
    const inputs: Array<Record<string, unknown>> = [
      { action: "rename", kind: "pdf_layout", id: "nope", name: "X" },
      { action: "open", kind: "journey", id: "nope" },
      { action: "duplicate", kind: "journey", id: "nope" },
      { action: "move", kind: "pdf_layout", id: "nope", toIndex: 0 },
      { action: "set_default", kind: "pdf_layout", id: current },
      { action: "new", kind: "pdf_layout", from: "template", templateId: "nope" }
    ];
    for (const input of inputs) {
      expect(refusalOf(await call(set.builder, input)), String(input.action)).toMatchObject({ code: "unsaved-draft", details: { reason: "draft" } });
    }
    designer.discardDraft("title");
    const after: unknown[] = [];
    for (const input of inputs) {
      const answered = await call(set.builder, input);
      after.push(input.action === "set_default" ? okOf(answered).changed : refusalOf(answered).code);
    }
    expect(after).toEqual(["unknown-document", "unknown-document", "unknown-document", "unknown-document", false, "unknown-template"]);
  });

  it("sets the default journey, 'form' included, with the old default as the reverse; the default already set changes nothing", async () => {
    const { builder, page } = documentsBuilder({ journeys: THREE_JOURNEYS });
    const whole = okOf(await call(builder, { action: "set_default", kind: "journey", id: "form" }));
    expect(whole).toMatchObject({ changed: true, opensAs: "form", reverse: { tool: "documents", input: { action: "set_default", kind: "journey", id: "b" } } });
    const back = okOf(await call(builder, (whole.reverse as { input: Record<string, unknown> }).input));
    expect(back).toMatchObject({ opensAs: "journey", reverse: { input: { id: "form" } } });
    expect(page.journeys.configuration.defaultJourneyId).toBe("b");
    expect(okOf(await call(builder, { action: "set_default", kind: "journey", id: "b" }))).toMatchObject({ changed: false });
    expect(refusalOf(await call(builder, { action: "set_default", kind: "pdf_layout", id: "form" })).code).toBe("unknown-document");
  });

  it("move and set_default on a catalog with no declared default come back JSON-equal through end_session { undo: true }", async () => {
    const { builder, page } = documentsBuilder({ pdf: UNDECLARED });
    const before = JSON_OF(page.pdf.configuration);
    okOf(await builder.execute("begin_session", { purpose: "Order" }));
    const moved = okOf(await call(builder, { action: "move", kind: "pdf_layout", id: "b", toIndex: 0 }));
    expect(moved).toMatchObject({ changed: true, reverse: { input: { action: "move", kind: "pdf_layout", id: "b", toIndex: 1 } } });
    expect(page.pdf.configuration.defaultLayoutId).toBe("a");
    okOf(await call(builder, { action: "set_default", kind: "pdf_layout", id: "b" }));
    expect(okOf(await call(builder, { action: "move", kind: "pdf_layout", id: "b", toIndex: 0 }))).toMatchObject({ changed: false });
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(JSON_OF(page.pdf.configuration)).toEqual(before);
    expect(page.pdf.configuration).not.toHaveProperty("defaultLayoutId");
  });

  it("restore_removed puts a removed journey back at its index with the default and opens-as it had", async () => {
    const { builder, page } = documentsBuilder({ journeys: THREE_JOURNEYS });
    const removed = okOf(await builder.execute("remove_part", { kind: "journey", id: "b" }));
    expect(removed.reverse).toEqual({ tool: "documents", input: { action: "restore_removed", kind: "journey", id: "b" } });
    expect(page.journeys.configuration.journeys?.map((journey) => journey.id)).toEqual(["a", "c"]);
    const restored = okOf(await call(builder, (removed.reverse as { input: Record<string, unknown> }).input));
    expect(restored).toMatchObject({ action: "restore_removed", changed: true, document: { id: "b", isDefault: true }, reverse: { tool: "remove_part", input: { kind: "journey", id: "b" } }, undo: { journaled: true } });
    expect(JSON_OF(page.journeys.configuration)).toEqual(JSON_OF(THREE_JOURNEYS));
    expect(page.journeys.calls.at(-1)?.method).toBe("applyCatalog");
    // Nothing more is held for it now that its id is back.
    expect(refusalOf(await call(builder, { action: "restore_removed", kind: "journey", id: "b" }))).toMatchObject({
      code: "nothing-to-restore",
      hint: "Nothing you removed is held for that id; it cannot be brought back from here.",
      details: { kind: "journey", id: "b" }
    });
  });

  it("a default the person chose since the removal stays theirs, with the default-kept warning", async () => {
    const { builder, page } = documentsBuilder({ journeys: THREE_JOURNEYS });
    okOf(await builder.execute("remove_part", { kind: "journey", id: "b" }));
    expect(page.journeys.configuration).not.toHaveProperty("defaultJourneyId");
    page.journeys.actions.chooseOpensAs("a");
    const restored = okOf(await call(builder, { action: "restore_removed", kind: "journey", id: "b" }));
    expect(restored.warnings).toEqual(["default-kept: the default journey the person chose since the removal stays; b is not made the default again"]);
    expect(restored.document).toMatchObject({ id: "b", isDefault: false });
    expect(page.journeys.configuration.defaultJourneyId).toBe("a");
    expect(page.journeys.configuration.journeys?.map((journey) => journey.id)).toEqual(["a", "b", "c"]);
  });

  it("journals every list change and end_session { undo: true } takes them all back; a document the person renamed since stays theirs", async () => {
    const { builder, page } = documentsBuilder();
    const journeysBefore = JSON_OF(page.journeys.configuration);
    const pdfBefore = JSON_OF(page.pdf.configuration);
    okOf(await builder.execute("begin_session", { purpose: "Documents" }));
    okOf(await call(builder, { action: "new", kind: "journey", name: "Short" }));
    okOf(await call(builder, { action: "duplicate", kind: "journey", id: "intake" }));
    okOf(await call(builder, { action: "set_default", kind: "journey", id: "journey-1" }));
    okOf(await call(builder, { action: "new", kind: "pdf_layout", from: "blank" }));
    okOf(await call(builder, { action: "move", kind: "pdf_layout", id: "cra-t2125", toIndex: 0 }));
    okOf(await call(builder, { action: "rename", kind: "pdf_layout", id: "summary", name: "Short summary" }));
    expect(builder.catalogue.shared.memory.outside.map((entry) => entry.kind)).toEqual(["catalog", "catalog", "catalog", "catalog", "catalog", "catalog"]);
    const ended = okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 6 });
    expect(JSON_OF(page.journeys.configuration)).toEqual(journeysBefore);
    expect(JSON_OF(page.pdf.configuration)).toEqual(pdfBefore);

    okOf(await builder.execute("begin_session", { purpose: "Again" }));
    okOf(await call(builder, { action: "rename", kind: "journey", id: "intake", name: "Agent name" }));
    page.journeys.actions.rename("intake", "Person name");
    okOf(await builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(page.journeys.configuration.journeys?.[0]?.name).toBe("Person name");
  });
});

describe("map_fields: the open template layout's fields, one step on its own history", () => {
  it("refuses with no layout open, a generated layout open, and a template whose PDF has no fields", async () => {
    const set = documentsBuilder();
    expect(refusalOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({
      code: "document-not-open",
      hint: "Open it first with documents { action: 'open', kind: 'pdf_layout', id }.",
      details: { kind: "pdf_layout" }
    });
    set.page.pdf.state.open = { id: "summary", ready: true };
    expect(refusalOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({
      code: "not-a-template",
      hint: "These actions fill a fillable PDF's fields; this layout has none, so tell the person.",
      details: { id: "summary", fields: 0 }
    });
    openTemplate(set, { fields: 0 });
    expect(refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }))).toMatchObject({ code: "not-a-template", details: { id: "cra-t2125", fields: 0 } });
    expect(set.page.pdf.calls.filter((entry) => entry.method === "suggestMappings" || entry.method === "createFormFields")).toEqual([]);
  });

  it("waits up to 10 s for a template still being read, then answers chunk-unavailable { pdf-template } (retryable)", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    set.page.pdf.state.open = { id: "cra-t2125", ready: false };
    set.page.pdf.state.ready = "loading";
    expect(refusalOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "pdf-template", state: "loading" } });
    set.page.pdf.state.ready = "failed";
    expect(refusalOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({ code: "chunk-unavailable", details: { what: "pdf-template", state: "failed" } });
    expect(set.page.pdf.calls.filter((entry) => entry.method === "whenOpenReady").map((entry) => entry.args)).toEqual([[10_000], [10_000]]);
    // Right after `new` from a template: the read finishes during the wait, and the mapping goes on.
    const original = set.page.pdf.actions.whenOpenReady;
    set.page.pdf.actions.whenOpenReady = async (timeoutMs) => {
      set.page.pdf.state.open = { id: "cra-t2125", ready: true, template: { fields: 4 } };
      set.page.pdf.state.ready = "ready";
      return original(timeoutMs);
    };
    expect(okOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({ changed: true, mapped: 3 });
    expect(layout.canUndo()).toBe(true);
  });

  it("lands every mapping as one layout step, journaled, reported in elsewhere and taken back by end_session { undo: true }", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const layout = openTemplate(set);
    set.stub.state.activeController = layout;
    const body = JSON.stringify(layout.snapshot());
    okOf(await set.builder.execute("begin_session", { purpose: "Map" }));
    const mapped = okOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }));
    expect(mapped).toMatchObject({
      action: "map_fields",
      changed: true,
      mapped: 3,
      elsewhere: { what: "PDF layout cra-t2125", steps: 1 },
      note: ["The 3 mappings are one step on the PDF layout's own undo history: the person undoes it in the PDF designer; end_session { undo: true } takes it back while it is the latest there."],
      undo: { steps: 0, journaled: true },
      next: ["documents { action: 'create_form_fields', kind: 'pdf_layout' } adds form fields for the PDF fields left unmapped."]
    });
    expect(set.page.pdf.calls.find((entry) => entry.method === "suggestMappings")?.args).toEqual([{ batch: true, around: true }]);
    expect(set.builder.catalogue.shared.memory.outside.map((entry) => entry.kind)).toEqual(["layout-steps"]);
    okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(JSON.stringify(layout.snapshot())).toBe(body);
    expect(layout.canUndo()).toBe(false);
  });

  it("answers changed: false and journals nothing when no field matched", async () => {
    const set = documentsBuilder();
    openTemplate(set, { mappings: 0 });
    expect(okOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({ changed: false, mapped: 0 });
    expect(set.builder.catalogue.shared.memory.outside).toEqual([]);
  });

  it("refuses on the layout controller's draft, which suggestMappings would write past, without raising a prompt", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    layout.select("title");
    layout.setDraftProperty("title", "label", "typed");
    expect(refusalOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "cra-t2125/title" } });
    expect(layout.unsavedChangesPrompt()).toBeUndefined();
    expect(set.page.pdf.calls.filter((entry) => entry.method === "suggestMappings")).toEqual([]);
  });

  it("a person's step on the layout after the agent's keeps it (person-edited); a rebuilt designer is history-gone", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    okOf(await set.builder.execute("begin_session", { purpose: "Map" }));
    okOf(await call(set.builder, { action: "map_fields", kind: "pdf_layout" }));
    layout.setProperties([{ componentId: "title", propertyPath: "label", value: "The person's" }]);
    const kept = set.builder.catalogue.shared.journal.undo(undefined, [...set.builder.catalogue.shared.memory.outside], "undo-all");
    expect(kept.kept.map((entry) => entry.reason)).toEqual(["person-edited"]);
    expect((layout.snapshot().children?.content?.[0]?.configuration as { label: string }).label).toBe("The person's");

    const again = documentsBuilder();
    openTemplate(again);
    okOf(await call(again.builder, { action: "map_fields", kind: "pdf_layout" }));
    again.page.pdf.state.layoutController = documentController();
    const gone = again.builder.catalogue.shared.journal.undo(undefined, [...again.builder.catalogue.shared.memory.outside], "undo-all");
    expect(gone.kept.map((entry) => entry.reason)).toEqual(["history-gone"]);
  });
});

describe("create_form_fields: one form step on history and one layout step journaled", () => {
  it("passes the fields pre-check in the PDF designer (never wrong-mode), refuses try-it-on while trying and a form tree draft PBM would not see", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const layout = openTemplate(set);
    set.stub.state.activeController = layout;
    set.page.pdf.state.formFields = { added: [], mapped: 0, matched: 0, skipped: [] };
    expect(okOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" })).action).toBe("create_form_fields");
    set.stub.state.trying = true;
    set.stub.state.triedAnswers = { full_name: "Ana" };
    expect(refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }))).toMatchObject({ code: "try-it-on", details: { triedPaths: 1 } });
    set.stub.state.trying = false;
    const form = set.builder.controller;
    form.select("email");
    form.setDraftProperty("email", "label", "typed");
    expect(refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(form.unsavedChangesPrompt()).toBeUndefined();
  });

  it("the form insert and the layout step are the agent's (ownSteps kept), a person's edit during the await is theirs", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    const shared = set.builder.catalogue.shared;
    const waited = gate();
    let added = "";
    set.page.pdf.actions.createFormFields = async ({ around }) => {
      const before = contentIds(set.builder);
      around?.(() => set.builder.controller.add("text"));
      added = contentIds(set.builder).find((id) => !before.includes(id)) ?? "";
      await waited.promise;
      around?.(() => layout.setProperties([{ componentId: "title", propertyPath: "label", value: "Mapped" }]));
      return { added: [added], mapped: 2, matched: 1, skipped: [{ pdfField: "Line9", reason: "no matching field" }] };
    };
    okOf(await set.builder.execute("add_components", { components: [{ type: "text", label: "Earlier" }] }));
    expect(shared.memory.ownSteps).toBe(1);
    const pending = call(set.builder, { action: "create_form_fields", kind: "pdf_layout" });
    await vi.waitFor(() => expect(added).not.toBe(""));
    expect(shared.memory.ownSteps).toBe(2);
    waited.open();
    const result = okOf(await pending);
    expect(result).toMatchObject({
      changed: true,
      formFields: { added: [added], mapped: 2, matched: 1, skipped: [{ pdfField: "Line9", reason: "no matching field" }] },
      elsewhere: { what: "PDF layout cra-t2125", steps: 1 },
      undo: { steps: 1, ownSteps: 2, journaled: true },
      next: ["get_form shows the new fields; set labels and rules with set_properties.", "documents { action: 'preview_pdf', kind: 'pdf_layout' } shows the person the filled PDF."]
    });
    expect(result).not.toHaveProperty("alsoChanged");
    expect(shared.memory.outside.map((entry) => entry.kind)).toEqual(["layout-steps"]);

    // A person's edit during the await: theirs (alsoChanged), and their step ends the agent's run on top.
    const second = gate();
    set.page.pdf.actions.createFormFields = async ({ around }) => {
      around?.(() => set.builder.controller.add("number"));
      await second.promise;
      return { added: [], mapped: 0, matched: 0, skipped: [] };
    };
    const ids = contentIds(set.builder);
    const next = call(set.builder, { action: "create_form_fields", kind: "pdf_layout" });
    await vi.waitFor(() => expect(contentIds(set.builder).length).toBe(ids.length + 1));
    set.builder.controller.add("date");
    const personId = contentIds(set.builder).find((id) => !ids.includes(id) && id.startsWith("date"));
    second.open();
    const after = okOf(await next);
    expect(after.alsoChanged).toEqual([personId]);
    expect(shared.memory.ownSteps).toBe(0);
  });

  it("refuses, never internal, when the mode rejects after the form insert (PBM awaits the host's templates there), keeping what landed on history", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    const before = contentIds(set.builder);
    set.page.pdf.actions.createFormFields = async ({ around }) => {
      around?.(() => set.builder.controller.add("text"));
      throw new Error("templates offline");
    };
    const refused = refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }));
    expect(refused).toMatchObject({
      code: "refused",
      message: "The builder did not finish adding the form fields; the fields it added are on the form's undo history, their PDF mappings were not written.",
      hint: "Tell the person; the PDF designer's Create form fields button says why."
    });
    expect(JSON.stringify(refused)).not.toContain("templates offline");
    expect(contentIds(set.builder)).toHaveLength(before.length + 1);
    expect(set.builder.controller.canUndo()).toBe(true);
    expect(layout.canUndo()).toBe(false);
    // A rejection before any insert: nothing was changed.
    set.page.pdf.actions.createFormFields = () => Promise.reject(new Error("offline"));
    expect(refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }))).toMatchObject({ code: "refused", message: "The builder did not add the form fields; nothing was changed." });
    expect(contentIds(set.builder)).toHaveLength(before.length + 1);
  });

  it("maps each errorCode, never PBM's words", async () => {
    const set = documentsBuilder();
    const layout = openTemplate(set);
    for (const [errorCode, code, details] of [
      ["form-unsaved", "unsaved-draft", { reason: "draft" }],
      ["layout-unsaved", "unsaved-draft", { reason: "draft", componentId: "cra-t2125/root" }],
      ["holding", "unsaved-draft", { reason: "prompt" }],
      ["no-form", "not-a-template", { id: "cra-t2125", fields: 5 }],
      ["refused", "refused", {}]
    ] as const) {
      set.page.pdf.state.formFields = { added: [], mapped: 0, matched: 0, skipped: [], error: `pdf.fill words for ${errorCode}`, errorCode };
      const refused = refusalOf(await call(set.builder, { action: "create_form_fields", kind: "pdf_layout" }));
      expect(refused, errorCode).toMatchObject({ code, details });
      expect(JSON.stringify(refused), errorCode).not.toContain("pdf.fill words");
    }
    expect(layout.canUndo()).toBe(false);
  });
});

describe("preview_pdf: the person's preview, metadata only", () => {
  it("returns codes and counts, never a warning's text, and hands the mode the layout and the answers only (never a signature)", async () => {
    const set = documentsBuilder();
    const seen: PdfPreviewReportOptions[] = [];
    const original = set.page.pdf.actions.previewReport;
    set.page.pdf.actions.previewReport = (options) => {
      seen.push(options);
      return original(options);
    };
    const sample = { formRoot: () => ({ id: "root", type: "form" }) } as unknown as RenderableRuntime;
    set.ui.hostRuntimeForPdf = () => sample;
    set.page.pdf.state.preview = {
      layoutId: "cra-t2125",
      layoutChoice: "asked",
      layoutKind: "template",
      pageCount: 2,
      warnings: [{ code: "font.fallback", componentId: "full_name", message: "Kernel says: secret wording" } as { code: string; componentId: string }],
      fields: { filled: 7, empty: 3 }
    };
    const result = okOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout", id: "cra-t2125" }));
    expect(result).toMatchObject({
      action: "preview_pdf",
      changed: false,
      preview: { layoutId: "cra-t2125", layoutChoice: "given", layoutKind: "template", pageCount: 2, answers: "host", warnings: [{ code: "font.fallback", componentId: "full_name" }], fields: { filled: 7, empty: 3 } },
      next: ["Tell the person the preview is open; downloading it from there is theirs."]
    });
    expect(JSON.stringify(result)).not.toContain("secret wording");
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(["layoutId", "runtime"]);
    expect(seen[0]?.runtime).toBe(sample);
  });

  it("prints Try it's answers by default when there are some, the page's sample ones on request", async () => {
    const set = documentsBuilder({ stub: { trying: true, triedAnswers: { full_name: "Ana" } } });
    const tried = { formRoot: () => ({ id: "root", type: "form" }) } as unknown as RenderableRuntime;
    const sample = { formRoot: () => ({ id: "root", type: "form" }) } as unknown as RenderableRuntime;
    set.ui.triedRuntimeForPdf = () => tried;
    set.ui.hostRuntimeForPdf = () => sample;
    const runtimes: unknown[] = [];
    const original = set.page.pdf.actions.previewReport;
    set.page.pdf.actions.previewReport = (options) => {
      runtimes.push(options.runtime);
      return original(options);
    };
    expect((okOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout" })).preview as { answers: string }).answers).toBe("tried");
    expect((okOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout", answers: "host" })).preview as { answers: string }).answers).toBe("host");
    expect(runtimes).toEqual([tried, sample]);
    set.ui.triedRuntimeForPdf = () => undefined;
    const fallback = okOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout", answers: "tried" }));
    expect(fallback.warnings).toEqual(["no-tried-answers: Try it holds no answers; the preview prints the page's sample answers"]);
  });

  it("answers busy { pdf-preview } while a preview renders, words a failed render itself, and refuses an unknown id", async () => {
    const set = documentsBuilder();
    set.page.pdf.state.preview = { error: "Another preview", busy: true };
    expect(refusalOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout" }))).toMatchObject({ code: "busy", retryable: true, details: { because: "pdf-preview" } });
    set.page.pdf.state.preview = { error: "PDF kernel: font table 0x2f broken" };
    const refused = refusalOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout" }));
    expect(refused.code).toBe("refused");
    expect(JSON.stringify(refused)).not.toContain("0x2f");
    expect(refusalOf(await call(set.builder, { action: "preview_pdf", kind: "pdf_layout", id: "nope" })).code).toBe("unknown-document");
  });
});

// ---- over the real modes -----------------------------------------------------------------

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

/** The real PDF mode on a page (its overlays in a shadow root), activated, its first layout's designer built. */
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
  await made.activate!({ host, root, showCanvasSurface: () => undefined });
  await until(() => made.ready);
  return made;
}

describe("over the real modes (the adapters' 1:1 calls)", () => {
  const modes: Array<PdfBuilderMode | JourneyBuilderMode> = [];
  afterEach(() => {
    for (const mode of modes.splice(0)) {
      mode.dispose?.();
    }
  });

  it("renames a journey (a string in the form's default language, its translations the map's), reads it back, and the reverse restores it", async () => {
    const set = documentsBuilder();
    const block: JourneyConfiguration = { ...JSON_OF(AGENT_BUILDER_JOURNEYS) };
    const mode = createJourneyBuilderMode({ form: set.builder.controller, journey: JSON_OF(block) });
    modes.push(mode);
    set.ui.journeys = () => journeySide(mode);
    const selectJourney = vi.spyOn(mode, "selectJourney");
    // A French name lives in the definition's map and is not touched by the rename (it goes stale instead).
    set.builder.controller.setOptions({ translations: { "fr-CA": { journeys: { intake: { name: { text: "Accueil", source: sourceHash("Intake") } } } } } });
    const renamed = okOf(await call(set.builder, { action: "rename", kind: "journey", id: "intake", name: "Intake 2" }));
    expect(renamed).toMatchObject({ document: { id: "intake", name: "Intake 2" }, reverse: { input: { name: "Intake" } } });
    expect(mode.journeyConfiguration?.journeys?.[0]?.name).toBe("Intake 2");
    expect(set.builder.controller.translations()?.["fr-CA"]?.journeys?.intake?.name).toEqual({ text: "Accueil", source: sourceHash("Intake") });
    okOf(await call(set.builder, (renamed.reverse as { input: Record<string, unknown> }).input));
    expect(JSON_OF(mode.journeyConfiguration)).toEqual(JSON_OF(block));
    // Opening goes through the shell's waiter, never the mode's own select (which has no guard).
    const opened: unknown[][] = [];
    set.ui.selectDocument = (...args) => {
      opened.push(args);
      return Promise.resolve({ status: "opened" });
    };
    okOf(await call(set.builder, { action: "open", kind: "journey", id: "intake" }));
    expect(opened).toEqual([["journeys", "intake"]]);
    expect(selectJourney).not.toHaveBeenCalled();
  });

  it("a real journey removed and restored, a real default set and taken back, JSON-equal through the catalog seam", async () => {
    const set = documentsBuilder();
    const mode = createJourneyBuilderMode({ form: set.builder.controller, journey: JSON_OF(THREE_JOURNEYS) });
    modes.push(mode);
    set.ui.journeys = () => journeySide(mode);
    const applied = vi.spyOn(mode, "applyCatalogForAgent");
    okOf(await set.builder.execute("remove_part", { kind: "journey", id: "b" }));
    expect(mode.journeys.map((journey) => journey.id)).toEqual(["a", "c"]);
    okOf(await call(set.builder, { action: "restore_removed", kind: "journey", id: "b" }));
    expect(JSON_OF(mode.journeyConfiguration)).toEqual(JSON_OF(THREE_JOURNEYS));
    expect(applied).toHaveBeenCalledTimes(1);
    okOf(await set.builder.execute("begin_session", { purpose: "Default" }));
    okOf(await call(set.builder, { action: "set_default", kind: "journey", id: "form" }));
    expect(mode.opensAs).toBe("form");
    okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(JSON_OF(mode.journeyConfiguration)).toEqual(JSON_OF(THREE_JOURNEYS));
  });

  it("the real PDF mode makes an unnamed layout under the builder's default words; a rename of the open layout writes no step on its tree", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const mode = await realPdfMode({ layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" });
    modes.push(mode);
    set.ui.pdfLayouts = () => pdfSide(mode);
    set.ui.selectDocument = () => Promise.resolve({ status: "opened" });
    set.stub.state.activeController = mode.controller;
    const selectLayout = vi.spyOn(mode, "selectLayout");
    const made = okOf(await call(set.builder, { action: "new", kind: "pdf_layout" }));
    expect(made).toMatchObject({ changed: true, document: { name: "Custom layout" } });
    expect(mode.layouts.map((layout) => layout.name)).toEqual(["Summary", "Full", "Custom layout"]);
    const renamed = okOf(await call(set.builder, { action: "rename", kind: "pdf_layout", id: "a", name: "Short" }));
    expect(renamed).toMatchObject({ changed: true, document: { name: "Short" } });
    expect(renamed).not.toHaveProperty("elsewhere");
    // The open designer's tree takes the name with no entry of its own.
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("Short");
    expect(mode.controller.canUndo()).toBe(false);
    expect(selectLayout).not.toHaveBeenCalled();
    okOf(await call(set.builder, (renamed.reverse as { input: Record<string, unknown> }).input));
    expect(mode.layouts.find((layout) => layout.id === "a")?.name).toBe("Summary");
  });

  it("a rename of the open layout is one record: Undo all puts the name back through the catalog seam, pushing nothing on the layout's history", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const mode = await realPdfMode({ layouts: [modeLayout("a", "Summary"), modeLayout("b", "Full")], defaultLayoutId: "a" });
    modes.push(mode);
    set.ui.pdfLayouts = () => pdfSide(mode);
    set.ui.selectDocument = () => Promise.resolve({ status: "opened" });
    set.stub.state.activeController = mode.controller;
    const memory = set.builder.catalogue.shared.memory;
    okOf(await set.builder.execute("begin_session", { purpose: "Rename" }));
    okOf(await call(set.builder, { action: "rename", kind: "pdf_layout", id: "a", name: "Short" }));
    // This mode has no form to make the rename a step of, so the journal holds it, and follows no layout for it.
    expect(memory.outside.map((entry) => entry.kind)).toEqual(["catalog"]);
    expect(memory.layoutFollowers.size).toBe(0);
    expect(mode.controller.canUndo()).toBe(false);
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 1 });
    expect(mode.layouts.find((layout) => layout.id === "a")?.name).toBe("Summary");
    expect((mode.controller.snapshot().configuration as { name?: unknown }).name).toBe("Summary");
    expect(mode.controller.canUndo()).toBe(false);
    expect(memory.outside).toHaveLength(0);
  });
});
