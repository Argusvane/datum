import { describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import type { JourneyPreviewRuntime, JourneyPreviewRuntimeRequest } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_PREVIEW_LENT as LENT, createJourneyDesigner, indexJourneyForm } from "../form-engine/builder/journey-designer/journey-designer.js";
// The preview is a chunk of its own: its values come from its module, never through the designer's.
import {
  JOURNEY_PREVIEW_LINK_TEXT,
  JOURNEY_PREVIEW_SUBMIT_TEXT,
  createEnginePreviewRuntime,
  createJourneyPreviewSession,
  journeyPreviewPath,
  previewJourney,
  type JourneyPreviewSession,
  type JourneyPreviewSessionOptions,
  type JourneyPreviewSubject
} from "../form-engine/builder/journey-designer/journey-preview.js";
import { JOURNEY_PAGES_SLOT, JOURNEY_ROUTES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { journeyFromTree, treeFromJourney } from "../form-engine/builder/journey-designer/journey-tree.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import type { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";

/**
 * The Journeys designer's preview under Node: the journey it hands the
 * runtime (its pages under their node ids, so a page keeps its place while its id is typed),
 * the words on its bar, the engine's own runtime (field constraints alone, no drafts,
 * no plugins, no server), and the session that keeps the runtime current: live on every edit,
 * rebuilt with the answers on a form change, started over by Restart. Try it runs on
 * the same session: seeded from the canvas's answers, handing back the path's and every form answer, Submit
 * and the checks run the journey's way, and the Journey card it words. The canvas draws it in
 * the packages/datum suite.
 */

const LOCALES: LocalizationConfiguration = {
  defaultLocale: "en",
  supportedLocales: [
    { code: "en", label: "English" },
    { code: "fr", label: "Français" }
  ]
};

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
        {
          id: "contactMethod",
          type: "select",
          configuration: { label: "Contact method", options: [{ value: "mail", label: "Mail" }, { value: "phone", label: "Phone" }] }
        },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } }
      ]
    }
  };
}

const methodIs = (value: string): string => `contactMethod = ${JSON.stringify(value)}`;

/** About you → (phone: Finish) → More → Finish; About you asks the server, which a preview never does. */
function journey(): Journey {
  return {
    id: "intake",
    name: "Step by step",
    pages: [
      {
        id: "about",
        title: "About you",
        components: ["fullName", "contactMethod"],
        routes: [{ when: methodIs("phone"), to: "finish" }],
        validation: { server: true }
      },
      { id: "more", components: ["notes"] },
      { id: "finish", title: "Finish", components: ["consent"] }
    ]
  };
}

interface Setup {
  form: BuilderController;
  controller: BuilderController;
  subject: JourneyPreviewSubject;
  pageIds: Map<string, string>;
  /** The page nodes, in order. */
  nodes(): string[];
}

/** The form's controller and a journey's, set up the way the Journeys mode sets them up. */
function setup(value: Journey = journey()): Setup {
  const form = new BuilderController({ initialRoot: formRoot(), localization: LOCALES, locale: "en" });
  const designer = createJourneyDesigner({ formRoot: () => form.snapshot(), locale: () => form.currentLocale() });
  const pageIds = new Map<string, string>();
  const tree = treeFromJourney(value, { pageIds });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => value.id, tree: () => controller.previewSnapshot(), pageIds });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });
  const subject: JourneyPreviewSubject = { journeyId: value.id, tree: () => controller.previewSnapshot(), pageIds };
  const nodes = (): string[] => (controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? []).map((node) => node.id);
  return { form, controller, subject, pageIds, nodes };
}

/** A session over the setup, refreshed on every change of the journey's controller but a selection — as the mode does. */
function session(
  value: Setup,
  runtime?: (request: JourneyPreviewRuntimeRequest) => JourneyPreviewRuntime,
  more: Partial<JourneyPreviewSessionOptions> = {}
): JourneyPreviewSession {
  const preview = createJourneyPreviewSession({ form: value.form, lent: LENT, ...(runtime ? { runtime } : {}), ...more });
  value.controller.on("change", (event) => {
    if (event.reason !== "select") {
      preview.refresh(value.subject);
    }
  });
  value.form.on("change", (event) => {
    if (event.reason !== "select") {
      preview.formChanged();
    }
  });
  preview.show(value.subject);
  return preview;
}

function runtimeOf(preview: JourneyPreviewSession): FormRuntime {
  expect(preview.runtime).toBeDefined();
  return preview.runtime as unknown as FormRuntime;
}

