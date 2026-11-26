import { afterEach, describe, expect, it, vi } from "vitest";

import { checkActionArgs } from "../form-engine/agent/folded-actions.js";
import { createFakeModelContext } from "../form-engine/testing/fake-model-context.js";
import { SENTINEL_TOOLS, type BuilderCallScope, type WriteKind } from "../form-engine/agent/builder/context.js";
import { createControllerHost, shellLoaders } from "../form-engine/agent/builder/host.js";
import { BUILDER_AGENT_TOOL_NAMES, createBuilderTools } from "../form-engine/agent/builder/tools.js";
import { BuilderController, type LeaveGuard } from "../form-engine/builder/controller/builder-controller.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { fakePdf } from "./fixtures/agent-builder-adapters.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, contactRequestController, okOf, refusalOf, uiStub, type AgentBuilder } from "./fixtures/agent-builder.js";

/**
 * The builder catalogue's foundation: the twenty-four names, the lazy bodies (each loaded on first use,
 * a failed load answered `chunk-unavailable` and retried, each factory handed its own catalogue's
 * `shared`), the yield rules of the new write kinds read on the active controller too, the
 * active-controller check at begin_session, `around`, the folded check, the sentinel names and
 * the data-model planner's loader on both hosts.
 */

afterEach(() => {
  vi.doUnmock("../form-engine/agent/builder/agentpart-try.js");
  vi.doUnmock("../form-engine/agent/builder/agentpart-languages.js");
  vi.doUnmock("../form-engine/agent/builder/agentpart-documents.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

const LATER_TOOLS = ["try_it", "languages", "documents", "remove_part", "save"];

/** A fresh scope as a tool body gets it. */
function scopeOf(builder: AgentBuilder): BuilderCallScope {
  return builder.catalogue.shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
}

/** A designer document's controller (a journey's or a layout's), with one field `title`. */
function designerController(): BuilderController {
  const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "title", type: "text", configuration: { label: "Title" } }] } };
  return new BuilderController({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
}

/** A leave guard holding edits, named `id`. */
function guard(id: string): LeaveGuard {
  return { pending: () => true, subject: () => ({ id, label: id, blocked: false }), save: () => true, discard: () => undefined };
}

/** What `yieldToPerson` throws (its code and details), or undefined when it lets the write through. */
function yieldOf(builder: AgentBuilder, kind: WriteKind, options?: Parameters<AgentBuilder["catalogue"]["shared"]["yieldToPerson"]>[2]): { code: string; details?: Record<string, unknown> } | undefined {
  try {
    builder.catalogue.shared.yieldToPerson(scopeOf(builder), kind, options);
    return undefined;
  } catch (error) {
    const refusal = error as { code: string; details?: Record<string, unknown> };
    return { code: refusal.code, ...(refusal.details !== undefined ? { details: refusal.details } : {}) };
  }
}

const NEW_KINDS: WriteKind[] = ["try", "languages", "catalog", "save", "identity", "fields"];

describe("the twenty-four names", () => {
  it("lists the first nineteen then the five later tools, and the catalogue returns exactly them", () => {
    expect(BUILDER_AGENT_TOOL_NAMES).toHaveLength(24);
    expect(BUILDER_AGENT_TOOL_NAMES.slice(19)).toEqual(LATER_TOOLS);
    expect(BUILDER_AGENT_TOOL_NAMES.slice(0, 19)).toEqual([
      "describe_builder",
      "get_form",
      "get_component",
      "list_component_types",
      "add_components",
      "replace_form",
      "set_properties",
      "rename_component",
      "move_component",
      "remove_components",
      "duplicate_component",
      "open",
      "history",
      "check_form",
      "get_definition",
      "list_tests",
      "write_test",
      "remove_test",
      "run_tests"
    ]);
    const tools = createBuilderTools(createControllerHost(contactRequestController())).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...BUILDER_AGENT_TOOL_NAMES]);
  });

  it("registers twenty-six names on a builder page (the catalogue's and the session pair)", async () => {
    const builder = agentBuilder();
    await builder.registrar.bind(createFakeModelContext());
    const names = builder.registrar.binding().names;
    expect(names).toHaveLength(26);
    expect([...names].sort()).toEqual([...BUILDER_AGENT_TOOL_NAMES, "begin_session", "end_session"].sort());
  });

  it("keeps the sentinel names in context.ts for the body modules", () => {
    expect(SENTINEL_TOOLS).toEqual({ describeBuilder: "describe_builder", listComponentTypes: "list_component_types" });
  });
});

