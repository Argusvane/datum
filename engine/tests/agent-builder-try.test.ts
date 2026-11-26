import { afterEach, describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { TrySubmitOutcome } from "../form-engine/builder/web-component/try-it-types.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_DEFINITIONS, agentBuilder, okOf, refusalOf, uiStub } from "./fixtures/agent-builder.js";
import { personTypes } from "./fixtures/agent-form.js";
import { guardedRoot, journeyTryPage, tableRoot, tryPage, type TryPage } from "./fixtures/agent-builder-try-fakes.js";
import { presentationForm } from "./fixtures/presentation-form.js";

/**
 * The `try_it` tool's body: every action over a real `BuilderPreviewRuntime` as the
 * tried runtime and over a journey's (a real `FormRuntime` whose pages run under node ids), the
 * start behind the prompt and draft pre-check, the person's state that holds a write (recording,
 * showing, the focused field, typed answers), the shared answers module's reading and refusals in
 * Try it's words, the person's Check and Submit through the adapter (budgets, busy, a refused
 * load), and the journaled stand-in settings with their reverse; plus a journey page by
 * its id through `nodeIdOf`, the start waiting on the session's `ready()`, and the 512 KB
 * input.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Result = Record<string, unknown>;

async function tried(page: TryPage, input: Record<string, unknown>): Promise<ReturnType<TryPage["builder"]["execute"]> extends Promise<infer R> ? R : never> {
  return page.builder.execute("try_it", input);
}

function callsOf(page: TryPage, method: string): unknown[][] {
  return page.tryIt.calls.filter((call) => call.method === method).map((call) => call.args);
}

/** A designer document's controller with one field `title` (a journey's or a layout's). */
function designerController(): BuilderController {
  const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "title", type: "text", configuration: { label: "Title" } }] } };
  return new BuilderController({ initialRoot: root, componentDefinitions: AGENT_BUILDER_DEFINITIONS });
}

const STARTED_NOTE = "Try it is now on: the person sees the live form. open { tryIt: false } goes back to editing and clears the tried answers.";

describe("try_it: where it runs", () => {
  it("answers no-ui on a bare controller and without a Try it adapter, but sets stand-ins without one", async () => {
    const bare = agentBuilder();
    expect(refusalOf(await bare.execute("try_it", { action: "read" }))).toMatchObject({ code: "no-ui", retryable: false });
    const stub = uiStub();
    const builder = agentBuilder({ ui: stub });
    expect(refusalOf(await builder.execute("try_it", { action: "fill", answers: { full_name: "Ana" } })).code).toBe("no-ui");
    expect(refusalOf(await builder.execute("try_it", { action: "read" })).code).toBe("no-ui");
    const set = okOf<Result>(await builder.execute("try_it", { action: "settings", trySubmission: { outcome: "fail" } }));
    expect(set).toMatchObject({ action: "settings", changed: true, trying: false, answered: { byPerson: 0, byAssistant: 0 } });
    expect(builder.controller.trySubmission().outcome).toBe("fail");
  });

  it("refuses feature-off with try-it off, except read and a settings call that sets stand-in lists only", async () => {
    const page = tryPage({ featureOn: { "try-it": false } });
    for (const input of [
      { action: "fill", answers: { full_name: "Ana" } },
      { action: "check" },
      { action: "submit" },
      { action: "clear" },
      { action: "edit_rows", collection: "items", rowAction: "add" },
      { action: "navigate", to: "next" },
      { action: "settings", trySubmission: { outcome: "refuse" } }
    ]) {
      expect(refusalOf(await tried(page, input)), String(input.action)).toMatchObject({ code: "feature-off", details: { feature: "try-it" } });
    }
    expect(callsOf(page, "start")).toEqual([]);
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect(read).toMatchObject({ trying: false, settings: { trySubmission: null } });
    const sources = okOf<Result>(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: ["Ontario"] }] }));
    expect(sources).toMatchObject({ changed: true, settings: { trySubmission: null }, settingsChanged: ["source:provinces"] });
  });

  it("answers the feature before the missing adapter: no Try it adapter with try-it off is feature-off, not no-ui", async () => {
    const page = tryPage({ featureOn: { "try-it": false } });
    // A host that hands no adapter while the feature is off.
    page.stub.state.tryIt = undefined;
    for (const input of [
      { action: "fill", answers: { full_name: "Ana" } },
      { action: "edit_rows", collection: "items", rowAction: "add" },
      { action: "navigate", to: "next" },
      { action: "check" },
      { action: "submit" },
      { action: "clear" }
    ]) {
      expect(refusalOf(await tried(page, input)), String(input.action)).toMatchObject({ code: "feature-off", details: { feature: "try-it" } });
    }
    expect(refusalOf(await tried(page, { action: "read" }))).toMatchObject({ code: "no-ui", retryable: false });
    okOf(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: ["Ontario"] }] }));
  });

  it("refuses not-tryable where the person has no Try it, and never starts it", async () => {
    const page = tryPage({ tryIt: { tryable: false }, stub: { workspace: "logic" } });
    expect(refusalOf(await tried(page, { action: "fill", answers: { full_name: "Ana" } }))).toMatchObject({
      code: "not-tryable",
      details: { workspace: "logic", mode: "form" },
      hint: "Try it runs on the form or an open journey or PDF template page; call open { workspace: 'form' } first, or tell the person."
    });
    expect(callsOf(page, "start")).toEqual([]);
  });
});