describe("the journey a preview runs", () => {
  it("names each page by its node, routes to the node of the first page with the target's id, and keeps the rest of the journey", () => {
    const value: Journey = {
      id: "intake",
      name: "Step by step",
      "x-note": "kept",
      pages: [
        { id: "about", components: ["fullName"], routes: [{ when: methodIs("phone"), to: "twin" }, { to: "$end", "x-route": 1 } as never] },
        { id: "twin", components: ["contactMethod"] },
        { id: "twin", components: ["notes"] },
        { id: "last", components: ["consent"], routes: [{ to: "nowhere" }] }
      ]
    } as Journey;
    const pageIds = new Map<string, string>();
    const tree = treeFromJourney(value, { pageIds });
    const nodes = (tree.children?.[JOURNEY_PAGES_SLOT] ?? []).map((node) => node.id);
    const running = previewJourney(LENT, tree, "intake", { pageIds })!;

    expect(running.pages.map((page) => page.id)).toEqual(nodes);
    // Two pages sharing an id stay two pages; a route goes to the first, as the path engine's does.
    expect(running.pages[0]!.routes).toEqual([{ when: methodIs("phone"), to: nodes[1] }, { to: "$end", "x-route": 1 }]);
    // A target no page has stays one.
    expect(running.pages[3]!.routes).toEqual([{ to: "nowhere" }]);
    // Everything else is the journey as written.
    expect((running as unknown as Record<string, unknown>)["x-note"]).toBe("kept");
    expect(running.pages.map((page) => page.components)).toEqual([["fullName"], ["contactMethod"], ["notes"], ["consent"]]);
    // Nothing of the written journey, nor the entry's memory, is changed by it.
    expect(journeyFromTree(tree, "intake", { pageIds: new Map(pageIds) })).toEqual(value);
    expect([...pageIds.values()]).toEqual(["about", "twin", "twin", "last"]);
  });

  it("stays the same journey while a page's id is typed: the page keeps its place", () => {
    const { controller, subject, nodes } = setup();
    const before = JSON.stringify(previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds }));
    controller.select(nodes()[1]!);
    controller.setDraftProperty(nodes()[1]!, "pageId", "more-2");
    expect(JSON.stringify(previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds }))).toBe(before);
    controller.commitDraft(nodes()[1]!);
    expect(JSON.stringify(previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds }))).toBe(before);
    // A route to a page given the id another one had goes where the written journey goes.
    controller.setProperty(nodes()[2]!, "pageId", "more");
    const routed = previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds })!;
    expect(routed.pages.map((page) => page.id)).toEqual(nodes());
  });

  it("keeps a route to a deleted page going nowhere, never to a page whose node id it spells", () => {
    const value: Journey = {
      id: "intake",
      pages: [
        { id: "about", components: ["fullName"], routes: [{ to: "journey-page_2" }] },
        { id: "gone", components: ["notes"] }
      ]
    };
    const pageIds = new Map<string, string>();
    const tree = treeFromJourney(value, { pageIds });
    // The page id "journey-page_2" is no page's, though the second page's node id spells it.
    const running = previewJourney(LENT, tree, "intake", { pageIds })!;
    expect(running.pages.map((page) => page.id)).toEqual(["journey-page_1", "journey-page_2"]);
    expect(running.pages[0]!.routes![0]!.to).not.toBe("journey-page_2");
    expect(running.pages.some((page) => page.id === running.pages[0]!.routes![0]!.to)).toBe(false);
  });

  it("gives nothing for a tree that cannot be written, and says why", () => {
    const { controller, subject, nodes } = setup();
    const route = controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    controller.setProperty(route, "when", 42);
    const onError = vi.fn();
    expect(previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds, onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(nodes()).toHaveLength(3);
  });

  it("says where the preview is: the pages taken, by number and name, then the page's place", () => {
    const { form, subject, nodes } = setup();
    const index = indexJourneyForm(form.snapshot(), "en");
    const [about, more, finish] = nodes();
    expect(journeyPreviewPath(LENT, { path: [about!, more!, finish!], index: 0, kind: "questions", number: 1, total: 3 }, subject.tree(), index, "en")).toBe(
      "1 About you · step 1 of 3"
    );
    // A page with no title is named by its first question.
    expect(journeyPreviewPath(LENT, { path: [about!, more!, finish!], index: 1, kind: "questions", number: 2, total: 3 }, subject.tree(), index, "en")).toBe(
      "1 About you › 2 Notes · step 2 of 3"
    );
    expect(journeyPreviewPath(LENT, { path: [about!, finish!], index: 1, kind: "exit", number: 1, total: 1 }, subject.tree(), index, "en")).toBe(
      "1 About you › 3 Finish · an exit step"
    );
  });

});

