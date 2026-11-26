import { describe, expect, it } from "vitest";

import { createAgentRegistrar } from "../form-engine/agent/registrar.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { loadDataModelPlan } from "../form-engine/builder/data/data-model-plan-loader.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, contactRequestController, contactRequestRoot, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";
import { documentsBuilder } from "./fixtures/agent-builder-documents-fakes.js";
import { tryPage } from "./fixtures/agent-builder-try-fakes.js";

/**
 * The builder catalogue's reads: describe_builder over the contact-request fixture, the handle rules, the two-builder
 * listing, get_form's paging and full rows, get_component's draft-applied properties,
 * list_component_types, get_definition's sections, the `stale` details and what moves the
 * revision.
 */

describe("describe_builder", () => {
  it("describes the contact-request form: identity, counts, features, undo and guidance", async () => {
    const builder = agentBuilder({ id: "contact-request" });
    const result = okOf(await builder.execute("describe_builder", {}));
    expect(result).toMatchObject({
      tool: "describe_builder",
      builder: "contact-request",
      revision: 1,
      toolset: "datum-builder/1",
      identity: { id: "contact-request", version: "1.0.0", schemaVersion: "1" },
      title: "Contact request",
      rootId: "root",
      empty: false,
      locale: "en",
      locales: [
        { code: "en", label: "English" },
        { code: "fr-CA", label: "Français (Canada)" }
      ],
      availableBindings: ["gcds"],
      counts: {
        components: 8,
        containers: 2,
        fields: 5,
        byType: { form: 1, text: 2, select: 1, fieldset: 1, textarea: 1, checkbox: 1, button: 1 },
        tests: 1,
        dataSources: 1,
        problems: 0,
        pdfLayouts: 0,
        journeys: 0
      },
      dataSourceIds: ["provinces"],
      blockedBy: [],
      undo: { steps: 0, ownSteps: 0, canUndo: false, canRedo: false },
      stopped: false
    });
    expect(result.features).toEqual(expect.objectContaining({ off: [] }));
    expect((result.features as { on: string[] }).on).toContain("agent");
    // A bare controller: no page to describe, no selection.
    expect(result.ui).toBeUndefined();
    expect(result.selection).toBeUndefined();
    const guidance = result.guidance as string[];
    expect(guidance[0]).toMatch(/^Component ids are the handles/);
    expect(guidance[guidance.length - 1]).toMatch(/^For several writes, call begin_session first/);
    // Four standing lines (the third reworded, one new) and the closing one; the fixture declares its languages, so no situational line.
    expect(guidance).toHaveLength(5);
  });

  it("reports the page, the selection, what blocks a write and the features left off", async () => {
    const stub = uiStub({ dirty: true, mode: "pdf", workspace: "pdf" });
    const builder = agentBuilder({ id: "contact-request", ui: stub, featureOn: { journeys: false, pdf: false, tests: false } });
    builder.controller.select("topic");
    builder.controller.setDraftProperty("topic", "label", "Subject");
    const result = okOf(await builder.execute("describe_builder", {}));
    expect(result.ui).toEqual({ workspace: "pdf", workspacesAvailable: ["form", "logic", "data", "languages"], mode: "pdf", panel: "components", trying: false, dirty: true, workspaceProblems: {}, tryable: true });
    expect(result.selection).toEqual({ componentId: "topic", type: "select", label: "Topic", hasUnsavedDraft: true });
    expect(result.blockedBy).toEqual(["draft", "wrong-mode"]);
    expect(result.draftComponentId).toBe("topic");
    expect((result.features as { off: string[] }).off).toEqual(["journeys", "pdf", "tests"]);
    const guidance = result.guidance as string[];
    expect(guidance).toContain("The person is editing topic; writes are refused until they apply or discard that edit.");
    expect(guidance).toContain(
      "The person is in the pdf designer: changes to components are refused there (open { workspace: 'form' } moves the person, so ask first); documents, languages, try_it and save work from here."
    );
    expect(guidance).toContain("The form has unsaved changes; this builder has no Save, so keeping them is the person's action (Download or their site's own save).");
    expect(guidance).toContain("Tests are off in this host: write_test, remove_test and run_tests will refuse.");
    expect(guidance).toContain("journeys is off in this host; the matching workspace and sections are unavailable.");
  });

  it("calls an empty form empty: nothing but the untouched seeded Submit", async () => {
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "submit", type: "button", configuration: { label: "Submit", action: "submit" } }] } };
    const result = okOf(await agentBuilder({ root, tests: null }).execute("describe_builder", {}));
    expect(result.empty).toBe(true);
    expect(result.guidance as string[]).toContain(
      "The form is empty: add_components with the whole tree builds it in one step; keep the Submit button last (it stays last by default)."
    );
  });
});

