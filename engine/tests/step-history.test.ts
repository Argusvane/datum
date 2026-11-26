import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode, type JourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_FIELD_TYPE, JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { CONTROLLER_MARKS, createStepHistory, type StepHistory } from "../form-engine/builder/journey-designer/step-history.js";
import { logicJourneyHostOf } from "../form-engine/builder/logic/logic-journey-host.js";
import type { BuilderModeContext } from "../form-engine/builder/web-component/builder-modes.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import type { JourneyConfiguration } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * The journeys Step view's one Undo, over the
 * real Journeys mode's two controllers: the form's and the shown journey's. The mode's own form
 * listener (registered as the mode is built, before any step history) follows a form rename
 * into every journey, which is what the history must undo consistently.
 */

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        { id: "email", type: "text", configuration: { label: "Email" } },
        { id: "notes", type: "text", configuration: { label: "Notes" } },
        { id: "submit", type: "button", configuration: { label: "Send" } }
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
          { id: "about", title: "About you", components: ["fullName", "email"] },
          { id: "finish", components: ["email", "notes", "submit"] }
        ]
      }
    ]
  } as unknown as JourneyConfiguration;
}

function context(): BuilderModeContext {
  return { host: {} as HTMLElement, root: {} as ShadowRoot, showCanvasSurface: () => undefined };
}

interface Rig {
  form: BuilderController;
  mode: JourneyBuilderMode;
  journey: BuilderController;
  history: StepHistory;
  pageNode(pageId: string): ComponentNode;
  content(pageId: string): ComponentNode[];
  /** Every placement's form id on the shown journey's tree. */
  treeRefs(): string[];
  /** Every page's components in the journey the mode writes (the catalog). */
  writtenRefs(): string[];
  label(id: string): string | undefined;
  formIds(): string[];
  /** Places a form field on a step, as a drop from the Form fields panel does: one journey step. */
  place(pageId: string, componentId: string): void;
  placed(pageId: string, componentId: string): boolean;
}

async function rig(): Promise<Rig> {
  const form = new BuilderController({ initialRoot: formRoot() });
  const mode = createJourneyBuilderMode({ form, journey: seed() });
  await mode.activate?.(context());
  const journey = mode.controller;
  // Made as the Step view makes it (step-view.ts): after the mode's own listeners, the journey's steps first.
  const history = createStepHistory([form, journey], CONTROLLER_MARKS, { first: journey });
  const pages = (): ComponentNode[] => journey.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
  const pageNode = (pageId: string): ComponentNode => pages().find((node) => (node.configuration as { pageId?: string }).pageId === pageId)!;
  const content = (pageId: string): ComponentNode[] => pageNode(pageId).children?.[JOURNEY_CONTENT_SLOT] ?? [];
  const treeRefs = (): string[] =>
    pages()
      .flatMap((page) => page.children?.[JOURNEY_CONTENT_SLOT] ?? [])
      .filter((node) => node.type === JOURNEY_FIELD_TYPE)
      .map((node) => (node.configuration as { componentId: string }).componentId);
  const writtenRefs = (): string[] => (mode.journey?.pages ?? []).flatMap((page) => (page.components ?? []).filter((entry): entry is string => typeof entry === "string"));
  const label = (id: string): string | undefined =>
    (form.snapshot().children?.content?.find((node) => node.id === id)?.configuration as { label?: string } | undefined)?.label;
  const formIds = (): string[] => (form.snapshot().children?.content ?? []).map((node) => node.id);
  const place = (pageId: string, componentId: string): void => {
    journey.add(JOURNEY_FIELD_TYPE, pageNode(pageId).id, JOURNEY_CONTENT_SLOT, { configuration: { componentId } });
    expect(journey.dropError).toBeUndefined();
  };
  const placed = (pageId: string, componentId: string): boolean =>
    content(pageId).some((node) => node.type === JOURNEY_FIELD_TYPE && (node.configuration as { componentId?: string }).componentId === componentId);
  return { form, mode, journey, history, pageNode, content, treeRefs, writtenRefs, label, formIds, place, placed };
}

