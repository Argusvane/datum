import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAfterRemoving, localizationWithout } from "../form-engine/agent/builder/documents-support.js";
import type { BuilderController, LeaveGuard } from "../form-engine/builder/controller/builder-controller.js";
import { defaultAfterRemoval, withLanguageRemoved } from "../form-engine/builder/controller/language-edits.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, FormDefinition, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import { AGENT_BUILDER_JOURNEYS } from "./fixtures/agent-builder-definitions.js";
import { documentController, documentsBuilder } from "./fixtures/agent-builder-documents-fakes.js";
import { contactRequestController, contactRequestRoot, okOf, refusalOf, type AgentBuilder } from "./fixtures/agent-builder.js";

/**
 * The `remove_part` tool's body: a
 * language in one history step (its translations are one map, so the form's, the journeys' and
 * the layouts' go together; removing the default language rewrites the designers' strings, so
 * a designer still loading is waited for and one the host turned off is reported `notReached`); a journey
 * or a PDF layout held in the outside journal before it goes, brought back by `restore_removed`,
 * Undo all and the notice's Restore while the page stays open, kept when its id is taken again;
 * the person's state first (their drafts, the document's own designer, Try it on it); and the
 * consequential hint. The language arithmetic is the controller's own.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const JSON_OF = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function removePart(builder: AgentBuilder, input: Record<string, unknown>): ReturnType<AgentBuilder["execute"]> {
  return builder.execute("remove_part", input);
}

/** contact-request with French on two labels (the strings are English; the French is the controller's map). */
function bilingualController(): BuilderController {
  const root: ComponentNode = contactRequestRoot();
  const content = root.children?.content ?? [];
  const label = (index: number): { id: string; label: string } => ({ id: content[index]!.id, label: (content[index]!.configuration as { label: string }).label });
  const [first, second] = [label(0), label(1)];
  const controller = contactRequestController({ root });
  controller.replaceTranslations(
    {
      "fr-CA": {
        components: {
          [first.id]: { label: { text: "Nom complet", source: sourceHash(first.label) } },
          [second.id]: { label: { text: "Courriel", source: sourceHash(second.label) } }
        }
      }
    },
    { silent: true }
  );
  return controller;
}

function guard(id: string): LeaveGuard {
  return { pending: () => true, subject: () => ({ id, label: id, blocked: false }), save: () => true, discard: () => undefined };
}

/** A definition whose journeys hold a name, over `controller`: the designer's block the default-language removal must rewrite. */
function withFrenchJourney(controller: BuilderController): () => FormDefinition {
  const journey: JourneyConfiguration = JSON_OF(AGENT_BUILDER_JOURNEYS);
  return () => ({
    id: "contact-request",
    version: "1.0.0",
    schemaVersion: "1",
    root: controller.snapshot(),
    ...(controller.localization() !== undefined ? { localization: controller.localization() as LocalizationConfiguration } : {}),
    journey
  });
}

