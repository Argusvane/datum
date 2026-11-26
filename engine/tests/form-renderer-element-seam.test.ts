// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormEventType } from "../form-engine/core/events/event-types.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { SubmissionVersionContext } from "../form-engine/core/submission/canonical-submission.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { defineDatumFormRendererElement, DATUM_FORM_RENDERER_TAG, type DatumFormRendererElement } from "../form-engine/render/web-component/form-renderer-element.js";
import { defineDatumFormHostElement, DATUM_FORM_HOST_TAG, type DatumFormHostElement } from "../form-engine/render/web-component/form-host-element.js";
import { extendBinding } from "../form-engine/render/live/contract.js";
import { registerBinding } from "../form-engine/render/live/binding-registry.js";
import { createDatumBinding } from "../form-engine/render/live/datum/options.js";

/*
 * The seam between <datum-form-renderer> (and <datum-form-host>) and the live renderer, where it
 * must give: an agent's refused submit and the person's focus, the host's
 * `headingLevel` through the outline, a remount and the answer being typed, and the host toolbar's
 * words from a binding registered late. Asserted on focus, accessible roles and heading levels,
 * the DOM contract and the runtime's events.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const VERSION: SubmissionVersionContext = { form: { id: "seam", version: "1.0.0" }, client: { runtimeVersion: "test", rendererVersion: "test", schemaVersion: "1.0.0" } };

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function definitionOf(content: ComponentNode[], configuration: Record<string, unknown> = {}): FormDefinition {
  return { id: "seam", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration, children: { content } } } as FormDefinition;
}

function runtimeFor(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
}

async function mount(runtime: FormRuntime, setup?: (element: DatumFormRendererElement) => void) {
  defineDatumFormRendererElement();
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  setup?.(element);
  element.runtime = runtime;
  document.body.append(element);
  await element.painted();
  return { element, root: element.shadowRoot! };
}

const input = (root: ShadowRoot, componentId: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-component-id="${componentId}"] input`)!;
const typeInto = (box: HTMLInputElement, value: string): void => {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
};
/** Every heading drawn, as `h<level>:<text>`, in document order. */
const headings = (root: ShadowRoot): string[] =>
  Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((heading) => `${heading.localName}:${(heading.textContent ?? "").replace(/\s+/g, " ").trim()}`);

const fields = (): ComponentNode[] => [
  { id: "age", type: "number", configuration: { label: "Age" } } as ComponentNode,
  { id: "name", type: "text", configuration: { label: "Your name", required: true } } as ComponentNode
];

describe("an agent's refused submit", () => {
  it("draws its errors and leaves focus in the field the person is typing in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = runtimeFor(definitionOf(fields()));
    const { element, root } = await mount(runtime);
    const age = input(root, "age");
    age.focus();
    typeInto(age, "3");
    await element.painted();
    expect(root.activeElement).toBe(age);

    // What <datum-form> does for an agent's submit: the quiet, released once the submit settles.
    const release = element.quietNextPageFocus();
    const result = await runtime.submit("submit", VERSION);
    release();
    await element.painted();
    await wait(50);
    expect(result.accepted).toBe(false);
    expect(root.querySelector("[data-datum-summary] [role=alert]")).not.toBeNull();
    expect(root.activeElement).toBe(input(root, "age"));
    expect(input(root, "age").value).toBe("3");

    // The quiet ended with the agent's submit: the person's own refused submit takes them to the errors.
    await runtime.submit("submit", VERSION);
    await element.painted();
    await wait(50);
    expect(root.activeElement?.closest("[data-datum-summary]")).not.toBeNull();
  });
});

