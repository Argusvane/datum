// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { ComponentTree } from "../form-engine/core/tree/component-tree.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import { foldPresentation, presentationNodes, type PresentationFoldOptions, type PresentationNode } from "../form-engine/render/core/presentation-tree.js";
import { leftOffScreen, paperOnlyApplies } from "../form-engine/render/core/print-options.js";
import { buildPrintModel, type PrintNode } from "../form-engine/render/print/index.js";
import { DATUM_FORM_RENDERER_TAG, defineDatumFormRendererElement, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { buildCanvasHooks } from "../form-engine/builder/web-component/canvas-hooks.js";

/**
 * A component drawn on paper only (`print.on: "paper"`, plan C): a screen fold leaves out static
 * content, an image and a container of only those, as it leaves out a hidden component; a fold
 * that keeps hidden ones keeps it, marked; paper folds it. A field asking for paper only is drawn
 * on screen as ever, since paper-only never hides a question.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const paper = { print: { on: "paper" } };

const children: ComponentNode[] = [
  { id: "name", type: "text", configuration: { label: "Name", required: true } },
  { id: "office", type: "html", configuration: { content: "<p>Office use only</p>", ...paper } },
  { id: "stamp", type: "image", configuration: { src: "https://example.test/stamp.png", alt: "Stamp", ...paper } },
  {
    id: "box",
    type: "fieldset",
    configuration: { label: "For the clerk", ...paper },
    children: { content: [{ id: "boxNote", type: "html", configuration: { content: "<p>Clerk</p>" } }] }
  },
  // A field asking for paper only is still a question: drawn on screen.
  { id: "phone", type: "text", configuration: { label: "Phone", ...paper } },
  // A container holding a question is drawn too, its question with it.
  {
    id: "mixed",
    type: "fieldset",
    configuration: { label: "Mixed", ...paper },
    children: { content: [{ id: "mixedNote", type: "html", configuration: { content: "<p>Note</p>" } }, { id: "email", type: "text", configuration: { label: "Email" } }] }
  },
  // A button is something the person does: never paper only.
  { id: "send", type: "button", configuration: { label: "Send", action: "submit", ...paper } }
];

const root: ComponentNode = { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: children } };

async function fold(options: Partial<PresentationFoldOptions> = {}) {
  const output = await buildRenderOutput({
    mode: "interactive",
    root,
    state: new FormStateStore("en").snapshot(),
    resolver: { resolveDataSource: async () => undefined },
    componentTree: new ComponentTree(root)
  });
  return foldPresentation(output, { locale: "en", ...options });
}

const ids = (nodes: readonly PresentationNode[]): string[] => presentationNodes(nodes).map((node) => node.id);

function runtimeOf(): FormRuntime {
  const form = { id: "intake", version: "1", schemaVersion: "1", root } as unknown as FormDefinition;
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(root)]) });
}

describe("paperOnlyApplies and leftOffScreen", () => {
  it("holds for static content, an image and a container of only those; never for a field, a button or an unknown type", () => {
    expect(paperOnlyApplies({ type: "html" })).toBe(true);
    expect(paperOnlyApplies({ type: "image" })).toBe(true);
    expect(paperOnlyApplies(children[3]!)).toBe(true);
    expect(paperOnlyApplies({ type: "text" })).toBe(false);
    expect(paperOnlyApplies({ type: "button" })).toBe(false);
    expect(paperOnlyApplies({ type: "button-group", children: { content: [{ id: "b", type: "button", configuration: {} }] } })).toBe(false);
    expect(paperOnlyApplies(children[5]!)).toBe(false);
    expect(paperOnlyApplies({ type: "acme-note" })).toBe(false);
    // Odd input reads as no.
    expect(paperOnlyApplies(null as never)).toBe(false);
    expect(paperOnlyApplies({ type: "fieldset", children: null } as never)).toBe(true);
  });

  it("is what a screen leaves out: paper only asked for and taking effect", () => {
    expect(leftOffScreen(children[1]!)).toBe(true);
    expect(leftOffScreen({ type: "html", configuration: {} })).toBe(false);
    expect(leftOffScreen({ type: "html", configuration: { print: { on: "screen" } } })).toBe(false);
    expect(leftOffScreen(children[4]!)).toBe(false);
    expect(leftOffScreen(children[6]!)).toBe(false);
  });
});

describe("the presentation fold's surface", () => {
  it("leaves paper-only static content off a screen, and folds every component without a surface or on paper", async () => {
    const screen = await fold({ surface: "screen" });
    expect(ids(screen.nodes)).toEqual(["name", "phone", "mixed", "mixedNote", "email", "send"]);
    expect(screen.fields.map((field) => field.id)).toEqual(["name", "phone", "mixedNote", "email", "send"]);
    const all = ["name", "office", "stamp", "box", "boxNote", "phone", "mixed", "mixedNote", "email", "send"];
    expect(ids((await fold()).nodes)).toEqual(all);
    expect(ids((await fold({ surface: "paper" })).nodes)).toEqual(all);
  });

  it("keeps a paper-only component on a screen fold that keeps hidden ones, marked as a hidden one is and paperOnly", async () => {
    const tree = await fold({ surface: "screen", includeHidden: true });
    const nodes = presentationNodes(tree.nodes);
    const office = nodes.find((node) => node.id === "office")!;
    expect(office).toMatchObject({ visible: false, paperOnly: true });
    expect(nodes.find((node) => node.id === "box")).toMatchObject({ visible: false, paperOnly: true });
    // Its contents are kept with it, as a hidden container's are.
    expect(nodes.find((node) => node.id === "boxNote")?.visible).toBe(true);
    for (const id of ["name", "phone", "mixed", "send"]) {
      const node = nodes.find((candidate) => candidate.id === id)!;
      expect(node.visible).toBe(true);
      expect(node.paperOnly).toBeUndefined();
    }
    // The model is the runtime's own, untouched: only the node is marked.
    expect(office.model?.visible).toBe(true);
  });

  it("draws a paper-only step on screen with its contents: a step a person moves through is never left out", async () => {
    const stepped: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "wizard",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "one", type: "step", configuration: { label: "One" }, children: { content: [{ id: "q", type: "text", configuration: { label: "Q" } }] } },
                { id: "two", type: "step", configuration: { label: "Office", ...paper }, children: { content: [{ id: "n", type: "html", configuration: { content: "<p>N</p>" } }] } }
              ]
            }
          }
        ]
      }
    };
    const output = await buildRenderOutput({ mode: "interactive", root: stepped, state: new FormStateStore("en").snapshot(), resolver: { resolveDataSource: async () => undefined }, componentTree: new ComponentTree(stepped) });
    const tree = foldPresentation(output, { locale: "en", surface: "screen" });
    const steps = presentationNodes(tree.nodes).find((node) => node.kind === "steps");
    expect(steps?.kind === "steps" && steps.steps.map((step) => [step.id, step.visible, step.children.length])).toEqual([
      ["one", true, 1],
      ["two", true, 1]
    ]);
    expect(paperOnlyApplies(stepped.children!.content![0]!.children!.content![1]!)).toBe(false);
    expect(paperOnlyApplies(stepped.children!.content![0]!)).toBe(false);
  });
});

describe("paper only, drawn", () => {
  it("is absent from the live form, a paper-only field still drawn and the Tab order unchanged", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.runtime = runtimeOf();
    document.body.append(element);
    await element.painted();
    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('[data-component-id="office"]')).toBeNull();
    expect(shadow.querySelector('[data-component-id="stamp"]')).toBeNull();
    expect(shadow.querySelector('[data-container-id="box"]')).toBeNull();
    expect(shadow.textContent).not.toContain("Office use only");
    expect(shadow.querySelector('[data-component-id="phone"] input')).not.toBeNull();
    expect(shadow.querySelector('[data-container-id="mixed"]')).not.toBeNull();
    expect(shadow.querySelector('[data-component-id="send"]')).not.toBeNull();
    const focusable = [...shadow.querySelectorAll<HTMLElement>("input, button, select, textarea, a[href]")].map((el) => el.closest("[data-component-id]")?.getAttribute("data-component-id"));
    expect(focusable.filter((id) => id !== undefined && id !== null)).toEqual(["name", "phone", "email", "send"]);
  });

  it("keeps the error summary's links on the questions when paper-only content is left out", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.runtime = runtimeOf();
    document.body.append(element);
    await element.painted();
    await element.validate();
    await element.painted();
    const links = [...element.shadowRoot!.querySelectorAll<HTMLAnchorElement>(".datum-form__summary a")].map((link) => link.getAttribute("href"));
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("name");
  });

  it("is on paper", async () => {
    const model = await buildPrintModel(runtimeOf());
    const flat = (nodes: readonly PrintNode[]): string[] => nodes.flatMap((node) => [node.id, ...(node.kind === "group" || node.kind === "section" ? flat(node.children) : [])]);
    const printed = flat(model.nodes);
    expect(printed).toEqual(expect.arrayContaining(["office", "box", "boxNote", "phone", "mixedNote"]));
  });
});

describe("paper only, on the builder's canvas", () => {
  /** A form drawn with the canvas's hooks and hidden components kept, as the canvas draws it. */
  async function canvasOf(kids: ComponentNode[], kinds?: Record<string, string>): Promise<ShadowRoot> {
    const canvasRoot: ComponentNode = { id: "root", type: "form", configuration: { title: "Intake" }, children: { content: kids } };
    const form = { id: "intake", version: "1", schemaVersion: "1", root: canvasRoot, ...(kinds ? { kinds } : {}) } as unknown as FormDefinition;
    const modes = new SubmissionModeRegistry();
    modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    element.showHiddenComponents = true;
    element.canvasHooks = buildCanvasHooks({ selectedId: undefined, rootId: "root", declaredSlots: new Map() });
    element.runtime = new FormRuntime(form, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
    document.body.append(element);
    await element.painted();
    return element.shadowRoot!;
  }
  const box = (shadow: ShadowRoot, id: string): HTMLElement => shadow.querySelector<HTMLElement>(`.db-node[data-component-id="${id}"]`)!;
  const tagOf = (shadow: ShadowRoot, id: string): HTMLElement | undefined =>
    [...box(shadow, id).children].find((element) => element.classList.contains("db-tag--hidden")) as HTMLElement | undefined;

  it("tags a paper-only component Paper only, dimmed as a hidden one, and one a rule also hides Hidden", async () => {
    const shadow = await canvasOf([
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "office", type: "html", configuration: { content: "<p>Office use only</p>", ...paper } },
      { id: "both", type: "html", configuration: { content: "<p>Both</p>", hidden: true, ...paper } },
      { id: "gone", type: "html", configuration: { content: "<p>Gone</p>", hidden: true } },
      { id: "clerk", type: "fieldset", configuration: { label: "For the clerk", ...paper }, children: { content: [{ id: "clerkNote", type: "html", configuration: { content: "<p>Clerk</p>" } }] } }
    ]);
    for (const id of ["office", "clerk"]) {
      expect(tagOf(shadow, id)?.hasAttribute("data-db-paper-only"), id).toBe(true);
      expect(tagOf(shadow, id)?.textContent, id).toBe("Paper only");
      expect(box(shadow, id).classList.contains("db-node--hidden"), id).toBe(true);
    }
    for (const id of ["both", "gone"]) {
      expect(tagOf(shadow, id)?.hasAttribute("data-db-paper-only"), id).toBe(false);
      expect(tagOf(shadow, id)?.textContent, id).toBe("Hidden by a rule");
      expect(box(shadow, id).classList.contains("db-node--hidden"), id).toBe(true);
    }
    expect(tagOf(shadow, "name")).toBeUndefined();
    expect(box(shadow, "name").classList.contains("db-node--hidden")).toBe(false);
  });

  it("reads a design system's container through the kinds map: paper only where its base holds only static content", async () => {
    const kids: ComponentNode[] = [
      { id: "aside", type: "acme-aside", configuration: { label: "Aside", ...paper }, children: { content: [{ id: "asideNote", type: "html", configuration: { content: "<p>Aside</p>" } }] } }
    ];
    const mapped = await canvasOf(kids, { "acme-aside": "fieldset" });
    expect(tagOf(mapped, "aside")?.hasAttribute("data-db-paper-only")).toBe(true);
    expect(box(mapped, "aside").classList.contains("db-node--hidden")).toBe(true);
  });
});