describe("the engine's own preview runtime", () => {
  it("runs the journey it is handed, over the form's field constraints alone: no drafts, no plugins, no server", async () => {
    const { form, subject } = setup();
    const generated = previewJourney(LENT, subject.tree(), "intake", { pageIds: subject.pageIds })!;
    const running = { ...generated, validation: { ...generated.validation, continue: "page" as const } };
    const configuration = { journeys: [running], defaultJourneyId: running.id };
    const runtime = createEnginePreviewRuntime({
      journeyConfiguration: () => configuration,
      journeyId: "intake",
      locale: "en",
      root: form.snapshot(),
      localization: form.localization()
    });
    const [about, , finish] = running.pages.map((page) => page.id);
    expect(runtime.journeyView()?.pageId).toBe(about);
    expect(runtime.installedPlugins()).toBeUndefined();
    await expect(runtime.saveDraft()).rejects.toThrow("Draft store is not configured");

    // The field constraints hold Continue: the name is required.
    expect((await runtime.nextPage()).ok).toBe(false);
    runtime.setValue("fullName", "Ada");
    runtime.setValue("contactMethod", "phone");
    // The page asks the server, and a preview asks none: Continue goes on, down the route.
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: finish });
    expect(runtime.journeyView()?.path).toEqual([about, finish]);
  });
});