describe("handles and the two-builder listing", () => {
  it("uses the element id as the handle, else builder-<n>; the definition's id is never the handle", async () => {
    const registrar = createAgentRegistrar();
    const named = agentBuilder({ id: "intake", registrar });
    const unnamed = agentBuilder({ registrar });
    expect(named.registration.handle).toBe("intake");
    expect(unnamed.registration.handle).toBe("builder-1");
    const described = okOf(await registrar.execute("describe_builder", { builder: "builder-1" }));
    expect(described.builder).toBe("builder-1");
    expect((described.identity as { id: string }).id).toBe("contact-request");
  });

  it("lists both builders without a revision, and refuses get_form without a handle", async () => {
    const registrar = createAgentRegistrar();
    agentBuilder({ id: "one", registrar });
    agentBuilder({ id: "two", registrar });
    const listing = okOf(await registrar.execute("describe_builder", {}));
    expect(listing.revision).toBeUndefined();
    expect(listing.builders).toEqual([
      { builder: "one", title: "Contact request", dirty: false, workspace: "form" },
      { builder: "two", title: "Contact request", dirty: false, workspace: "form" }
    ]);
    const refused = refusalOf(await registrar.execute("get_form", {}));
    expect(refused.code).toBe("builder-required");
  });
});

describe("get_form", () => {
  it("pages the outline in document order", async () => {
    const builder = agentBuilder({ id: "contact-request" });
    const first = okOf(await builder.execute("get_form", { limit: 3 }));
    expect(first).toMatchObject({ rootId: "root", total: 8, count: 3, truncated: true, nextOffset: 3, problems: 0 });
    expect(first.nodes).toEqual([
      { id: "root", type: "form", label: "Contact request", index: 0, depth: 0, slots: [{ id: "content", count: 5, multiple: true }] },
      { id: "full_name", type: "text", label: "Full name", parentId: "root", slotId: "content", index: 0, depth: 1, path: "full_name", required: true },
      { id: "email", type: "text", label: "Email", parentId: "root", slotId: "content", index: 1, depth: 1, path: "email", required: true }
    ]);
    const rest = okOf(await builder.execute("get_form", { offset: 3 }));
    expect((rest.nodes as Array<{ id: string }>).map((node) => node.id)).toEqual(["topic", "details", "message", "subscribe", "submit"]);
    expect(rest.truncated).toBeUndefined();
  });

  it("returns a subtree to a depth, and full rows that are copies", async () => {
    const builder = agentBuilder();
    const shallow = okOf(await builder.execute("get_form", { componentId: "details", depth: 0 }));
    expect((shallow.nodes as Array<{ id: string }>).map((node) => node.id)).toEqual(["details"]);
    const full = okOf(await builder.execute("get_form", { componentId: "details", detail: "full" }));
    const nodes = full.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((node) => node.id)).toEqual(["details", "message", "subscribe"]);
    expect(nodes[1]).toMatchObject({ id: "message", rules: ["requiredWhen"], rulesText: { requiredWhen: 'topic = "other"' }, configuration: { label: "Message", rows: 4 } });
    (nodes[1]?.configuration as Record<string, unknown>).label = "Changed";
    const message = builder.controller.snapshot().children?.content?.[3]?.children?.content?.[0];
    expect((message?.configuration as Record<string, unknown>).label).toBe("Message");
  });

  it("refuses an id that names nothing, with the closest one", async () => {
    const refused = refusalOf(await agentBuilder().execute("get_form", { componentId: "detials" }));
    expect(refused.code).toBe("unknown-component");
    expect(refused.details).toEqual({ componentId: "detials", closest: "details" });
  });
});

