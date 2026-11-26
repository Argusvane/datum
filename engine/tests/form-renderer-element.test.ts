// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import type { ValidationResult, ValidationStage } from "../form-engine/core/schema/contracts.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFileStorageResolver } from "../form-engine/render/core/file-storage.js";
import {
  defineDatumFormRendererElement,
  DATUM_FORM_RENDERER_TAG,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";
import { extendBinding, type FieldAdapter, type LiveBinding } from "../form-engine/render/live/contract.js";
import { bindingById, onBindingsChanged, registerBinding, registeredBindings } from "../form-engine/render/live/binding-registry.js";
import { createDatumBinding } from "../form-engine/render/live/renderer.js";
import { html } from "../form-engine/render/live/lit.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

/*
 * <datum-form-renderer> on the live renderer: the element mounts its runtime
 * with `mountLive`, the binding it names (Datum's by default) and the renderer's modules, and keeps
 * the public surface hosts and the agent layer use. Asserted on the DOM contract
 * (`data-component-id`, `data-value-path`, `data-container-id`), the state hooks, accessible names
 * and roles, the runtime's state and the element's events, never on a binding's class names.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 200): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function definitionOf(content: ComponentNode[], extra: Partial<FormDefinition> = {}, configuration: Record<string, unknown> = {}): FormDefinition {
  return {
    id: "element",
    version: "1",
    schemaVersion: "1",
    root: { id: "root", type: "form", configuration, children: { content } },
    ...extra
  } as FormDefinition;
}

function runtimeFor(definition: FormDefinition, stages: ValidationStage[] = [createFieldConstraintsStage(definition.root)]): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline(stages) });
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

const wrapper = (root: ShadowRoot, componentId: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-component-id="${componentId}"]`);
const control = <E extends HTMLElement = HTMLInputElement>(root: ShadowRoot, componentId: string, selector = "input"): E | null =>
  root.querySelector<E>(`[data-component-id="${componentId}"] ${selector}`);

/** Types `value` and leaves the box: the keystroke (interim) and the browser's change on leaving. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const name = (): ComponentNode => ({ id: "name", type: "text", configuration: { label: "Your name", required: true } });

describe("the binding registry", () => {
  it("registers by id, replaces under the same id, lists in order, and tells its listeners once per change", () => {
    const heard = vi.fn();
    const stop = onBindingsChanged(heard);
    const one: LiveBinding = { id: "registry-one", label: "One", components: {} };
    const two: LiveBinding = { id: "registry-two", label: "Two", components: {} };
    registerBinding([one, two]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(bindingById("registry-one")).toBe(one);
    const ids = registeredBindings().map((binding) => binding.id);
    expect(ids.indexOf("registry-one")).toBeLessThan(ids.indexOf("registry-two"));

    const replaced: LiveBinding = { id: "registry-one", label: "One again", components: {} };
    registerBinding(replaced);
    expect(bindingById("registry-one")).toBe(replaced);
    expect(heard).toHaveBeenCalledTimes(2);
    // The same binding again changes nothing.
    registerBinding(replaced);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    registerBinding({ id: "registry-three", label: "Three", components: {} });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("never stores a binding under datum, nor something that is no binding", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registerBinding({ id: "datum", label: "Not Datum", components: {} });
    registerBinding({ id: "", label: "No id", components: {} } as LiveBinding);
    registerBinding({ label: "No components" } as unknown as LiveBinding);
    expect(bindingById("datum")).toBeUndefined();
    expect(registeredBindings().some((binding) => binding.label === "Not Datum" || binding.label === "No id")).toBe(false);
    expect(error).toHaveBeenCalledTimes(3);
  });
});

describe("<datum-form-renderer> binding", () => {
  /** A binding that draws text fields alone, its own way; Datum draws the rest. */
  function textOnly(id: string): LiveBinding {
    const datumText = createDatumBinding().components.text as FieldAdapter;
    return {
      id,
      label: id,
      components: {
        text: { ...datumText, name: `${id}-text`, template: (state, on) => html`<div data-own=${id}>${datumText.template(state, on)}</div>` } as FieldAdapter
      }
    };
  }

  it("draws with the Datum binding when it names none", async () => {
    const { element, root } = await mount(runtimeFor(definitionOf([name()])));
    expect(element.binding).toBeUndefined();
    expect(element.live?.adapterOf("name")).toMatchObject({ from: "binding", via: "text" });
    expect(wrapper(root, "name")?.getAttribute("data-kind")).toBe("text");
    expect(wrapper(root, "name")?.getAttribute("data-value-path")).toBe("name");
    expect(control(root, "name")?.labels?.[0]?.textContent).toContain("Your name");
  });

  it("draws with a binding object, Datum's adapters drawing what it does not, and says so", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const binding = textOnly("own-object");
    const { element, root } = await mount(runtimeFor(definitionOf([name(), { id: "notes", type: "textarea", configuration: { label: "Notes" } }])), (el) => {
      el.binding = binding;
    });
    expect(element.binding).toBe(binding);
    expect(wrapper(root, "name")?.querySelector('[data-own="own-object"]')).not.toBeNull();
    expect(element.live?.adapterOf("name")).toMatchObject({ from: "binding", name: "own-object-text" });
    expect(element.live?.adapterOf("notes")?.from).toBe("datum");
    expect(wrapper(root, "notes")?.hasAttribute("data-fallback")).toBe(true);
    expect(element.live?.unsupported()).toContain('notes: component "textarea"');
  });

  it("draws with a binding registered under the id it names, and with Datum's (saying so once) while none is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const problems: Array<{ hook: string; id?: string }> = [];
    const { element, root } = await mount(runtimeFor(definitionOf([name()])), (el) => {
      el.addEventListener("datum-binding-error", (event) => problems.push((event as CustomEvent).detail));
      el.binding = "registered-later";
    });
    expect(problems).toEqual([expect.objectContaining({ hook: "binding", id: "registered-later" })]);
    expect(element.live?.adapterOf("name")?.from).toBe("binding");
    expect(wrapper(root, "name")?.querySelector("[data-own]")).toBeNull();

    // Registered now: the element hears it and draws with it.
    registerBinding(textOnly("registered-later"));
    await until(() => wrapper(root, "name")?.querySelector('[data-own="registered-later"]'));
    expect(problems).toHaveLength(1);

    registerBinding(textOnly("registered-first"));
    element.binding = "registered-first";
    await element.painted();
    expect(wrapper(root, "name")?.querySelector('[data-own="registered-first"]')).not.toBeNull();
    // "datum" is the Datum binding, never a registered one.
    element.binding = "datum";
    await element.painted();
    expect(wrapper(root, "name")?.querySelector("[data-own]")).toBeNull();
    expect(problems).toHaveLength(1);
  });

  it("answers the capabilities of a field type under its binding, and nothing for a type nothing draws", async () => {
    const { element } = await mount(runtimeFor(definitionOf([name()])));
    const text = element.capabilitiesOf("text");
    expect(text?.kind).toBe("text");
    expect(text?.answers.tooltip).toBe("drawn");
    expect(element.live?.capabilitiesOf("text")).toEqual(text);
    expect(element.capabilitiesOf("no-such-type")).toBeUndefined();
  });

  it("draws the binding's dark look under a dark colour scheme, without mounting again", async () => {
    const { element, root } = await mount(runtimeFor(definitionOf([name()])));
    const live = element.live;
    const datum = createDatumBinding();
    const classOf = (scheme: "light" | "dark"): string => (typeof datum.formClass === "function" ? datum.formClass({ colorScheme: scheme, locale: "en" }) : "");
    const form = () => root.querySelector("form")!;
    expect(form().className).toContain(classOf("light"));
    element.colorScheme = "dark";
    await element.painted();
    expect(classOf("dark")).not.toBe(classOf("light"));
    for (const name of classOf("dark").split(/\s+/)) {
      expect(form().classList.contains(name)).toBe(true);
    }
    expect(element.live).toBe(live);
  });
});

