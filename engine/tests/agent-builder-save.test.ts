import { describe, expect, it, vi } from "vitest";

import type { BuilderToolUi } from "../form-engine/agent/builder/host.js";
import type { BuilderSessionHooks } from "../form-engine/agent/builder/session.js";
import type { BuilderSaveOutcome } from "../form-engine/builder/web-component/default-builder-element.js";
import { agentBuilder, contactRequestController, okOf, refusalOf, uiStub, type AgentBuilder, type UiStub, type UiStubState } from "./fixtures/agent-builder.js";
import { documentController } from "./fixtures/agent-builder-documents-fakes.js";

/**
 * `save`: the site's Save as the File
 * menu's, through `ui.saveAvailable` and `ui.save` alone. Every `BuilderSaveOutcome` maps to one
 * answer; the guards run in the documented order (the registrar's `stale` first, `no-ui`,
 * `no-save`, the person's unapplied edit or prompt, `busy`, `already-saved`); nothing here
 * raises or answers a prompt; the barrier it leaves in the outside journal is what Undo all
 * reads.
 */

type Saved = Record<string, unknown> & { saved: boolean; label: string; problems: number; dirtyAfter: boolean; localeChanges?: { removed: string[]; renamed: Array<{ from: string; to: string }> } };

function page(initial: Partial<UiStubState> = {}, options: { id?: string } = {}): { builder: AgentBuilder; stub: UiStub } {
  const stub = uiStub({ saveLabel: "Save", saveOutcome: { status: "saved" }, ...initial });
  const builder = agentBuilder({ ui: stub, ...(options.id !== undefined ? { id: options.id } : {}) });
  return { builder, stub };
}

function actionEvents(builder: AgentBuilder): Array<Record<string, unknown>> {
  return builder.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as Record<string, unknown>);
}

describe("save: the answer to each outcome", () => {
  it("answers a saved form with the site's label, the time, what the site was told and the static notes", async () => {
    const { builder, stub } = page({ saveLabel: "Save draft", saveOutcome: { status: "saved", localeChanges: { removed: ["de"], renamed: [{ from: "fr", to: "fr-CA" }] } } });
    const before = Date.now();
    const result = okOf<Saved>(await builder.execute("save", {}));
    expect(result).toMatchObject({
      tool: "save",
      saved: true,
      changed: true,
      label: "Save draft",
      undoable: false,
      problems: 0,
      dirtyAfter: false,
      localeChanges: { removed: ["de"], renamed: [{ from: "fr", to: "fr-CA" }] },
      note: ["The site may have published this version; tell the person it is saved."],
      next: ["Tell the person it is saved."]
    });
    expect(result.savedAt).toBeGreaterThanOrEqual(before);
    expect(result.warnings).toBeUndefined();
    expect(result).not.toHaveProperty("undo");
    expect(stub.callsOf("save")).toHaveLength(1);
  });

  it("leaves localeChanges out when the languages did not change, and reports a site that stays dirty", async () => {
    const { builder, stub } = page({ saveOutcome: { status: "saved", localeChanges: { removed: [], renamed: [] } }, dirty: true });
    const result = okOf<Saved>(await builder.execute("save", {}));
    expect(result).not.toHaveProperty("localeChanges");
    expect(result.dirtyAfter).toBe(true);
    expect(stub.state.dirty).toBe(true);
  });

  it("counts check_form's findings at save time and warns, without stopping the save", async () => {
    const stub = uiStub({ saveLabel: "Save", saveOutcome: { status: "saved" } });
    const controller = contactRequestController({ root: { id: "root", type: "form", configuration: { title: "T" }, children: { content: [{ id: "a", type: "select", configuration: { label: "A" } }] } } });
    const builder = agentBuilder({ controller, ui: stub });
    const found = (okOf(await builder.execute("describe_builder", {})).counts as { problems: number }).problems;
    expect(found).toBeGreaterThan(0);
    const result = okOf<Saved>(await builder.execute("save", {}));
    expect(result.problems).toBe(found);
    expect(result.warnings).toEqual([`problems: the form has ${found} findings; check_form lists them.`]);
    expect(result.saved).toBe(true);
  });

  it("maps no-save and busy from the shell, and held to the person's unanswered edit", async () => {
    const none = page({ saveOutcome: { status: "no-save" } });
    expect(refusalOf(await none.builder.execute("save", {}))).toMatchObject({ code: "no-save", retryable: false });
    const running = page({ saveOutcome: { status: "busy" } });
    expect(refusalOf(await running.builder.execute("save", {}))).toMatchObject({ code: "busy", retryable: true, details: { because: "saving" } });
    const prompted = page({ saveOutcome: { status: "held", reason: "draft", componentId: "topic" } });
    expect(refusalOf(await prompted.builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "topic" } });
    const guarded = page({ saveOutcome: { status: "held", reason: "leave-guard", componentId: "tests-panel" } });
    expect(refusalOf(await guarded.builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "tests-panel" } });
    const typed = page({ saveOutcome: { status: "held", reason: "leave-guard", componentId: "languages-texts" }, languagesPending: 3 });
    expect(refusalOf(await typed.builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { componentId: "languages-texts", cells: 3 } });
    // Nothing was saved, so nothing is remembered: the next call is not already-saved.
    expect(none.builder.catalogue.shared.memory.lastSave).toBeUndefined();
  });

  it("quotes the site's own words on a failure, control characters stripped and cut to 300", async () => {
    const message = `Server said:\u0007 ${"x".repeat(400)}\nend`;
    const { builder } = page({ saveOutcome: { status: "failed", message } });
    const refused = refusalOf(await builder.execute("save", {}));
    expect(refused).toMatchObject({
      code: "save-failed",
      retryable: false,
      message: "The site did not save the form.",
      hint: "Tell the person the save failed and what the site said; do not retry unless they ask."
    });
    const quoted = (refused.details as { message: string }).message;
    expect(quoted.length).toBeLessThanOrEqual(300);
    expect(quoted.startsWith("Server said: xxx")).toBe(true);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted).not.toMatch(/\p{Cc}/u);
    const short = page({ saveOutcome: { status: "failed", message: "Changed elsewhere.\nReload." } });
    expect((refusalOf(await short.builder.execute("save", {})).details as { message: string }).message).toBe("Changed elsewhere. Reload.");
    expect(short.builder.catalogue.shared.memory.lastSave).toBeUndefined();
  });
});