describe("get_component", () => {
  it("lists the inspector's properties draft-applied, with the committed value where a draft differs", async () => {
    const builder = agentBuilder();
    builder.controller.setDraftProperty("topic", "label", "Subject");
    const result = okOf(await builder.execute("get_component", { componentId: "topic" }));
    expect(result.hasUnsavedDraft).toBe(true);
    const properties = result.properties as Array<Record<string, unknown>>;
    const label = properties.find((property) => property.propertyPath === "label");
    expect(label).toMatchObject({ kind: "localized-text", value: "Subject", committedValue: "Topic" });
    const options = properties.find((property) => property.propertyPath === "options");
    expect(options).toMatchObject({ kind: "options", shape: "[{ value, label }], or set configuration.data.sourceId for a data source" });
    expect((options?.options as unknown[]).length).toBe(3);
    expect(result.location).toEqual({ parentId: "root", slotId: "content", index: 2 });
    expect(result.dependents).toEqual({ items: [{ kind: "rule", componentId: "message", name: "Message", rule: "requiredWhen" }], lines: [expect.any(String)] });
    expect(result.ruleKeys).toEqual(["visibleWhen", "requiredWhen", "enabledWhen", "readonlyWhen", "validWhen", "value", "defaultValue"]);
    expect((result.moveTargets as Array<Record<string, unknown>>)[0]).toMatchObject({ parentId: "root", slotId: "content", siblings: 4, current: 2 });
  });

  it("returns a note's code beside its message, so a caller can tell it from the check's finding", async () => {
    const builder = agentBuilder();
    builder.controller.setProperty("full_name", "minLength", 9);
    builder.controller.setProperty("full_name", "maxLength", 3);
    const result = okOf(await builder.execute("get_component", { componentId: "full_name" }));
    expect(result.notes).toContainEqual({ target: "maxLength", message: expect.any(String), severity: "warning", code: "component.limits.inverted" });
  });

  it("lists the root's agentTools as an ordinary property", async () => {
    const root = contactRequestRoot();
    root.configuration = { ...(root.configuration ?? {}), agentTools: "allowed" };
    const result = okOf(await agentBuilder({ root }).execute("get_component", { componentId: "root" }));
    // The node carries the configuration as stored, so the key is there with the rest.
    expect(result.node).toMatchObject({ id: "root", configuration: { title: "Contact request", agentTools: "allowed" } });
  });

  it("reports rules with their parse status and children per slot", async () => {
    const builder = agentBuilder();
    builder.controller.setRules("subscribe", { visibleWhen: "topic = = 1" });
    const message = okOf(await builder.execute("get_component", { componentId: "message" }));
    expect(message.rules).toEqual({ requiredWhen: { formula: 'topic = "other"', parses: true } });
    const subscribe = okOf(await builder.execute("get_component", { componentId: "subscribe" }));
    const rule = (subscribe.rules as Record<string, { parses: boolean; problem?: { code: string } }>).visibleWhen;
    expect(rule?.parses).toBe(false);
    expect(rule?.problem?.code).toBeDefined();
    expect(subscribe.problems).toContainEqual({ target: "rules:visibleWhen", message: expect.any(String) });
    const details = okOf(await builder.execute("get_component", { componentId: "details" }));
    expect(details.children).toEqual([{ slotId: "content", ids: ["message", "subscribe"], multiple: true }]);
  });

  it("refuses an unknown id with the closest one in the hint", async () => {
    const refused = refusalOf(await agentBuilder().execute("get_component", { componentId: "topics" }));
    expect(refused).toMatchObject({
      code: "unknown-component",
      message: 'No component has the id "topics".',
      hint: 'Call get_form to list the current ids; ids change after rename_component and history. Closest: "topic".',
      details: { componentId: "topics", closest: "topic" },
      retryable: false
    });
  });
});