describe("the preview's session", () => {
  it("starts the journey on the engine's runtime, and follows a route as the answers are given", async () => {
    const value = setup();
    const preview = session(value);
    const runtime = runtimeOf(preview);
    const [about, more, finish] = value.nodes();
    expect(preview.engine).toBe(true);
    expect(preview.visible).toBe(true);
    expect(runtime.journeyView()?.path).toEqual([about, more, finish]);

    runtime.setValue("fullName", "Ada");
    runtime.setValue("contactMethod", "phone");
    expect(runtime.journeyView()?.path).toEqual([about, finish]);
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: finish });
  });

  it("follows the journey as it is edited, drafts included, and keeps the page by its node while its id is typed", async () => {
    const value = setup();
    const preview = session(value);
    const runtime = runtimeOf(preview);
    const [about, more, finish] = value.nodes();
    runtime.setValue("fullName", "Ada");
    runtime.setValue("contactMethod", "mail");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: more });
    const configuration = preview.journeyConfiguration();

    // The step's id typed into the inspector, then saved: the same journey, the same page.
    value.controller.select(more!);
    value.controller.setDraftProperty(more!, "pageId", "m");
    value.controller.setDraftProperty(more!, "pageId", "more-details");
    expect(preview.journeyConfiguration()).toBe(configuration);
    expect(runtime.journeyView()?.pageId).toBe(more);
    value.controller.commitDraft(more!);
    expect(preview.runtime).toBe(runtime);
    expect(runtime.journeyView()?.pageId).toBe(more);
    expect(runtime.journeyView()?.completed).toEqual([about]);
    expect(runtime.state().values.fullName).toBe("Ada");

    // A draft that changes the path is followed as it is typed: a route's condition.
    const route = value.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    value.controller.select(route);
    value.controller.setDraftProperty(route, "when", methodIs("mail"));
    expect(preview.journeyConfiguration()).not.toBe(configuration);
    expect(runtime.journeyView()?.path).toEqual([about, finish]);
    value.controller.discardDraft(route);
    expect(runtime.journeyView()?.path).toEqual([about, more, finish]);

    // Deleting the page the person is on takes them back to the last page before it.
    value.controller.remove(more!);
    expect(runtime.journeyView()?.pageId).toBe(about);
    value.controller.undo();
    expect(runtime.journeyView()?.path).toEqual([about, more, finish]);
  });

  it("keeps the last journey that could run while the tree cannot be written, and says why", () => {
    const value = setup();
    const preview = session(value);
    const configuration = preview.journeyConfiguration();
    const route = value.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    value.controller.setProperty(route, "when", 42);
    expect(preview.problem).toBeTruthy();
    expect(preview.journeyConfiguration()).toBe(configuration);
    expect(runtimeOf(preview).journeyView()).toBeDefined();
    value.controller.undo();
    expect(preview.problem).toBeUndefined();
  });

  it("rebuilds on a new form tree with the answers and the page, switches locale in place, and starts over on Restart", async () => {
    const value = setup();
    const preview = session(value);
    const first = runtimeOf(preview);
    const [about, more] = value.nodes();
    first.setValue("fullName", "Ada");
    first.setValue("contactMethod", "mail");
    await first.nextPage();
    expect(first.journeyView()?.pageId).toBe(more);

    // Another locale is switched to, not rebuilt.
    value.form.setOptions({ locale: "fr" });
    preview.formChanged();
    expect(preview.runtime).toBe(first);
    expect(first.state().locale).toBe("fr");

    // A new form tree: a new runtime, the answers replayed, the person where they were.
    value.form.setProperty("notes", "label", "Anything else");
    const second = runtimeOf(preview);
    expect(second).not.toBe(first);
    expect(second.state().values).toMatchObject({ fullName: "Ada", contactMethod: "mail" });
    expect(second.state().locale).toBe("fr");
    expect(second.journeyView()?.pageId).toBe(more);
    expect(second.formRoot().children!.content![2]!.configuration).toMatchObject({ label: "Anything else" });

    preview.restart();
    const third = runtimeOf(preview);
    expect(third).not.toBe(second);
    expect(third.state().values.fullName).toBeUndefined();
    expect(third.journeyView()?.pageId).toBe(about);
  });

  it("only notes what changes while it is off the page, and catches up when shown again", () => {
    const value = setup();
    const preview = session(value);
    const runtime = runtimeOf(preview);
    const [about, more] = value.nodes();
    preview.hide();
    value.controller.setProperty(about!, "title", "Who you are");
    expect(runtime.journeyView()?.page.title).toBe("About you");
    value.form.setProperty("notes", "label", "Anything else");
    expect(preview.runtime).toBe(runtime);

    preview.show(value.subject);
    const caught = runtimeOf(preview);
    expect(caught).not.toBe(runtime);
    expect(caught.journeyView()?.page.title).toBe("Who you are");
    expect(caught.journeyView()?.path.slice(0, 2)).toEqual([about, more]);
  });

  it("runs on the host's runtime when there is one, asked for with the journey, the locale and the form", () => {
    const value = setup();
    const requests: JourneyPreviewRuntimeRequest[] = [];
    const preview = session(value, (request) => {
      requests.push(request);
      return createEnginePreviewRuntime(request) as unknown as JourneyPreviewRuntime;
    });
    expect(preview.engine).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ journeyId: "intake", locale: "en", localization: LOCALES });
    expect(requests[0]!.root).toEqual(value.form.snapshot());
    expect(requests[0]!.journeyConfiguration()).toBe(preview.journeyConfiguration());

    // Another journey on the preview: a new runtime, the answers carried over.
    runtimeOf(preview).setValue("fullName", "Ada");
    const other = setup({ id: "short", pages: [{ id: "only", components: ["fullName", "notes"] }] });
    preview.show({ ...other.subject, tree: other.subject.tree });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.journeyId).toBe("short");
    expect(runtimeOf(preview).state().values.fullName).toBe("Ada");
    expect(runtimeOf(preview).journeyView()?.journeyId).toBe("short");
  });
});

