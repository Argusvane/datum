// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import {
  createJourneyBuilderMode,
  loadJourneyDesigner,
  type JourneyBuilderMode,
  type JourneyBuilderModeChangeDetail
} from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import type { BuilderModeContext, BuilderTrySession } from "../form-engine/builder/web-component/builder-modes.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The Journeys mode announces a page's new id: the Tests name pages by id,
 * so an edit that gives a page of a journey another id (its id saved in the
 * inspector, or its node renamed where the node's id is the page's) is followed by an `onChange`
 * with reason `"page-rename"` and `renamed: { journeyId, from, to }`, after the edit's own. A
 * page id is the journey's, never the designer's node id.
 */

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "consent", type: "checkbox", configuration: { label: "I agree" } }
      ]
    }
  };
}

function seed(): JourneyConfiguration {
  return {
    journeys: [
      {
        id: "intake",
        name: "Step by step",
        pages: [
          { id: "about", title: "About you", components: ["fullName"], routes: [{ to: "finish" }] },
          { id: "more", components: ["notes"] },
          { id: "finish", components: ["consent"] }
        ]
      }
    ]
  } as unknown as JourneyConfiguration;
}

function context(): BuilderModeContext {
  return { host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) };
}

async function activated(): Promise<{ mode: JourneyBuilderMode; changes: JourneyBuilderModeChangeDetail[] }> {
  const form = new BuilderController({ initialRoot: formRoot() });
  const changes: JourneyBuilderModeChangeDetail[] = [];
  const mode = createJourneyBuilderMode({ form, journey: seed(), onChange: (detail) => changes.push(detail) });
  await mode.activate?.(context());
  return { mode, changes };
}

function pages(controller: BuilderController): ComponentNode[] {
  return controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
}

const renames = (changes: JourneyBuilderModeChangeDetail[]): unknown[] => changes.filter((change) => change.reason === "page-rename").map((change) => change.renamed);

describe("the Journeys mode announces a page's new id", () => {
  it("after a page id saved: the edit, then page-rename with the journey and both ids", async () => {
    const { mode, changes } = await activated();
    const more = pages(mode.controller)[1]!;
    mode.controller.setProperty(more.id, "pageId", "details");
    expect(changes.map((change) => change.reason)).toEqual(["edit", "page-rename"]);
    expect(changes[1]).toMatchObject({ reason: "page-rename", renamed: { journeyId: "intake", from: "more", to: "details" } });
    // The detail carries the journey as written, like the edit's.
    expect(changes[1]!.journey?.pages.map((page) => page.id)).toEqual(["about", "details", "finish"]);
    expect(changes[1]!.configuration).toEqual(changes[0]!.configuration);
  });

  it("a Save of a drafted id is announced; a draft is not, nor a Save the page-id check refuses", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const [about, more] = pages(controller);
    controller.select(more!.id);
    controller.setDraftProperty(more!.id, "pageId", "extra");
    expect(changes).toEqual([]);
    expect(controller.commitDraft(more!.id)).toBe(true);
    expect(renames(changes)).toEqual([{ journeyId: "intake", from: "more", to: "extra" }]);
    // A clash is refused at Save: nothing written, nothing announced.
    controller.setDraftProperty(more!.id, "pageId", "about");
    controller.requestSelect(about!.id);
    controller.answerUnsavedChangesPrompt("save");
    expect(renames(changes)).toHaveLength(1);
  });

  it("a page node renamed, where the node's id is the page's, is the page renamed", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const more = pages(controller)[1]!;
    // The page goes by its node id once its own id is blanked: that is a rename too.
    controller.setProperty(more.id, "pageId", "");
    expect(renames(changes)).toEqual([{ journeyId: "intake", from: "more", to: more.id }]);
    controller.renameId(more.id, "extra_page");
    expect(renames(changes).at(-1)).toEqual({ journeyId: "intake", from: more.id, to: "extra_page" });
    expect(mode.journey?.pages.map((page) => page.id)).toEqual(["about", "extra_page", "finish"]);
  });

  it("an undo of the id's edit is announced back; a title, a page added or removed is no rename", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const [, more, finish] = pages(controller);
    controller.setProperty(more!.id, "pageId", "details");
    controller.undo();
    expect(renames(changes)).toEqual([
      { journeyId: "intake", from: "more", to: "details" },
      { journeyId: "intake", from: "details", to: "more" }
    ]);
    controller.setProperty(more!.id, "title", "More about you");
    controller.remove(finish!.id);
    expect(renames(changes)).toHaveLength(2);
    expect(changes.length).toBeGreaterThan(2);
  });

  it("leaves the edit's own report as it was: one change for an edit that renames nothing", async () => {
    const { mode, changes } = await activated();
    mode.controller.setProperty(pages(mode.controller)[0]!.id, "title", "About");
    expect(changes.map((change) => change.reason)).toEqual(["edit"]);
    expect(changes[0]!.renamed).toBeUndefined();
  });

  it("a node renamed under a page id of its own changes no page id: nothing announced, and a later id edit still is", async () => {
    const { mode, changes } = await activated();
    const controller = mode.controller;
    const more = pages(controller)[1]!;
    controller.renameId(more.id, "more_node");
    expect(renames(changes)).toEqual([]);
    controller.setProperty("more_node", "pageId", "details");
    expect(renames(changes)).toEqual([{ journeyId: "intake", from: "more", to: "details" }]);
  });
});