describe("list_component_types", () => {
  it("lists every insertable type, palette order first, step only inside steps, form never", async () => {
    const result = okOf(await agentBuilder().execute("list_component_types", {}));
    const types = result.types as Array<Record<string, unknown>>;
    expect(types.map((type) => type.type)).not.toContain("form");
    expect(result.notPlaceable).toEqual(["form"]);
    expect(result.rootSlots).toEqual(["content"]);
    expect(types[0]?.type).toBe("text");
    expect(types.find((type) => type.type === "step")).toMatchObject({ onPalette: false, onlyInside: ["steps"], container: true });
    expect(types.find((type) => type.type === "tabs")).toMatchObject({ configuredSlots: "tabs", slots: [{ id: "tab_1", multiple: true }, { id: "tab_2", multiple: true }] });
    expect(types.find((type) => type.type === "grid")).toMatchObject({ configuredSlots: "grid", slots: [{ id: "column_1", multiple: true }, { id: "column_2", multiple: true }] });
    expect(types.find((type) => type.type === "text")).toMatchObject({ storesValue: true, offersDataKey: true, offersRequired: true, group: "Fields" });
    expect(types[0]?.properties).toBeUndefined();
  });

  it("filters by group, details one type, and refuses an unknown type", async () => {
    const builder = agentBuilder();
    const layout = okOf(await builder.execute("list_component_types", { group: "Layout" }));
    expect((layout.types as Array<{ type: string }>).map((type) => type.type)).toEqual(["fieldset", "panel", "tabs", "steps", "grid", "dataGrid"]);
    const number = okOf(await builder.execute("list_component_types", { type: "number", detail: "full" }));
    const entry = (number.types as Array<Record<string, unknown>>)[0];
    expect(entry?.defaults).toEqual({ label: "Number" });
    expect((entry?.properties as Array<{ propertyPath: string }>).map((property) => property.propertyPath)).toContain("dataKey");
    const refused = refusalOf(await builder.execute("list_component_types", { type: "signature-pad" }));
    expect(refused.code).toBe("unknown-type");
    expect((refused.details as { known: string[] }).known).toContain("text");
  });
});

describe("get_definition", () => {
  it("returns a section, a subtree to a depth and the sizes", async () => {
    const builder = agentBuilder();
    const tests = okOf(await builder.execute("get_definition", { section: "tests" }));
    expect(tests.value).toEqual({ scenarios: [{ id: "test-1", source: expect.stringContaining('test "Other topic needs a message"') }] });
    expect(tests.hasDrafts).toBe(false);
    const root = okOf(await builder.execute("get_definition", { section: "root", componentId: "details", depth: 0 }));
    expect(root.value).toEqual({
      id: "details",
      type: "fieldset",
      configuration: { label: "Details" },
      children: { content: [{ id: "message", type: "textarea", omitted: true }, { id: "subscribe", type: "checkbox", omitted: true }] }
    });
    const summary = okOf(await builder.execute("get_definition", { section: "summary" }));
    expect(Object.keys(summary.sizes as Record<string, number>)).toEqual(expect.arrayContaining(["id", "root", "localization", "tests"]));
    const identity = okOf(await builder.execute("get_definition", { section: "identity" }));
    expect(identity.value).toEqual({ id: "contact-request", version: "1.0.0", schemaVersion: "1" });
  });

  it("answers feature-off for a side the host left out, and warns when drafts are not in the JSON", async () => {
    const builder = agentBuilder({ featureOn: { pdf: false } });
    const refused = refusalOf(await builder.execute("get_definition", { section: "pdf" }));
    expect(refused).toMatchObject({ code: "feature-off", details: { feature: "pdf" } });
    builder.controller.setDraftProperty("email", "label", "E-mail");
    const all = okOf(await builder.execute("get_definition", {}));
    expect(all.hasDrafts).toBe(true);
    expect(all.warnings).toEqual(["drafts-excluded: the person's unsaved edits are not in this JSON."]);
    expect(builder.controller.hasPendingChanges("email")).toBe(true);
  });
});

describe("the revision and the stale details", () => {
  it("stale details carry the first 50 outline rows and the total", () => {
    const content: ComponentNode[] = Array.from({ length: 60 }, (_, index) => ({ id: `field_${index}`, type: "text", configuration: { label: `Field ${index}` } }));
    const builder = agentBuilder({ root: { id: "root", type: "form", configuration: {}, children: { content } }, tests: null });
    const details = builder.catalogue.staleDetails?.(5, 3) as { revision: number; outline: { rootId: string; nodes: unknown[]; total: number } };
    expect(details.revision).toBe(5);
    expect(details.outline.rootId).toBe("root");
    expect(details.outline.nodes).toHaveLength(50);
    expect(details.outline.total).toBe(61);
  });

  it("an expectedRevision below the current one is refused with the outline", async () => {
    const builder = agentBuilder();
    builder.controller.add("text");
    const refused = refusalOf(await builder.execute("history", { action: "undo", expectedRevision: 1, beyondOwn: true }));
    expect(refused.code).toBe("stale");
    expect(refused.details).toMatchObject({ revision: 2, outline: { rootId: "root", total: 9 } });
  });

  it("moves on committed changes and a silent identity write, never on drafts, selection or the preview", () => {
    const builder = agentBuilder();
    const revision = (): number => builder.registration.revision();
    expect(revision()).toBe(1);
    builder.controller.setDraftProperty("email", "label", "E-mail");
    builder.controller.setShowHiddenComponents(false);
    builder.controller.setPreviewWidth(420);
    builder.controller.select("topic");
    expect(revision()).toBe(1);
    builder.controller.setIdentity({ id: "contact-request-2", version: "1.0.0", schemaVersion: "1" });
    expect(revision()).toBe(2);
    builder.controller.add("text");
    expect(revision()).toBe(3);
    builder.controller.undo();
    expect(revision()).toBe(4);
  });

  it("follows a controller built after registration", async () => {
    let controller: ReturnType<typeof contactRequestController> | undefined;
    const builder = agentBuilder({ host: { controller: () => controller, ready: () => controller !== undefined } });
    const refused = refusalOf(await builder.execute("get_form", {}));
    expect(refused).toMatchObject({ code: "builder-not-ready", retryable: true });
    controller = contactRequestController();
    okOf(await builder.execute("get_form", {}));
    const before = builder.registration.revision();
    controller.add("text");
    expect(builder.registration.revision()).toBe(before + 1);
  });
});