const turn = (): Promise<void> => Promise.resolve();

/** Every placement on the journey, in its tree and as written, names a field the form has. */
function consistent(s: Rig): void {
  const ids = new Set(s.formIds());
  expect(s.treeRefs().filter((id) => !ids.has(id))).toEqual([]);
  expect(s.writtenRefs().filter((id) => !ids.has(id))).toEqual([]);
}

describe("the Step view's one history", () => {
  it("takes back the last change, whichever controller holds it: a drop, an applied label, a move; and makes them again", async () => {
    const s = await rig();
    const order = s.content("about").map((node) => node.id);
    // (b) a journey-only field dropped on the step.
    s.place("about", "notes");
    await turn();
    // (a) the inspector's draft path: keystrokes are no steps, the Apply is one.
    s.form.setDraftProperty("email", "label", "Em");
    s.form.setDraftProperty("email", "label", "Email address");
    await turn();
    expect(s.history.entries()).toEqual([[s.journey]]);
    expect(s.form.commitDraft("email")).toBe(true);
    await turn();
    // (c) a move within the step.
    s.journey.moveBy(order[0]!, 1);
    await turn();
    expect(s.history.entries()).toEqual([[s.journey], [s.form], [s.journey]]);
    expect(s.history.canUndo()).toBe(true);
    expect(s.history.canRedo()).toBe(false);

    expect(s.history.undo()).toBe(true); // (c)
    expect(s.content("about").slice(0, order.length).map((node) => node.id)).toEqual(order);
    expect(s.label("email")).toBe("Email address");
    expect(s.history.undo()).toBe(true); // (a), on the form, although the canvas is the journey's
    expect(s.label("email")).toBe("Email");
    expect(s.content("about")).toHaveLength(order.length + 1);
    expect(s.history.undo()).toBe(true); // (b)
    expect(s.content("about")).toHaveLength(order.length);
    expect(s.history.undo()).toBe(false);
    expect(s.history.canUndo()).toBe(false);
    expect(s.history.canRedo()).toBe(true);

    expect(s.history.redo()).toBe(true); // (b)
    expect(s.content("about")).toHaveLength(order.length + 1);
    expect(s.history.redo()).toBe(true); // (a)
    expect(s.label("email")).toBe("Email address");
    expect(s.history.redo()).toBe(true); // (c)
    expect(s.content("about").slice(0, 2).map((node) => node.id)).toEqual([order[1], order[0]]);
    expect(s.history.redo()).toBe(false);
    s.history.dispose();
  });

  it("drops an entry whose controller's history moved on outside it, never undoing it blind", async () => {
    const s = await rig();
    const before = s.content("about").length;
    s.place("about", "notes");
    await turn();
    s.form.setDraftProperty("email", "label", "Email address");
    s.form.commitDraft("email");
    await turn();
    expect(s.history.entries()).toEqual([[s.journey], [s.form]]);
    // The form's own Undo, not the history's (another workspace's bar): the form entry is stale.
    s.form.undo();
    expect(s.label("email")).toBe("Email");
    expect(s.history.undo()).toBe(true);
    expect(s.content("about")).toHaveLength(before);
    expect(s.label("email")).toBe("Email");
    // Nothing of its own left: the shell falls back to the journey's own Undo.
    expect(s.history.canUndo()).toBe(false);
    expect(s.history.undo()).toBe(false);
    s.history.dispose();
  });

  it("a rename made from the Step view: one Undo and the journey reads the form's ids again; one Redo, likewise", async () => {
    const s = await rig();
    // A journey step before the rename, which the rename's entry must not strand.
    s.place("about", "notes");
    await turn();
    s.form.setDraftId("email", "emailAddress");
    expect(s.form.commitDraft("email")).toBe(true);
    await turn();
    expect(s.treeRefs().filter((id) => id.startsWith("email"))).toEqual(["emailAddress", "emailAddress"]);
    consistent(s);
    // One entry, the rename's: the journeys' follow-up is no entry of the tree's.
    expect(s.history.entries()).toEqual([[s.journey], [s.form]]);

    expect(s.history.undo()).toBe(true);
    expect(s.formIds()).toContain("email");
    expect(s.treeRefs().filter((id) => id.startsWith("email"))).toEqual(["email", "email"]);
    consistent(s);

    expect(s.history.redo()).toBe(true);
    expect(s.formIds()).toContain("emailAddress");
    expect(s.treeRefs().filter((id) => id.startsWith("email"))).toEqual(["emailAddress", "emailAddress"]);
    consistent(s);

    // And back again; then the journey step made before the rename is still the history's to take back.
    expect(s.history.undo()).toBe(true);
    consistent(s);
    expect(s.placed("about", "notes")).toBe(true);
    expect(s.history.undo()).toBe(true);
    expect(s.placed("about", "notes")).toBe(false);
    consistent(s);
    expect(s.history.canUndo()).toBe(false);
    s.history.dispose();
  });

  it("an Undo with a form draft open takes back the newest applied step and leaves the draft open (as in the Form workspace)", async () => {
    const s = await rig();
    const before = s.content("about").length;
    s.place("about", "notes");
    await turn();
    s.form.setDraftProperty("email", "label", "Em");
    expect(s.history.entries()).toEqual([[s.journey]]);
    expect(s.history.undo()).toBe(true);
    expect(s.content("about")).toHaveLength(before);
    // The draft is no step: still open, still the author's to apply or discard.
    expect(s.form.hasPendingChanges("email")).toBe(true);
    expect((s.form.editedNode("email")?.configuration as { label?: string }).label).toBe("Em");
    expect(s.label("email")).toBe("Email");
    // Applied afterwards, it is a step like any other.
    expect(s.form.commitDraft("email")).toBe(true);
    await turn();
    expect(s.history.canRedo()).toBe(false);
    expect(s.history.undo()).toBe(true);
    expect(s.label("email")).toBe("Email");
    s.history.dispose();
  });

  it("steps one controller's own top step through it (the agent's tools): its entry whole, a newer entry on the other controller left where it is", async () => {
    const s = await rig();
    s.form.setDraftId("email", "emailAddress");
    s.form.commitDraft("email");
    await turn();
    s.place("finish", "notes");
    await turn();
    expect(s.history.entries()).toEqual([[s.form], [s.journey]]);
    // The rename's entry is the form's alone (the journeys' follow-up is no entry of the tree's),
    // so it is whole under the newer drop: taken out of turn, the drop left where it is, and the
    // journey follows the id back.
    expect(s.history.stepOn(s.form, "undo")).toBe(true);
    expect(s.formIds()).toContain("email");
    expect(s.placed("finish", "notes")).toBe(true);
    consistent(s);
    expect(s.history.stepOn(s.form, "redo")).toBe(true);
    expect(s.formIds()).toContain("emailAddress");
    consistent(s);
    // A plain form step under a newer journey one: taken out of turn, the journey's left.
    s.place("finish", "fullName");
    await turn();
    s.form.setDraftProperty("notes", "label", "Anything else");
    s.form.commitDraft("notes");
    await turn();
    s.place("finish", "submit");
    await turn();
    expect(s.history.stepOn(s.form, "undo")).toBe(true);
    expect(s.label("notes")).toBe("Notes");
    expect((s.content("finish").filter((node) => (node.configuration as { componentId?: string }).componentId === "submit").length === 2)).toBe(true);
    // A controller it does not hold, or one with nothing of its own: false.
    expect(s.history.stepOn(new BuilderController({ initialRoot: formRoot() }), "undo")).toBe(false);
    s.history.dispose();
  });

  it("tells its listeners when what it can undo or redo may have moved, and stops once disposed", async () => {
    const s = await rig();
    let heard = 0;
    const off = s.history.subscribe(() => (heard += 1));
    s.form.setDraftProperty("email", "label", "Em");
    s.form.commitDraft("email");
    await turn();
    expect(heard).toBeGreaterThan(0);
    const at = heard;
    s.history.undo();
    expect(heard).toBeGreaterThan(at);
    off();
    const after = heard;
    s.history.redo();
    expect(heard).toBe(after);
    s.history.dispose();
    expect(s.history.canUndo()).toBe(false);
    expect(s.history.undo()).toBe(false);
    s.form.setDraftProperty("email", "label", "E");
    s.form.commitDraft("email");
    await turn();
    expect(s.history.entries()).toEqual([]);
  });
});