describe("save: the guards, in the documented order", () => {
  it("answers no-ui under a bare controller and no-save where the site gave none, without calling the seam", async () => {
    expect(refusalOf(await agentBuilder().execute("save", {})).code).toBe("no-ui");
    const { builder, stub } = page({ saveLabel: undefined });
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({
      code: "no-save",
      message: "This builder has no Save.",
      hint: "This builder has no Save; the person keeps the form with Download or their site's own save."
    });
    expect(stub.callsOf("save")).toEqual([]);
  });

  it("judges stale before any body: nothing is asked of the site", async () => {
    const { builder, stub } = page({ saveLabel: undefined });
    builder.controller.add("text");
    const refused = refusalOf(await builder.execute("save", { expectedRevision: 1 }));
    expect(refused.code).toBe("stale");
    expect(stub.callsOf("save")).toEqual([]);
    // With the right revision the body runs, and its own refusal comes.
    expect(refusalOf(await builder.execute("save", { expectedRevision: builder.registration.revision() })).code).toBe("no-save");
  });

  it("refuses an unapplied edit of the person's, never raising or answering a prompt and never asking to leave", async () => {
    const { builder, stub } = page();
    const requestLeave = vi.spyOn(builder.controller, "requestLeave");
    const answer = vi.spyOn(builder.controller, "answerUnsavedChangesPrompt");
    builder.controller.select("topic");
    builder.controller.setDraftProperty("topic", "label", "Subject");
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "topic" } });
    expect(requestLeave).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(builder.controller.hasPendingChanges("topic")).toBe(true);
    expect(stub.callsOf("save")).toEqual([]);
  });

  it("refuses while the builder is asking the person about an edit, and leaves the question standing", async () => {
    const { builder, stub } = page();
    const subject = { id: "layout-1", label: "Main layout", blocked: false };
    builder.controller.setLeaveGuard({ pending: () => true, subject: () => subject, save: () => true, discard: () => undefined });
    expect(builder.controller.requestLeave(() => undefined)).toBe(false);
    const prompt = builder.controller.unsavedChangesPrompt();
    expect(prompt).toBeDefined();
    const requestLeave = vi.spyOn(builder.controller, "requestLeave");
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { reason: "prompt" } });
    expect(requestLeave).not.toHaveBeenCalled();
    expect(builder.controller.unsavedChangesPrompt()).toEqual(prompt);
    expect(stub.callsOf("save")).toEqual([]);
  });

  it("refuses an editor outside the tree that holds edits (a leave guard), naming its subject", async () => {
    const { builder, stub } = page();
    builder.controller.setLeaveGuard({ pending: () => true, subject: () => ({ id: "tests-panel", label: "Tests", blocked: false }), save: () => true, discard: () => undefined });
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft" } });
    expect(builder.controller.unsavedChangesPrompt()).toBeUndefined();
    expect(stub.callsOf("save")).toEqual([]);
  });

  it("reads the active controller too: a designer document's draft holds the save", async () => {
    const document = documentController();
    const { builder, stub } = page({ activeController: document, mode: "pdf", workspace: "pdf" });
    document.select("title");
    document.setDraftProperty("title", "label", "Name");
    const refused = refusalOf(await builder.execute("save", {}));
    expect(refused).toMatchObject({ code: "unsaved-draft", details: { reason: "draft" } });
    expect(stub.callsOf("save")).toEqual([]);
    // Without a draft, a designer, Try it or an open session do not hold a save back.
    document.discardDraft("title");
    okOf(await builder.execute("save", {}));
    expect(stub.callsOf("save")).toHaveLength(1);
  });

  it("is not held by Try it or an open session, and answers busy while a save the host reports runs, before already-saved (the host-provided busy path only)", async () => {
    const { builder, stub } = page({ trying: true });
    okOf(await builder.execute("begin_session", { purpose: "Save" }));
    okOf(await builder.execute("save", {}));
    expect(stub.callsOf("save")).toHaveLength(1);
    // The site reports a save running (the person's click): busy wins over already-saved.
    (builder.host.ui as BuilderToolUi).saveAvailable = () => ({ label: "Save", busy: true }) as { label: string };
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "busy", details: { because: "saving" } });
    expect(stub.callsOf("save")).toHaveLength(1);
  });

  it("on the real page the person's running save surfaces only as the shell's busy outcome, after already-saved", async () => {
    const { builder, stub } = page();
    okOf(await builder.execute("save", {}));
    // The person clicks Save at the same revision; the shell answers busy to the next ui.save().
    stub.state.saveOutcome = { status: "busy" };
    expect(refusalOf(await builder.execute("save", {})).code).toBe("already-saved");
    // A change since gets as far as the shell, which then says busy.
    builder.controller.add("text");
    expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "busy", details: { because: "saving" } });
    expect(stub.callsOf("save")).toHaveLength(2);
  });

  it("reports ui.save.busy to a read while the agent's own save is still waiting on the site", async () => {
    let release: (outcome: BuilderSaveOutcome) => void = () => undefined;
    const { builder, stub } = page();
    let asked = false;
    (builder.host.ui as BuilderToolUi).save = () => {
      asked = true;
      return new Promise<BuilderSaveOutcome>((resolve) => (release = resolve));
    };
    void stub;
    const first = builder.execute("save", {});
    await vi.waitFor(() => expect(asked).toBe(true));
    const described = okOf(await builder.execute("describe_builder", {}));
    expect((described.ui as { save: { busy: boolean } }).save.busy).toBe(true);
    release({ status: "saved" });
    expect(okOf(await first).saved).toBe(true);
    expect(((okOf(await builder.execute("describe_builder", {}))).ui as { save: { busy: boolean } }).save.busy).toBe(false);
  });
});

