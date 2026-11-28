import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTOSAVE_NOTE } from "../form-engine/agent/form/tools.js";
import type { FormAgentDrafts } from "../form-engine/agent/form/host.js";
import type { AgentActionDetail } from "../form-engine/agent/registrar.js";
import type { DraftStore, FormDraft } from "../form-engine/persistence/core/draft-store.js";
import { InMemoryDraftStore } from "../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { AGENT_JOURNEY_FORM, AGENT_VERSION_CONTEXT, TRAVEL_CLAIM_FORM, agentSetup as baseSetup, personTypes, type AgentSetup, type AgentSetupOptions } from "./fixtures/agent-form.js";

/**
 * `drafts`: save, restore and clear
 * through the node host (store kind `page`), the consent gate before a restore over entered
 * answers, the typed `DraftError` refusals, store failures worded without the store's text, the
 * journal and last-writer reset on a restore, the quiet page focus of a journey resume, the
 * one-time autosave note, the registrar's stale gate before any body, and the deep search that no
 * result and no saved record carries the draft key, a URL or provenance.
 */

type Row = Record<string, unknown>;

const KEY = "claim-ana";

/** Every registrar call of the test, so afterEach can search every result (done-when: no result anywhere carries the key). */
const calls: Array<Promise<unknown>> = [];

/** `agentSetup`, with every result its registrar answers kept for the deep search below. */
function agentSetup(definition: Parameters<typeof baseSetup>[0], options: AgentSetupOptions = {}): AgentSetup {
  const setup = baseSetup(definition, options);
  const execute = setup.registrar.execute.bind(setup.registrar);
  setup.registrar.execute = (name, input, callOptions) => {
    const result = execute(name, input, callOptions);
    calls.push(result.catch(() => undefined));
    return result;
  };
  return setup;
}

afterEach(async () => {
  vi.useRealTimers();
  // Every result of the test, drafts' and every other tool's: never
  // the draft key, a store URL or the store's own words.
  const results = await Promise.all(calls.splice(0));
  expect(results.length, "every test calls a tool through the tracked registrar").toBeGreaterThan(0);
  for (const result of results) {
    expectNothingLeaks(result, ["Service Unavailable", "Bad Gateway", "Internal Server Error", "maintenance"]);
  }
});

