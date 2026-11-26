import { describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, contactRequestController, okOf, refusalOf, uiStub, type AgentBuilder } from "./fixtures/agent-builder.js";
import { tryPage } from "./fixtures/agent-builder-try-fakes.js";

/**
 * `open` and `history`: open applies selection, workspace, panel and Try it in that order, reports what
 * the host hides under notDone, never clears typed Try it answers unasked, needs a page and keeps
 * working after Stop; history stays within the assistant's own steps, counts them as the
 * contract says, and answers undo-failed when the first step cannot be taken.
 */

function agentWrite(builder: AgentBuilder, run: () => void): number {
  const shared = builder.catalogue.shared;
  const scope = shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
  return shared.write(scope, run).steps;
}

async function ownSteps(builder: AgentBuilder): Promise<number> {
  const described = okOf(await builder.execute("describe_builder", {}));
  return (described.undo as { ownSteps: number }).ownSteps;
}

describe("open", () => {
  it("applies the component, the workspace, the panel and Try it, in that order", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.select("topic");
    const result = okOf(await builder.execute("open", { tryIt: true, panel: "variables", workspace: "logic", componentId: "topic" }));
    const order = stub.calls.map((call) => call.method).filter((method) => ["revealComponent", "setWorkspace", "setPanel", "setTrying"].includes(method));
    expect(order).toEqual(["revealComponent", "setWorkspace", "setPanel", "setTrying"]);
    expect(result.shown).toEqual({ componentId: "topic", workspace: "logic", panel: "variables", trying: true });
    expect(result.notDone).toBeUndefined();
  });

  it("selects a component that is not selected, through the controller's guard", async () => {
    const builder = agentBuilder({ ui: uiStub() });
    const result = okOf(await builder.execute("open", { componentId: "message" }));
    expect(builder.controller.selectedComponentId()).toBe("message");
    expect(result.shown).toMatchObject({ componentId: "message" });
  });

  it("reports a hidden workspace, a panel left off and a feature off under notDone", async () => {
    const stub = uiStub({ available: ["form", "logic"], panelsOff: new Set(["variables", "tests"]) });
    const builder = agentBuilder({ ui: stub, featureOn: { tests: false, pdf: false } });
    const hidden = okOf(await builder.execute("open", { workspace: "data", panel: "variables" }));
    expect(hidden.notDone).toEqual([
      { what: "workspace", reason: "hidden", message: "The host hides the data workspace." },
      { what: "panel", reason: "hidden", message: "The host hides the variables panel." }
    ]);
    const off = okOf(await builder.execute("open", { workspace: "pdf", panel: "tests" }));
    expect((off.notDone as Array<{ reason: string }>).map((entry) => entry.reason)).toEqual(["feature-off", "feature-off"]);
    expect(stub.callsOf("setWorkspace")).toEqual([]);
    expect(stub.state.workspace).toBe("form");
  });

  it("keeps typed Try it answers unless told to discard them, and says what leaving would clear", async () => {
    const stub = uiStub({ trying: true, triedAnswers: { topic: "other", email: "a@b.c" } });
    const builder = agentBuilder({ ui: stub });
    const kept = okOf(await builder.execute("open", { tryIt: false }));
    expect(kept.notDone).toEqual([{ what: "tryIt", reason: "tried-answers", message: "The person typed 2 answers in Try it; leaving clears them.", triedPaths: 2 }]);
    expect(kept.note).toEqual(["Pass discardTriedAnswers: true to leave Try it after telling the person their 2 answers will be cleared."]);
    expect(stub.state.trying).toBe(true);
    const left = okOf(await builder.execute("open", { tryIt: false, discardTriedAnswers: true }));
    expect(left.triedAnswersCleared).toBe(2);
    expect(left.shown).toMatchObject({ trying: false });
    expect(stub.state.triedAnswers).toEqual({});
  });

  it("reports Try it as not tryable where the person has none", async () => {
    const stub = uiStub({ canTry: false });
    const result = okOf(await agentBuilder({ ui: stub }).execute("open", { tryIt: true }));
    expect(result.notDone).toEqual([{ what: "tryIt", reason: "not-tryable", message: "Try it is not available here." }]);
    expect(stub.callsOf("setTrying")).toEqual([]);
    const refusedByShell = uiStub({ setTryingAnswers: false });
    const fallback = okOf(await agentBuilder({ ui: refusedByShell }).execute("open", { tryIt: true }));
    expect((fallback.notDone as Array<{ reason: string }>)[0]?.reason).toBe("not-tryable");
  });

  it("refuses before applying anything while the person has a draft in the way", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.select("topic");
    builder.controller.setDraftProperty("topic", "label", "Subject");
    const refused = refusalOf(await builder.execute("open", { panel: "outline", componentId: "email" }));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "topic" } });
    expect(stub.callsOf("setPanel")).toEqual([]);
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
  });

  it("answers no-ui under a bare controller and bad-input when given nothing", async () => {
    const bare = agentBuilder();
    expect(refusalOf(await bare.execute("open", { panel: "outline" })).code).toBe("no-ui");
    expect(refusalOf(await agentBuilder({ ui: uiStub() }).execute("open", {})).code).toBe("bad-input");
  });

  it("runs while the person has stopped the assistant", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    (stub.state.session as { onStop(): void }).onStop();
    await Promise.resolve();
    expect(refusalOf(await builder.execute("history", { action: "undo" })).code).toBe("stopped");
    okOf(await builder.execute("open", { panel: "outline" }));
    expect(stub.state.panel).toBe("outline");
  });
});