describe("save: the revision the site was handed, the wait on the site, the cancelled guard", () => {
  function deferredSave(builder: AgentBuilder): { release: (outcome: BuilderSaveOutcome) => void; asked: () => boolean } {
    let release: (outcome: BuilderSaveOutcome) => void = () => undefined;
    let asked = false;
    (builder.host.ui as BuilderToolUi).save = () => {
      asked = true;
      return new Promise<BuilderSaveOutcome>((resolve) => (release = resolve));
    };
    return { release: (outcome) => release(outcome), asked: () => asked };
  }

  it("records the revision handed to the site: an edit made while the save was pending is not marked saved", async () => {
    const { builder, stub } = page();
    const deferred = deferredSave(builder);
    const handed = builder.registration.revision();
    const first = builder.execute("save", {});
    await vi.waitFor(() => expect(deferred.asked()).toBe(true));
    // The person adds a component while the site's save waits.
    builder.controller.add("text");
    expect(builder.registration.revision()).toBeGreaterThan(handed);
    deferred.release({ status: "saved" });
    expect(okOf(await first).saved).toBe(true);
    expect(builder.catalogue.shared.memory.lastSave?.revision).toBe(handed);
    const barrier = builder.catalogue.shared.memory.outside.find((entry) => entry.kind === "save") as { revision: number } | undefined;
    expect(barrier?.revision).toBe(handed);
    // The newer edit never reached the site, so the next save goes through.
    (builder.host.ui as BuilderToolUi).save = stub.ui.save as NonNullable<BuilderToolUi["save"]>;
    expect(okOf<Saved>(await builder.execute("save", {})).saved).toBe(true);
    expect(stub.callsOf("save")).toHaveLength(1);
  });

  it("reports the barrier's own time as savedAt", async () => {
    const { builder } = page();
    const result = okOf<Saved>(await builder.execute("save", {}));
    const barrier = builder.catalogue.shared.memory.outside.find((entry) => entry.kind === "save") as { at: number };
    expect(result.savedAt).toBe(barrier.at);
    expect(builder.catalogue.shared.memory.lastSave?.at).toBe(barrier.at);
  });

  it("answers timeout { stillRunning } after 30 000 ms, leaves ui.save.busy true until the site settles, and keeps the mark through a late save", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { builder } = page();
      const deferred = deferredSave(builder);
      const first = builder.execute("save", {});
      await vi.advanceTimersByTimeAsync(0);
      expect(deferred.asked()).toBe(true);
      // A flag, not a race against an already-resolved promise (which always wins the race).
      let done = false;
      void first.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      const refused = refusalOf(await first);
      expect(refused).toMatchObject({ code: "timeout", retryable: true, details: { afterMs: 30_000, stillRunning: true } });
      expect(refused.hint).toContain("ui.save.busy");
      // The site's promise runs on: still busy, and a second save is refused busy.
      const described = okOf(await builder.execute("describe_builder", {}));
      expect((described.ui as { save: { busy: boolean } }).save.busy).toBe(true);
      expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "busy" });
      deferred.release({ status: "saved" });
      await vi.advanceTimersByTimeAsync(0);
      expect(((okOf(await builder.execute("describe_builder", {}))).ui as { save: { busy: boolean } }).save.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave the mark or a timer behind when the site's save rejects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { builder } = page();
      (builder.host.ui as BuilderToolUi).save = () => Promise.reject(new Error("boom"));
      const refused = refusalOf(await builder.execute("save", {}));
      expect(refused.code).toBe("internal");
      expect(vi.getTimerCount()).toBe(0);
      expect(((okOf(await builder.execute("describe_builder", {}))).ui as { save: { busy: boolean } }).save.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave the budget timer armed after a save answered in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { builder } = page();
      expect(okOf<Saved>(await builder.execute("save", {})).saved).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the mark when the site's save throws synchronously, so a later save reaches the seam", async () => {
    const { builder, stub } = page();
    (builder.host.ui as BuilderToolUi).save = () => {
      throw new Error("sync");
    };
    expect(refusalOf(await builder.execute("save", {})).code).toBe("internal");
    expect(((okOf(await builder.execute("describe_builder", {}))).ui as { save: { busy: boolean } }).save.busy).toBe(false);
    (builder.host.ui as BuilderToolUi).save = stub.ui.save as NonNullable<BuilderToolUi["save"]>;
    expect(okOf<Saved>(await builder.execute("save", {})).saved).toBe(true);
    expect(stub.callsOf("save")).toHaveLength(1);
  });

  // The "save in flight" mark is `memory.saving`, not a module set. A
  // reseed (`runtimeReplaced`) re-creates the memory in place and copies the flag, so a save the
  // site is still working on after the call timed out keeps answering `busy` across it, as the
  // set did. (A second save while the first call is still waiting queues behind it in the
  // registrar, so the timeout is what frees the agent to ask again.)
  it("keeps answering busy for a save still running across a reseed, and clears memory.saving when the site settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { builder } = page();
      const deferred = deferredSave(builder);
      const memory = builder.catalogue.shared.memory;
      expect(memory.saving).toBe(false);
      const first = builder.execute("save", {});
      await vi.advanceTimersByTimeAsync(0);
      expect(deferred.asked()).toBe(true);
      expect(memory.saving).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(refusalOf(await first)).toMatchObject({ code: "timeout", details: { stillRunning: true } });
      builder.registration.runtimeReplaced();
      // The same memory object, with the flag carried over.
      expect(builder.catalogue.shared.memory).toBe(memory);
      expect(memory.saving).toBe(true);
      expect(((okOf(await builder.execute("describe_builder", {}))).ui as { save: { busy: boolean } }).save.busy).toBe(true);
      expect(refusalOf(await builder.execute("save", {}))).toMatchObject({ code: "busy", details: { because: "saving" } });
      deferred.release({ status: "saved" });
      await vi.advanceTimersByTimeAsync(0);
      expect(memory.saving).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets memory.saving only while the site's save runs: false after an in-time answer, a rejection and a synchronous throw", async () => {
    const { builder, stub } = page();
    const memory = builder.catalogue.shared.memory;
    expect(okOf<Saved>(await builder.execute("save", {})).saved).toBe(true);
    expect(memory.saving).toBe(false);
    // Each later save follows an edit, or `already-saved` answers before the site is asked.
    builder.controller.add("text");
    (builder.host.ui as BuilderToolUi).save = () => Promise.reject(new Error("boom"));
    expect(refusalOf(await builder.execute("save", {})).code).toBe("internal");
    await vi.waitFor(() => expect(memory.saving).toBe(false));
    builder.controller.add("text");
    (builder.host.ui as BuilderToolUi).save = () => {
      throw new Error("sync");
    };
    expect(refusalOf(await builder.execute("save", {})).code).toBe("internal");
    expect(memory.saving).toBe(false);
    (builder.host.ui as BuilderToolUi).save = stub.ui.save as NonNullable<BuilderToolUi["save"]>;
  });

  it("cuts the host's label to the label cap, as describe_builder does", async () => {
    const { builder } = page({ saveLabel: "S".repeat(5_000) });
    const result = okOf<Saved>(await builder.execute("save", {}));
    const described = okOf(await builder.execute("describe_builder", {}));
    expect(result.label.length).toBeLessThan(5_000);
    expect(result.label).toBe((described.ui as { save: { label: string } }).save.label);
  });

  it("asks nothing of the site when the call was cancelled before it ran", async () => {
    const { builder, stub } = page();
    const controller = new AbortController();
    controller.abort();
    expect(refusalOf(await builder.execute("save", {}, { signal: controller.signal })).code).toBe("cancelled");
    expect(stub.callsOf("save")).toEqual([]);
  });

  it("the body's own guard: a call cancelled after the registrar let it in (while it waited on the page) saves nothing", async () => {
    const { builder, stub } = page();
    const controller = new AbortController();
    const available = (builder.host.ui as BuilderToolUi).saveAvailable as () => { label: string } | undefined;
    // The cancel lands while the body is reading the page, after the registrar's own check.
    (builder.host.ui as BuilderToolUi).saveAvailable = () => {
      controller.abort();
      return available();
    };
    expect(refusalOf(await builder.execute("save", {}, { signal: controller.signal })).code).toBe("cancelled");
    expect(stub.callsOf("save")).toEqual([]);
    expect(builder.catalogue.shared.memory.lastSave).toBeUndefined();
  });
});