describe("remove_part { kind: 'language' }: one history step", () => {
  it("removes the language and every translation in it, one step that history { action: 'undo' } takes back", async () => {
    const set = documentsBuilder({ controller: bilingualController() });
    const controller = set.builder.controller;
    const before = { localization: controller.localization(), root: JSON_OF(controller.snapshot()), translations: controller.translations() };
    const removed = okOf(await removePart(set.builder, { kind: "language", id: "fr-CA" }));
    expect(removed).toMatchObject({
      tool: "remove_part",
      kind: "language",
      id: "fr-CA",
      name: "Français (Canada)",
      changed: true,
      language: { translationsRemoved: 2, nowSingleLanguage: true },
      restorable: "history",
      undo: { steps: 1, ownSteps: 1, canUndo: true },
      next: ["history { action: 'undo' } puts the language and its translations back if the person changes their mind."]
    });
    expect(removed.language).not.toHaveProperty("newDefault");
    expect(removed).not.toHaveProperty("reverse");
    expect(controller.localization()?.supportedLocales).toEqual([{ code: "en", label: "English" }]);
    expect(controller.translations()).toBeUndefined();
    expect(JSON_OF(controller.snapshot())).toEqual(before.root);
    expect(set.stub.callsOf("announce").at(-1)).toEqual(["Assistant removed Français (Canada)"]);
    okOf(await set.builder.execute("history", { action: "undo" }));
    expect(controller.localization()).toEqual(before.localization);
    expect(JSON_OF(controller.snapshot())).toEqual(before.root);
    expect(controller.translations()).toEqual(before.translations);
  });

  it("names the new default when the default language goes", async () => {
    const set = documentsBuilder();
    const removed = okOf(await removePart(set.builder, { kind: "language", id: "en" }));
    expect(removed.language).toEqual({ translationsRemoved: 0, newDefault: "fr-CA", nowSingleLanguage: true });
    expect(set.builder.controller.localization()).toMatchObject({ defaultLocale: "fr-CA", supportedLocales: [{ code: "fr-CA" }] });
  });

  it("refuses a code the form does not declare (case included) with the codes it does", async () => {
    const set = documentsBuilder();
    for (const code of ["de", "fr-ca"]) {
      expect(refusalOf(await removePart(set.builder, { kind: "language", id: code }))).toMatchObject({
        code: "locale-unsupported",
        retryable: false,
        hint: "Use one of the form's language codes; languages { action: 'add' } adds one.",
        details: { locale: code, supported: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français (Canada)" }] }
      });
    }
    expect(set.builder.controller.localization()?.supportedLocales).toHaveLength(2);
  });

  it("answers feature-off with the languages feature off", async () => {
    const set = documentsBuilder({ featureOn: { languages: false } });
    expect(refusalOf(await removePart(set.builder, { kind: "language", id: "fr-CA" }))).toMatchObject({ code: "feature-off", details: { feature: "languages" } });
  });

  it("yields to the Form panel's root draft and the Languages workspace's typed cells, raising no prompt", async () => {
    const set = documentsBuilder({ stub: { languagesPending: 3 } });
    const form = set.builder.controller;
    form.select(form.rootId());
    form.setDraftProperty(form.rootId(), "title", "Draft title");
    expect(refusalOf(await removePart(set.builder, { kind: "language", id: "fr-CA" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "root" } });
    form.discardDraft(form.rootId());
    form.setLeaveGuard(guard("languages-texts"));
    expect(refusalOf(await removePart(set.builder, { kind: "language", id: "fr-CA" }))).toMatchObject({ code: "unsaved-draft", details: { reason: "draft", componentId: "languages-texts", cells: 3 } });
    expect(form.unsavedChangesPrompt()).toBeUndefined();
    expect(form.localization()?.supportedLocales).toHaveLength(2);
  });

  it("does not wait for a designer to remove a language that is not the default: the translations are one map", async () => {
    const controller = contactRequestController();
    const set = documentsBuilder({ controller, host: { definition: withFrenchJourney(controller) } });
    set.page.journeys.designer.state = "loading";
    set.page.pdf.designer.state = "failed";
    const removed = okOf(await removePart(set.builder, { kind: "language", id: "fr-CA" }));
    expect(removed.language).not.toHaveProperty("notReached");
    expect(removed).not.toHaveProperty("warnings");
    expect(controller.localization()?.supportedLocales).toHaveLength(1);
  });

  it("waits for a designer still loading when the default language goes (its strings are rewritten), and goes ahead past one with no block", async () => {
    const controller = contactRequestController();
    const set = documentsBuilder({ controller, host: { definition: withFrenchJourney(controller) } });
    for (const state of ["loading", "failed"] as const) {
      set.page.journeys.designer.state = state;
      expect(refusalOf(await removePart(set.builder, { kind: "language", id: "en" }))).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "journeys", state } });
    }
    expect(controller.localization()?.supportedLocales).toHaveLength(2);
    // The PDF layouts hold no block in this definition: their designer loading holds nothing back.
    set.page.journeys.designer.state = "ready";
    set.page.pdf.designer.state = "loading";
    const removed = okOf(await removePart(set.builder, { kind: "language", id: "en" }));
    expect(removed.language).not.toHaveProperty("notReached");
    expect(removed).not.toHaveProperty("warnings");
  });

  it("reads a designer's state on the page seam itself (a host's adapter getter may read `this`)", async () => {
    const controller = contactRequestController();
    const set = documentsBuilder({ controller, host: { definition: withFrenchJourney(controller) } });
    set.ui.journeys = function (this: unknown) {
      if (this !== set.ui) {
        throw new TypeError("journeys() called off its host");
      }
      return set.page.journeys.side();
    };
    const removed = okOf(await removePart(set.builder, { kind: "language", id: "en" }));
    expect(removed.language).not.toHaveProperty("notReached");
    expect(controller.localization()?.supportedLocales).toHaveLength(1);
  });

  it("removes the default language anyway when the host turned the designer off or hides it, saying which strings were not reached", async () => {
    for (const [setUp, side, words] of [
      [(set: ReturnType<typeof documentsBuilder>) => (set.page.journeys.designer.state = "hidden"), "journeys", "journeys"],
      [(set: ReturnType<typeof documentsBuilder>) => (set.page.journeys.designer.state = "off"), "journeys", "journeys"]
    ] as const) {
      const controller = contactRequestController();
      const set = documentsBuilder({ controller, host: { definition: withFrenchJourney(controller) } });
      setUp(set);
      const removed = okOf(await removePart(set.builder, { kind: "language", id: "en" }));
      expect(removed.language).toMatchObject({ notReached: [side] });
      expect(removed.warnings).toEqual([`outside-not-swapped: the ${words} are not loaded, so their texts keep the old source wording.`]);
      expect(controller.localization()?.supportedLocales).toHaveLength(1);
    }
    const controller = contactRequestController();
    const off = documentsBuilder({ controller, featureOn: { journeys: false }, host: { definition: withFrenchJourney(controller) } });
    expect(okOf(await removePart(off.builder, { kind: "language", id: "en" })).language).toMatchObject({ notReached: ["journeys"] });
  });

  it("states the removal with the controller's own language arithmetic", () => {
    expect(localizationWithout).toBe(withLanguageRemoved);
    expect(defaultAfterRemoving).toBe(defaultAfterRemoval);
    const configs: Array<LocalizationConfiguration | undefined> = [
      { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français (Canada)" }] },
      { supportedLocales: [{ code: "fr" }] },
      { defaultLocale: "es", supportedLocales: [{ code: "es" }] },
      undefined
    ];
    for (const config of configs) {
      for (const code of ["en", "fr-CA", "fr", "es", "x"]) {
        expect(defaultAfterRemoving(config, code), `${JSON.stringify(config)} ${code}`).toEqual(defaultAfterRemoval(config, code));
      }
    }
    // A form that declares languages and no default reads the first as its default: removing it promotes the next.
    expect(defaultAfterRemoval({ supportedLocales: [{ code: "en" }, { code: "fr" }] }, "en")).toBe("fr");
  });
});

