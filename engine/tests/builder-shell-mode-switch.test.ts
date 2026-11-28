// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createJourneyBuilderMode } from "../form-engine/builder/journey-designer/journey-builder-mode.js";
import { createPdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { BuilderMode, BuilderModeContext } from "../form-engine/builder/web-component/builder-modes.js";
import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";

/*
 * The shell's mode switches when another choice comes while one is still activating: the
 * switch given way to lands nothing, and a mode whose `activate` ran for it is taken down again,
 * so it never stays on the page's side (hearing the form, holding its steps) while another is
 * on the page.
 */

defineDatumBuilderElement();

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.innerHTML = "";
});

function formRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Intake" },
    children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
  };
}

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function mount(): DatumBuilderElement {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: formRoot(), componentTypes: [{ type: "text", label: "Text" }] };
  document.body.append(element);
  return element;
}

/** A mode whose `activate` waits for `finish()`, and that counts what the shell asked of it. */
function gatedMode(id: string) {
  const log: string[] = [];
  let active = false;
  const pending: Array<() => void> = [];
  const mode: BuilderMode = {
    id,
    label: id,
    controller: new BuilderController({ initialRoot: formRoot() }),
    activate: () =>
      new Promise<void>((resolve) => {
        log.push("activate");
        pending.push(() => {
          active = true;
          resolve();
        });
      }),
    deactivate: () => {
      log.push("deactivate");
      active = false;
    }
  };
  return {
    mode,
    log,
    active: () => active,
    /** Settles every activation still pending. */
    finish: async () => {
      for (const settle of pending.splice(0)) {
        settle();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

/** Wraps a mode's `activate` so a test can wait on the activation the shell started. */
function watchActivation(mode: BuilderMode): () => Promise<void> | undefined {
  const activate = mode.activate!.bind(mode);
  let pending: Promise<void> | undefined;
  mode.activate = (context: BuilderModeContext) => (pending = Promise.resolve(activate(context)));
  return () => pending;
}

const childCount = (controller: BuilderController): number => controller.snapshot().children?.content?.length ?? 0;

describe("a mode switch given way to while it activates", () => {
  it("takes the mode down again once its activate settles, when the form was chosen meanwhile", async () => {
    const element = mount();
    const slow = gatedMode("slow");
    element.addMode(slow.mode);
    expect(element.setMode("slow")).toBe(true);
    expect(element.setMode("form")).toBe(true);
    // Taken down at once, and again for what its activate set up once it settles.
    expect(slow.log).toEqual(["activate", "deactivate"]);
    await slow.finish();
    expect(element.mode).toBe("form");
    expect(slow.active()).toBe(false);
    expect(slow.log).toEqual(["activate", "deactivate", "deactivate"]);
  });

  it("takes the mode down again when another mode's switch supersedes it", async () => {
    const element = mount();
    const first = gatedMode("first");
    const second = gatedMode("second");
    element.addMode(first.mode);
    element.addMode(second.mode);
    expect(element.setMode("first")).toBe(true);
    expect(element.setMode("second")).toBe(true);
    await first.finish();
    await second.finish();
    expect(element.mode).toBe("second");
    expect(first.active()).toBe(false);
    expect(second.active()).toBe(true);
    expect(second.log).toEqual(["activate"]);
  });

  it("leaves a mode chosen again before its first activation settles on the page", async () => {
    const element = mount();
    const slow = gatedMode("slow");
    element.addMode(slow.mode);
    expect(element.setMode("slow")).toBe(true);
    expect(element.setMode("form")).toBe(true);
    expect(element.setMode("slow")).toBe(true);
    await slow.finish();
    expect(element.mode).toBe("slow");
    expect(slow.active()).toBe(true);
  });

  it("lands nothing for a mode removed while it activates: the form stays on the page", async () => {
    const element = mount();
    const slow = gatedMode("slow");
    slow.mode.dispose = () => {
      slow.log.push("dispose");
    };
    element.addMode(slow.mode);
    expect(element.setMode("slow")).toBe(true);
    element.removeMode("slow");
    await slow.finish();
    expect(element.mode).toBe("form");
    expect(element.modes.map((mode) => mode.id)).toEqual(["form"]);
    expect(element.activeController).toBe(element.controller);
    expect(element.getAttribute("mode")).not.toBe("slow");
    expect(slow.active()).toBe(false);
    expect(slow.log[0]).toBe("activate");
    expect(slow.log.at(-1)).toBe("deactivate");
  });

  it("gives way to the mode attribute set back to the mode on the page, or taken away", async () => {
    for (const back of [(element: DatumBuilderElement) => element.setAttribute("mode", "form"), (element: DatumBuilderElement) => element.removeAttribute("mode")]) {
      const element = mount();
      const slow = gatedMode("slow");
      element.addMode(slow.mode);
      element.setAttribute("mode", "slow");
      back(element);
      await slow.finish();
      expect(element.mode).toBe("form");
      expect(element.getAttribute("mode") ?? "form").toBe("form");
      expect(slow.active()).toBe(false);
      element.remove();
    }
  });

  it("gives way to the document already on the page, chosen again", async () => {
    const element = mount();
    element.addMode({
      id: "docs",
      label: "Docs",
      controller: new BuilderController({ initialRoot: formRoot() }),
      documents: { list: () => [{ id: "a", label: "A" }], selectedId: () => "a", select: () => undefined, subscribe: () => () => undefined }
    });
    expect(element.setMode("docs")).toBe(true);
    await until(() => element.mode === "docs");
    const slow = gatedMode("slow");
    element.addMode(slow.mode);
    expect(element.setMode("slow")).toBe(true);
    expect(element.selectDocument("docs", "a")).toBe(true);
    await slow.finish();
    expect(element.mode).toBe("docs");
    expect(slow.active()).toBe(false);
  });

  it("takes down a mode whose document could not be opened after its activate ran", async () => {
    const element = mount();
    const log: string[] = [];
    element.addMode({
      id: "docs",
      label: "Docs",
      controller: new BuilderController({ initialRoot: formRoot() }),
      activate: () => {
        log.push("activate");
      },
      deactivate: () => {
        log.push("deactivate");
      },
      documents: {
        list: () => [
          { id: "a", label: "A" },
          { id: "b", label: "B" }
        ],
        selectedId: () => "a",
        select: () => Promise.reject(new Error("cannot open b")),
        subscribe: () => () => undefined
      }
    });
    const errors: unknown[] = [];
    element.addEventListener("builder-mode-error", (event) => errors.push((event as CustomEvent).detail.mode));
    expect(element.selectDocument("docs", "b")).toBe(true);
    await until(() => errors.length > 0);
    expect(element.mode).toBe("form");
    expect(log).toEqual(["activate", "deactivate"]);
  });
});

describe("a designer left while it loads", () => {
  it("PDF: its Undo does not take back an edit made in the Form workspace", async () => {
    const element = mount();
    const layout: PdfGeneratedLayout = {
      id: "receipt",
      kind: "generated",
      name: "Receipt",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } }
    };
    const mode = createPdfBuilderMode({
      formRoot: () => element.controller.snapshot(),
      runtime: () => ({}) as RenderableRuntime,
      pdf: { layouts: [layout] },
      locale: () => "en",
      form: () => element.controller
    });
    disposals.push(() => mode.dispose?.());
    const activation = watchActivation(mode);
    element.addMode(mode);
    expect(element.setMode("pdf")).toBe(true);
    // The author changes their mind while the designer loads.
    expect(element.setMode("form")).toBe(true);
    // An edit in the Form workspace, while the designer is still loading and after it has.
    expect(element.controller.requestAddAfter("text")).toBe(true);
    await activation();
    expect(element.controller.requestAddAfter("text")).toBe(true);
    expect(childCount(element.controller)).toBe(3);
    expect(element.setMode("pdf")).toBe(true);
    await until(() => element.activeController === mode.controller && mode.ready);
    expect(element.canHistoryStep("undo")).toBe(false);
    element.undo();
    expect(childCount(element.controller)).toBe(3);
  });

  it("Journeys: its Undo does not take back an edit made in the Form workspace", async () => {
    const element = mount();
    const mode = createJourneyBuilderMode({
      form: element.controller,
      journey: { journeys: [{ id: "apply", name: "Apply", pages: [{ id: "about", components: ["fullName"] }] }] }
    });
    disposals.push(() => mode.dispose?.());
    const activation = watchActivation(mode);
    element.addMode(mode);
    expect(element.setMode("journeys")).toBe(true);
    // The Form tab, before the designer's chunk has arrived.
    expect(element.setMode("form")).toBe(true);
    await activation();
    element.controller.setProperty("fullName", "label", "Your name");
    expect(element.setMode("journeys")).toBe(true);
    await until(() => element.activeController === mode.controller);
    expect(element.canHistoryStep("undo")).toBe(false);
    element.undo();
    expect((element.controller.snapshot().children?.content?.[0]?.configuration as { label?: unknown }).label).toBe("Your name");
  });
});