describe("try_it: turning Try it on", () => {
  it("starts Try it for a starting action after the pre-check, waits for it, and says so", async () => {
    const page = tryPage();
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { full_name: "Ana Silva" } }));
    expect(result).toMatchObject({ action: "fill", changed: true, trying: true, started: true, where: { workspace: "form" }, note: [STARTED_NOTE] });
    expect(page.tryIt.calls.map((call) => call.method).slice(0, 2)).toEqual(["start", "ready"]);
    expect(page.stub.state.trying).toBe(true);
    expect(page.controller.unsavedChangesPrompt()).toBeUndefined();
    // Already on: no second start, no `started`.
    const again = okOf<Result>(await tried(page, { action: "fill", answers: { email: "ana@example.org" } }));
    expect(again).not.toHaveProperty("started");
    expect(callsOf(page, "start")).toHaveLength(1);
  });

  it("never starts it on read, clear or settings", async () => {
    const page = tryPage();
    okOf(await tried(page, { action: "read" }));
    okOf(await tried(page, { action: "clear" }));
    okOf(await tried(page, { action: "settings", trySubmission: { delayMs: 0 } }));
    expect(callsOf(page, "start")).toEqual([]);
    expect(page.stub.state.trying).toBe(false);
  });

  it("refuses unsaved-draft on the person's draft, on the form or the active designer document, and raises no prompt", async () => {
    const page = tryPage();
    page.controller.select("email");
    page.controller.setDraftProperty("email", "label", "typed");
    expect(refusalOf(await tried(page, { action: "check" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "email" } });
    expect(page.controller.unsavedChangesPrompt()).toBeUndefined();
    page.controller.discardDraft();

    const designer = designerController();
    page.stub.state.activeController = designer;
    designer.select("title");
    designer.setDraftProperty("title", "label", "typed");
    expect(refusalOf(await tried(page, { action: "submit" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "title" } });
    expect(designer.unsavedChangesPrompt()).toBeUndefined();
    expect(callsOf(page, "start")).toEqual([]);
  });

  it("answers not-tryable when the shell holds Try it with no prompt up", async () => {
    const page = tryPage({ tryIt: { startAnswers: false } });
    expect(refusalOf(await tried(page, { action: "fill", answers: { full_name: "Ana" } })).code).toBe("not-tryable");
    expect(page.controller.unsavedChangesPrompt()).toBeUndefined();
  });

  it("refuses try-it-busy while the person records a test or Try it shows one, before anything is written", async () => {
    const recording = tryPage({ tryIt: { trying: true, recording: true } });
    for (const input of [
      { action: "fill", answers: { full_name: "Ana" } },
      { action: "edit_rows", collection: "items", rowAction: "add" },
      { action: "navigate", to: "next" },
      { action: "submit" },
      { action: "clear" }
    ]) {
      expect(refusalOf(await tried(recording, input)), String(input.action)).toMatchObject({
        code: "try-it-busy",
        details: { because: "recording" },
        hint: "The person is recording a test; your answers would be written into it. Wait until they stop, then call again."
      });
    }
    expect(recording.tryIt.runtime.state().values).toEqual({});
    const showing = tryPage({ tryIt: { trying: true, showing: true } });
    expect(refusalOf(await tried(showing, { action: "fill", answers: { full_name: "Ana" } }))).toMatchObject({
      code: "try-it-busy",
      details: { because: "showing" },
      hint: "Try it is showing a test scenario; ask the person to close it first."
    });
    // A check draws problems only: it is not held.
    okOf(await tried(showing, { action: "check" }));
  });
});

describe("try_it { action: 'read' }", () => {
  it("answers with Try it off: trying false, a note, the settings, no fields", async () => {
    const page = tryPage();
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect(read).toMatchObject({ action: "read", changed: false, trying: false, answered: { byPerson: 0, byAssistant: 0 }, recording: false, showing: false });
    expect(read).not.toHaveProperty("fields");
    expect(read).not.toHaveProperty("where");
    expect(read.settings).toMatchObject({ trySubmission: { outcome: "accept" }, sources: [{ sourceId: "provinces", state: "host", usedBy: [] }] });
    expect(read.next).toEqual(["try_it { action: 'fill' } types answers; 'check' shows what the form would refuse."]);
  });

  it("lists the tried fields, whose answers are the person's or the assistant's, hidden ones only with include all", async () => {
    const page = tryPage({ root: guardedRoot(), tryIt: { trying: true } });
    page.tryIt.runtime.setValue("email", "person@example.org");
    okOf(await tried(page, { action: "fill", answers: { full_name: "Ana", topic: "Support" } }));
    const read = okOf<Result>(await tried(page, { action: "read" }));
    const fields = read.fields as Array<Record<string, unknown>>;
    expect(fields.find((field) => field.path === "full_name")).toMatchObject({ value: "Ana", typedBy: "assistant", required: true, visible: true });
    expect(fields.find((field) => field.path === "email")).toMatchObject({ value: "person@example.org", typedBy: "person" });
    expect(fields.find((field) => field.path === "topic")).toMatchObject({ value: "support", display: "Support", typedBy: "assistant" });
    expect(fields.find((field) => field.path === "double")).toMatchObject({ readonly: true });
    expect(fields.some((field) => field.path === "secret")).toBe(false);
    expect(read.answered).toEqual({ byPerson: 1, byAssistant: 2 });
    const all = okOf<Result>(await tried(page, { action: "read", include: "all" }));
    const secret = (all.fields as Array<Record<string, unknown>>).find((field) => field.path === "secret");
    expect(secret).toMatchObject({ visible: false });
    expect(secret).not.toHaveProperty("value");
    expect(all.fieldCount).toBe((read.fieldCount as number) + 1);
  });

  it("pages the fields with offset and limit", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    const all = okOf<Result>(await tried(page, { action: "read" }));
    const paged = okOf<Result>(await tried(page, { action: "read", offset: 1, limit: 2 }));
    expect(paged.fieldCount).toBe(all.fieldCount);
    expect((paged.fields as unknown[]).map((field) => (field as { path: string }).path)).toEqual((all.fields as Array<{ path: string }>).slice(1, 3).map((field) => field.path));
  });

  it("answers during Stop and is reported as a read, while a write action is stopped", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await page.builder.execute("begin_session", { purpose: "Try the form" }));
    (page.stub.state.session as { onStop(): void }).onStop();
    await Promise.resolve();
    const before = page.builder.host.calls.length;
    okOf(await tried(page, { action: "read" }));
    const event = page.builder.host.calls.slice(before).find((call) => call.method === "emit" && call.args[0] === "datum-agent-action")?.args[1] as { readOnly: boolean };
    expect(event).toMatchObject({ readOnly: true });
    expect(refusalOf(await tried(page, { action: "fill", answers: { full_name: "Ana" } })).code).toBe("stopped");
  });

  it("reports anyone's last Submit while trying, and the agent's last check", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await tried(page, { action: "read" }));
    page.tryIt.emitSubmit({ outcome: "refused", answers: {} });
    page.tryIt.state.checkOutcome = { problems: [{ componentId: "email", label: "Email", message: "Enter your email." }], server: "off" };
    okOf(await tried(page, { action: "check" }));
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect(read.lastSubmit).toMatchObject({ outcome: "refused" });
    expect(read.lastCheck).toMatchObject({ problemCount: 1 });
    // Try it ended: both go with it (the next call finds it off).
    page.stub.state.trying = false;
    const off = okOf<Result>(await tried(page, { action: "read" }));
    expect(off).not.toHaveProperty("lastSubmit");
    expect(off).not.toHaveProperty("lastCheck");
  });

  it("drops its Submit subscription once the registration is gone, instead of writing into a dead memory", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await tried(page, { action: "read" }));
    const memory = page.builder.catalogue.shared.memory;
    const subscribed = page.tryIt.listeners();
    expect(subscribed).toBe(1);
    // A reseed disposes the tool too, and the next call subscribes again (the body stays loaded).
    page.builder.registration.runtimeReplaced();
    expect(page.tryIt.listeners()).toBe(0);
    okOf(await tried(page, { action: "read" }));
    expect(page.tryIt.listeners()).toBe(1);
    page.builder.connection.abort();
    // The unregister disposes the tool, so the
    // listener is gone at once, before any Submit.
    expect(page.tryIt.listeners()).toBe(0);
    // A Submit after the unregister reaches nothing: nothing recorded.
    page.tryIt.emitSubmit({ outcome: "accepted", answers: {}, reference: "DT-000009" });
    expect(memory.tryLast.lastSubmit).toBeUndefined();
    expect(page.tryIt.listeners()).toBe(0);
    page.tryIt.emitSubmit({ outcome: "refused", answers: {} });
    expect(memory.tryLast.lastSubmit).toBeUndefined();
  });

  it("leaves no Submit subscription when the registration goes while the first call's chunk is still loading", async () => {
    // The first call starts the agent-try load, the
    // registration goes before it lands, and the call then runs the body after its dispose.
    const page = tryPage({ tryIt: { trying: true } });
    const memory = page.builder.catalogue.shared.memory;
    const call = page.builder.execute("try_it", { action: "read" });
    page.builder.connection.abort();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.tryIt.listeners()).toBe(0);
    page.tryIt.emitSubmit({ outcome: "accepted", answers: {}, reference: "DT-000010" });
    expect(memory.tryLast.lastSubmit).toBeUndefined();
  });
});