/** Every string and key in a value, depth first: what the deep searches read. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      strings(item, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Row)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

/** No result carries the key, a URL or origin, or the store's own words. */
function expectNothingLeaks(result: unknown, extra: readonly string[] = []): void {
  for (const text of strings(result)) {
    expect(text, JSON.stringify(result).slice(0, 300)).not.toContain(KEY);
    expect(text).not.toMatch(/https?:\/\//u);
    for (const forbidden of extra) {
      expect(text).not.toContain(forbidden);
    }
  }
}

function draftOf(values: Row, overrides: Partial<FormDraft> = {}): FormDraft {
  return {
    id: KEY,
    formId: "travel-claim",
    formVersion: AGENT_VERSION_CONTEXT.formVersion,
    runtime: { schemaVersion: AGENT_VERSION_CONTEXT.schemaVersion, rendererVersion: AGENT_VERSION_CONTEXT.rendererVersion },
    locale: "en",
    values,
    state: { mode: "normal", touched: [], dirty: [], visitedSteps: [], completedSteps: [] },
    updatedAt: 1_792_530_000_000,
    ...overrides
  };
}

function actions(setup: AgentSetup): AgentActionDetail[] {
  return setup.host.calls.filter((call) => call.method === "emit" && call.args[0] === "datum-agent-action").map((call) => call.args[1] as AgentActionDetail);
}

describe("drafts { save }", () => {
  it("saves through the runtime's store: kind page, savedAt from the summary, the visible answers counted, never undoable, consequential", async () => {
    const store = new InMemoryDraftStore();
    const save = vi.spyOn(store, "save");
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    personTypes(setup.runtime, { traveller: "Ana", amount: 120, case_ref: "C-77" });
    const result = await setup.ok("drafts", { action: "save" });
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0] as FormDraft;
    expect(saved.id).toBe(KEY);
    expect(result).toMatchObject({ ok: true, tool: "drafts", action: "save", changed: true, store: "page", undoable: false, savedAt: saved.updatedAt, answered: 2 });
    expect(result.next).toEqual(["Tell the person the draft is saved on the site."]);
    expect(setup.host.calls.filter((call) => call.method === "announce").map((call) => call.args[0])).toContain("An assistant saved your draft");
    expect(actions(setup).find((detail) => detail.tool === "drafts")).toMatchObject({ consequential: true, readOnly: false });
    expectNothingLeaks(result, ["C-77"]);
    // The saved record is the runtime's draft; no provenance rides in it.
    for (const text of strings(saved)) {
      expect(["agent", "involved", "paths", "submittedBy"]).not.toContain(text);
    }
  });

  it("a browser store says so in next, and an argument save does not read is warned (folded convention)", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    const seam = setup.host.drafts?.() as FormAgentDrafts;
    setup.host.drafts = () => ({ ...seam, store: "browser" });
    const result = await setup.ok("drafts", { action: "save", replaceAnswers: true });
    expect(result).toMatchObject({ store: "browser", next: ["Tell the person the draft is saved in this browser."] });
    expect(result.warnings).toEqual(["ignored argument for action 'save': replaceAnswers"]);
  });

  it("feature-off without the drafts feature and no-drafts without a key; the store is never asked", async () => {
    const store = new InMemoryDraftStore();
    const save = vi.spyOn(store, "save");
    const off = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store }, host: { allows: { drafts: false } } });
    expect(await off.refused("drafts", { action: "save" })).toMatchObject({ code: "feature-off", details: { feature: "drafts" } });
    const none = agentSetup(TRAVEL_CLAIM_FORM);
    expect(await none.refused("drafts", { action: "restore" })).toMatchObject({
      code: "no-drafts",
      retryable: false,
      hint: "This form does not keep drafts; tell the person.",
      details: {}
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("a store failure is draft-failed with the status and never the store's words or URL; a beforeDraftSave hook's throw is the host's", async () => {
    const failing: DraftStore = {
      save: () => Promise.reject(new Error(`Saving the draft failed: 503 Service Unavailable https://forms.example.ca/api/drafts/${KEY}`)),
      load: () => Promise.reject(new Error(`Loading the draft failed: 500 Internal Server Error https://forms.example.ca/api/drafts/${KEY}`)),
      list: () => Promise.resolve([]),
      delete: () => Promise.reject(new Error(`Deleting the draft failed: 502 Bad Gateway https://forms.example.ca/api/drafts/${KEY}`))
    };
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store: failing } });
    const save = await setup.refused("drafts", { action: "save" });
    expect(save).toMatchObject({
      code: "draft-failed",
      retryable: false,
      message: "The site did not save the draft.",
      hint: "The site did not save the draft; tell the person. Try once more only if they ask.",
      details: { what: "save", status: 503 }
    });
    const load = await setup.refused("drafts", { action: "restore", replaceAnswers: true });
    expect(load).toMatchObject({ code: "draft-failed", details: { what: "load", status: 500 } });
    const clear = await setup.refused("drafts", { action: "clear" });
    expect(clear).toMatchObject({ code: "draft-failed", details: { what: "delete", status: 502 } });
    for (const result of [save, load, clear]) {
      expectNothingLeaks(result, ["Service Unavailable", "Bad Gateway", "forms.example.ca"]);
    }

    const hooked = agentSetup(TRAVEL_CLAIM_FORM, {
      drafts: {},
      hooks: {
        beforeDraftSave: [
          () => {
            throw new Error("Drafts are closed for maintenance at https://intranet.example/notes");
          }
        ]
      }
    });
    const refused = await hooked.refused("drafts", { action: "save" });
    expect(refused).toMatchObject({ code: "draft-failed", details: { what: "save", by: "host" } });
    expectNothingLeaks(refused, ["maintenance", "intranet"]);
  });

  it("an expectedRevision behind the form is stale before the body: nothing is saved", async () => {
    const store = new InMemoryDraftStore();
    const save = vi.spyOn(store, "save");
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    const described = await setup.ok("describe_form");
    personTypes(setup.runtime, { traveller: "Ana" });
    const stale = await setup.refused("drafts", { action: "save", expectedRevision: described.revision as number });
    expect(stale.code).toBe("stale");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("drafts { restore }", () => {
  it("restores over an empty form: savedAt, the answers counted, the locale, the next sentences; the revision moves", async () => {
    const store = new InMemoryDraftStore();
    await store.save(draftOf({ traveller: "Ana", amount: 40 }));
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    const before = await setup.ok("describe_form");
    const result = await setup.ok("drafts", { action: "restore" });
    expect(result).toMatchObject({ action: "restore", changed: true, store: "page", undoable: false, savedAt: 1_792_530_000_000, answered: 2, locale: "en" });
    expect(result).not.toHaveProperty("page");
    expect(result.next).toEqual(["Call describe_form to see the restored answers before changing any.", "check { scope: 'form' } shows what is still missing."]);
    expect(result.revision as number).toBeGreaterThan(before.revision as number);
    expect(setup.runtime.formValues()).toMatchObject({ traveller: "Ana", amount: 40 });
    expect(setup.host.calls.filter((call) => call.method === "announce").map((call) => call.args[0])).toContain("An assistant restored your saved draft");
    expect(actions(setup).find((detail) => detail.tool === "drafts")).toMatchObject({ consequential: true, changed: true });
    expectNothingLeaks(result);
  });

  it("reports the language the form is in after the restore, not the raw draft's", async () => {
    const store = new InMemoryDraftStore();
    await store.save(draftOf({ traveller: "Ana" }, { locale: "xx-nowhere" }));
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    const restored = await setup.host.drafts?.()?.restore();
    expect(restored?.locale).toBe(setup.runtime.state().locale);
    expect(restored?.locale).not.toBe("xx-nowhere");
    expect((await setup.ok("drafts", { action: "restore" })).locale).toBe(setup.runtime.state().locale);
  });

  it("answers-present counts a person write and an agent write, never a hidden prefill; replaceAnswers: true restores", async () => {
    const store = new InMemoryDraftStore();
    await store.save(draftOf({ traveller: "Bea" }));
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    setup.runtime.setValues({ case_ref: "C-77" });
    // Only the hidden prefill so far: nothing the person or the agent entered.
    const quiet = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    quiet.runtime.setValues({ case_ref: "C-77" });
    expect((await quiet.ok("drafts", { action: "restore" })).action).toBe("restore");

    personTypes(setup.runtime, { traveller: "Ana" });
    await setup.ok("set_answers", { answers: { amount: 12 } });
    const refused = await setup.refused("drafts", { action: "restore" });
    expect(refused).toMatchObject({
      code: "answers-present",
      retryable: false,
      message: "The form already holds 2 answers; nothing was restored.",
      hint: "Restoring replaces the 2 answers on screen and cannot be undone; ask the person, then call again with replaceAnswers: true.",
      details: { answered: 2 }
    });
    expect(setup.runtime.formValues()).toMatchObject({ traveller: "Ana", amount: 12 });
    const restored = await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    expect(restored).toMatchObject({ action: "restore", answered: 1 });
    expect(setup.runtime.formValues().traveller).toBe("Bea");
  });

  it("no-draft, and draft-incompatible for another form or another version, from the DraftError codes", async () => {
    const empty = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    expect(await empty.refused("drafts", { action: "restore" })).toMatchObject({
      code: "no-draft",
      hint: "There is no saved draft to restore; tell the person.",
      details: { store: "page" }
    });
    const other = new InMemoryDraftStore();
    await other.save(draftOf({ traveller: "X" }, { formId: "another-form" }));
    expect(await agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store: other } }).refused("drafts", { action: "restore" })).toMatchObject({
      code: "draft-incompatible",
      hint: "The saved draft cannot be restored into this version of the form; tell the person.",
      details: { reason: "other-form" }
    });
    const older = new InMemoryDraftStore();
    await older.save(draftOf({ traveller: "X" }, { runtime: { schemaVersion: "0.9.0", rendererVersion: "old" } }));
    expect(await agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store: older } }).refused("drafts", { action: "restore" })).toMatchObject({
      code: "draft-incompatible",
      details: { reason: "form-changed" }
    });
  });

  it("a host store's plain errors are read by their old message prefixes", async () => {
    const plain: DraftStore = {
      save: () => Promise.resolve(),
      load: () => Promise.reject(new Error(`Draft not found: ${KEY}`)),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve()
    };
    const result = await agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store: plain } }).refused("drafts", { action: "restore" });
    expect(result).toMatchObject({ code: "no-draft" });
    expectNothingLeaks(result);
  });

  it("field-in-use before a restore while the person types outside a session; nothing is loaded", async () => {
    const store = new InMemoryDraftStore();
    const load = vi.spyOn(store, "load");
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store }, host: { focusedValuePath: () => "traveller" } });
    expect(await setup.refused("drafts", { action: "restore", replaceAnswers: true })).toMatchObject({ code: "field-in-use", details: { path: "traveller" } });
    expect(load).not.toHaveBeenCalled();
  });

  it("after a restore the journal and the last-writer map are empty, and undo_agent_changes answers draft-restored until the agent writes", async () => {
    const store = new InMemoryDraftStore();
    await store.save(draftOf({ traveller: "Bea" }));
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    await setup.ok("set_answers", { answers: { amount: 12 } });
    await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    const answers = await setup.ok("get_answers");
    for (const answer of answers.answers as Row[]) {
      expect(answer).not.toHaveProperty("lastWriter");
    }
    const undo = await setup.refused("undo_agent_changes");
    expect(undo).toMatchObject({ code: "draft-restored", retryable: false, hint: "A saved draft replaced the answers; changes made before it cannot be undone." });
    expect(typeof (undo.details as Row).restoredAt).toBe("number");
    await setup.ok("set_answers", { answers: { amount: 30 } });
    const undone = await setup.ok("undo_agent_changes");
    expect((undone.restored as Row[]).map((entry) => entry.path)).toEqual(["amount"]);
  });

  it("a journey resume runs under the quiet page focus and releases it; the result says where the draft put the person", async () => {
    const store = new InMemoryDraftStore();
    const setup = agentSetup(AGENT_JOURNEY_FORM, { drafts: { store } });
    await setup.ok("set_answers", { answers: { full_name: "Ada" } }).catch(() => undefined);
    const quiet = vi.fn();
    const release = vi.fn();
    setup.host.quietPageFocus = () => {
      quiet();
      return release;
    };
    const page = (await setup.ok("describe_form")).currentPage as Row;
    const saved = await setup.ok("drafts", { action: "save" });
    expect(saved.store).toBe("page");
    const result = await setup.ok("drafts", { action: "restore", replaceAnswers: true });
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.page).toEqual({ id: page.id, title: page.title, number: page.number });
  });
});

