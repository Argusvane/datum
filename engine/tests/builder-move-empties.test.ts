// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { CanvasMove, type CanvasMoveHost } from "../form-engine/builder/drag-drop/move-ui.js";
import { createJourneyDesigner } from "../form-engine/builder/journey-designer/journey-designer.js";
import { checkJourneyTree } from "../form-engine/builder/journey-designer/journey-checks.js";
import { JOURNEY_CONTENT_SLOT, JOURNEY_PAGES_SLOT } from "../form-engine/builder/journey-designer/journey-mode-model.js";
import { BuilderWords } from "../form-engine/builder/logic/builder-texts.js";
import type { Journey } from "../form-engine/core/schema/journey.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * Move to... that empties a journey page: the dialog's confirm line and the
 * live region say so, the journey's own check already lists the empty page, and the move still
 * happens. A page that keeps other questions says nothing.
 */

const field = (id: string): ComponentNode => ({ id, type: "text", configuration: { label: id } });
const form: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [field("name"), field("email"), field("phone")] } };
const journey: Journey = {
  id: "intake",
  pages: [
    { id: "about", title: "About you", components: ["name", "email"], routes: [{ to: "contact" }] },
    { id: "contact", title: "Contact", components: ["phone"], routes: [{ to: "$end" }] }
  ]
};

function setup() {
  const designer = createJourneyDesigner({ formRoot: () => form, locale: () => "en" });
  const pageIds = new Map<string, string>();
  const tree = designer.treeFromJourney(journey, { pageIds });
  const controller = new BuilderController({ componentTypes: [], initialRoot: tree });
  const design = designer.entry({ journeyId: () => journey.id, tree: () => controller.previewSnapshot(), pageIds });
  controller.setOptions({ ...design.builderOptions, initialRoot: tree, locale: "en" });

  const root = document.createElement("div");
  root.innerHTML = "<div data-canvas-prompt></div>";
  document.body.append(root);
  const said: string[] = [];
  const host: CanvasMoveHost = {
    controller: () => controller,
    root: root as unknown as ShadowRoot,
    previewRoot: () => undefined,
    words: () => new BuilderWords(),
    announce: (text) => said.push(text),
    revealComponent: () => undefined,
    showMarker: (zone) => zone,
    clearMarker: () => undefined,
    focusCanvas: () => undefined,
    rtl: () => false
  };
  const mover = new CanvasMove(host);
  const pages = (): ComponentNode[] => controller.snapshot().children?.[JOURNEY_PAGES_SLOT] ?? [];
  const member = (page: number, index: number): ComponentNode => pages()[page]!.children![JOURNEY_CONTENT_SLOT]![index]!;
  return { controller, mover, root, said, pages, member, designer, pageIds };
}

afterEach(() => {
  document.body.innerHTML = "";
});

const warning = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>("[data-move-empties]")!;

/** Chooses the page named `label` in the dialog and fires the change the canvas forwards. */
function choose(mover: CanvasMove, root: HTMLElement, label: string): void {
  const select = root.querySelector<HTMLSelectElement>("[data-move-target]")!;
  const option = [...select.options].find((candidate) => candidate.textContent!.includes(label))!;
  select.value = option.value;
  mover.changed(select);
}

describe("Move to... that empties a journey page", () => {
  it("says in the dialog that the step it leaves will have no fields, and still moves", () => {
    const { controller, mover, root, said, pages, member } = setup();
    const phone = member(1, 0);
    mover.openDialog(phone.id);
    // Opened on where it is: nothing is emptied by staying put.
    expect(warning(root).hidden).toBe(true);
    choose(mover, root, "About you");
    expect(warning(root).hidden).toBe(false);
    expect(warning(root).textContent).toBe("Step 2 · Contact will have no fields: it shows only its buttons.");
    // A warning, not a block: Move is on.
    const confirm = root.querySelector<HTMLButtonElement>("[data-move-confirm]")!;
    expect(confirm.disabled).toBe(false);
    mover.confirmDialog();
    expect(pages()[0]!.children![JOURNEY_CONTENT_SLOT]!.map((node) => node.id)).toContain(phone.id);
    expect(pages()[1]!.children![JOURNEY_CONTENT_SLOT] ?? []).toEqual([]);
    expect(said.at(-1)).toContain("Moved to Step 1 · About you");
    expect(said.at(-1)).toContain("Step 2 · Contact is now empty.");
    expect(controller.canUndo()).toBe(true);
  });

  it("says nothing of the emptied page in the journey's own check: an empty step is shown as it is", () => {
    const { controller, mover, root, pageIds, member, pages } = setup();
    mover.openDialog(member(1, 0).id);
    choose(mover, root, "About you");
    mover.confirmDialog();
    const emptied = pages()[1]!;
    const check = checkJourneyTree(form, controller.snapshot(), journey.id, { pageIds });
    expect(check.findings.byNode.get(emptied.id) ?? []).toEqual([]);
  });

  it("says nothing when the page it leaves keeps other questions", () => {
    const { mover, root, said, member, pages } = setup();
    const email = member(0, 1);
    mover.openDialog(email.id);
    choose(mover, root, "Contact");
    expect(warning(root).hidden).toBe(true);
    expect(warning(root).textContent).toBe("");
    mover.confirmDialog();
    expect(pages()[1]!.children![JOURNEY_CONTENT_SLOT]!.map((node) => node.id)).toContain(email.id);
    expect(said.at(-1)).toContain("Moved to Step 2 · Contact");
    expect(said.at(-1)).not.toContain("empty");
  });

  it("says nothing for a form container that an ordinary move leaves empty", () => {
    const flat: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "box", type: "panel", configuration: { label: "Box" }, children: { content: [field("only")] } }, field("other")] }
    };
    const controller = new BuilderController({ initialRoot: flat, componentDefinitions: [] });
    const root = document.createElement("div");
    root.innerHTML = "<div data-canvas-prompt></div>";
    document.body.append(root);
    const mover = new CanvasMove({
      controller: () => controller,
      root: root as unknown as ShadowRoot,
      previewRoot: () => undefined,
      words: () => new BuilderWords(),
      announce: () => undefined,
      revealComponent: () => undefined,
      showMarker: (zone) => zone,
      clearMarker: () => undefined,
      focusCanvas: () => undefined,
      rtl: () => false
    });
    mover.openDialog("only");
    // Whatever the tree offers here, a plain panel emptied is not a warning.
    expect(root.querySelector("[data-move-empties]")).not.toBeNull();
    expect(warning(root).hidden).toBe(true);
  });
});
