import { describe, expect, it } from "vitest";

import type { FormDefinition, ComponentNode } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { InMemoryDraftStore } from "../../form-engine/persistence/local-storage/in-memory-draft-store.js";
import { FormEventType } from "../../form-engine/core/events/event-types.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { parseDraftFile, serializeDraftFile } from "../../form-engine/persistence/file-draft/draft-file.js";
import type { DraftStore, FormDraft } from "../../form-engine/persistence/core/draft-store.js";
import { BrowserLocalDraftStore, type StorageLike } from "../../form-engine/persistence/local-storage/browser-local-draft-store.js";
import { ServerDraftStore, type DraftServerApi } from "../../form-engine/persistence/server/server-draft-store.js";
import { presentationForm } from "../fixtures/presentation-form.js";

function form(): FormDefinition {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [{ id: "name", type: "text", configuration: { required: true } }]
    }
  };
  return { id: "f1", version: "3", schemaVersion: "2", root, localization: { defaultLocale: "en" } };
}

const versionContext = {
  formVersion: "3",
  schemaVersion: "2",
  rendererVersion: "1"
};

function makeRuntime(store: InMemoryDraftStore, hooks = {}): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form(), {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([
      {
        id: "required",
        version: "1.0.0",
        validate: (ctx) =>
          ctx.values.name
            ? { errors: [] }
            : { errors: [{ code: "required", componentId: "name", path: "name", stage: "required", source: "client" }] }
      }
    ]),
    draftStore: store,
    versionContext,
    hooks
  });
}