describe("save: already-saved and again", () => {
  it("refuses a second save of the same revision, allows it after a write or with again", async () => {
    const { builder, stub } = page();
    const first = okOf<Saved>(await builder.execute("save", {}));
    const refused = refusalOf(await builder.execute("save", {}));
    expect(refused).toMatchObject({ code: "already-saved", retryable: false, details: { revision: builder.registration.revision(), savedAt: expect.any(Number) } });
    expect(stub.callsOf("save")).toHaveLength(1);
    expect(okOf<Saved>(await builder.execute("save", { again: true })).saved).toBe(true);
    expect(stub.callsOf("save")).toHaveLength(2);
    // A change since is something new to save.
    builder.controller.add("text");
    expect(okOf<Saved>(await builder.execute("save", {})).saved).toBe(true);
    expect(stub.callsOf("save")).toHaveLength(3);
    expect(first.saved).toBe(true);
  });
});

describe("save: what the person sees and what the host hears", () => {
  it("shows the notice with no button and announces it; the event is consequential", async () => {
    const { builder, stub } = page();
    okOf(await builder.execute("save", {}));
    expect(stub.callsOf("announce")).toEqual([["Assistant saved the form"]]);
    expect(stub.callsOf("notice")).toEqual([["Assistant saved the form", undefined]]);
    const events = actionEvents(builder).filter((event) => event.tool === "save");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tool: "save", consequential: true, readOnly: false });
    // A refusal is no consequential act that happened: the event says the tool ran, still flagged.
    const refused = page({ saveLabel: undefined });
    await refused.builder.execute("save", {});
    expect(actionEvents(refused.builder).filter((event) => event.tool === "save")[0]).toMatchObject({ consequential: true });
  });

  it("inside a session the banner speaks for the work: the announcement stays, the notice does not", async () => {
    const { builder, stub } = page();
    okOf(await builder.execute("begin_session", { purpose: "Save" }));
    okOf(await builder.execute("save", {}));
    expect(stub.callsOf("announce").at(-1)).toEqual(["Assistant saved the form"]);
    expect(stub.callsOf("notice")).toEqual([]);
  });

  it("records a save barrier: end_session { undo: true } after a save undoes the work and says what the site keeps", async () => {
    const { builder } = page();
    const hooks = builder.catalogue.sessionHooks as BuilderSessionHooks;
    vi.spyOn(hooks, "end");
    okOf(await builder.execute("begin_session", { purpose: "Save" }));
    okOf(await builder.execute("set_properties", { edits: [{ componentId: "email", propertyPath: "label", value: "E-mail" }] }));
    okOf(await builder.execute("save", {}));
    const barrier = builder.catalogue.shared.memory.outside.find((entry) => entry.kind === "save");
    expect(barrier).toBeDefined();
    const ended = okOf(await builder.execute("end_session", { undo: true, summary: "Saved." }));
    expect(ended.session).toMatchObject({ undone: 1 });
    const last = (hooks.end as unknown as { mock: { results: Array<{ value: { note?: string[] } }> } }).mock.results.at(-1)?.value;
    expect(last?.note).toEqual([`The site keeps the version saved at ${new Date((barrier as { at: number }).at).toISOString()}; save again to keep the undo.`]);
    // The barrier is never undone: the form's change went, the saved version stays the site's.
    const email = builder.controller.snapshot().children?.content?.[1];
    expect((email?.configuration as { label: string }).label).toBe("Email");
  });
});