describe("history", () => {
  it("answers ok with done 0 when there is nothing to undo or redo", async () => {
    const builder = agentBuilder();
    const result = okOf(await builder.execute("history", { action: "undo" }));
    expect(result).toMatchObject({ action: "undo", requested: 1, done: 0, undo: { steps: 0, ownSteps: 0, canUndo: false, canRedo: false } });
    expect(result.shown).toBeUndefined();
  });

  it("counts own steps: a tool write +1, the person's own edit back to 0, undo -1, redo +1 up to the ceiling", async () => {
    const builder = agentBuilder();
    expect(agentWrite(builder, () => builder.controller.add("text"))).toBe(1);
    expect(await ownSteps(builder)).toBe(1);
    builder.controller.add("number");
    expect(await ownSteps(builder)).toBe(0);
    agentWrite(builder, () => builder.controller.add("text"));
    agentWrite(builder, () => builder.controller.add("date"));
    expect(await ownSteps(builder)).toBe(2);
    const undone = okOf(await builder.execute("history", { action: "undo" }));
    expect(undone).toMatchObject({ done: 1, undo: { steps: 1, ownSteps: 1, canUndo: true, canRedo: true } });
    const redone = okOf(await builder.execute("history", { action: "redo" }));
    expect(redone).toMatchObject({ done: 1, undo: { steps: 1, ownSteps: 2, canRedo: false } });
    const nothing = okOf(await builder.execute("history", { action: "redo" }));
    expect(nothing).toMatchObject({ done: 0 });
  });

  it("refuses beyond-own past the assistant's steps, and undoes the person's with beyondOwn", async () => {
    const builder = agentBuilder();
    builder.controller.add("number");
    agentWrite(builder, () => builder.controller.add("text"));
    agentWrite(builder, () => builder.controller.add("date"));
    const refused = refusalOf(await builder.execute("history", { action: "undo", steps: 3 }));
    expect(refused).toMatchObject({
      code: "beyond-own",
      message: "Only 2 of the undoable steps are this assistant's.",
      hint: "Resend with steps: 2, or beyondOwn: true only if the person asked you to undo their own work.",
      details: { ownSteps: 2, requested: 3 }
    });
    const allowed = okOf(await builder.execute("history", { action: "undo", steps: 3, beyondOwn: true }));
    expect(allowed).toMatchObject({ done: 3, undo: { steps: 3, ownSteps: 0, canUndo: false } });
  });

  it("answers undo-failed when the first step cannot be taken, and stoppedBecause when a later one cannot", async () => {
    const builder = agentBuilder();
    agentWrite(builder, () => builder.controller.add("text"));
    agentWrite(builder, () => builder.controller.add("date"));
    const controller = builder.controller;
    const failing = vi.spyOn(controller, "undo").mockImplementation(() => {
      controller.dropError = "This step could not be undone, nor can the ones before it.";
    });
    const refused = refusalOf(await builder.execute("history", { action: "undo" }));
    expect(refused).toMatchObject({ code: "undo-failed", details: { done: 0, message: "This step could not be undone, nor can the ones before it." } });
    failing.mockRestore();
    const real = controller.undo.bind(controller);
    let calls = 0;
    vi.spyOn(controller, "undo").mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        controller.dropError = "This step could not be undone, nor can the ones before it.";
        return;
      }
      real();
    });
    const partial = okOf(await builder.execute("history", { action: "undo", steps: 2 }));
    expect(partial).toMatchObject({ done: 1, stoppedBecause: "This step could not be undone, nor can the ones before it." });
  });

  it("is refused while the person has any draft, and in a designer or Try it", async () => {
    const drafted = agentBuilder();
    agentWrite(drafted, () => drafted.controller.add("text"));
    drafted.controller.setDraftProperty("email", "label", "E-mail");
    expect(refusalOf(await drafted.execute("history", { action: "undo" })).code).toBe("unsaved-draft");
    const designer = agentBuilder({ ui: uiStub({ mode: "pdf" }) });
    expect(refusalOf(await designer.execute("history", { action: "undo" }))).toMatchObject({ code: "wrong-mode", details: { mode: "pdf" } });
    const trying = agentBuilder({ ui: uiStub({ trying: true, triedAnswers: { topic: "sales" } }) });
    expect(refusalOf(await trying.execute("history", { action: "undo" }))).toMatchObject({ code: "try-it-on", details: { triedPaths: 1 } });
  });

  it("shows an undo to the person: the selection revealed, the touched ids highlighted, announced, a Redo notice", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    agentWrite(builder, () => builder.controller.setProperties([{ componentId: "email", propertyPath: "label", value: "E-mail" }]));
    builder.controller.select("email");
    const result = okOf(await builder.execute("history", { action: "undo" }));
    expect(result.shown).toEqual({ componentId: "email" });
    expect(stub.callsOf("revealComponent")).toEqual([["email"]]);
    expect(stub.callsOf("highlight")).toEqual([[["email"]]]);
    expect(stub.callsOf("announce")).toEqual([["Assistant undid 1 step"]]);
    const [text, action] = stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    expect(text).toBe("Assistant undid 1 step");
    expect(action.label).toBe("Redo");
    action.run();
    const email = builder.controller.snapshot().children?.content?.[1];
    expect((email?.configuration as { label: string }).label).toBe("E-mail");
  });

  it("skips the reveal and the highlight while the person types in a text control", async () => {
    const stub = uiStub({ focusInTextControl: true });
    const builder = agentBuilder({ ui: stub });
    agentWrite(builder, () => builder.controller.add("text"));
    builder.controller.select("email");
    okOf(await builder.execute("history", { action: "undo" }));
    expect(stub.callsOf("revealComponent")).toEqual([]);
    expect(stub.callsOf("highlight")).toEqual([]);
    expect(stub.callsOf("announce")).toHaveLength(1);
  });

  it("takes each step the way the person's Undo goes: through the page's historyStep, the notice's Redo too", async () => {
    const stub = uiStub();
    const stepped: Array<[BuilderController, "undo" | "redo"]> = [];
    stub.ui.historyStep = (controller, direction) => {
      stepped.push([controller, direction]);
      if (direction === "undo") {
        controller.undo();
      } else {
        controller.redo();
      }
    };
    const builder = agentBuilder({ ui: stub });
    agentWrite(builder, () => builder.controller.add("text"));
    agentWrite(builder, () => builder.controller.add("date"));
    const undone = okOf(await builder.execute("history", { action: "undo", steps: 2 }));
    expect(undone).toMatchObject({ done: 2, undo: { ownSteps: 0, canRedo: true } });
    expect(stepped).toEqual([
      [builder.controller, "undo"],
      [builder.controller, "undo"]
    ]);
    const [, action] = stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    action.run();
    expect(stepped.slice(2)).toEqual([
      [builder.controller, "redo"],
      [builder.controller, "redo"]
    ]);
    expect(builder.controller.canRedo()).toBe(false);
  });
});