describe("<datum-form-renderer> builder settings", () => {
  it("wraps each field and draws empty slots through the canvas hooks, and draws again when they change", async () => {
    const definition = definitionOf([name(), { id: "box", type: "fieldset", configuration: { label: "Box" }, children: { content: [] } } as ComponentNode]);
    const { element, root } = await mount(runtimeFor(definition));
    const live = element.live;
    const seen: string[] = [];
    element.canvasHooks = {
      decorateField: (model, content) => {
        seen.push(model.id);
        return html`<div data-canvas-node=${model.id}>${content}</div>`;
      },
      emptySlot: ({ containerId, slotId }) => html`<p data-drop-zone=${`${containerId}:${slotId}`}>Drop here</p>`
    };
    await element.painted();
    expect(seen).toContain("name");
    // The hook's drawing sits inside the field's wrapper, which keeps the DOM contract.
    expect(wrapper(root, "name")?.querySelector('[data-canvas-node="name"]')).not.toBeNull();
    expect(element.live).toBe(live);
    element.canvasHooks = undefined;
    await element.painted();
    expect(root.querySelector("[data-canvas-node]")).toBeNull();
  });

  it("draws the components a rule hides only while showHiddenComponents is on", async () => {
    const definition = definitionOf([name(), { id: "secret", type: "text", configuration: { label: "Secret", hidden: true } }]);
    const { element, root } = await mount(runtimeFor(definition));
    expect(wrapper(root, "secret")).toBeNull();
    element.showHiddenComponents = true;
    await element.painted();
    expect(wrapper(root, "secret")).not.toBeNull();
    element.showHiddenComponents = false;
    await element.painted();
    expect(wrapper(root, "secret")).toBeNull();
  });

  it("draws a data grid's template as its one row, children at their own ids and no row button, under dataGridRows template", async () => {
    const grid = {
      id: "people",
      type: "dataGrid",
      configuration: { label: "People" },
      children: { content: [{ id: "who", type: "text", configuration: { label: "Who" } }] }
    } as ComponentNode;
    const runtime = runtimeFor(definitionOf([grid]));
    runtime.addRow("people");
    runtime.addRow("people");
    const { element, root } = await mount(runtime);
    const rows = () => Array.from(root.querySelectorAll<HTMLElement>('[data-component-id="who"]'));
    const entries = runtime.rows("people").length;
    expect(entries).toBeGreaterThan(1);
    expect(rows().map((row) => row.getAttribute("data-value-path"))).toEqual(Array.from({ length: entries }, (_, index) => `people[${index}].who`));
    const buttons = () => Array.from(root.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(buttons().some((text) => text?.startsWith("Add"))).toBe(true);

    element.dataGridRows = "template";
    await element.painted();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.getAttribute("data-value-path")).not.toMatch(/\[\d+\]/);
    expect(buttons().some((text) => text?.startsWith("Add") || text?.startsWith("Remove"))).toBe(false);
    expect(root.querySelector('[data-container-id="people"]')).not.toBeNull();
  });

  it("adopts extraStyles after the renderer's own sheets, changes them in place, and drops them when emptied", async () => {
    // A root that takes no constructed sheets: the rules are a <style> after the renderer's own.
    const restoreSheets = hideConstructedSheets();
    onTestFinished(restoreSheets);
    const { element, root } = await mount(runtimeFor(definitionOf([name()])));
    element.extraStyles = ".canvas { outline: 1px solid red; }";
    const extra = () => root.querySelector<HTMLStyleElement>("style[data-datum-extra]");
    expect(extra()?.textContent).toContain(".canvas");
    const own = Array.from(root.children).filter((child) => child.matches("style[data-datum-live]"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.at(-1)!.compareDocumentPosition(extra()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    element.extraStyles = ".canvas { outline: none; }";
    expect(root.querySelectorAll("style[data-datum-extra]")).toHaveLength(1);
    expect(extra()?.textContent).toContain("outline: none");
    element.extraStyles = "";
    expect(extra()).toBeNull();
  });
});

describe("<datum-form-renderer> answers and checks", () => {
  it("checks a field as it is left only after its error has shown (validateOn commitAfterError, the default)", async () => {
    const runtime = runtimeFor(definitionOf([name(), { id: "city", type: "text", configuration: { label: "City", required: true } }]));
    const { element, root } = await mount(runtime);
    // First leave: no check, so no error, though the field is empty and required.
    type(control(root, "city")!, "");
    await element.painted();
    expect(wrapper(root, "city")?.hasAttribute("data-invalid")).toBe(false);

    await element.validate({ focus: false });
    await element.painted();
    expect(wrapper(root, "name")?.hasAttribute("data-invalid")).toBe(true);
    expect(control(root, "name")?.getAttribute("aria-invalid")).toBe("true");

    // Answered and left: the field is checked again on its own and its error goes.
    type(control(root, "name")!, "Ada");
    await until(() => !wrapper(root, "name")?.hasAttribute("data-invalid"));
    expect(runtime.errors().some((error) => error.componentId === "name")).toBe(false);
    // The other field's error stands: only the path left was checked.
    expect(wrapper(root, "city")?.hasAttribute("data-invalid")).toBe(true);
  });

  it("leaves a shown error until the next whole check under validateOn submit", async () => {
    const runtime = runtimeFor(definitionOf([name()], {}, { validateOn: "submit" }));
    const { element, root } = await mount(runtime);
    await element.validate({ focus: false });
    await element.painted();
    expect(wrapper(root, "name")?.hasAttribute("data-invalid")).toBe(true);
    type(control(root, "name")!, "Ada");
    await element.painted();
    expect(wrapper(root, "name")?.hasAttribute("data-invalid")).toBe(true);
    await element.validate({ focus: false });
    await element.painted();
    expect(wrapper(root, "name")?.hasAttribute("data-invalid")).toBe(false);
  });

  it("marks a field pending while an async check of its path runs", async () => {
    let answer: (result: ValidationResult) => void = () => undefined;
    const stage: ValidationStage = {
      id: "email-taken",
      version: "1",
      kind: "async",
      paths: () => ["email"],
      validate: () =>
        new Promise<ValidationResult>((resolve) => {
          answer = resolve;
        })
    };
    const definition = definitionOf([{ id: "email", type: "text", configuration: { label: "Email" } }]);
    const runtime = runtimeFor(definition, [stage]);
    const { element, root } = await mount(runtime);
    // An error already shown on the field: leaving it checks it (the default validateOn).
    runtime.setErrors([{ componentId: "email", code: "email.taken", message: "Taken" }]);
    await element.painted();
    type(control(root, "email")!, "ada@example.com");
    await until(() => wrapper(root, "email")?.hasAttribute("data-pending"));
    expect(wrapper(root, "email")?.getAttribute("aria-busy")).toBe("true");
    answer({ errors: [] });
    await until(() => !wrapper(root, "email")?.hasAttribute("data-pending"));
    expect(wrapper(root, "email")?.getAttribute("aria-busy")).toBeNull();
  });

  it("takes no answer while read-only and draws the stored one back", async () => {
    const runtime = runtimeFor(definitionOf([name()]));
    runtime.setValue("name", "Ada");
    const { element, root } = await mount(runtime, (el) => {
      el.mode = "readonly";
    });
    expect(wrapper(root, "name")?.hasAttribute("data-readonly")).toBe(true);
    const input = control(root, "name")!;
    input.value = "Grace";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await element.painted();
    expect(runtime.formValues().name).toBe("Ada");
    expect(control(root, "name")?.value).toBe("Ada");
  });

  it("stores a picked file through the host's file storage", async () => {
    const store = vi.fn(async (file: File) => ({ name: file.name, type: file.type, size: file.size, storage: "bucket", url: `https://files.example/${file.name}` }));
    const definition = definitionOf([{ id: "doc", type: "file", configuration: { label: "Document", storage: "bucket" } }]);
    const runtime = runtimeFor(definition);
    const { element, root } = await mount(runtime, (el) => {
      el.fileStorage = createFileStorageResolver([{ kind: "bucket", store }]);
    });
    const input = control(root, "doc", 'input[type="file"]')!;
    const file = new File(["%PDF"], "report.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => store.mock.calls.length > 0);
    await until(() => (runtime.formValues().doc as { name?: string } | undefined)?.name === "report.pdf");
    await element.painted();
    expect(store.mock.calls[0]?.[0]).toBe(file);
  });
});

describe("<datum-form-renderer> host state", () => {
  it("draws the form busy while submitting, and takes it back when the submission ends", async () => {
    const { element, root } = await mount(runtimeFor(definitionOf([name()])));
    element.submitting = true;
    await element.painted();
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(wrapper(root, "name")?.hasAttribute("inert")).toBe(true);
    element.submitting = false;
    await element.painted();
    expect(root.querySelector("form")?.hasAttribute("aria-busy")).toBe(false);
    expect(wrapper(root, "name")?.hasAttribute("inert")).toBe(false);
  });

  it("applies a submission already in flight when the form is mounted", async () => {
    const { root } = await mount(runtimeFor(definitionOf([name()])), (el) => {
      el.submitting = true;
    });
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  });

  it("moves focus to the host's notice when asked", async () => {
    const { element, root } = await mount(runtimeFor(definitionOf([name()])));
    element.notice = { kind: "success", title: "Received", message: "Thank you." };
    element.focusNotice();
    await until(() => root.activeElement !== null);
    expect(root.activeElement?.textContent).toContain("Thank you.");
  });

  it("shows the loading line until there is a form, and again once its runtime is taken away", async () => {
    defineDatumFormRendererElement();
    const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
    document.body.append(element);
    const root = element.shadowRoot!;
    expect(root.querySelector("p")?.textContent).toBe("Loading form…");
    element.runtime = runtimeFor(definitionOf([name()]));
    await element.painted();
    expect(root.textContent).not.toContain("Loading form…");
    expect(wrapper(root, "name")).not.toBeNull();
    element.runtime = undefined;
    expect(wrapper(root, "name")).toBeNull();
    expect(element.live).toBeUndefined();
    await element.painted();
    expect(root.textContent).toContain("Loading form…");
  });
});

describe("<datum-form-renderer> containers", () => {
  const steps = (): ComponentNode =>
    ({
      id: "wizard",
      type: "steps",
      configuration: {},
      children: {
        content: [
          { id: "one", type: "step", configuration: { label: "One" }, children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }] } },
          { id: "two", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "second", type: "text", configuration: { label: "Second" } }] } }
        ]
      }
    }) as ComponentNode;

  /** The steps shown: each step's container outside every hidden panel. */
  const shown = (root: ShadowRoot): string[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-kind="step"][data-container-id]'))
      .filter((step) => step.closest("[hidden]") === null)
      .map((step) => step.dataset.containerId ?? "");

  it("opens the step a component sits on for revealComponent, and moves no focus (the builder canvas and an agent reveal while someone else holds it)", async () => {
    const { element, root } = await mount(runtimeFor(definitionOf([steps()])));
    const holder = document.createElement("button");
    document.body.append(holder);
    holder.focus();
    expect(shown(root)).toEqual(["one"]);
    element.revealComponent("second");
    await until(() => shown(root).includes("two"));
    expect(root.activeElement).toBeNull();
    expect(document.activeElement).toBe(holder);
    // A step itself, by its own id.
    element.revealComponent("one");
    await until(() => shown(root).includes("one"));
    expect(root.activeElement).toBeNull();
  });
});