describe("draft lifecycle integration", () => {
  it("saves a draft that captures version context, runs beforeDraftSave, and emits DRAFT_SAVED", async () => {
    const store = new InMemoryDraftStore();
    const beforeSaveValues: Array<Record<string, unknown>> = [];
    const runtime = makeRuntime(store, {
      beforeDraftSave: [
        (ctx: { values: Record<string, unknown> }) => {
          beforeSaveValues.push({ ...ctx.values });
        }
      ]
    });

    runtime.setValue("name", "Ada");

    const savedEvents: unknown[] = [];
    runtime.events().subscribe(FormEventType.DRAFT_SAVED, (event) => savedEvents.push(event.data));

    const summary = await runtime.saveDraft("d1");

    expect(summary).toMatchObject({ id: "d1", formId: "f1", formVersion: "3", locale: "en" });
    expect(beforeSaveValues).toEqual([{ name: "Ada" }]);
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]).toMatchObject({ draftId: "d1" });
    expect((savedEvents[0] as { latencyMs?: number }).latencyMs).toBeGreaterThanOrEqual(0);

    const persisted = await store.load("d1");
    expect(persisted.values).toEqual({ name: "Ada" });
    expect(persisted.formVersion).toBe("3");
    expect(persisted.runtime).toEqual({ schemaVersion: "2", rendererVersion: "1" });
  });

  it("round-trips through hydrateFromDraft and transiently revalidates on restore", async () => {
    const store = new InMemoryDraftStore();
    const writer = makeRuntime(store);
    writer.setValue("name", "");
    await writer.saveDraft("d2");

    const reader = makeRuntime(store);
    const draft = await store.load("d2");
    await reader.hydrateFromDraft(draft);

    // Restore recomputes validation without an explicit validate() call.
    expect(reader.state().validation.lastValidatedAt).toBeTypeOf("number");
    expect(reader.errors().some((error) => error.code === "required")).toBe(true);
  });

  it("rejects saveDraft without a configured draft store", async () => {
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const runtime = new FormRuntime(form(), {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([])
    });
    await expect(runtime.saveDraft()).rejects.toThrow(/draft store/i);
  });

  it("round-trips full wizard navigation state losslessly", async () => {
    const wizardForm: FormDefinition = {
      id: "f1",
      version: "3",
      schemaVersion: "2",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "s1", type: "step", configuration: {}, children: { content: [] } },
            { id: "s2", type: "step", configuration: {}, children: { content: [] } },
            { id: "s3", type: "step", configuration: {}, children: { content: [] } }
          ]
        }
      }
    };
    const store = new InMemoryDraftStore();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
    const deps = {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([]),
      draftStore: store,
      versionContext
    };

    const writer = new FormRuntime(wizardForm, deps);
    await writer.next(); // -> s1
    await writer.next(); // -> s2 (s1 now visited)
    await writer.saveDraft("wiz");

    const persisted = await store.load("wiz");
    expect(persisted.state.mode).toBe("wizard");
    expect(persisted.state.currentStep).toBe("s2");
    expect(persisted.state.visitedSteps?.sort()).toEqual(["s1", "s2"]);

    const reader = new FormRuntime(wizardForm, deps);
    await reader.hydrateFromDraft(persisted);
    expect(reader.state().navigation.mode).toBe("wizard");
    expect(reader.state().navigation.currentStepId).toBe("s2");
    expect([...reader.state().navigation.visitedSteps].sort()).toEqual(["s1", "s2"]);
  });

  it("blocks hydrate when the draft schema version is incompatible", async () => {
    const store = new InMemoryDraftStore();
    const writer = makeRuntime(store);
    await writer.saveDraft("stale");
    const draft = await store.load("stale");
    (draft.runtime as { schemaVersion: string }).schemaVersion = "1"; // runtime expects "2"

    const reader = makeRuntime(store);
    await expect(reader.hydrateFromDraft(draft)).rejects.toThrow(/incompatible/i);
  });

  it("takes a draft of another form version only when the host's policy lists it", async () => {
    const store = new InMemoryDraftStore();
    const writer = makeRuntime(store);
    await writer.saveDraft("earlier-form");
    const draft = await store.load("earlier-form");
    (draft as { formVersion: string }).formVersion = "0.9.0";

    const readerWith = (allowedFormVersions: string[]): FormRuntime => {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "m", validate: false, sign: false, serverValidation: false });
      return new FormRuntime(form(), {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([]),
        draftStore: store,
        versionContext,
        draftCompatibilityPolicy: { allowedFormVersions }
      });
    };
    await expect(readerWith([versionContext.formVersion]).hydrateFromDraft(draft)).rejects.toThrow(/form version 0\.9\.0/);
    await expect(readerWith(["0.9.0", versionContext.formVersion]).hydrateFromDraft(draft)).resolves.toEqual({ dropped: [] });
  });

  describe("journeys", () => {
    function journeyForm(): FormDefinition {
      const root: ComponentNode = {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "name", type: "text", configuration: { required: true } },
            { id: "email", type: "text", configuration: { required: true } },
            { id: "phone", type: "text", configuration: { required: true } }
          ]
        }
      };
      return {
        id: "f1",
        version: "3",
        schemaVersion: "2",
        root,
        journey: {
          journeys: [
            {
              id: "signup",
              validation: { continue: "page" },
              pages: [
                { id: "who", components: ["name"] },
                { id: "reach", components: ["email"] },
                { id: "call", components: ["phone"] }
              ]
            }
          ]
        }
      };
    }

    function journeyRuntime(store: InMemoryDraftStore, definition: FormDefinition = journeyForm()): FormRuntime {
      const modes = new SubmissionModeRegistry();
      modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
      return new FormRuntime(definition, {
        submissionModes: modes,
        validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
        draftStore: store,
        versionContext
      });
    }

    it("saves the journey's place and resumes on it with no errors showing on that page", async () => {
      const store = new InMemoryDraftStore();
      const writer = journeyRuntime(store);
      writer.setValue("name", "Ada");
      expect((await writer.nextPage()).pageId).toBe("reach");
      await writer.saveDraft("j1");

      const persisted = await store.load("j1");
      // The place, never what a server said about the answers.
      expect(persisted.state.journey).toEqual({ id: "signup", page: "reach", completed: ["who"] });

      const reader = journeyRuntime(store);
      const pages: unknown[] = [];
      reader.events().subscribe(FormEventType.PAGE_CHANGED, (event) => pages.push(event.data));
      await reader.hydrateFromDraft(persisted);
      expect(reader.journeyView()).toMatchObject({ journeyId: "signup", pageId: "reach", completed: ["who"] });
      // The empty email on the page resumed is not complained about before the person acts.
      expect(reader.errors()).toEqual([]);
      expect(pages).toEqual([{ journeyId: "signup", fromPageId: "who", toPageId: "reach", direction: "resume", index: 1, total: 3 }]);
      // And it goes on from there.
      expect((await reader.nextPage()).reason).toBe("validation");
      reader.setValue("email", "ada@example.org");
      expect((await reader.nextPage()).pageId).toBe("call");
    });

    it("revalidates the completed pages, and keeps the page to one the person may reach", async () => {
      const store = new InMemoryDraftStore();
      const writer = journeyRuntime(store);
      writer.setValue("name", "Ada");
      await writer.nextPage();
      await writer.saveDraft("j2");
      const persisted = await store.load("j2");

      // A completed page whose answer has gone shows its error again.
      const emptied = { ...persisted, values: { name: "" } };
      const reader = journeyRuntime(store);
      await reader.hydrateFromDraft(emptied);
      expect(reader.errors().map((error) => error.componentId)).toEqual(["name"]);

      // A page past the furthest one completed is not where the person resumes.
      const ahead = { ...persisted, state: { ...persisted.state, journey: { id: "signup", page: "call", completed: [] } } };
      const clamped = journeyRuntime(store);
      await clamped.hydrateFromDraft(ahead);
      expect(clamped.journeyView()).toMatchObject({ pageId: "who", completed: [] });

      // A draft saved while the form had no journey (one added since) starts the journey over the draft's answers.
      const { journey: _journey, ...pageState } = persisted.state;
      const onePage = journeyRuntime(store);
      onePage.setValue("name", "Grace");
      expect((await onePage.nextPage()).pageId).toBe("reach");
      await onePage.hydrateFromDraft({ ...persisted, state: pageState });
      expect(onePage.journeyView()).toMatchObject({ pageId: "who", completed: [] });
    });

    it("does not revalidate a deferred page on resume: its errors wait for the journey's end", async () => {
      const deferring = journeyForm();
      const signup = deferring.journey?.journeys?.[0];
      if (!signup) {
        throw new Error("fixture has no journey");
      }
      signup.pages[0] = { ...signup.pages[0]!, validation: { continue: "defer" } };
      const store = new InMemoryDraftStore();
      const writer = journeyRuntime(store, deferring);
      // Continue from a deferred page moves on with its question unanswered.
      expect((await writer.nextPage()).pageId).toBe("reach");
      writer.setValue("email", "ada@example.org");
      expect((await writer.nextPage()).pageId).toBe("call");
      await writer.saveDraft("j4");

      const reader = journeyRuntime(store, deferring);
      await reader.hydrateFromDraft(await store.load("j4"));
      expect(reader.journeyView()).toMatchObject({ pageId: "call", completed: ["who", "reach"] });
      expect(reader.errors()).toEqual([]);

      // The same page not deferred is revalidated.
      const strict = journeyRuntime(store);
      await strict.hydrateFromDraft(await store.load("j4"));
      expect(strict.errors().map((error) => error.componentId)).toEqual(["name"]);
    });

    it("round-trips the journey through a draft file, dropping one that is unusable", async () => {
      const store = new InMemoryDraftStore();
      const writer = journeyRuntime(store);
      writer.setValue("name", "Ada");
      await writer.nextPage();
      await writer.saveDraft("j3");
      const persisted = await store.load("j3");

      const parsed = parseDraftFile(serializeDraftFile({ ...persisted, state: { ...persisted.state, journey: { id: "signup", page: "reach", completed: ["who"] } } }));
      expect(parsed.state.journey).toEqual({ id: "signup", page: "reach", completed: ["who"] });

      // A server's verdict an earlier draft file kept is dropped: a draft never vouches for answers.
      const vouching = JSON.parse(serializeDraftFile(persisted)) as { state: Record<string, unknown> };
      vouching.state.journey = { id: "signup", page: "reach", completed: ["who"], clean: { who: "abc" } };
      expect(parseDraftFile(JSON.stringify(vouching)).state.journey).toEqual({ id: "signup", page: "reach", completed: ["who"] });

      const damaged = JSON.parse(serializeDraftFile(persisted)) as { state: Record<string, unknown> };
      damaged.state.journey = { id: "signup", completed: "who" };
      expect(parseDraftFile(JSON.stringify(damaged)).state.journey).toBeUndefined();
    });
  });
});