describe("the history's top after the person's own Undo", () => {
  /** A write's notice, as shared.show draws it after an agent write. */
  function writeWithNotice(builder: AgentBuilder, run: () => void): void {
    const shared = builder.catalogue.shared;
    const scope = shared.scope({ host: builder.host, signal: new AbortController().signal, revision: () => builder.registration.revision(), session: undefined, state: new Map() });
    const { steps } = shared.write(scope, run);
    shared.show(scope, { ids: [], announce: "Assistant added 1 component", undoSteps: steps });
  }

  function contentIds(builder: AgentBuilder): string[] {
    return (builder.controller.snapshot().children?.content ?? []).map((node) => node.id);
  }

  it("redo is beyond-own once the person undid past the assistant's steps into their own", async () => {
    const builder = agentBuilder();
    builder.controller.add("number");
    agentWrite(builder, () => builder.controller.add("text"));
    builder.controller.undo();
    builder.controller.undo();
    const refused = refusalOf(await builder.execute("history", { action: "redo" }));
    expect(refused).toMatchObject({ code: "beyond-own", details: { ownSteps: 0, requested: 1 } });
    expect(builder.controller.canRedo()).toBe(true);
    // The same after the agent's own beyondOwn undo past its steps.
    const again = agentBuilder();
    again.controller.add("number");
    agentWrite(again, () => again.controller.add("text"));
    okOf(await again.execute("history", { action: "undo", steps: 2, beyondOwn: true }));
    expect(refusalOf(await again.execute("history", { action: "redo" })).code).toBe("beyond-own");
  });

  it("a write's Undo notice goes on the person's own Undo, and a stale press reaches none of the person's work", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.add("number");
    const personOnly = contentIds(builder);
    writeWithNotice(builder, () => builder.controller.add("text"));
    const [, action] = stub.callsOf("notice").at(-1) as [string, { label: string; run(): void }];
    expect(action.label).toBe("Undo");
    const cleared = stub.callsOf("clearNotice").length;
    builder.controller.undo();
    expect(stub.callsOf("clearNotice").length).toBeGreaterThan(cleared);
    expect(contentIds(builder)).toEqual(personOnly);
    action.run();
    expect(contentIds(builder)).toEqual(personOnly);
    expect(builder.controller.canRedo()).toBe(true);
  });

  it("history's Redo notice does not redo the person's step the person undid since", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.add("number");
    agentWrite(builder, () => builder.controller.add("text"));
    okOf(await builder.execute("history", { action: "undo" }));
    const [, action] = stub.callsOf("notice").at(-1) as [string, { label: string; run(): void }];
    expect(action.label).toBe("Redo");
    builder.controller.undo();
    const after = structuredClone(builder.controller.snapshot());
    action.run();
    expect(builder.controller.snapshot()).toEqual(after);
  });
});