describe("save: the seam is Save alone", () => {
  it("touches exactly ui.saveAvailable and ui.save on the page, and never asks the controller to leave", async () => {
    const { builder, stub } = page();
    const requestLeave = vi.spyOn(builder.controller, "requestLeave");
    const answer = vi.spyOn(builder.controller, "answerUnsavedChangesPrompt");
    // Every ui member is wrapped, so any call to one the save should not make is seen, by name.
    const touched = new Set<string>();
    const ui = builder.host.ui as unknown as Record<string, unknown>;
    for (const [name, member] of Object.entries(ui)) {
      if (typeof member === "function") {
        ui[name] = (...args: unknown[]) => {
          touched.add(name);
          return (member as (...rest: unknown[]) => unknown)(...args);
        };
      }
    }
    okOf(await builder.execute("save", {}));
    expect(stub.callsOf("save")).toHaveLength(1);
    expect(touched.has("saveAvailable")).toBe(true);
    expect(touched.has("save")).toBe(true);
    // Reading the page for the answer (dirty, the active controller, the person's pending work) is allowed; acting on it is not.
    const acts = ["setWorkspace", "setTrying", "setPanel", "setBinding", "setPreviewLocale", "selectDocument", "clearTriedAnswers"];
    expect([...touched].filter((name) => acts.includes(name))).toEqual([]);
    expect(requestLeave).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });
});