describe("try_it { action: 'fill' }", () => {
  it("types answers as the form reads them, an option by its label, and shows the person", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    const revision = page.builder.registration.revision();
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { full_name: "Ana Silva", topic: "Support", subscribe: "yes" } }));
    expect(result.written).toEqual([
      { path: "full_name", value: "Ana Silva" },
      { path: "topic", value: "support", display: "Support", matched: "label" },
      { path: "subscribe", value: true }
    ]);
    expect(page.tryIt.runtime.state().values).toMatchObject({ full_name: "Ana Silva", topic: "support", subscribe: true });
    expect(page.tryIt.runtime.state().dirty.has("full_name")).toBe(true);
    expect(page.stub.callsOf("highlight")).toEqual([[["full_name", "topic", "subscribe"]]]);
    expect(page.stub.callsOf("revealComponent")).toEqual([["full_name"]]);
    expect(page.stub.callsOf("announce")).toEqual([["Assistant typed 3 answers in Try it"]]);
    // Tried answers are not the definition: no revision, no history, no notice.
    expect(page.builder.registration.revision()).toBe(revision);
    expect(page.controller.canUndo()).toBe(false);
    expect(page.stub.callsOf("notice")).toEqual([]);
    expect(result.next).toEqual(["Call try_it { action: 'check' } to see what the form would refuse.", "try_it { action: 'submit' } presses Submit against the stand-in server; nothing is sent."]);
  });

  it("neither highlights nor reveals while the person types in a text control, but still announces (recorded reading c)", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true }, stub: { focusInTextControl: true } });
    okOf(await tried(page, { action: "fill", answers: { full_name: "Ana" } }));
    expect(page.stub.callsOf("highlight")).toEqual([]);
    expect(page.stub.callsOf("revealComponent")).toEqual([]);
    expect(page.stub.callsOf("announce")).toEqual([["Assistant typed 1 answer in Try it"]]);
    okOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add", values: { qty: 2 } }));
    expect(page.stub.callsOf("highlight")).toEqual([]);
    expect(page.stub.callsOf("revealComponent")).toEqual([]);
    expect(page.stub.callsOf("announce")).toEqual([["Assistant typed 1 answer in Try it"], ["Assistant changed the rows of Items in Try it"]]);
  });

  it("tells the model when a journey's fields of other pages were written in place, and reveals the shown page's only", async () => {
    const page = journeyTryPage({ tryIt: { trying: true } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { email: "x@y.z", applicant_name: "Ana" } }));
    expect(result.written).toEqual([
      { path: "email", value: "x@y.z" },
      { path: "applicant_name", value: "Ana" }
    ]);
    expect(result.note).toEqual(["Some fields are on other pages; they were written in place and their page checks run when you navigate there."]);
    expect(page.journey.state().values).toMatchObject({ email: "x@y.z", applicant_name: "Ana" });
    expect(page.stub.callsOf("highlight")).toEqual([[["email", "applicant_name"]]]);
    expect(page.stub.callsOf("revealComponent")).toEqual([["applicant_name"]]);
    // Only fields of other pages: nothing to scroll to, no second note on a fill of the shown page.
    const elsewhere = okOf<Result>(await tried(page, { action: "fill", answers: { stop_code: "A1" } }));
    expect(elsewhere.note).toEqual(["Some fields are on other pages; they were written in place and their page checks run when you navigate there."]);
    expect(page.stub.callsOf("revealComponent")).toEqual([["applicant_name"]]);
    const here = okOf<Result>(await tried(page, { action: "fill", answers: { age: 30 } }));
    expect(here).not.toHaveProperty("note");
    expect(page.stub.callsOf("revealComponent")).toEqual([["applicant_name"], ["age"]]);
  });

  it("refuses per path through the shared answers module, in Try it's words, and writes the rest", async () => {
    const root = guardedRoot();
    ((root.children?.content as ComponentNode[]).find((node) => node.id === "locked") as ComponentNode).rules = { readonlyWhen: "true" };
    const page = tryPage({ root, tryIt: { trying: true } });
    const result = okOf<Result>(
      await tried(page, { action: "fill", answers: { secret: "x", locked: "y", double: 3, quantity: "abc", emial: "a@b", topic: "Nothing", full_name: "Ana" } })
    );
    const refused = result.refused as Array<Record<string, unknown>>;
    const byPath = new Map(refused.map((item) => [item.path, item]));
    expect(byPath.get("secret")).toMatchObject({ code: "not-writable", details: { reason: "hidden" } });
    expect(byPath.get("locked")).toMatchObject({ code: "not-writable", details: { reason: "readonly" } });
    expect(byPath.get("double")).toMatchObject({ code: "not-writable", details: { reason: "calculated" }, hint: "The form works this value out itself; write the fields it depends on." });
    expect(byPath.get("quantity")).toMatchObject({ code: "invalid-value", details: { path: "quantity", kind: "number", expected: "a number" } });
    expect(byPath.get("emial")).toMatchObject({ code: "unknown-field", details: { ref: "emial" } });
    expect((byPath.get("emial")?.details as { suggestions: string[] }).suggestions).toContain("email");
    expect(byPath.get("topic")).toMatchObject({ code: "no-such-option", details: { got: "Nothing", total: 3 } });
    expect(result.written).toEqual([{ path: "full_name", value: "Ana" }]);
    // No hint names a renderer tool.
    expect(JSON.stringify(refused)).not.toMatch(/describe_form|get_options|set_answers|edit_rows with|navigate with/u);
  });

  it("refuses the field the person is typing in, and writes the others", async () => {
    const page = tryPage({ tryIt: { trying: true, focusedPath: "email" } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { full_name: "Ana Silva", email: "ana@example.org" } }));
    expect(result.refused).toEqual([
      { path: "email", code: "field-in-use", message: "The person is typing in Email.", hint: "The person is typing there; fill the other fields now and retry this one.", details: { path: "email" } }
    ]);
    expect(page.tryIt.runtime.state().values.email).toBeUndefined();
  });

  it("answers nothing-written when every path was refused", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    const refused = refusalOf(await tried(page, { action: "fill", answers: { nope: 1, email: ["a"] } }));
    expect(refused).toMatchObject({ code: "nothing-written", hint: "See each refusal's hint." });
    expect((refused.details as { refused: unknown[] }).refused).toHaveLength(2);
  });

  it("names the fields the answers made required and revealed, and the problems now on the written ones", async () => {
    const page = tryPage({ root: guardedRoot(), tryIt: { trying: true } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { topic: "other", email: null } }));
    expect(result.revealed).toEqual(["secret"]);
    expect(result.nowRequired).toEqual(["message"]);
    expect(result.next).toEqual(["Fill message next: it became required.", "Call try_it { action: 'check' } to see what the form would refuse."]);
    expect(result.problems).toEqual([{ path: "email", componentId: "email", label: "Email", message: "Email is required." }]);
    expect(result.problemCount).toBe(1);
  });

  it("counts a revealed required field as now required", async () => {
    const root = guardedRoot();
    (((root.children?.content as ComponentNode[]).find((node) => node.id === "secret") as ComponentNode).configuration as Record<string, unknown>).required = true;
    const page = tryPage({ root, tryIt: { trying: true } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { topic: "other" } }));
    expect(result).toMatchObject({ revealed: ["secret"], nowRequired: ["secret", "message"] });
    expect(result.next).toEqual(["Fill secret, message next: they became required.", "Call try_it { action: 'check' } to see what the form would refuse."]);
  });

  it("checks the grammar first: bad paths, caps, ignored arguments", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    expect(refusalOf(await tried(page, { action: "fill", answers: { "bad path!": 1 } }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "answers.bad path!" }] } });
    expect(refusalOf(await tried(page, { action: "fill" }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "answers", expected: "required for action 'fill'" }] } });
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, at) => [`field_${at}`, "x"]));
    expect(refusalOf(await tried(page, { action: "fill", answers: many }))).toMatchObject({ code: "too-large", details: { key: "answers", limit: 200, got: 201 } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { full_name: "Ana" }, to: "next" }));
    expect(result.warnings).toEqual(["ignored argument for action 'fill': to"]);
  });

  it("takes a 400 KB call and refuses a 600 KB one as too large", async () => {
    const page = tryPage();
    const options = (count: number): Array<{ value: string; label: string }> => Array.from({ length: count }, (_, at) => ({ value: `v${at}`, label: "x".repeat(250) }));
    expect(JSON.stringify(options(1_500)).length).toBeGreaterThan(400_000);
    okOf(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: options(1_500) }] }));
    expect(refusalOf(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: options(2_000) }, { sourceId: "provinces", options: options(400) }] }))).toMatchObject({
      code: "too-large",
      details: { what: "input", limit: 524_288 }
    });
  });

  it("writes a whole table as rows, and refuses one over the person's typed rows", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true } });
    const result = okOf<Result>(await tried(page, { action: "fill", answers: { items: [{ qty: 1, note: "a" }, { qty: "2" }] } }));
    expect(result.written).toEqual([{ path: "items", value: [{ qty: 1, note: "a" }, { qty: 2, note: undefined }] }]);
    expect(result.answered).toEqual({ byPerson: 0, byAssistant: 3 });
    page.tryIt.runtime.setValue("items[1].note", "mine");
    const refused = okOf<Result>(await tried(page, { action: "fill", answers: { items: [{ qty: 9 }], full_name: "Ana" } }));
    expect(refused.refused).toEqual([expect.objectContaining({ path: "items", code: "person-data", details: { collection: "items", paths: ["items[1].note"] } })]);
    // Over the grid's bounds.
    expect(okOf<Result>(await tried(page, { action: "fill", answers: { items: [], full_name: "Ana" } })).refused).toEqual([
      expect.objectContaining({ path: "items", code: "rows-limit", details: expect.objectContaining({ min: 1, max: 3, asked: 0 }) })
    ]);
    // A cell of a row that is not there.
    expect(okOf<Result>(await tried(page, { action: "fill", answers: { "items[7].qty": 1, full_name: "Ana" } })).refused).toEqual([
      expect.objectContaining({ path: "items[7].qty", code: "no-such-row", details: { collection: "items", index: 7, rows: 2 } })
    ]);
  });
});