describe("open's prompt refusal", () => {
  it("names the external leave guard in details.prompt, as begin_session does", async () => {
    const builder = agentBuilder({ ui: uiStub() });
    const subject = { id: "layout-1", label: "Main layout", blocked: false };
    builder.controller.setLeaveGuard({ pending: () => true, subject: () => subject, save: () => true, discard: () => undefined });
    expect(builder.controller.requestLeave(() => undefined)).toBe(false);
    const opened = refusalOf(await builder.execute("open", { panel: "outline" }));
    expect(opened).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt", prompt: { componentId: "layout-1", action: "leave", external: subject } } });
    const begun = refusalOf(await builder.execute("begin_session", { purpose: "x" }));
    expect(begun.details).toEqual(opened.details);
  });
});

describe("open { binding }", () => {
  it("previews a binding through the shell's seam, never the controller alone, and shows it", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const result = okOf(await builder.execute("open", { binding: "gcds" }));
    expect(stub.callsOf("setBinding")).toEqual([["gcds"]]);
    expect(stub.state.binding).toBe("gcds");
    expect(result.shown).toEqual({ workspace: "form", panel: "components", trying: false, binding: "gcds" });
    expect(result.notDone).toBeUndefined();
    // The seam is the shell's handler (the binding's assets, the host's event); the controller was not asked on its own.
    expect(builder.controller.bindingId()).toBeUndefined();
    // Not a write: no revision, no undo step, no notice.
    expect(builder.registration.revision()).toBe(1);
    expect(stub.callsOf("notice")).toEqual([]);
    expect(result.undo).toBeUndefined();
  });

  it("previews the default look with an empty id", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const result = okOf(await builder.execute("open", { binding: "" }));
    expect(stub.callsOf("setBinding")).toEqual([[undefined]]);
    expect(result.shown).toMatchObject({ binding: "" });
  });

  it("reports an unknown id under notDone and still applies the rest of the call", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    const result = okOf(await builder.execute("open", { binding: "nope", panel: "outline" }));
    expect(result.notDone).toEqual([{ what: "binding", reason: "not-available", message: "The builder offers no binding nope; it offers gcds." }]);
    expect(stub.callsOf("setBinding")).toEqual([]);
    expect(stub.state.panel).toBe("outline");
    expect(result.shown).not.toHaveProperty("binding");
  });

  it("reports a builder that offers no bindings, and a shell that refused the id", async () => {
    const bare = new BuilderController({ initialRoot: contactRequestController().snapshot(), componentDefinitions: AGENT_BUILDER_DEFINITIONS });
    const none = uiStub();
    const empty = okOf(await agentBuilder({ controller: bare, ui: none }).execute("open", { binding: "gcds" }));
    expect(empty.notDone).toEqual([{ what: "binding", reason: "not-available", message: "The builder offers no binding gcds; it offers none." }]);
    expect(none.callsOf("setBinding")).toEqual([]);
    const refused = uiStub({ bindingAnswers: false });
    const raced = okOf(await agentBuilder({ ui: refused }).execute("open", { binding: "gcds" }));
    expect((raced.notDone as Array<{ reason: string }>)[0]?.reason).toBe("not-available");
    expect(raced.shown).not.toHaveProperty("binding");
  });

  it("reports the binding picker left off as feature-off", async () => {
    const stub = uiStub();
    const result = okOf(await agentBuilder({ ui: stub, featureOn: { "binding-picker": false } }).execute("open", { binding: "gcds", panel: "outline" }));
    expect(result.notDone).toEqual([{ what: "binding", reason: "feature-off", message: "The binding-picker feature is off in this host." }]);
    expect(stub.callsOf("setBinding")).toEqual([]);
    expect(stub.state.panel).toBe("outline");
  });

  it("holds the binding change back under the person's Stop and runs the rest of the call", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    okOf(await builder.execute("begin_session", { purpose: "x" }));
    (stub.state.session as { onStop(): void }).onStop();
    await Promise.resolve();
    const result = okOf(await builder.execute("open", { binding: "gcds", panel: "outline" }));
    expect(result.notDone).toEqual([{ what: "binding", reason: "stopped", message: "The person stopped you; a binding change waits until they allow you again." }]);
    expect(stub.callsOf("setBinding")).toEqual([]);
    expect(stub.state.panel).toBe("outline");
  });

  it("is a preview, so a draft of the person's does not hold it, and it counts as a part of the call", async () => {
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    builder.controller.select("topic");
    builder.controller.setDraftProperty("topic", "label", "Subject");
    okOf(await builder.execute("open", { binding: "gcds" }));
    expect(builder.controller.hasPendingChanges("topic")).toBe(true);
    expect(refusalOf(await agentBuilder({ ui: uiStub() }).execute("open", {})).details).toMatchObject({ problems: [{ expected: expect.stringContaining("binding") }] });
  });

  it("describes the property and the call in the documented words", async () => {
    const tool = agentBuilder({ ui: uiStub() }).catalogue.tools.find((entry) => entry.name === "open") as unknown as {
      description: string;
      inputSchema: { properties: { binding: { type: string; maxLength: number; description: string }; discardTriedAnswers: { description: string } } };
    };
    expect(tool.inputSchema.properties.binding).toEqual({
      type: "string",
      maxLength: 128,
      description: "Preview the form in this design-system binding: an id from describe_builder bindings, or '' for the default look. Only the builder's preview changes, not the form."
    });
    expect(tool.inputSchema.properties.discardTriedAnswers.description).toBe(
      "Needed with tryIt: false, or a workspace change while Try it is on, only when the person typed some tried answers themselves; they are cleared. Tell the person first."
    );
    expect(tool.description).toContain("or previews the form in another design-system binding.");
    expect(tool.description).toContain("To open a journey or a PDF layout in its designer use documents with action 'open'; to fill the tried form use try_it.");
  });
});