describe("<datum-form-renderer> journeys and the language switch", () => {
  function journey(): FormDefinition {
    return definitionOf(
      [
        { id: "first", type: "text", configuration: { label: "First answer" } },
        { id: "second", type: "text", configuration: { label: "Second answer" } }
      ],
      {
        journey: {
          opensAs: "journey",
          defaultJourneyId: "flow",
          journeys: [{ id: "flow", pages: [{ id: "one", title: "Page one", components: ["first"] }, { id: "two", title: "Page two", components: ["second"] }] }]
        }
      } as Partial<FormDefinition>
    );
  }

  const heading = (root: ShadowRoot) => root.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
  const button = (root: ShadowRoot, label: string) => Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);

  it("moves on through the runtime on Continue, and reports the last page's Submit as the form's action", async () => {
    const runtime = runtimeFor(journey());
    const actions: unknown[] = [];
    const { element, root } = await mount(runtime, (el) => {
      el.addEventListener("datum-form-action", (event) => actions.push((event as CustomEvent).detail));
    });
    expect(heading(root)?.textContent).toContain("Page one");
    button(root, "Continue")!.click();
    await until(() => heading(root)?.textContent?.includes("Page two"));
    await element.painted();
    expect(root.activeElement).toBe(heading(root));
    button(root, "Submit")!.click();
    await until(() => actions.length > 0);
    expect(actions[0]).toEqual({ componentId: "root", action: "submit", journey: { journeyId: "flow", pageId: "two" } });
  });

  it("says the page is a redirect until the next page change", async () => {
    const runtime = runtimeFor(journey());
    const { element, root } = await mount(runtime, (el) => {
      el.pageRedirected = true;
    });
    const status = () => Array.from(root.querySelectorAll('[role="status"]')).find((line) => (line.textContent ?? "").trim() !== "");
    await until(() => status());
    runtime.setValues({ first: "A" });
    expect((await runtime.nextPage()).ok).toBe(true);
    await element.painted();
    expect(element.pageRedirected).toBe(false);
    expect(status()).toBeUndefined();
  });

  it("switches the locale through the runtime from the switcher, and says what came of it", async () => {
    const definition = definitionOf([name()], {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr-CA", label: "Français" }] }
    } as Partial<FormDefinition>);
    const runtime = runtimeFor(definition);
    const applied: string[] = [];
    const rejected: string[] = [];
    const { element, root } = await mount(runtime, (el) => {
      el.chrome = { header: [{ type: "language-switcher" }] };
      el.addEventListener("datum-locale-applied", (event) => applied.push((event as CustomEvent<{ locale: string }>).detail.locale));
      el.addEventListener("datum-locale-rejected", (event) => rejected.push((event as CustomEvent<{ locale: string }>).detail.locale));
    });
    const select = Array.from(root.querySelectorAll("select")).find((candidate) => candidate.closest("[data-component-id]") === null)!;
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await element.painted();
    expect(applied).toEqual(["fr-CA"]);
    expect(runtime.state().locale).toBe("fr-CA");
    expect(root.querySelector("form")?.getAttribute("lang")).toBe("fr-CA");
    expect(rejected).toEqual([]);
  });
});