describe("drafts { clear }, busy and the autosave note", () => {
  it("clear deletes the saved draft for good and says the form saves a new one", async () => {
    const store = new InMemoryDraftStore();
    await store.save(draftOf({ traveller: "Ana" }));
    const remove = vi.spyOn(store, "delete");
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    const result = await setup.ok("drafts", { action: "clear" });
    expect(remove).toHaveBeenCalledWith(KEY);
    expect(result).toMatchObject({ action: "clear", changed: true, store: "page", undoable: false });
    expect(result.next).toEqual(["Tell the person the saved draft is deleted; the form saves a new one as soon as an answer changes."]);
    expect(await store.list()).toEqual([]);
    expect(setup.host.calls.filter((call) => call.method === "announce").map((call) => call.args[0])).toContain("An assistant deleted your saved draft");
    expectNothingLeaks(result);
  });

  it("busy { submission } during a submission, and busy { draft } while the agent's own timed-out save still runs", async () => {
    const hanging = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {}, hooks: { beforeSubmit: [() => new Promise<void>(() => undefined)] } });
    personTypes(hanging.runtime, { traveller: "Ana", amount: 3 });
    void hanging.runtime.submit("embed", { form: { id: "travel-claim", version: "1.0.0" }, client: { runtimeVersion: "t", rendererVersion: "t", schemaVersion: "1.0.0" } }, {});
    expect(await hanging.refused("drafts", { action: "save" })).toMatchObject({ code: "busy", retryable: true, details: { because: "submission" } });

    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const slow: DraftStore = {
      save: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      load: () => Promise.reject(new Error("unused")),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve()
    };
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store: slow } });
    const first = setup.execute("drafts", { action: "save" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toMatchObject({ ok: false, code: "timeout", retryable: true, details: { afterMs: 15_000, stillRunning: true } });
    expect(await setup.refused("drafts", { action: "clear" })).toMatchObject({ code: "busy", details: { because: "draft" } });
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect((await setup.ok("drafts", { action: "clear" })).action).toBe("clear");
  });

  it("the first write on a site-kept draft carries the autosave note once per target; a browser draft never does", async () => {
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    const first = await setup.ok("set_answers", { answers: { traveller: "Ana" } });
    expect(first.note).toEqual([AUTOSAVE_NOTE]);
    expect(AUTOSAVE_NOTE).toBe("This form saves the answers as a draft on the site as they change.");
    const second = await setup.ok("edit_rows", { collection: "items", action: "add" });
    expect(second).not.toHaveProperty("note");
    const third = await setup.ok("undo_agent_changes", { scope: "last" });
    expect(third.note ?? []).not.toContain(AUTOSAVE_NOTE);

    const rows = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    expect((await rows.ok("edit_rows", { collection: "items", action: "add" })).note).toEqual([AUTOSAVE_NOTE]);

    const browser = agentSetup(TRAVEL_CLAIM_FORM, { drafts: {} });
    const seam = browser.host.drafts?.() as FormAgentDrafts;
    browser.host.drafts = () => ({ ...seam, store: "browser" });
    expect(await browser.ok("set_answers", { answers: { traveller: "Ana" } })).not.toHaveProperty("note");
    expect(await agentSetup(TRAVEL_CLAIM_FORM).ok("set_answers", { answers: { traveller: "Ana" } })).not.toHaveProperty("note");
  });
});

describe("drafts { restore } of a damaged draft", () => {
  it("is draft-incompatible with reason damaged, worded without the store's text, and the form is left as it was", async () => {
    const store = new InMemoryDraftStore();
    const damaged = { ...draftOf({ traveller: "X" }), values: "not-a-record" } as unknown as FormDraft;
    vi.spyOn(store, "load").mockResolvedValue(damaged);
    const setup = agentSetup(TRAVEL_CLAIM_FORM, { drafts: { store } });
    const refused = await setup.refused("drafts", { action: "restore" });
    expect(refused).toMatchObject({
      code: "draft-incompatible",
      message: "The saved draft is damaged and cannot be read; nothing was restored.",
      details: { reason: "damaged" }
    });
    expect(JSON.stringify(refused)).not.toContain("Draft is malformed");
    expect(setup.runtime.formValues().traveller).not.toBe("X");
  });
});