describe("draft lifecycle: presentations", () => {
  const presentationVersions = { formVersion: "1.0.0", schemaVersion: "1.0.0", rendererVersion: "1" };

  function presentationRuntime(store: DraftStore): FormRuntime {
    const definition = presentationForm();
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "m", validate: true, sign: false, serverValidation: false });
    return new FormRuntime(definition, {
      submissionModes: modes,
      validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
      draftStore: store,
      versionContext: presentationVersions
    });
  }

  /** `localStorage`, as far as a draft store needs it. */
  function memoryStorage(): StorageLike {
    const items = new Map<string, string>();
    return {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
      removeItem: (key) => void items.delete(key)
    };
  }

  /** A server that keeps drafts as the JSON it was sent. */
  function serverApi(): DraftServerApi {
    const drafts = new Map<string, string>();
    return {
      saveDraft: async (draft) => void drafts.set(draft.id, JSON.stringify(draft)),
      loadDraft: async (id) => (drafts.has(id) ? (JSON.parse(drafts.get(id) as string) as FormDraft) : undefined),
      listDrafts: async () => [],
      deleteDraft: async (id) => void drafts.delete(id)
    };
  }

  const stores: Array<[string, () => DraftStore]> = [
    ["in memory", () => new InMemoryDraftStore()],
    ["local storage (JSON)", () => new BrowserLocalDraftStore(memoryStorage())],
    ["a server's store (JSON)", () => new ServerDraftStore(serverApi())]
  ];

  it.each(stores)("round-trips own answers and what the worked-out values wrote: %s", async (_label, makeStore) => {
    const store = makeStore();
    const writer = presentationRuntime(store);
    writer.setValue("email", "ada@example.org");
    writer.setValue("@apply.m1", 20000);
    writer.setValue("@apply.m2", 40000);
    expect((await writer.nextPage()).pageId).toBe("income");
    await writer.saveDraft("p1");

    const persisted = await store.load("p1");
    // The own answers are the person's and stay with the draft; `written` is the journey's note
    // of which field it worked out — no verdict, and no answer of its own.
    expect(persisted.values).toEqual({ email: "ada@example.org", "@apply.m1": 20000, "@apply.m2": 40000, annual_income: 60000 });
    expect(persisted.state.journey).toEqual({ id: "apply", page: "income", completed: ["details"], written: { annual_income: 60000 } });

    const reader = presentationRuntime(store);
    await reader.hydrateFromDraft(persisted);
    expect(reader.journeyView()).toMatchObject({ journeyId: "apply", pageId: "income", path: ["details", "income", "assist"], completed: ["details"] });
    expect(reader.errors()).toEqual([]);
    expect(reader.presentationValues()).toEqual({ m1: 20000, m2: 40000 });
    expect(reader.state().values.annual_income).toBe(60000);
    expect(reader.state().journey?.written).toEqual({ annual_income: 60000 });
    // Resumed, the page goes on working the field out — and, its sources emptied, clears what
    // the journey itself wrote.
    reader.setValue("@apply.m2", 10000);
    expect(reader.state().values.annual_income).toBe(30000);
    expect(reader.journeyView()?.path).toEqual(["details", "income"]);
    reader.setValue("@apply.m1", undefined);
    reader.setValue("@apply.m2", undefined);
    expect(reader.state().values.annual_income).toBeUndefined();
    expect(reader.state().journey?.written).toBeUndefined();
    await reader.saveDraft("p2");
    expect((await store.load("p2")).state.journey).toEqual({ id: "apply", page: "income", completed: ["details"] });
  });

  it.each(stores)("restores what the worked-out values wrote, so a resume whose sources are no longer answered clears the value the page wrote: %s", async (_label, makeStore) => {
    const store = makeStore();
    const writer = presentationRuntime(store);
    writer.setValue("email", "ada@example.org");
    writer.setValue("@apply.m1", 20000);
    writer.setValue("@apply.m2", 40000);
    await writer.nextPage();
    await writer.saveDraft("gone");
    const persisted = await store.load("gone");
    // The own answers are gone by the time it is resumed (a host's hook, a hand-edited file):
    // the page's sources are empty, and the value it holds is the one the page itself wrote.
    const emptied = structuredClone(persisted);
    delete emptied.values["@apply.m1"];
    delete emptied.values["@apply.m2"];
    const reader = presentationRuntime(store);
    await reader.hydrateFromDraft(emptied);
    expect(reader.state().values.annual_income).toBeUndefined();
    expect(reader.state().journey?.written).toBeUndefined();

    // The same through the draft file.
    const file = JSON.parse(serializeDraftFile(persisted)) as { values: Record<string, unknown> };
    delete file.values["@apply.m1"];
    delete file.values["@apply.m2"];
    const fromFile = presentationRuntime(store);
    await fromFile.hydrateFromDraft(parseDraftFile(JSON.stringify(file)));
    expect(fromFile.state().values.annual_income).toBeUndefined();
    expect(fromFile.state().journey?.written).toBeUndefined();
  });

  it("keeps a drafted answer nobody worked out: no `written`, so empty sources clear nothing", async () => {
    const store = new InMemoryDraftStore();
    const writer = presentationRuntime(store);
    writer.setValue("email", "ada@example.org");
    writer.setValue("annual_income", 41000);
    await writer.nextPage();
    await writer.saveDraft("p3");
    const persisted = await store.load("p3");
    expect(persisted.state.journey).toEqual({ id: "apply", page: "income", completed: ["details"] });

    const reader = presentationRuntime(store);
    await reader.hydrateFromDraft(persisted);
    expect(reader.state().values.annual_income).toBe(41000);
    reader.setValue("@apply.m1", "");
    expect(reader.state().values.annual_income).toBe(41000);
    // The same draft with a `written` a client added by hand: it can only make the journey clear
    // a field while its sources are empty — never vouch for an answer.
    const forged = structuredClone(persisted);
    (forged.state.journey as { written?: Record<string, unknown> }).written = { annual_income: 41000 };
    const trusting = presentationRuntime(store);
    await trusting.hydrateFromDraft(forged);
    expect(trusting.state().values.annual_income).toBeUndefined();
    expect(trusting.state().journey?.written).toBeUndefined();
  });

  it("carries `written` through a draft file, and drops one that is not a record", async () => {
    const store = new InMemoryDraftStore();
    const writer = presentationRuntime(store);
    writer.setValue("@apply.m3", 700);
    await writer.saveDraft("p4");
    const persisted = await store.load("p4");
    const file = serializeDraftFile(persisted);
    expect(parseDraftFile(file).state.journey).toEqual({ id: "apply", page: "details", completed: [], written: { annual_income: 700 } });
    expect(parseDraftFile(file).values).toEqual({ "@apply.m3": 700, annual_income: 700 });

    for (const bad of ["yes", ["annual_income"], null, {}]) {
      const damaged = JSON.parse(file) as { state: { journey: Record<string, unknown> } };
      damaged.state.journey.written = bad;
      expect(parseDraftFile(JSON.stringify(damaged)).state.journey, JSON.stringify(bad)).toEqual({ id: "apply", page: "details", completed: [] });
    }
    // A draft handed straight to the runtime with a damaged note resumes all the same.
    const odd = structuredClone(persisted);
    (odd.state.journey as unknown as { written: unknown }).written = "yes";
    const reader = presentationRuntime(store);
    await reader.hydrateFromDraft(odd);
    expect(reader.state().values.annual_income).toBe(700);
    expect(reader.state().journey?.written).toEqual({ annual_income: 700 });
  });
});