describe("try_it { action: 'edit_rows' }", () => {
  it("adds a row with answers by column and removes one within the grid's bounds", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true } });
    const added = okOf<Result>(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add", values: { qty: "5", note: "n", bogus: 1 } }));
    expect(added).toMatchObject({ rows: { collection: "items", count: 2, added: 1 }, written: [{ path: "items[1].qty", value: 5 }, { path: "items[1].note", value: "n" }] });
    expect(added.refused).toEqual([expect.objectContaining({ path: "items[1].bogus", code: "unknown-field" })]);
    expect(page.stub.callsOf("announce")).toEqual([["Assistant changed the rows of Items in Try it"]]);
    okOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add" }));
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add" }))).toMatchObject({ code: "rows-limit", details: { min: 1, max: 3, rows: 3, asked: 4 } });
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove", index: 5 }))).toMatchObject({ code: "no-such-row", details: { index: 5, rows: 3 } });
    // The row above the agent's goes: its marks follow its row up to index 0 (still the assistant's, not the person's).
    const removed = okOf<Result>(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove", index: 0 }));
    expect(removed.rows).toEqual({ collection: "items", count: 2, removed: 1 });
    expect(removed.answered).toEqual({ byPerson: 0, byAssistant: 2 });
    expect([...page.builder.catalogue.shared.memory.tried.keys()]).toEqual(["items[0].qty", "items[0].note"]);
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect((read.fields as Array<Record<string, unknown>>).find((field) => field.path === "items")).toMatchObject({ typedBy: "assistant", value: [{ qty: 5, note: "n" }, {}] });
    expect(okOf<Result>(await tried(page, { action: "clear" }))).toMatchObject({ cleared: { byPerson: 0, byAssistant: 2 } });
  });

  it("refuses removing a row the person typed in unless force, and the bounds and locks", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true } });
    okOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add" }));
    page.tryIt.runtime.setValue("items[0].note", "mine");
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove", index: 0 }))).toMatchObject({
      code: "person-data",
      details: { collection: "items", index: 0, paths: ["items[0].note"] },
      hint: "Removing the person's own entries needs their say; ask them, then pass force: true."
    });
    okOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove", index: 0, force: true }));
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove", index: 0 }))).toMatchObject({ code: "rows-limit", details: { min: 1, asked: 0 } });
    const locked = tryPage({ root: tableRoot({ canAdd: false }), tryIt: { trying: true } });
    expect(refusalOf(await tried(locked, { action: "edit_rows", collection: "items", rowAction: "add" }))).toMatchObject({ code: "rows-locked", details: { operation: "add" } });
  });

  it("checks its grammar: index with remove, a table's path", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true } });
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "remove" }))).toMatchObject({
      code: "bad-input",
      details: { problems: [{ key: "index", expected: "required for rowAction 'remove'" }] }
    });
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "full_name", rowAction: "add" }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "collection" }] } });
    const warned = okOf<Result>(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add", force: true }));
    expect(warned.warnings).toEqual(["ignored argument for rowAction 'add': force"]);
  });

  it("refuses the table the person is typing in", async () => {
    const page = tryPage({ root: tableRoot(), tryIt: { trying: true, focusedPath: "items[0].note" } });
    expect(refusalOf(await tried(page, { action: "edit_rows", collection: "items", rowAction: "add" }))).toMatchObject({ code: "field-in-use", details: { path: "items[0].note" } });
  });
});