describe("headingLevel through the outline", () => {
  const form = () =>
    definitionOf(
      [
        { id: "card", type: "panel", configuration: { label: "Details" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Your name", required: true } }] } } as ComponentNode
      ],
      { title: "Grant application" }
    );

  it("heads the summary and the containers a level under the form's own heading, and follows a change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = runtimeFor(form());
    const { element, root } = await mount(runtime, (el) => {
      el.headingLevel = 3;
    });
    await element.validate({ focus: false });
    await element.painted();
    expect(headings(root)).toEqual(["h3:Grant application", "h4:1 error", "h4:Details"]);
    const alert = root.querySelector("[data-datum-summary] [role=alert]");
    expect(root.getElementById(alert?.getAttribute("aria-labelledby") ?? "")?.localName ?? alert?.querySelector("h4")?.localName).toBe("h4");

    element.headingLevel = 1;
    await element.painted();
    expect(headings(root)).toEqual(["h1:Grant application", "h2:1 error", "h2:Details"]);
  });

  it("hands a binding's summary the level", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: number[] = [];
    const datum = createDatumBinding();
    const binding = extendBinding(datum, {
      id: "seam-summary-level",
      label: "Seam",
      summary: (entries, state) => {
        seen.push(state.headingLevel);
        return datum.summary!(entries, state);
      }
    });
    const runtime = runtimeFor(form());
    const { element } = await mount(runtime, (el) => {
      el.binding = binding;
      el.headingLevel = 2;
    });
    await element.validate({ focus: false });
    await element.painted();
    expect(seen.at(-1)).toBe(3);
  });
});

describe("a remount and the answer being typed", () => {
  it("does not mount again for the same features list, and commits what is typed before a remount", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = runtimeFor(definitionOf(fields()));
    const commits: unknown[] = [];
    runtime.events().subscribe(FormEventType.COMPONENT_COMMITTED, (event) => commits.push(event.data));
    const { element, root } = await mount(runtime, (el) => {
      el.setAttribute("features", "all");
    });
    const live = element.live;
    const name = input(root, "name");
    name.focus();
    typeInto(name, "Half");
    await element.painted();

    // A host writes the same list again (as <datum-form-host> does on every set): nothing remounts.
    element.setAttribute("features", "all");
    element.features = "all";
    await element.painted();
    expect(element.live).toBe(live);
    expect(input(root, "name")).toBe(name);
    expect(root.activeElement).toBe(name);
    expect(name.value).toBe("Half");
    expect(commits).toHaveLength(0);

    // A different list mounts again: what was typed is committed first.
    element.features = "all agent";
    await element.painted();
    expect(element.live).not.toBe(live);
    expect(commits).toHaveLength(1);
    expect(runtime.state().values["name"]).toBe("Half");
    expect(input(root, "name").value).toBe("Half");
  });
});

describe("the host toolbar and a binding registered late", () => {
  it("takes the binding's words once a binding is registered under the id it names", async () => {
    defineDatumFormHostElement();
    const host = document.createElement(DATUM_FORM_HOST_TAG) as DatumFormHostElement;
    const runtime = runtimeFor(definitionOf(fields(), { localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] } }));
    runtime.setLocale("fr");
    host.runtime = runtime;
    host.binding = "seam-late-pack";
    document.body.append(host);
    const label = () => host.shadowRoot!.querySelector('[part="validate-label"]')!.textContent;
    expect(label()).toBe("Validate");
    registerBinding(extendBinding(createDatumBinding(), { id: "seam-late-pack", label: "Late", texts: { fr: { validateLabel: "Valider (tard)" } } }));
    await wait(0);
    expect(label()).toBe("Valider (tard)");

    // Off the page it hears the registry no more; back on, it does again.
    host.remove();
    await wait(0);
    registerBinding(extendBinding(createDatumBinding(), { id: "seam-late-pack", label: "Late", texts: { fr: { validateLabel: "Valider (encore)" } } }));
    expect(label()).toBe("Valider (tard)");
    document.body.append(host);
    registerBinding(extendBinding(createDatumBinding(), { id: "seam-late-pack", label: "Late", texts: { fr: { validateLabel: "Valider (de retour)" } } }));
    await wait(0);
    expect(label()).toBe("Valider (de retour)");
  });
});