/**
 * The same history as the Step view in the mode brings it up (`mode.view = "step"`,
 * `mode.history()`), over an entry whose form step carries the journeys' block: a step deleted
 * on a translated form (the mode prunes its entries in one form step) and a Logic Go to rule
 * written while the Step view is up (the rule's block recorded on the form). Taking the form's
 * step back first would put the block back ahead of the journey's tree and build the designer
 * again in the middle of the Undo: the Step view's history and the journey's own both gone.
 */
describe("the Step view's history over a form step that carries the journeys' block", () => {
  function threeSteps(): JourneyConfiguration {
    return {
      journeys: [
        {
          id: "intake",
          name: "Step by step",
          pages: [
            { id: "about", title: "About you", components: ["fullName"] },
            { id: "more", title: "More", components: ["notes"] },
            { id: "finish", components: ["email", "submit"] }
          ]
        }
      ]
    } as unknown as JourneyConfiguration;
  }

  async function stepRig(options: { translated?: boolean } = {}) {
    const form = new BuilderController({ initialRoot: formRoot() });
    if (options.translated) {
      form.replaceTranslations({ fr: { journeys: { intake: { pages: { more: { title: { text: "Plus", source: sourceHash("More") } } } } } } } as never, { silent: true });
    }
    const mode = createJourneyBuilderMode({ form, journey: threeSteps() });
    await mode.activate?.(context());
    mode.view = "step";
    const journey = mode.controller;
    const history = mode.history?.() as StepHistory | undefined;
    expect(history).toBeDefined();
    const pages = (): ComponentNode[] => journey.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
    const pageNode = (pageId: string): ComponentNode | undefined => pages().find((node) => (node.configuration as { pageId?: string }).pageId === pageId);
    const content = (pageId: string): ComponentNode[] => pageNode(pageId)?.children?.[JOURNEY_CONTENT_SLOT] ?? [];
    return { form, mode, journey, history: history!, pages, pageNode, content };
  }

  for (const translated of [false, true]) {
    it(`a step deleted after a drop${translated ? " on a translated form" : ""}: two Undos take both back, two Redos make both again, the history kept throughout`, async () => {
      const s = await stepRig({ translated });
      const journeyBefore = s.journey;
      s.journey.add(JOURNEY_FIELD_TYPE, s.pageNode("about")!.id, JOURNEY_CONTENT_SLOT, { configuration: { componentId: "email" } });
      await turn();
      expect(s.content("about")).toHaveLength(2);
      s.journey.remove(s.pageNode("more")!.id);
      await turn();
      expect(s.pages()).toHaveLength(2);
      expect(s.history.entries()).toEqual(translated ? [[s.journey], [s.journey, s.form]] : [[s.journey], [s.journey]]);
      if (translated) {
        expect(JSON.stringify(s.form.translations() ?? {})).not.toContain("Plus");
      }

      expect(s.history.undo()).toBe(true);
      await turn();
      expect(s.pages()).toHaveLength(3);
      expect(JSON.stringify(s.form.translations() ?? {})).toBe(translated ? JSON.stringify({ fr: { journeys: { intake: { pages: { more: { title: { text: "Plus", source: sourceHash("More") } } } } } } }) : "{}");
      // Not built again: the same controller, the same history, and still the drop to take back.
      expect(s.mode.controller).toBe(journeyBefore);
      expect(s.mode.history?.()).toBe(s.history);
      expect(s.mode.journey?.pages.map((page) => page.id)).toEqual(["about", "more", "finish"]);
      expect(s.history.undo()).toBe(true);
      await turn();
      expect(s.content("about")).toHaveLength(1);
      expect(s.history.canUndo()).toBe(false);

      expect(s.history.redo()).toBe(true);
      await turn();
      expect(s.content("about")).toHaveLength(2);
      expect(s.history.redo()).toBe(true);
      await turn();
      expect(s.pages()).toHaveLength(2);
      expect(s.mode.journey?.pages.map((page) => page.id)).toEqual(["about", "finish"]);
      if (translated) {
        expect(JSON.stringify(s.form.translations() ?? {})).not.toContain("Plus");
      }
      expect(s.mode.history?.()).toBe(s.history);
      // And back once more: the translations come back once, from the form's own step.
      expect(s.history.undo()).toBe(true);
      await turn();
      expect(s.pages()).toHaveLength(3);
      if (translated) {
        expect(JSON.stringify(s.form.translations())).toContain("Plus");
      }
      expect(s.mode.history?.()).toBe(s.history);
    });
  }

  it("a Logic Go to rule written while the Step view is up: one Undo takes the rule back, the next the drop before it", async () => {
    const s = await stepRig();
    const journeyBefore = s.journey;
    s.journey.add(JOURNEY_FIELD_TYPE, s.pageNode("about")!.id, JOURNEY_CONTENT_SLOT, { configuration: { componentId: "email" } });
    await turn();
    const host = logicJourneyHostOf(s.form)!;
    await host.prepare();
    expect(host.create({ journeyId: "intake", pageId: "about", to: "finish", when: 'fullName = "x"' })).toBeDefined();
    await turn();
    expect(s.mode.journey?.pages[0]?.routes).toEqual([{ when: 'fullName = "x"', to: "finish" }]);
    expect(s.history.entries()).toEqual([[s.journey], [s.journey, s.form]]);

    expect(s.history.undo()).toBe(true);
    await turn();
    expect(s.mode.journey?.pages[0]?.routes).toBeUndefined();
    expect(s.mode.controller).toBe(journeyBefore);
    expect(s.mode.history?.()).toBe(s.history);
    expect(s.history.undo()).toBe(true);
    await turn();
    expect(s.content("about")).toHaveLength(1);

    expect(s.history.redo()).toBe(true);
    expect(s.history.redo()).toBe(true);
    await turn();
    expect(s.mode.journey?.pages[0]?.routes).toEqual([{ when: 'fullName = "x"', to: "finish" }]);
    expect(s.content("about").length).toBeGreaterThan(1);
    expect(s.mode.history?.()).toBe(s.history);
  });

  it("leaving the Journeys workspace puts the Step view away: a Form-workspace edit is the form's own step, not the Step view's", async () => {
    const s = await stepRig();
    s.mode.deactivate?.();
    expect(s.mode.history?.()).toBeUndefined();
    expect(s.journey.canvasRegionOwner()).toBeUndefined();
    s.form.setProperty("notes", "label", "Anything else");
    await turn();
    await s.mode.activate?.(context());
    const again = s.mode.history?.() as StepHistory | undefined;
    expect(again).toBeDefined();
    expect(again).not.toBe(s.history);
    expect(again!.entries()).toEqual([]);
    expect(again!.undo()).toBe(false);
    const label = (s.form.snapshot().children?.content?.find((node) => node.id === "notes")?.configuration as { label?: string }).label;
    expect(label).toBe("Anything else");
    // The step shown is kept across the round trip.
    expect(s.journey.canvasRootId()).toBe(s.pageNode("about")!.id);
  });
});