describe("try_it { action: 'navigate' } on a journey's preview", () => {
  it("answers not-a-journey on the form, without starting Try it", async () => {
    const page = tryPage();
    expect(refusalOf(await tried(page, { action: "navigate", to: "next" }))).toMatchObject({
      code: "not-a-journey",
      details: { workspace: "form" },
      hint: "navigate moves a journey's preview; open the journey with documents { action: 'open', kind: 'journey', id } and call try_it again."
    });
    expect(callsOf(page, "start")).toEqual([]);
  });

  it("moves page by page under quiet page focus, the pages named as the journey writes them", async () => {
    const page = journeyTryPage({ tryIt: { trying: true } });
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect(read.where).toMatchObject({ workspace: "journeys", journey: { journeyId: "main", pageId: "intro", title: "Name", index: 0, final: false } });
    expect((read.where as { journey: { pages: Array<{ pageId: string }> } }).journey.pages.map((entry) => entry.pageId)).toEqual(["intro", "contact", "details", "review", "stop"]);
    // The current page's fields alone.
    expect((read.fields as Array<{ path: string }>).map((field) => field.path)).toEqual(["applicant_name", "age", "age_next_year", "wants_details", "nickname"]);
    const blocked = refusalOf(await tried(page, { action: "navigate", to: "next" }));
    expect(blocked).toMatchObject({ code: "blocked", details: { reason: "validation", problems: [{ path: "applicant_name", componentId: "applicant_name", label: "Name" }] } });
    expect(blocked.hint).toBe("Fix the answers listed with try_it { action: 'fill' }, then move again.");
    okOf(await tried(page, { action: "fill", answers: { applicant_name: "Ana", age: 30 } }));
    const moved = okOf<Result>(await tried(page, { action: "navigate", to: "next" }));
    expect(moved).toMatchObject({ action: "navigate", changed: true, moved: true, where: { journey: { pageId: "contact", index: 1 } } });
    expect(moved.next).toEqual(["Fill this page with try_it { action: 'fill' }, then navigate to 'next'."]);
    expect(callsOf(page, "quietPageFocus").length).toBe(2);
    expect(page.tryIt.quiet()).toBe(0);
  });

  it("reaches a page by its id through nodeIdOf, refuses an unknown one, at-start and at-end", async () => {
    const page = journeyTryPage({ tryIt: { trying: true } });
    const nodeIdOf = vi.spyOn(page.tryIt.adapter, "nodeIdOf");
    expect(refusalOf(await tried(page, { action: "navigate", to: "back" }))).toMatchObject({ code: "at-start", details: { page: "intro" } });
    okOf(await tried(page, { action: "fill", answers: { applicant_name: "Ana", age: 30 } }));
    okOf(await tried(page, { action: "navigate", to: "next" }));
    const jumped = okOf<Result>(await tried(page, { action: "navigate", to: "intro" }));
    expect(nodeIdOf).toHaveBeenCalledWith("intro");
    expect(page.journey.journeyView()?.pageId).toBe("n-intro");
    expect(jumped).toMatchObject({ moved: true, where: { journey: { pageId: "intro" } } });
    const unknown = refusalOf(await tried(page, { action: "navigate", to: "nowhere" }));
    expect(unknown).toMatchObject({ code: "unknown-page", details: { to: "nowhere" } });
    expect((unknown.details as { pages: Array<{ id: string }> }).pages.map((entry) => entry.id)).toContain("review");
    okOf(await tried(page, { action: "navigate", to: "next" }));
    okOf(await tried(page, { action: "navigate", to: "next" }));
    expect(page.journey.journeyView()?.pageId).toBe("n-review");
    expect(refusalOf(await tried(page, { action: "navigate", to: "next" }))).toMatchObject({ code: "at-end", details: { page: "review" } });
  });

  it("waits for the journey session's ready() before the first answer when it starts Try it", async () => {
    const page = journeyTryPage();
    let release!: () => void;
    page.tryIt.adapter.ready = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = tried(page, { action: "fill", answers: { applicant_name: "Ana" } });
    await vi.waitFor(() => expect(callsOf(page, "start")).toHaveLength(1));
    // Try it is on, and nothing is written while the session is still coming up.
    expect(page.stub.state.trying).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.journey.state().values.applicant_name).toBeUndefined();
    release();
    const result = okOf<Result>(await call);
    expect(result).toMatchObject({ started: true, written: [{ path: "applicant_name", value: "Ana" }], where: { workspace: "journeys" } });
  });

  it("answers chunk-unavailable when the journey preview does not come up in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = journeyTryPage();
    page.tryIt.adapter.ready = () => new Promise<void>(() => undefined);
    const call = tried(page, { action: "fill", answers: { applicant_name: "Ana" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refusalOf(await call)).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "journey-preview", state: "loading" } });
  });
});