describe("the lazy bodies", () => {
  /**
   * The body modules with their factories counted: each factory is the real one, wrapped. The fixture is imported fresh after the mocks, so
   * the registrar, the bodies and `ToolRefusal` come from one module graph and a body's own
   * refusal reaches the registrar as itself (a body loaded into a graph `vi.resetModules()`
   * replaced would answer `internal` with its message, which is the artefact the stub-era case
   * leaned on).
   */
  async function countedBodies(): Promise<{ fixture: typeof import("./fixtures/agent-builder.js"); made: Record<string, number> }> {
    vi.resetModules();
    const made: Record<string, number> = { tryItBody: 0, languagesBody: 0, documentsBody: 0, removePartBody: 0 };
    const counted = <M extends Record<string, unknown>>(actual: M, names: string[]): M => {
      const out: Record<string, unknown> = { ...actual };
      for (const name of names) {
        const factory = actual[name] as (...args: unknown[]) => unknown;
        out[name] = (...args: unknown[]) => {
          made[name] = (made[name] ?? 0) + 1;
          return factory(...args);
        };
      }
      return out as M;
    };
    vi.doMock("../form-engine/agent/builder/agentpart-try.js", async (importOriginal) => counted(await importOriginal<Record<string, unknown>>(), ["tryItBody"]));
    vi.doMock("../form-engine/agent/builder/agentpart-languages.js", async (importOriginal) => counted(await importOriginal<Record<string, unknown>>(), ["languagesBody"]));
    vi.doMock("../form-engine/agent/builder/agentpart-documents.js", async (importOriginal) => counted(await importOriginal<Record<string, unknown>>(), ["documentsBody", "removePartBody"]));
    const fixture = await import("./fixtures/agent-builder.js");
    return { fixture, made };
  }

  it("loads each body once per registration on a read action, which it answers as a read", async () => {
    const { fixture, made } = await countedBodies();
    const builder = fixture.agentBuilder();
    const rows: Array<[string, Record<string, unknown>, string]> = [
      // A bare controller has no Try it: the built body's own guard.
      ["try_it", { action: "read" }, "no-ui"],
      ["languages", { action: "list" }, "ok"],
      ["languages", { action: "texts" }, "ok"],
      // The designers are the page's; a bare controller has neither.
      ["documents", { action: "list", kind: "journey" }, "no-ui"]
    ];
    for (const [name, input, outcome] of rows) {
      const before = builder.host.calls.length;
      const result = await builder.execute(name, input);
      expect(result.ok ? "ok" : result.code, name).toBe(outcome);
      if (!result.ok) {
        expect(result.retryable, name).toBe(false);
      } else {
        expect((result as unknown as { action: string }).action, name).toBe(input.action);
      }
      const action = builder.host.calls.slice(before).find((call) => call.method === "emit" && call.args[0] === "datum-agent-action")?.args[1] as { tool: string; readOnly: boolean } | undefined;
      expect(action, name).toMatchObject({ tool: name, readOnly: true });
    }
    // One factory call per body for this registration, however many calls reached it; documents'
    // module also holds remove_part's body, which nothing has asked for yet.
    expect(made).toEqual({ tryItBody: 1, languagesBody: 1, documentsBody: 1, removePartBody: 0 });
    // A second registration makes its own.
    const second = fixture.agentBuilder({ id: "second" });
    expect((await second.execute("languages", { action: "list", builder: "second" })).ok).toBe(true);
    expect(made.languagesBody).toBe(2);
  });

  it("answers the built bodies' own refusals on the write actions, remove_part and save over a bare controller", async () => {
    const { fixture, made } = await countedBodies();
    const builder = fixture.agentBuilder();
    for (const [name, input] of [
      ["try_it", { action: "fill", answers: { full_name: "Ana" } }],
      ["languages", { action: "preview", code: "fr-CA" }],
      ["documents", { action: "open", kind: "journey", id: "intake" }],
      ["remove_part", { kind: "journey", id: "intake" }],
      ["save", {}]
    ] as const) {
      const refused = refusalOf(await builder.execute(name, input));
      expect(refused.code, name).not.toBe("internal");
      expect(refused.code, name).not.toBe("chunk-unavailable");
      expect(refused.message, name).not.toBe("Not built yet.");
      expect(refused.retryable, name).toBe(false);
      // Every one of them needs the page; the bare controller has none.
      expect(refused.code, name).toBe("no-ui");
    }
    expect(made).toEqual({ tryItBody: 1, languagesBody: 1, documentsBody: 1, removePartBody: 1 });
  });

  for (const [tool, input, module, what, outcome] of [
    ["try_it", { action: "read" }, "../form-engine/agent/builder/agentpart-try.js", "agent-try", "no-ui"],
    ["languages", { action: "list" }, "../form-engine/agent/builder/agentpart-languages.js", "agent-languages", "ok"],
    ["documents", { action: "list", kind: "pdf_layout" }, "../form-engine/agent/builder/agentpart-documents.js", "agent-documents", "no-ui"]
  ] as const) {
    it(`answers a failed ${what} load with retryable chunk-unavailable, and loads again on a later call`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.resetModules();
      vi.doMock(module, () => {
        throw new Error("x");
      });
      const fixture = await import("./fixtures/agent-builder.js");
      const builder = fixture.agentBuilder();
      const refused = refusalOf(await builder.execute(tool, input));
      expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what, state: "failed" } });
      expect(refused.hint).toBe("Try once more; if it fails again the host removed that file: tell the person.");
      vi.doUnmock(module);
      // A later call on the same catalogue tries the load again (the failed one was forgotten) and
      // reaches the built body: its own answer on a bare controller, never chunk-unavailable.
      const later = await builder.execute(tool, input);
      expect(later.ok ? "ok" : later.code).toBe(outcome);
      // A fresh import with the module back loads it too.
      vi.resetModules();
      const fresh = await import("./fixtures/agent-builder.js");
      const again = await fresh.agentBuilder().execute(tool, input);
      expect(again.ok ? "ok" : again.code).toBe(outcome);
    });
  }

  it("hands each body factory its own catalogue's shared, so two builders on one page never share one", async () => {
    vi.resetModules();
    const seen: unknown[] = [];
    vi.doMock("../form-engine/agent/builder/agentpart-try.js", () => ({
      tryItBody: (shared: unknown) => {
        seen.push(shared);
        return { run: () => ({ action: "read", changed: false }) };
      }
    }));
    const fixture = await import("./fixtures/agent-builder.js");
    const first = fixture.agentBuilder({ id: "first" });
    const second = fixture.agentBuilder({ id: "second" });
    expect(okOf(await first.execute("try_it", { action: "read" })).action).toBe("read");
    expect(okOf(await second.execute("try_it", { action: "read" })).action).toBe("read");
    // One load per catalogue: a second call reuses the body.
    okOf(await first.execute("try_it", { action: "read" }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(first.catalogue.shared);
    expect(seen[1]).toBe(second.catalogue.shared);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("the yield rules of the additional write kinds", () => {
  it("lets every new kind through on a clean page, and never refuses wrong-mode for one", () => {
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    for (const kind of NEW_KINDS) {
      expect(yieldOf(builder, kind), kind).toBeUndefined();
    }
    // A tree write still refuses in a designer.
    expect(yieldOf(builder, "tree")?.code).toBe("wrong-mode");
  });

  it("refuses try-it-on for fields alone", () => {
    const stub = uiStub({ trying: true, triedAnswers: { full_name: "Ana" } });
    const builder = agentBuilder({ ui: stub });
    for (const kind of NEW_KINDS) {
      const refused = yieldOf(builder, kind);
      if (kind === "fields") {
        expect(refused).toEqual({ code: "try-it-on", details: { triedPaths: 1 } });
      } else {
        expect(refused, kind).toBeUndefined();
      }
    }
  });

  it("refuses every new kind on a prompt up on the form's controller or on the active one, and leaves the prompt as it was", () => {
    for (const where of ["form", "active"] as const) {
      const stub = uiStub();
      const builder = agentBuilder({ ui: stub });
      const designer = designerController();
      stub.state.activeController = designer;
      const controller = where === "form" ? builder.controller : designer;
      const id = where === "form" ? "email" : "title";
      controller.select(id);
      controller.setDraftProperty(id, "label", "typed");
      expect(controller.requestSelect(where === "form" ? "topic" : "root")).toBe(false);
      const prompt = controller.unsavedChangesPrompt();
      expect(prompt).toBeDefined();
      for (const kind of NEW_KINDS) {
        expect(yieldOf(builder, kind), `${where} ${kind}`).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt" } });
        expect(controller.unsavedChangesPrompt()).toEqual(prompt);
      }
    }
  });

  it("follows each kind's draft rules and never raises a prompt", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const form = builder.controller;
    const root = form.rootId();
    const expectNoPrompt = (): void => {
      expect(form.unsavedChangesPrompt()).toBeUndefined();
    };

    // A draft on a component the person selected (not the root).
    form.select("email");
    form.setDraftProperty("email", "label", "typed");
    expect(yieldOf(builder, "try")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(yieldOf(builder, "catalog")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(yieldOf(builder, "save")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(yieldOf(builder, "fields")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    // languages and identity read the root's draft only.
    expect(yieldOf(builder, "languages")).toBeUndefined();
    expect(yieldOf(builder, "identity")).toBeUndefined();
    expectNoPrompt();
    form.discardDraft("email");

    // The root's draft (the Form panel).
    form.select(root);
    form.setDraftProperty(root, "title", "Draft title");
    expect(yieldOf(builder, "languages")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: root } });
    expect(yieldOf(builder, "identity")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: root } });
    expect(yieldOf(builder, "save")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: root } });
    // create_form_fields reads the selection's draft as a tree write does, never the root's.
    expect(yieldOf(builder, "fields")).toBeUndefined();
    expectNoPrompt();
    form.discardDraft(root);

    // The Languages surface's typed cells (its leave guard): languages and save stop, identity does not.
    stub.state.languagesPending = 3;
    form.setLeaveGuard(guard("languages-texts"));
    expect(yieldOf(builder, "languages")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "languages-texts", cells: 3 } });
    expect(yieldOf(builder, "save")).toMatchObject({ code: "unsaved-draft", details: { componentId: "languages-texts" } });
    expect(yieldOf(builder, "identity")).toBeUndefined();
    form.setLeaveGuard(undefined);

    // Another leave guard (the Tests panel's): languages walks past it, save and Try it's start do not.
    form.setLeaveGuard(guard("tests-panel"));
    expect(yieldOf(builder, "languages")).toBeUndefined();
    expect(yieldOf(builder, "save")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "tests-panel" } });
    expect(yieldOf(builder, "try")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "tests-panel" } });
    form.setLeaveGuard(undefined);
    expectNoPrompt();
  });

  it("reads a designer document's draft on the active controller and names it <documentId>/<nodeId>", () => {
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    const designer = designerController();
    const pdf = fakePdf();
    pdf.designer.openId = "cra-t2125";
    pdf.state.layoutController = designer;
    stub.state.pdf = pdf.side();
    stub.state.activeController = designer;
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    // fields reads the layout's drafts: the active controller while the PDF designer is open,
    // also when the tool names the form as the controller to check.
    for (const kind of ["try", "catalog", "save", "fields"] as const) {
      expect(yieldOf(builder, kind), kind).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "cra-t2125/title" } });
    }
    expect(yieldOf(builder, "fields", { controller: builder.controller })).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "cra-t2125/title" } });
    // languages and identity do not read the active document's drafts.
    for (const kind of ["languages", "identity"] as const) {
      expect(yieldOf(builder, kind), kind).toBeUndefined();
    }
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
  });

  it("fields with { controller: form } in the PDF designer: the form's selection draft and the layout's drafts, never the form's root draft or its Tests panel", () => {
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    const form = builder.controller;
    const designer = designerController();
    const pdf = fakePdf();
    pdf.designer.openId = "cra-t2125";
    pdf.state.layoutController = designer;
    stub.state.pdf = pdf.side();
    stub.state.activeController = designer;
    const fields = (): ReturnType<typeof yieldOf> => yieldOf(builder, "fields", { controller: form });
    expect(fields()).toBeUndefined();
    // The Form panel's root draft: not what inserting form fields walks past.
    form.select(form.rootId());
    form.setDraftProperty(form.rootId(), "title", "Draft title");
    expect(fields()).toBeUndefined();
    form.discardDraft(form.rootId());
    // The Tests panel's unsaved edits (the form's leave guard): not a fields rule either.
    form.setLeaveGuard(guard("tests-panel"));
    expect(fields()).toBeUndefined();
    form.setLeaveGuard(undefined);
    // The form's selected draft, as a tree write reads it.
    form.select("email");
    form.setDraftProperty("email", "label", "typed");
    expect(fields()).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    form.discardDraft("email");
    // A leave guard on the layout's controller.
    designer.setLeaveGuard(guard("layout-rules"));
    expect(fields()).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "layout-rules" } });
    expect(form.unsavedChangesPrompt()).toBeUndefined();
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
  });

  it("with a designer active, save reads the form's selection draft, catalog the designer's leave guard and try the form's", () => {
    const stub = uiStub({ mode: "journeys", workspace: "journeys" });
    const builder = agentBuilder({ ui: stub });
    const form = builder.controller;
    const designer = designerController();
    stub.state.activeController = designer;
    // An Inspector draft the person left on the form before opening the designer.
    form.select("email");
    form.setDraftProperty("email", "label", "typed");
    expect(yieldOf(builder, "save")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    form.discardDraft("email");
    // A leave guard holding edits in the designer.
    designer.setLeaveGuard(guard("journey-rules"));
    expect(yieldOf(builder, "catalog")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "journey-rules" } });
    designer.setLeaveGuard(undefined);
    // The form's Tests panel holding edits: starting Try it would walk past it.
    form.setLeaveGuard(guard("tests-panel"));
    expect(yieldOf(builder, "try")).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "tests-panel" } });
    form.setLeaveGuard(undefined);
    expect(yieldOf(builder, "try")).toBeUndefined();
  });

  it("blockers() reports a prompt raised on the active controller (a designer document's)", () => {
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    const designer = designerController();
    stub.state.activeController = designer;
    expect(builder.catalogue.shared.blockers(scopeOf(builder)).reasons).not.toContain("prompt");
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    expect(designer.requestSelect("root")).toBe(false);
    expect(designer.unsavedChangesPrompt()).toBeDefined();
    expect(builder.catalogue.shared.blockers(scopeOf(builder)).reasons).toContain("prompt");
  });

  it("reads the document's own controller when the act names it (catalog, fields)", () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const layout = designerController();
    layout.select("title");
    layout.setDraftProperty("title", "label", "typed");
    for (const kind of ["catalog", "fields"] as const) {
      expect(yieldOf(builder, kind, { controller: layout, documentId: "summary" }), kind).toEqual({ code: "unsaved-draft", details: { reason: "draft", componentId: "summary/title" } });
      expect(yieldOf(builder, kind), `${kind} without the document`).toBeUndefined();
    }
  });
});