describe("the Journeys mode announces a journey's new id", () => {
  it("after a host's replaceJourney under another id: the catalog's change, then journey-rename", async () => {
    const { mode, changes } = await activated();
    const journey = mode.journey!;
    mode.replaceJourney("intake", { ...journey, id: "intake_v2" });
    expect(changes.map((change) => change.reason)).toEqual(["journeys", "journey-rename"]);
    expect(changes[1]!.renamed).toEqual({ journeyId: "intake_v2", from: "intake", to: "intake_v2" });
  });

  it("not for a replace under the same id, nor a new name", async () => {
    const { mode, changes } = await activated();
    mode.replaceJourney("intake", { ...mode.journey!, name: "Other" });
    mode.renameJourney("intake", "Third");
    expect(changes.some((change) => change.reason === "journey-rename")).toBe(false);
  });
});

type RenameEvent = { kind: string; journeyId: string; from: string; to: string };

/** A mode over a real element root, the way the builder's shell hosts one, listening for the shell's channel. */
async function activatedInTree(): Promise<{ mode: JourneyBuilderMode; events: RenameEvent[]; outer: Event[] }> {
  const form = new BuilderController({ initialRoot: formRoot() });
  const outer = document.createElement("div");
  const root = document.createElement("div");
  outer.append(root);
  const events: RenameEvent[] = [];
  const bubbled: Event[] = [];
  root.addEventListener("builder-journey-rename", (event) => events.push((event as CustomEvent<RenameEvent>).detail));
  outer.addEventListener("builder-journey-rename", (event) => bubbled.push(event));
  const mode = createJourneyBuilderMode({ form, journey: seed(), onChange: () => undefined });
  await mode.activate?.({ host: root, root: root as unknown as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
  return { mode, events, outer: bubbled };
}

describe("the Journeys mode tells the shell itself about a rename", () => {
  it("a page id saved dispatches a bubbling, composed event with kind page, the journey and both ids", async () => {
    const { mode, events, outer } = await activatedInTree();
    mode.controller.setProperty(pages(mode.controller)[1]!.id, "pageId", "details");
    expect(events).toEqual([{ kind: "page", journeyId: "intake", from: "more", to: "details" }]);
    expect(outer).toHaveLength(1);
    expect(outer[0]!.bubbles).toBe(true);
    expect(outer[0]!.composed).toBe(true);
  });

  it("a journey given another id dispatches kind journey", async () => {
    const { mode, events } = await activatedInTree();
    mode.replaceJourney("intake", { ...mode.journey!, id: "intake_v2" });
    expect(events).toEqual([{ kind: "journey", journeyId: "intake_v2", from: "intake", to: "intake_v2" }]);
  });

  it("an edit that renames nothing, a draft, and a new name dispatch nothing", async () => {
    const { mode, events } = await activatedInTree();
    mode.controller.setProperty(pages(mode.controller)[0]!.id, "title", "About");
    mode.controller.setDraftProperty(pages(mode.controller)[1]!.id, "pageId", "draft");
    mode.renameJourney("intake", "Third");
    expect(events).toEqual([]);
  });

  it("a journey renamed before the mode was first activated is told when it is, chained renames as one", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    const root = document.createElement("div");
    const events: RenameEvent[] = [];
    root.addEventListener("builder-journey-rename", (event) => events.push((event as CustomEvent<RenameEvent>).detail));
    const mode = createJourneyBuilderMode({ form, journey: seed(), onChange: () => undefined });
    mode.replaceJourney("intake", { ...mode.journey!, id: "intake_v2" });
    mode.replaceJourney("intake_v2", { ...mode.journey!, id: "intake_v3" });
    expect(events).toEqual([]);
    await mode.activate?.({ host: root, root: root as unknown as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    expect(events).toEqual([{ kind: "journey", journeyId: "intake_v3", from: "intake", to: "intake_v3" }]);
    // Told once: a second activation has nothing waiting.
    mode.deactivate?.();
    await mode.activate?.({ host: root, root: root as unknown as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    expect(events).toHaveLength(1);
  });

  it("a rename that no longer holds when the mode activates (renamed back) is not told", async () => {
    const form = new BuilderController({ initialRoot: formRoot() });
    const root = document.createElement("div");
    const events: RenameEvent[] = [];
    root.addEventListener("builder-journey-rename", (event) => events.push((event as CustomEvent<RenameEvent>).detail));
    const mode = createJourneyBuilderMode({ form, journey: seed(), onChange: () => undefined });
    mode.replaceJourney("intake", { ...mode.journey!, id: "intake_v2" });
    mode.replaceJourney("intake_v2", { ...mode.journey!, id: "intake" });
    await mode.activate?.({ host: root, root: root as unknown as ShadowRoot, showCanvasSurface: () => undefined, holdForInspector: (run: () => void) => (run(), true) });
    expect(events).toEqual([]);
  });

  it("the onChange detail keeps its reasons for hosts", async () => {
    const { mode, changes } = await activated();
    mode.controller.setProperty(pages(mode.controller)[1]!.id, "pageId", "details");
    expect(changes.map((change) => change.reason)).toEqual(["edit", "page-rename"]);
  });
});

describe("the Journeys mode's Try session goes to a page by its id", () => {
  async function warmedSession(answers: Record<string, unknown> = {}) {
    const { mode } = await activated();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await (await loadJourneyDesigner()).loadJourneyPreview();
    await Promise.resolve();
    const session = mode.tryIt!.session!(answers) as BuilderTrySession & { pageIdOf?(id: string): string | undefined };
    return { mode, session, runtime: mode.previewRuntime! };
  }

  it("showPage takes the journey's page id to the node the preview runs it under", async () => {
    const { mode, session, runtime } = await warmedSession({ fullName: "Ada" });
    const [about, more, finish] = pages(mode.controller).map((page) => page.id);
    expect(runtime.journeyView()!.pageId).toBe(about);
    expect(runtime.journeyView()!.path).toEqual([about, finish]);
    session.showPage!("finish");
    await vi.waitFor(() => expect(runtime.journeyView()!.pageId).toBe(finish));
    // A page off the path, or an id no page has, goes nowhere.
    session.showPage!("more");
    session.showPage!("nowhere");
    await Promise.resolve();
    expect(runtime.journeyView()!.pageId).toBe(finish);
    void more;
    session.dispose();
  });

  it("pageIdOf reads a node the preview runs a page under back as the journey's page id", async () => {
    const { mode, session } = await warmedSession();
    const [about, more] = pages(mode.controller).map((page) => page.id);
    expect(session.pageIdOf?.(about!)).toBe("about");
    expect(session.pageIdOf?.(more!)).toBe("more");
    expect(session.pageIdOf?.("not-a-node")).toBeUndefined();
    session.dispose();
  });
});