describe("the session Try it runs", () => {
  /** The journey with its checks deferred to the end, so Continue leaves the required name unanswered. */
  const deferred = (): Journey => ({ ...journey(), validation: { continue: "defer" } });
  const withIndex = (value: Setup): Partial<JourneyPreviewSessionOptions> => ({ formIndex: () => indexJourneyForm(value.form.snapshot(), "en") });

  it("replays only the answers typed into the canvas's store, and carries only typed answers into a rebuild", () => {
    const value = setup();
    // The notes were worked out (a default, a calculation), not typed: they are not an answer tried.
    const preview = session(value, undefined, { seed: { fullName: "Ada", notes: "Worked out" }, typed: new Set(["fullName"]) });
    const runtime = runtimeOf(preview);
    expect(runtime.state().values.fullName).toBe("Ada");
    expect(runtime.state().values.notes).toBeUndefined();
    expect([...runtime.state().dirty]).toEqual(["fullName"]);
    // A new form tree rebuilds the runtime with what was typed in this one.
    runtime.setValue("contactMethod", "mail");
    value.form.setProperty("notes", "label", "Anything else");
    const rebuilt = runtimeOf(preview);
    expect(rebuilt).not.toBe(runtime);
    expect(rebuilt.state().values).toMatchObject({ fullName: "Ada", contactMethod: "mail" });
    expect([...rebuilt.state().dirty].sort()).toEqual(["contactMethod", "fullName"]);
  });

  it("starts from the canvas's answers once, a journey's own only to itself, and hands back the path's answers", () => {
    const value = setup();
    const preview = session(value, undefined, { seed: { fullName: "Ada", contactMethod: "phone", notes: "Off the path", "@intake.x": 1, "@other.y": 2 } });
    const runtime = runtimeOf(preview);
    const [about, , finish] = value.nodes();
    expect(runtime.state().values).toMatchObject({ fullName: "Ada", contactMethod: "phone", notes: "Off the path" });
    expect(runtime.state().values["@other.y"]).toBeUndefined();
    expect(runtime.journeyView()?.path).toEqual([about, finish]);
    // What a submission on this path carries: the notes asked on the skipped page are left out.
    expect(preview.answers()).toMatchObject({ fullName: "Ada", contactMethod: "phone" });
    expect(preview.answers()).not.toHaveProperty("notes");
    // Restart starts with none: the seed is spent.
    preview.restart();
    expect(runtimeOf(preview).state().values.fullName).toBeUndefined();
    expect(preview.answers()).toEqual({});
  });

  it("takes a Submit held back by an answer on an earlier step to that page, and words the problem for the Try panel", async () => {
    const value = setup(deferred());
    const preview = session(value, undefined, withIndex(value));
    const runtime = runtimeOf(preview);
    const [about, more] = value.nodes();
    runtime.setValue("contactMethod", "mail");
    expect(await runtime.nextPage()).toMatchObject({ ok: true, pageId: more });

    const outcome = await preview.submit();
    expect(outcome.problems).toEqual([{ componentId: "fullName", label: "Full name", message: expect.any(String) }]);
    expect(outcome.problems[0]!.message).not.toBe("");
    expect(runtime.journeyView()?.pageId).toBe(about);
    expect(preview.card()).toContain("Not submitted: an answer needs attention.");
  });

  it("takes a Submit to the earliest page with a problem, whatever order the problems come in", async () => {
    // The notes page comes first, yet the form lists the name before the notes: the name's
    // problem comes first, on the later page.
    const value = setup({
      id: "intake",
      validation: { continue: "defer" },
      pages: [
        { id: "early", title: "Early", components: ["notes"] },
        { id: "late", title: "Late", components: ["fullName"] },
        { id: "last", title: "Last", components: ["consent"] }
      ]
    });
    value.form.setProperty("notes", "required", true);
    const preview = session(value, undefined, withIndex(value));
    const runtime = runtimeOf(preview);
    const [early, late, last] = value.nodes();
    await runtime.nextPage();
    await runtime.nextPage();
    expect(runtime.journeyView()?.pageId).toBe(last);

    const outcome = await preview.submit();
    expect(outcome.problems.map((problem) => problem.componentId)).toEqual(["fullName", "notes"]);
    expect(runtime.journeyView()?.pageId).toBe(early);
    expect(runtime.journeyView()?.pageId).not.toBe(late);
    expect(preview.card()).toContain("Not submitted: 2 answers need attention.");
  });

  it("checks read-only: the person's runtime keeps its errors, and only the pages taken so far are listed", async () => {
    const value = setup(deferred());
    value.form.setProperty("consent", "required", true);
    const preview = session(value, undefined, withIndex(value));
    const runtime = runtimeOf(preview);
    const [, more] = value.nodes();
    runtime.setValue("contactMethod", "mail");
    await runtime.nextPage();
    expect(runtime.journeyView()?.pageId).toBe(more);
    const before = runtime.errors();
    const validated = runtime.state().validation;

    // The consent on Finish, not reached yet, is not on the path so far.
    const problems = await preview.check();
    expect(problems.map((problem) => problem.componentId)).toEqual(["fullName"]);
    expect(runtime.errors()).toEqual(before);
    expect(runtime.state().validation).toEqual(validated);
    expect(runtime.journeyView()?.pageId).toBe(more);
    expect(preview.runtime).toBe(runtime);
  });

  it("checks without moving, and a clean path submits with nothing held back", async () => {
    const value = setup(deferred());
    const preview = session(value, undefined, withIndex(value));
    const runtime = runtimeOf(preview);
    const [about, more] = value.nodes();
    runtime.setValue("contactMethod", "mail");
    await runtime.nextPage();

    const problems = await preview.check();
    expect(problems.map((problem) => problem.componentId)).toEqual(["fullName"]);
    expect(runtime.journeyView()?.pageId).toBe(more);
    expect(preview.card()).not.toContain("Not submitted");

    runtime.setValue("fullName", "Ada");
    expect(await preview.check()).toEqual([]);
    expect(await preview.submit()).toEqual({ problems: [] });
    expect(preview.card()).toContain(JOURNEY_PREVIEW_SUBMIT_TEXT);
    // What was said goes once the person moves on.
    await runtime.previousPage();
    expect(runtime.journeyView()?.pageId).toBe(about);
    expect(preview.card()).not.toContain(JOURNEY_PREVIEW_SUBMIT_TEXT);
  });

  it("words the Journey card: the path, Restart and Open this step as the mode's actions, a link held, a journey that cannot run", () => {
    const value = setup();
    const preview = session(value, undefined, withIndex(value));
    const card = (): HTMLElementLike => parseCard(preview.card());
    expect(card().attributes).toEqual(expect.arrayContaining(["data-try-journey", "data-journey-try-session"]));
    expect(card().text("data-try-journey-path")).toBe("1 About you · step 1 of 3");
    expect(preview.card()).toMatch(/data-try-mode-action="restart" data-try-journey-restart/);
    expect(preview.card()).toMatch(/data-try-mode-action="open-step" data-try-journey-show/);
    // Over the engine's own runtime the card says what it does not check.
    expect(preview.card()).toContain("Host validators are off");

    // The notice line is always there, a polite live region, empty until something is said.
    expect(preview.card()).toMatch(/<p class="try-note" data-try-journey-notice role="status" aria-live="polite"><\/p>/);
    preview.linkHeld();
    expect(card().text("data-try-journey-notice")).toBe(JOURNEY_PREVIEW_LINK_TEXT);

    const route = value.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    value.controller.setProperty(route, "when", 42);
    expect(card().text("data-try-journey-problem")).toMatch(/^This journey cannot run as it stands \(.+\); Try it runs the last version that could\.$/);
  });

  it("says a journey that never could run could not start, rather than running a last version", () => {
    const value = setup();
    const route = value.controller.snapshot().children![JOURNEY_PAGES_SLOT]![0]!.children![JOURNEY_ROUTES_SLOT]![0]!.id;
    value.controller.setProperty(route, "when", 42);
    const preview = session(value, undefined, withIndex(value));
    const problem = parseCard(preview.card()).text("data-try-journey-problem") ?? "";
    expect(problem).toMatch(/^The journey could not start: .+/);
    expect(problem).not.toContain("last version");
  });

  it("names a page the tree no longer holds by the page id it was written as, never by its node id", () => {
    const { form, subject } = setup();
    const index = indexJourneyForm(form.snapshot(), "en");
    const view = { path: ["node-gone"], index: 0, kind: "questions" as const, number: 1, total: 1 };
    expect(journeyPreviewPath(LENT, view, subject.tree(), index, "en", undefined, new Map([["node-gone", "old-page"]]))).toBe("old-page · step 1 of 1");
    expect(journeyPreviewPath(LENT, view, subject.tree(), index, "en")).toBe("a step no longer in the journey · step 1 of 1");
  });

  it("names a problem on a node of the journey's own by its label, never by its node id", async () => {
    const value = setup();
    const [about] = value.nodes();
    // A host's runtime reporting a problem on a node the form does not have (a page-only field's).
    const preview = session(
      value,
      (request) => {
        const runtime = createEnginePreviewRuntime(request);
        runtime.validate = async () => [{ id: "e1", code: "required", componentId: about!, stage: "field", source: "client", severity: "error" }];
        return runtime as unknown as JourneyPreviewRuntime;
      },
      withIndex(value)
    );
    const { problems } = await preview.submit();
    expect(problems).toHaveLength(1);
    expect(problems[0]!.label).not.toContain(about!);
    expect(problems[0]!.label).toBe("A field of this journey");
  });
});

interface HTMLElementLike {
  attributes: string[];
  text(attribute: string): string | undefined;
}

/** The card's markup read without a DOM: its section's attributes, and the text of the element carrying an attribute. */
function parseCard(html: string): HTMLElementLike {
  const section = /<section([^>]*)>/.exec(html)?.[1] ?? "";
  return {
    attributes: [...section.matchAll(/\s([a-z-]+)(?:="[^"]*")?/g)].map((match) => match[1]!),
    text: (attribute) => new RegExp(`<[a-z0-9]+[^>]*\\s${attribute}(?:="[^"]*")?(?:\\s[^>]*)?>([^<]*)<`).exec(html)?.[1]
  };
}