describe("try_it over a journey's presentation (own fields)", () => {
  it("writes the shown page's own fields by their @ path, and refuses another page's as presentation with the navigate hint", async () => {
    const page = journeyTryPage({ journey: presentationForm(), tryIt: { trying: true } });
    const start = okOf<Result>(await tried(page, { action: "read" }));
    expect(start.where).toMatchObject({ journey: { journeyId: "apply", pageId: "details" } });
    // On `details`, the own fields of `income` are another page's: never written, the hint names navigate.
    const away = refusalOf(await tried(page, { action: "fill", answers: { "@apply.m1": 2100 } }));
    expect(away.code).toBe("nothing-written");
    expect((away.details as { refused: unknown[] }).refused).toEqual([
      {
        path: "@apply.m1",
        code: "not-writable",
        message: "The tried field '@apply.m1' belongs to another page of the journey.",
        hint: "This field belongs to another page of the journey; move there with try_it { action: 'navigate' }, then fill it.",
        details: { path: "@apply.m1", reason: "presentation" }
      }
    ]);
    expect(page.journey.state().values).not.toHaveProperty("@apply.m1");
    // The person answers the alias `details` requires; the agent moves on to `income`.
    personTypes(page.journey, { email: "ana@example.ca" });
    const moved = okOf<Result>(await tried(page, { action: "navigate", to: "next" }));
    expect(moved).toMatchObject({ moved: true, where: { journey: { pageId: "income" } } });
    // There, the page's own fields take answers like form fields, and the worked-out value follows.
    const filled = okOf<Result>(await tried(page, { action: "fill", answers: { "@apply.m1": 2100, "@apply.m2": 2100, "@apply.m3": 2300 } }));
    expect(filled.refused).toBeUndefined();
    expect(filled.written).toEqual([
      { path: "@apply.m1", value: 2100 },
      { path: "@apply.m2", value: 2100 },
      { path: "@apply.m3", value: 2300 }
    ]);
    expect(page.journey.state().values).toMatchObject({ "@apply.m1": 2100, "@apply.m2": 2100, "@apply.m3": 2300, annual_income: 6500 });
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect((read.fields as Array<{ path: string; typedBy?: string }>).filter((field) => field.path.startsWith("@")).map((field) => [field.path, field.typedBy])).toEqual([
      ["@apply.m1", "assistant"],
      ["@apply.m2", "assistant"],
      ["@apply.m3", "assistant"]
    ]);
  });
});