describe("open and the tried answers: only the person's count", () => {
  it("leaves Try it after only the assistant's own answers with no flag, and reports what it cleared", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await page.builder.execute("try_it", { action: "fill", answers: { full_name: "Ana", topic: "Support" } }));
    const result = okOf(await page.builder.execute("open", { tryIt: false }));
    expect(result.notDone).toBeUndefined();
    expect(result.triedAnswersCleared).toBe(2);
    expect(result.shown).toMatchObject({ trying: false });
    expect(page.stub.callsOf("clearTriedAnswers")).toHaveLength(1);
    expect(result.note).toBeUndefined();
  });

  it("counts the person's answers alone for notDone, and clears both with the flag", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    page.tryIt.runtime.setValue("email", "person@example.org");
    okOf(await page.builder.execute("try_it", { action: "fill", answers: { full_name: "Ana" } }));
    const held = okOf(await page.builder.execute("open", { tryIt: false }));
    expect(held.notDone).toEqual([{ what: "tryIt", reason: "tried-answers", message: "The person typed 1 answers in Try it; leaving clears them.", triedPaths: 1 }]);
    expect(held.note).toEqual(["Pass discardTriedAnswers: true to leave Try it after telling the person their 1 answers will be cleared."]);
    expect(page.stub.state.trying).toBe(true);
    const left = okOf(await page.builder.execute("open", { tryIt: false, discardTriedAnswers: true }));
    expect(left.triedAnswersCleared).toBe(2);
    expect(page.stub.state.trying).toBe(false);
  });

  it("an answer that is not dirty (a default, a calculation) is nobody's: leaving Try it needs no flag and nothing is counted", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    // The tried runtime holds a value no one typed (a defaultValue the form computed).
    const real = page.tryIt.adapter.typed;
    page.tryIt.adapter.typed = () => {
      const typed = real();
      return { values: { ...typed.values, email: "default@example.org" }, dirty: typed.dirty };
    };
    const described = okOf(await page.builder.execute("describe_builder", {}));
    expect((described.tryIt as { answered: { byPerson: number } }).answered.byPerson).toBe(0);
    expect(described.guidance as string[]).not.toContainEqual(expect.stringContaining("The person typed"));
    const result = okOf(await page.builder.execute("open", { tryIt: false }));
    expect(result.notDone).toBeUndefined();
    expect(page.stub.state.trying).toBe(false);
    // The same value, typed by the person (dirty), counts.
    const typed = tryPage({ tryIt: { trying: true } });
    typed.tryIt.runtime.setValue("email", "person@example.org");
    expect((okOf(await typed.builder.execute("describe_builder", {})).tryIt as { answered: { byPerson: number } }).answered.byPerson).toBe(1);
  });

  it("applies the same rule to a workspace change while Try it is on", async () => {
    const own = tryPage({ tryIt: { trying: true } });
    okOf(await own.builder.execute("try_it", { action: "fill", answers: { full_name: "Ana" } }));
    const moved = okOf(await own.builder.execute("open", { workspace: "logic" }));
    expect(moved.notDone).toBeUndefined();
    expect(moved.triedAnswersCleared).toBe(1);
    expect(own.stub.state.workspace).toBe("logic");
    const typed = tryPage({ tryIt: { trying: true } });
    typed.tryIt.runtime.setValue("email", "person@example.org");
    const held = okOf(await typed.builder.execute("open", { workspace: "logic" }));
    expect(held.notDone).toEqual([{ what: "workspace", reason: "tried-answers", message: "The person typed 1 answers in Try it; leaving clears them.", triedPaths: 1 }]);
    expect(typed.stub.state.workspace).toBe("form");
  });

  it("an answer the person overwrote after the assistant wrote it is the person's", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await page.builder.execute("try_it", { action: "fill", answers: { full_name: "Ana" } }));
    page.tryIt.runtime.setValue("full_name", "Bea");
    const held = okOf(await page.builder.execute("open", { tryIt: false }));
    expect((held.notDone as Array<{ triedPaths: number }>)[0]?.triedPaths).toBe(1);
  });

  it("describes history as reaching none of the outside changes", async () => {
    const tool = agentBuilder().catalogue.tools.find((entry) => entry.name === "history") as unknown as { description: string };
    expect(tool.description.endsWith(" It does not reach journey and PDF layout list changes, Try it settings or the form's identity; their results carry a reverse call, and end_session { undo: true } and the person's Undo all take back yours.")).toBe(true);
  });
});