describe("remove_part { kind: 'journey' | 'pdf_layout' }: held until the page reloads", () => {
  it("removes a layout, held in the journal first, with restore_removed as the reverse and the new default named", async () => {
    const set = documentsBuilder();
    const before = JSON_OF(set.page.pdf.configuration);
    const removed = okOf(await removePart(set.builder, { kind: "pdf_layout", id: "summary" }));
    expect(removed).toMatchObject({
      kind: "pdf_layout",
      id: "summary",
      name: "Summary",
      changed: true,
      layout: { layoutsLeft: 1, newDefault: "cra-t2125" },
      restorable: "until-reload",
      reverse: { tool: "documents", input: { action: "restore_removed", kind: "pdf_layout", id: "summary" } },
      undo: { steps: 0, journaled: true },
      next: ["Tell the person it is gone; documents { action: 'restore_removed' } brings it back while this page stays open."]
    });
    const [entry] = set.builder.catalogue.shared.memory.outside;
    expect(entry).toMatchObject({ kind: "removed", side: "pdf", id: "summary", index: 0, defaults: { defaultLayoutId: "summary" }, tool: "remove_part" });
    expect(JSON_OF((entry as { json: unknown }).json)).toEqual(before.layouts?.[0]);
    okOf(await set.builder.execute("documents", (removed.reverse as { input: Record<string, unknown> }).input));
    expect(JSON_OF(set.page.pdf.configuration)).toEqual(before);
  });

  it("reports a removed journey's pages and what the form opens as", async () => {
    const set = documentsBuilder();
    const removed = okOf(await removePart(set.builder, { kind: "journey", id: "intake" }));
    expect(removed).toMatchObject({ kind: "journey", name: "Intake", journey: { pages: 2, opensAs: "journey" }, restorable: "until-reload" });
    expect(set.page.journeys.configuration.journeys).toEqual([]);
  });

  it("is brought back by end_session { undo: true } and by the notice's Restore", async () => {
    const set = documentsBuilder();
    const journeys = JSON_OF(set.page.journeys.configuration);
    const pdf = JSON_OF(set.page.pdf.configuration);
    okOf(await set.builder.execute("begin_session", { purpose: "Tidy" }));
    okOf(await removePart(set.builder, { kind: "journey", id: "intake" }));
    okOf(await removePart(set.builder, { kind: "pdf_layout", id: "cra-t2125" }));
    const ended = okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(ended.session).toMatchObject({ undone: 2 });
    expect(JSON_OF(set.page.journeys.configuration)).toEqual(journeys);
    expect(JSON_OF(set.page.pdf.configuration)).toEqual(pdf);

    okOf(await removePart(set.builder, { kind: "pdf_layout", id: "cra-t2125" }));
    const [text, action] = set.stub.callsOf("notice").at(-1) as [string, { label: string; run(): void }];
    expect(text).toBe("Assistant removed CRA T2125");
    expect(action.label).toBe("Restore");
    action.run();
    expect(JSON_OF(set.page.pdf.configuration)).toEqual(pdf);
  });

  it("keeps a document whose id the person took again (id-taken): theirs stays", async () => {
    const set = documentsBuilder();
    okOf(await set.builder.execute("begin_session", { purpose: "Tidy" }));
    okOf(await removePart(set.builder, { kind: "journey", id: "intake" }));
    const theirs = { id: "intake", name: "The person's intake", pages: [{ id: "p", components: ["full_name"] }] };
    set.page.journeys.actions.addJourney(theirs);
    okOf(await set.builder.execute("end_session", { summary: "Done.", undo: true }));
    expect(set.page.journeys.configuration.journeys).toEqual([theirs]);
  });

  it("refuses the person's draft in the document's own designer (example 2), raising no prompt", async () => {
    const set = documentsBuilder({ stub: { mode: "pdf", workspace: "pdf" } });
    const layout = documentController();
    set.page.pdf.designer.openId = "cra-t2125";
    set.page.pdf.state.layoutController = layout;
    layout.select("title");
    layout.setDraftProperty("title", "label", "typed");
    expect(refusalOf(await removePart(set.builder, { kind: "pdf_layout", id: "cra-t2125" }))).toMatchObject({
      code: "unsaved-draft",
      hint: "The person is editing cra-t2125/title; ask them to apply or discard that edit, then call again. Do not retry on your own.",
      details: { reason: "draft", componentId: "cra-t2125/title" }
    });
    expect(layout.unsavedChangesPrompt()).toBeUndefined();
    expect(set.page.pdf.configuration.layouts).toHaveLength(2);
  });

  it("refuses tried-answers while Try it runs on the journey with the person's answers; another part is not held", async () => {
    const set = documentsBuilder({ tryIt: { trying: true, where: { workspace: "journeys", journeyId: "intake" } }, stub: { trying: true } });
    // The tried runtime holds the person's answer and the agent's own (which needs no consent).
    set.page.tryIt?.runtime.replaceValues({ full_name: "Ana", email: "ana@example.org" }, ["full_name", "email"]);
    set.builder.catalogue.shared.memory.tried.set("email", JSON.stringify("ana@example.org"));
    expect(refusalOf(await removePart(set.builder, { kind: "journey", id: "intake" }))).toMatchObject({
      code: "tried-answers",
      details: { byPerson: 1, byAssistant: 1 },
      hint: "The person typed 1 answers in Try it on it; ask them to clear them or leave Try it, then call again."
    });
    expect(set.page.journeys.configuration.journeys).toHaveLength(1);
    okOf(await removePart(set.builder, { kind: "pdf_layout", id: "summary" }));
  });

  it("refuses an unknown id and answers the designer's state as documents does", async () => {
    const set = documentsBuilder();
    expect(refusalOf(await removePart(set.builder, { kind: "journey", id: "nope" }))).toMatchObject({ code: "unknown-document", details: { kind: "journey", id: "nope", known: [{ id: "intake", name: "Intake" }] } });
    set.page.pdf.designer.state = "loading";
    expect(refusalOf(await removePart(set.builder, { kind: "pdf_layout", id: "summary" }))).toMatchObject({ code: "chunk-unavailable", retryable: true, details: { what: "pdf", state: "loading" } });
    set.page.pdf.designer.state = "hidden";
    expect(refusalOf(await removePart(set.builder, { kind: "pdf_layout", id: "summary" }))).toMatchObject({ code: "feature-off", details: { feature: "pdf", hidden: true } });
  });
});

describe("the consequential hint", () => {
  it("is on the tool, and every remove_part action event says consequential", async () => {
    const set = documentsBuilder();
    const tool = set.builder.catalogue.tools.find((entry) => entry.name === "remove_part");
    expect(tool?.annotations).toEqual({ consequentialHint: true, untrustedContentHint: true });
    const before = set.builder.host.calls.length;
    okOf(await removePart(set.builder, { kind: "pdf_layout", id: "cra-t2125" }));
    const action = set.builder.host.calls.slice(before).find((entry) => entry.method === "emit" && entry.args[0] === "datum-agent-action")?.args[1];
    expect(action).toMatchObject({ tool: "remove_part", consequential: true });
  });
});