describe("try_it { action: 'check' } and { action: 'submit' }", () => {
  it("runs the person's Check and reports what the panel shows", async () => {
    const page = tryPage({ tryIt: { trying: true, checkOutcome: { problems: [{ componentId: "email", label: "Email", message: "Enter your email." }, { label: "The form", message: "Too short." }], server: "ran" } } });
    const result = okOf<Result>(await tried(page, { action: "check" }));
    expect(result).toMatchObject({
      action: "check",
      changed: false,
      problems: [{ path: "email", componentId: "email", label: "Email", message: "Enter your email." }, { label: "The form", message: "Too short." }],
      problemCount: 2,
      serverChecks: "on",
      next: ["Fix the answers with try_it { action: 'fill' }, or the rules with set_properties after open { tryIt: false }."]
    });
    page.tryIt.state.checkOutcome = { problems: [], server: "off" };
    expect(okOf<Result>(await tried(page, { action: "check" }))).toMatchObject({ problemCount: 0, serverChecks: "off", next: ["try_it { action: 'submit' } shows the stand-in's answer, or write_test keeps these answers as a test."] });
  });

  it("maps a refused Check: a failed chunk, a chunk still loading, Try it ended", async () => {
    const page = tryPage({ tryIt: { trying: true, checkOutcome: new Error("The Try it panel could not be loaded."), chunk: "failed" } });
    expect(refusalOf(await tried(page, { action: "check" }))).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "try-it", state: "failed" } });
    page.tryIt.state.chunk = "ready";
    expect(refusalOf(await tried(page, { action: "check" }))).toMatchObject({ code: "not-tryable" });
  });

  it("answers a Check past its 10 s: chunk-unavailable while the chunk loads, else timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = tryPage({ tryIt: { trying: true, chunk: "loading" } });
    page.tryIt.adapter.check = () => new Promise(() => undefined);
    const loading = tried(page, { action: "check" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refusalOf(await loading)).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "try-it", state: "loading" }, hint: "That part of the builder is still loading; call again in a moment." });
    page.tryIt.state.chunk = "ready";
    const slow = tried(page, { action: "check" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refusalOf(await slow)).toMatchObject({ code: "timeout", details: { afterMs: 10_000, stillRunning: true } });
  });

  it("presses Submit against the stand-in and says what it answered", async () => {
    const page = tryPage({ tryIt: { trying: true, submitOutcome: { outcome: "accepted", answers: {}, reference: "DT-123456" } } });
    page.controller.setTrySubmission({ afterAccept: "readonly" });
    const accepted = okOf<Result>(await tried(page, { action: "submit" }));
    expect(accepted).toMatchObject({
      action: "submit",
      changed: true,
      submitted: { outcome: "accepted", standIn: true, reference: "DT-123456", message: "We have your answers.", readOnlyNow: true },
      serverChecks: "off",
      next: ["Tell the person what the stand-in answered; write_test can keep these answers as a test."]
    });
    expect(okOf<Result>(await tried(page, { action: "read" })).lastSubmit).toMatchObject({ outcome: "accepted", reference: "DT-123456" });
    page.controller.setTrySubmission({ refusalMessage: "Our office is closed." });
    page.tryIt.state.submitOutcome = { outcome: "refused", answers: {} };
    expect(okOf<Result>(await tried(page, { action: "submit" })).submitted).toEqual({ outcome: "refused", standIn: true, message: "Our office is closed." });
  });

  it("reports the problems an invalid Submit put on the form", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    page.tryIt.adapter.submit = () => {
      page.tryIt.runtime.setErrors([{ id: "e1", code: "required", componentId: "email", stage: "field-constraints", source: "client" }]);
      return Promise.resolve({ outcome: "invalid", answers: {} } satisfies TrySubmitOutcome);
    };
    const result = okOf<Result>(await tried(page, { action: "submit" }));
    expect(result).toMatchObject({ submitted: { outcome: "invalid", standIn: true }, problemCount: 1, next: ["Fix the answers with try_it { action: 'fill' }, or the rules with set_properties after open { tryIt: false }."] });
    expect((result.problems as Array<Record<string, unknown>>)[0]).toMatchObject({ path: "email", componentId: "email", label: "Email" });
  });

  it("answers busy at once while a Submit runs, and timeout after 20 s", async () => {
    const page = tryPage({ tryIt: { trying: true, submitOutcome: { state: "busy" } } });
    expect(refusalOf(await tried(page, { action: "submit" }))).toMatchObject({ code: "busy", retryable: true, details: { because: "try-submit" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    page.tryIt.adapter.submit = () => new Promise(() => undefined);
    const call = tried(page, { action: "submit" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refusalOf(await call)).toMatchObject({ code: "timeout", retryable: true, details: { afterMs: 20_000, stillRunning: true } });
  });
});

describe("try_it { action: 'clear' }", () => {
  it("refuses tried-answers over one answer the person typed, and clears with discardTriedAnswers", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await tried(page, { action: "fill", answers: { full_name: "Ana" } }));
    page.tryIt.runtime.setValue("email", "person@example.org");
    expect(refusalOf(await tried(page, { action: "clear" }))).toEqual(
      expect.objectContaining({
        code: "tried-answers",
        message: "The person typed 1 answers in Try it; nothing was cleared.",
        hint: "The person typed 1 answers in Try it; tell them they will be cleared, then call again with discardTriedAnswers: true.",
        details: { byPerson: 1, byAssistant: 1 }
      })
    );
    expect(page.tryIt.runtime.state().values.email).toBe("person@example.org");
    const cleared = okOf<Result>(await tried(page, { action: "clear", discardTriedAnswers: true }));
    expect(cleared).toMatchObject({ changed: true, cleared: { byPerson: 1, byAssistant: 1 }, answered: { byPerson: 0, byAssistant: 0 }, next: ["try_it { action: 'fill' } starts again from the form's defaults."] });
    expect(callsOf(page, "clear")).toHaveLength(1);
  });

  it("clears the agent's own answers without the flag, and forgets them: the same value typed later is the person's", async () => {
    const page = tryPage({ tryIt: { trying: true } });
    okOf(await tried(page, { action: "fill", answers: { full_name: "Ana", email: "ana@example.org" } }));
    expect(okOf<Result>(await tried(page, { action: "clear" }))).toMatchObject({ cleared: { byPerson: 0, byAssistant: 2 } });
    expect(page.tryIt.runtime.state().values).toEqual({});
    expect(page.builder.catalogue.shared.memory.tried.size).toBe(0);
    // The person types what the agent wrote before the clear: theirs, so a plain clear is refused.
    page.tryIt.runtime.setValue("full_name", "Ana");
    const read = okOf<Result>(await tried(page, { action: "read" }));
    expect(read.answered).toEqual({ byPerson: 1, byAssistant: 0 });
    expect((read.fields as Array<Record<string, unknown>>).find((field) => field.path === "full_name")).toMatchObject({ typedBy: "person", value: "Ana" });
    expect(refusalOf(await tried(page, { action: "clear" }))).toMatchObject({ code: "tried-answers", details: { byPerson: 1, byAssistant: 0 } });
    expect(page.tryIt.runtime.state().values.full_name).toBe("Ana");
  });
});