describe("begin_session and the active controller", () => {
  it("refuses unsaved-draft on a draft in the active controller (a designer document's), raising no prompt", async () => {
    const stub = uiStub({ mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ ui: stub });
    const designer = designerController();
    const pdf = fakePdf();
    pdf.designer.openId = "cra-t2125";
    pdf.state.layoutController = designer;
    stub.state.pdf = pdf.side();
    stub.state.activeController = designer;
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    const refused = refusalOf(await builder.execute("begin_session", { purpose: "Map the PDF" }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "cra-t2125/title" } });
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
    designer.discardDraft("title");
    expect(okOf(await builder.execute("begin_session", { purpose: "Map the PDF" })).locked).toBe(true);
  });
});

describe("shared helpers", () => {
  it("around runs a mode's step with the writing flag up, so its history step is the agent's", () => {
    const builder = agentBuilder();
    const scope = scopeOf(builder);
    const around = builder.catalogue.shared.around(scope);
    let writing: boolean | undefined;
    around(() => {
      writing = builder.catalogue.shared.memory.writing;
      builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]);
    });
    expect(writing).toBe(true);
    expect(builder.catalogue.shared.memory.writing).toBe(false);
    expect(builder.catalogue.shared.memory.ownSteps).toBe(1);
  });

  it("folded is the folded-action check, and every call gets its own id", () => {
    const builder = agentBuilder();
    expect(builder.catalogue.shared.folded).toBe(checkActionArgs);
    expect(scopeOf(builder).call).not.toBe(scopeOf(builder).call);
  });

  it("hands both hosts the data-model planner's loader, which loads the plan module", async () => {
    expect(typeof shellLoaders().loadDataModelKit).toBe("function");
    const host = createControllerHost(contactRequestController());
    expect(typeof host.loadDataModelKit).toBe("function");
    const kit = await host.loadDataModelKit?.();
    expect(typeof kit?.planDataModelAdd).toBe("function");
    expect(typeof kit?.formDataModel).toBe("function");
  });

  it("forgets the agent's tried answers once a call finds Try it off", () => {
    const stub = uiStub({ trying: true });
    const builder = agentBuilder({ ui: stub });
    const memory = builder.catalogue.shared.memory;
    memory.tried.set("full_name", JSON.stringify("Ana"));
    memory.tryLast.lastCheck = { at: 1, problemCount: 0 };
    scopeOf(builder);
    expect(memory.tried.size).toBe(1);
    stub.state.trying = false;
    scopeOf(builder);
    expect(memory.tried.size).toBe(0);
    expect(memory.tryLast).toEqual({});
  });
});