describe("describe_builder, the page's facts", () => {
  type Described = Record<string, unknown> & {
    bindings: Array<{ id: string; label: string }>;
    identityOwner: string;
    assistants: string;
    languages: { declared: boolean; default: string; preview: string; count: number };
    managed?: string[];
    designers?: { journeys: string; pdf: string; open?: { kind: string; id: string } };
    tryIt?: Record<string, unknown> & { answered: { byPerson: number; byAssistant: number }; standIn: { outcome: string; sources: number } };
    ui?: Record<string, unknown>;
    guidance: string[];
  };
  const describe = async (builder: { execute(name: string, input?: unknown): Promise<never> | Promise<unknown> }): Promise<Described> => okOf<Described>((await builder.execute("describe_builder", {})) as never);

  it("states the bindings with their labels, who owns the identity and the committed languages, on a bare controller too", async () => {
    const result = await describe(agentBuilder());
    expect(result.bindings).toEqual([{ id: "gcds", label: "GC Design System" }]);
    expect(result.availableBindings).toEqual(["gcds"]);
    // No choice made: the canvas draws the default look and names no binding.
    expect(result).not.toHaveProperty("binding");
    const chosen = agentBuilder();
    chosen.controller.setBindingId("gcds");
    expect((await describe(chosen)).binding).toBe("gcds");
    chosen.controller.setBindingId("ghost");
    expect((await describe(chosen)).binding).toBe("gcds");
    chosen.controller.setBindingId(undefined);
    expect(await describe(chosen)).not.toHaveProperty("binding");
    expect(result.identityOwner).toBe("form");
    expect(result.languages).toEqual({ declared: true, default: "en", preview: "en", count: 2 });
    // Nothing dropped: no managed list while the site manages nothing. The author's switch is
    // always stated: "unset" on a root that carries none.
    expect(result.assistants).toBe("unset");
    expect(result.managed).toBeUndefined();
    expect(result.designers).toBeUndefined();
    expect(result.tryIt).toBeUndefined();
  });

  const WORDING = "The author turned assistants off for filling this form (Form settings, agentTools); that switch is theirs, and set_properties refuses it.";
  const withSwitch = (value: unknown): ReturnType<typeof agentBuilder> => {
    const root = contactRequestRoot();
    root.configuration = { ...(root.configuration ?? {}), ...(value === undefined ? {} : { agentTools: value }) };
    return agentBuilder({ root });
  };

  it("assistants: reads the three values from the committed root, anything else as unset", async () => {
    expect((await describe(withSwitch("allowed"))).assistants).toBe("allowed");
    expect((await describe(withSwitch("off"))).assistants).toBe("off");
    expect((await describe(withSwitch(undefined))).assistants).toBe("unset");
    for (const word of ["maybe", "Off", true, 1, null, ""]) {
      expect((await describe(withSwitch(word))).assistants).toBe("unset");
    }
  });

  it("assistants: does not read a drafted value; the committed one stands until it is applied", async () => {
    const builder = withSwitch("allowed");
    builder.controller.setDraftProperty("root", "agentTools", "off");
    expect((await describe(builder)).assistants).toBe("allowed");
    builder.controller.commitDraft("root");
    expect((await describe(builder)).assistants).toBe("off");
  });

  it("assistants: adds one guidance line, after the languages line, only when the author turned it off", async () => {
    const off = await describe(withSwitch("off"));
    expect(off.guidance.filter((line) => line.includes("agentTools"))).toEqual([WORDING]);
    expect(off.guidance[off.guidance.length - 1]).toMatch(/^For several writes, call begin_session first/);
    expect(off.guidance[off.guidance.length - 2]).toBe(WORDING);
    for (const value of ["allowed", undefined, "maybe"]) {
      expect((await describe(withSwitch(value))).guidance.some((line) => line.includes("agentTools"))).toBe(false);
    }
  });

  it("assistants: puts the line after the languages line when the form declares none", async () => {
    const controller = new BuilderController({ initialRoot: { ...contactRequestRoot(), configuration: { title: "Contact request", agentTools: "off" } }, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    const result = await describe(agentBuilder({ controller }));
    const languages = result.guidance.findIndex((line) => line.startsWith("The form declares no languages"));
    expect(languages).toBeGreaterThan(-1);
    expect(result.guidance[languages + 1]).toBe(WORDING);
  });

  it("says the host owns the identity when the controller holds none, and lists the paths the site manages", async () => {
    const controller = new BuilderController({ initialRoot: contactRequestController().snapshot(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    const stub = uiStub({ managed: ["metadata.owner", "identity"] });
    const result = await describe(agentBuilder({ controller, ui: stub }));
    expect(result.identityOwner).toBe("host");
    expect(result.managed).toEqual(["metadata.owner", "identity"]);
    expect(result.languages).toEqual({ declared: false, default: "en", preview: "en", count: 0 });
  });

  it("reports ui.save only when the site gave the builder a Save, and words the dirty line to match", async () => {
    const without = await describe(agentBuilder({ ui: uiStub({ dirty: true }) }));
    expect(without.ui).not.toHaveProperty("save");
    expect(without.ui).toMatchObject({ tryable: true });
    const stub = uiStub({ dirty: true, saveLabel: "Save draft" });
    const withSave = await describe(agentBuilder({ ui: stub }));
    expect(withSave.ui).toMatchObject({ save: { label: "Save draft", busy: false } });
    expect(withSave.guidance).toContain("The form has unsaved changes; save stores them with the site, only when the person asks (it may publish the form).");
    expect(withSave.guidance.some((line) => line.includes("there is no save tool"))).toBe(false);
    // The widened canTry is read from the host, not assumed.
    const cannot = await describe(agentBuilder({ ui: uiStub({ canTry: false }) }));
    expect(cannot.ui).toMatchObject({ tryable: false });
  });

  it("follows the Try it adapter's chunk() through its four values, and says off with no adapter", async () => {
    const none = await describe(agentBuilder({ ui: uiStub() }));
    expect(none.tryIt).toMatchObject({ on: false, tryable: true, chunk: "off", recording: false, showing: false, serverChecks: "off", answered: { byPerson: 0, byAssistant: 0 } });
    const page = tryPage();
    for (const chunk of ["ready", "loading", "failed", "off"] as const) {
      page.tryIt.state.chunk = chunk;
      expect((await describe(page.builder)).tryIt?.chunk).toBe(chunk);
    }
  });

  it("splits the tried answers between the person and the assistant, and reads the stand-in server", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    page.tryIt.runtime.setValue("email", "person@example.org");
    okOf(await page.builder.execute("try_it", { action: "fill", answers: { full_name: "Ana", topic: "Support" } }));
    // A recording or a showing holds try_it writes, so the person starts them after the fill.
    Object.assign(page.tryIt.state, { recording: true, showing: true, serverChecks: "on" });
    page.controller.setTrySubmission({ outcome: "refuse" });
    page.controller.setSimulatedDataSource("provinces", [{ value: "x", label: "X" }]);
    const result = await describe(page.builder);
    expect(result.tryIt).toMatchObject({
      on: true,
      chunk: "ready",
      answered: { byPerson: 1, byAssistant: 2 },
      recording: true,
      showing: true,
      serverChecks: "on",
      standIn: { outcome: "refuse", sources: 1 }
    });
    expect(result.guidance).toContain("The person typed 1 answers in Try it; leaving Try it clears them, so ask before open { tryIt: false }.");
    expect(result.guidance).toContain("The person is recording a test in Try it; try_it writes wait until they stop.");
  });

  it("states both designers and the document open in one; a loading one adds its line", async () => {
    const page = documentsBuilder();
    page.page.journeys.designer.openId = "intake";
    const ready = await describe(page.builder);
    expect(ready.designers).toEqual({ journeys: "ready", pdf: "ready", open: { kind: "journey", id: "intake" } });
    page.page.journeys.designer.openId = undefined;
    page.page.pdf.designer.openId = "main";
    page.page.pdf.designer.state = "loading";
    const loading = await describe(page.builder);
    expect(loading.designers).toEqual({ journeys: "ready", pdf: "loading" });
    expect(loading.guidance).toContain("The PDF designer is still loading; documents answers chunk-unavailable until it is in.");
    page.page.journeys.designer.state = "loading";
    expect((await describe(page.builder)).guidance).toContain("The journeys designer is still loading; documents answers chunk-unavailable until it is in.");
    page.page.journeys.designer.state = "hidden";
    page.page.pdf.designer.state = "failed";
    expect((await describe(page.builder)).designers).toEqual({ journeys: "hidden", pdf: "failed" });
  });

  it("prefers the PDF side's open document while the person is in the pdf workspace, the journey's otherwise", async () => {
    const page = documentsBuilder({ stub: { workspace: "pdf", mode: "pdf" } });
    page.page.journeys.designer.openId = "intake";
    page.page.pdf.designer.openId = "main";
    expect((await describe(page.builder)).designers).toEqual({ journeys: "ready", pdf: "ready", open: { kind: "pdf_layout", id: "main" } });
    page.stub.state.workspace = "journeys";
    expect((await describe(page.builder)).designers).toMatchObject({ open: { kind: "journey", id: "intake" } });
  });

  it("offers ui.save only when the page lends both saveAvailable and save", async () => {
    const both = agentBuilder({ ui: uiStub({ saveLabel: "Save draft", saveOutcome: { status: "saved" } }) });
    expect(((await describe(both)).ui as { save?: { label: string } }).save).toEqual({ label: "Save draft", busy: false });
    const half = agentBuilder({ ui: uiStub({ saveLabel: "Save draft", saveOutcome: { status: "saved" } }) });
    delete (half.host.ui as { save?: unknown }).save;
    expect("save" in ((await describe(half)).ui as object)).toBe(false);
    const other = uiStub({ saveLabel: undefined });
    expect("save" in ((await describe(agentBuilder({ ui: other }))).ui as object)).toBe(false);
  });

  it("adds the standing lines in the documented order, and the undeclared-languages line only with the feature on", async () => {
    const bare = new BuilderController({ initialRoot: contactRequestController().snapshot(), componentDefinitions: AGENT_BUILDER_DEFINITIONS, identity: { id: "x", version: "1.0.0", schemaVersion: "1" } });
    const on = await describe(agentBuilder({ controller: bare }));
    expect(on.guidance.slice(0, 4)).toEqual([
      expect.stringMatching(/^Component ids are the handles/),
      expect.stringMatching(/^Labels, descriptions, formulas/),
      "Each write is one undo step; the person can undo it with Ctrl+Z or the Undo button on your notice. Journey and PDF layout list changes, Try it settings and the form's identity are on no undo history: your results say how to reverse them, and Undo all or end_session { undo: true } take yours back. Run check_form before you say the work is done, and write_test + run_tests for any rule you add.",
      "Settings live where they act: the preview design system in open { binding }, Try it's stand-in Submit and option lists in try_it { action: 'settings' }, the form's id and version in set_properties { target: 'identity' } on the root id."
    ]);
    const line = "The form declares no languages; to add one, name the language its texts are written in (languages { action: 'add', code, sourceLocale }).";
    expect(on.guidance).toContain(line);
    expect(on.guidance.indexOf(line)).toBeLessThan(on.guidance.length - 1);
    const off = await describe(agentBuilder({ controller: bare, featureOn: { languages: false } }));
    expect(off.guidance).not.toContain(line);
  });

  it("words the try-it and wrong-mode blockers so they do not send the model out of where its tools work", async () => {
    const trying = await describe(agentBuilder({ ui: uiStub({ trying: true }) }));
    expect(trying.guidance).toContain("The person is trying the form: changes to components are refused until Try it is off (open { tryIt: false }); try_it, languages and documents still work.");
    const designer = await describe(agentBuilder({ ui: uiStub({ mode: "journeys", workspace: "journeys" }) }));
    expect(designer.blockedBy).toEqual(["wrong-mode"]);
    expect(designer.guidance).toContain(
      "The person is in the journeys designer: changes to components are refused there (open { workspace: 'form' } moves the person, so ask first); documents, languages, try_it and save work from here."
    );
  });

  it("reads nothing it fetches: no kit load, no chunk, no adapter call that acts", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    const loads = { kit: 0 };
    page.builder.host.loadDataModelKit = () => {
      loads.kit += 1;
      return loadDataModelPlan();
    };
    await describe(page.builder);
    expect(loads.kit).toBe(0);
    expect(page.tryIt.calls.map((call) => call.method)).not.toContain("start");
  });
});

describe("get_definition { section: 'data-model' }", () => {
  type Section = { dataModel: { schema: Record<string, unknown>; example: Record<string, unknown>; places: number; notes: string[]; draftsApplied: boolean } };

  it("equals the Data surface's schema and example for the fixture, drafts excluded from its warnings", async () => {
    const builder = agentBuilder();
    const kit = await loadDataModelPlan();
    const model = kit.formDataModel(builder.controller);
    const result = okOf(await builder.execute("get_definition", { section: "data-model" }));
    const value = result.value as Section;
    expect(result.section).toBe("data-model");
    expect(value.dataModel.schema).toEqual(kit.dataModelToJsonSchema(model));
    expect(value.dataModel.example).toEqual(kit.dataModelExample(model));
    expect(value.dataModel.draftsApplied).toBe(false);
    expect(value.dataModel.places).toBeGreaterThanOrEqual(5);
    expect(Object.keys((value.dataModel.schema.properties ?? {}) as Record<string, unknown>)).toEqual(expect.arrayContaining(["full_name", "email", "topic", "message", "subscribe"]));
    expect(result.warnings).toBeUndefined();
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("shows the person's unapplied drafts, as the Data surface does, and says so", async () => {
    const builder = agentBuilder();
    builder.controller.setDraftProperty("email", "dataKey", "contact_email");
    const result = okOf(await builder.execute("get_definition", { section: "data-model" }));
    const value = result.value as Section;
    expect(value.dataModel.draftsApplied).toBe(true);
    expect(Object.keys((value.dataModel.schema.properties ?? {}) as Record<string, unknown>)).toContain("contact_email");
    expect(result.hasDrafts).toBe(true);
  });

  it("answers a rejected kit with the retryable chunk-unavailable, and reads again on the next call", async () => {
    let failing = true;
    const builder = agentBuilder({
      host: {
        loadDataModelKit: () => (failing ? Promise.reject(new Error("offline")) : loadDataModelPlan())
      }
    });
    const refused = refusalOf(await builder.execute("get_definition", { section: "data-model" }));
    expect(refused).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "data-model", state: "failed" } });
    failing = false;
    okOf(await builder.execute("get_definition", { section: "data-model" }));
  });

  it("cuts an over-large section to the result cap, the example first, with the example-omitted note and the schema kept", async () => {
    const kit = await loadDataModelPlan();
    const huge = { filler: "x".repeat(70_000) };
    const builder = agentBuilder({ host: { loadDataModelKit: () => Promise.resolve({ ...kit, dataModelExample: () => huge }) } });
    const result = okOf(await builder.execute("get_definition", { section: "data-model" }));
    const value = result.value as Section;
    expect(value.dataModel.example).toEqual({});
    expect(value.dataModel.notes).toContain("example-omitted: the example was over the result limit; the schema stands.");
    expect(Object.keys((value.dataModel.schema.properties ?? {}) as Record<string, unknown>)).toEqual(expect.arrayContaining(["full_name", "email"]));
    expect(result.bytes as number).toBeLessThan(65_536);
    // Within the cap the example is kept.
    const small = okOf(await agentBuilder().execute("get_definition", { section: "data-model" }));
    expect((small.value as Section).dataModel.notes).not.toContain("example-omitted: the example was over the result limit; the schema stands.");
  });

  it("refuses an unknown section value at the schema, and lists data-model in the enum", async () => {
    const builder = agentBuilder();
    expect(refusalOf(await builder.execute("get_definition", { section: "dataModel" })).code).toBe("bad-input");
    const tool = builder.catalogue.tools.find((entry) => entry.name === "get_definition") as unknown as { inputSchema: { properties: { section: { enum: string[] } } }; description: string };
    expect(tool.inputSchema.properties.section.enum).toContain("data-model");
    expect(tool.description).toContain("data-model (the JSON Schema and an example of the answers this form collects)");
  });
});