describe("try_it { action: 'settings' }", () => {
  it("sets the stand-in Submit, journaled with its reverse, and the reverse round-trips", async () => {
    const page = tryPage();
    const before = JSON.stringify(page.controller.trySubmission());
    const result = okOf<Result>(await tried(page, { action: "settings", trySubmission: { outcome: "refuse", refusalMessage: "Our office is closed." } }));
    expect(result).toMatchObject({
      action: "settings",
      changed: true,
      trying: false,
      settingsChanged: ["trySubmission.outcome", "trySubmission.refusalMessage"],
      undo: { steps: 0, journaled: true },
      reverse: { tool: "try_it", input: { action: "settings", trySubmission: { outcome: "accept", refusalMessage: "The server refused the form." } } },
      next: ["Try it with try_it { action: 'submit' } or 'fill'."]
    });
    expect(page.controller.trySubmission()).toMatchObject({ outcome: "refuse", refusalMessage: "Our office is closed." });
    expect(page.stub.callsOf("announce")).toEqual([["Assistant changed how Try it's stand-in server answers"]]);
    const notice = page.stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    expect(notice[1].label).toBe("Undo");
    const reverse = (result.reverse as { input: Record<string, unknown> }).input;
    okOf(await tried(page, reverse));
    expect(JSON.stringify(page.controller.trySubmission())).toBe(before);
    // The same values again: nothing changes, nothing is journaled.
    const memory = page.builder.catalogue.shared.memory;
    const entries = memory.outside.length;
    expect(okOf<Result>(await tried(page, { action: "settings", trySubmission: { outcome: "accept" } }))).toMatchObject({ changed: false, settingsChanged: [] });
    expect(memory.outside.length).toBe(entries);
  });

  it("puts back the stand-in Submit and a stand-in list on end_session { undo: true }", async () => {
    const page = tryPage();
    okOf(await page.builder.execute("begin_session", { purpose: "Try the refusal" }));
    okOf(await tried(page, { action: "settings", trySubmission: { outcome: "fail", delayMs: 0 } }));
    const listed = okOf<Result>(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: ["Ontario", { value: "qc", label: "Quebec" }] }] }));
    expect(listed.warnings).toEqual(["host-source: the site's list for provinces is replaced in the builder's preview only"]);
    expect(page.controller.simulatedDataSources().get("provinces")).toEqual([
      { value: "Ontario", label: "Ontario" },
      { value: "qc", label: "Quebec" }
    ]);
    expect((listed.settings as { sources: unknown[] }).sources).toEqual([{ sourceId: "provinces", state: "simulated", usedBy: [], simulatedOptions: 2 }]);
    expect(listed.reverse).toEqual({ tool: "try_it", input: { action: "settings", sources: [{ sourceId: "provinces", clear: true }] } });
    const ended = okOf<Result>(await page.builder.execute("end_session", { summary: "Tried it.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(page.controller.trySubmission()).toMatchObject({ outcome: "accept", delayMs: 800 });
    expect(page.controller.simulatedDataSources().has("provinces")).toBe(false);
  });

  it("the notice's Undo puts the settings back, and keeps a part the person changed since", async () => {
    const page = tryPage();
    okOf(await tried(page, { action: "settings", trySubmission: { outcome: "refuse" }, sources: [{ sourceId: "provinces", options: ["Ontario"] }] }));
    const [, action] = page.stub.callsOf("notice")[0] as [string, { label: string; run(): void }];
    // The person sets their own stand-in list meanwhile: it stays theirs.
    page.controller.setSimulatedDataSource("provinces", [{ value: "bc", label: "British Columbia" }]);
    action.run();
    expect(page.controller.trySubmission().outcome).toBe("accept");
    expect(page.controller.simulatedDataSources().get("provinces")).toEqual([{ value: "bc", label: "British Columbia" }]);
  });

  it("refuses an unknown source, an over-long list and a bad item before setting anything", async () => {
    const page = tryPage();
    const unknown = refusalOf(await tried(page, { action: "settings", trySubmission: { outcome: "fail" }, sources: [{ sourceId: "nope", options: ["x"] }] }));
    expect(unknown).toMatchObject({ code: "unknown-source", details: { sourceId: "nope", known: ["provinces"] }, hint: "Use one of the listed data-source ids (describe_builder dataSourceIds)." });
    expect(page.controller.trySubmission().outcome).toBe("accept");
    const options = Array.from({ length: 2_001 }, (_, at) => `option ${at}`);
    expect(refusalOf(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options }] }))).toMatchObject({
      code: "too-large",
      details: { key: "sources[0].options", limit: 2_000, got: 2_001 }
    });
    expect(refusalOf(await tried(page, { action: "settings", sources: [{ sourceId: "provinces", options: ["x"], clear: true }] }))).toMatchObject({
      code: "bad-input",
      details: { problems: [{ key: "sources[0]", expected: "exactly one of options and clear: true" }] }
    });
    expect(refusalOf(await tried(page, { action: "settings" }))).toMatchObject({ code: "bad-input", details: { problems: [{ key: "trySubmission" }] } });
    expect(refusalOf(await tried(page, { action: "settings", trySubmission: { statusPlacement: [] } }))).toMatchObject({
      code: "bad-input",
      details: { problems: [{ key: "trySubmission.statusPlacement" }] }
    });
    expect(page.controller.simulatedDataSources().size).toBe(0);
    expect(page.builder.catalogue.shared.memory.outside).toEqual([]);
  });
});
