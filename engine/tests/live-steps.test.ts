// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type { FieldAdapter, GroupAdapter, LiveBinding, StepsAdapter, TextFieldState } from "../form-engine/render/live/contract.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveContext, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";
import { defaultStepsAdapter, stepsFeature } from "../form-engine/render/live/steps.js";

/*
 * The steps container (render/live/steps.ts) and the group items a button group draws
 * from (mount.ts): which step shows (the runtime's when it navigates, the renderer's where it
 * cannot), Continue checking the step on show, Back, the indicator, opening a step for a field
 * in it, the builder canvas's free switching, the flat review and print, and Datum's own look
 * as the fallback.
 */

// ── A binding drawn through createBinding(lit) ─────────────────────────────────────────────

function textAdapter({ html, live, ifDefined, nothing }: Lit): FieldAdapter<TextFieldState> {
  return {
    kind: "field",
    name: "ds-text",
    template: (s, on) =>
      html`<label id=${s.labelId} for=${s.id}>${s.label}</label>
        <input id=${s.id} .value=${live(s.value)} aria-invalid=${ifDefined(s.invalid ? "true" : undefined)} @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })} @change=${() => on.commit()} />
        ${s.errors.length > 0 ? html`<p class="error">${s.message}</p>` : nothing}`
  };
}

function buttonAdapter({ html }: Lit): FieldAdapter {
  return { kind: "field", name: "ds-button", template: (s) => html`<button type="button" id=${s.id}>${s.label}</button>` };
}

function stepsAdapter({ html, nothing }: Lit): StepsAdapter {
  return {
    kind: "steps",
    name: "ds-steps",
    template: (s) => html`<div class="ds-steps" data-flat=${s.flat ? "yes" : nothing} data-active=${s.activeStepId ?? ""}>
      ${s.flat
        ? nothing
        : html`<ol>${s.steps.map(
            (step) => html`<li data-step=${step.id} data-status=${step.status} data-selectable=${step.select ? "yes" : "no"}><button type="button" class="entry" @click=${() => step.select?.()}>${step.label}</button></li>`
          )}</ol>
          <p class="progress">${s.progress}</p>`}
      ${s.eachStep(
        (step) => html`<section class="panel" data-panel=${step.id} ?hidden=${!step.shown}><h2 id=${step.headingId} tabindex="-1" data-tag=${step.tag}>${step.label}</h2>${step.content}</section>`
      )}
      ${s.others}
      ${s.back ? html`<button type="button" class="back" @click=${() => s.back?.go()}>${s.back.label}</button>` : nothing}
      ${s.next ? html`<button type="button" class="next" aria-disabled=${s.busy ? "true" : nothing} @click=${() => s.next?.go()}>${s.next.label}</button>` : nothing}
    </div>`
  };
}

function createTestBinding(l: Lit, extra: Partial<LiveBinding> = {}): LiveBinding {
  return { id: "test-ds", label: "Test DS", components: { text: textAdapter(l), button: buttonAdapter(l), steps: stepsAdapter(l) }, ...extra };
}

/** Datum's stand-in: a container adapter and nothing for steps, so the renderer's own look draws them. */
function createDatumStandIn(l: Lit): LiveBinding {
  const { html, nothing } = l;
  const fieldset: GroupAdapter = {
    kind: "group",
    name: "datum-fieldset",
    template: (s, children) => html`<fieldset>${s.legend !== undefined ? html`<legend>${s.legend}</legend>` : nothing}${children}</fieldset>`
  };
  return { id: "datum", label: "Datum", components: { text: textAdapter(l), fieldset } };
}

// ── Forms and mounts ───────────────────────────────────────────────────────────────────────

function steppedForm(children?: ComponentNode[]): FormDefinition {
  return {
    id: "f",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "journey",
            type: "steps",
            configuration: {},
            children: {
              content: [
                { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "name", type: "text", configuration: { label: "Name", required: true } }] } },
                { id: "where", type: "step", configuration: { label: "Where" }, children: { content: [{ id: "city", type: "text", configuration: { label: "City", required: true } }] } },
                { id: "done", type: "step", configuration: { label: "Done" }, children: { content: [{ id: "note", type: "text", configuration: { label: "Note" } }] } }
              ]
            }
          },
          ...(children ?? [])
        ]
      }
    },
    localization: { defaultLocale: "en" }
  };
}

/** Required text fields are reported blank, like the field-constraints stage does. */
const requiredStage: ValidationStage = {
  id: "required",
  version: "1.0.0",
  validate: (context) => ({
    errors: ["name", "city"]
      .filter((id) => context.values[id] === undefined || context.values[id] === "")
      .map((id) => ({ code: "validation.required", componentId: id, stage: "field" as const, source: "client" as const }))
  })
};

function runtimeOf(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([requiredStage]) });
}

/** The runtime as a host that cannot navigate sees it (the builder's preview): no `navigate`, no `markStepCompleted`. */
function withoutNavigation(runtime: FormRuntime): FormRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "navigate" || property === "markStepCompleted") {
        return undefined;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

interface Mounted {
  runtime: FormRuntime;
  host: HTMLElement;
  root: ShadowRoot;
  form: LiveForm;
  live: () => LiveContext;
}

const forms: LiveForm[] = [];

async function mounted(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime; blind?: boolean } = {}): Promise<Mounted> {
  const real = options.runtime ?? runtimeOf(definition);
  const runtime = options.blind ? withoutNavigation(real) : real;
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  let context: LiveContext | undefined;
  const grab: LiveFeature = {
    id: "grab",
    start: (live) => {
      context = live;
    }
  };
  const form = mountLive(root, {
    binding: createTestBinding(lit),
    datum: createDatumStandIn(lit),
    ...options,
    features: [stepsFeature(), grab, ...(options.features ?? [])],
    runtime
  });
  forms.push(form);
  await form.ready;
  return { runtime: real, host, root, form, live: () => context as LiveContext };
}

async function settled(form: LiveForm): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
}

/** Waits (in macrotasks) until `check` holds; the moves are async. */
async function until(form: LiveForm, check: () => boolean): Promise<void> {
  // At least one settle: the move that drew the change has yet to release its busy flag.
  await settled(form);
  for (let round = 0; round < 40 && !check(); round += 1) {
    await settled(form);
  }
}

const panel = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-panel="${id}"]`) as HTMLElement;
const shown = (root: ShadowRoot): string[] => Array.from(root.querySelectorAll<HTMLElement>("[data-panel]")).filter((p) => !p.hidden).map((p) => p.dataset.panel as string);
const input = (root: ShadowRoot, id: string): HTMLInputElement => root.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`)!.querySelector("input") as HTMLInputElement;
const click = (root: ShadowRoot, selector: string): void => (root.querySelector<HTMLElement>(selector) as HTMLElement).click();

function type(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

afterEach(() => {
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

// ── Steps on a runtime that navigates ──────────────────────────────────────────────────────

describe("live steps: a runtime that navigates", () => {
  it("draws every step, shows the first, and gives each step's components a wrapper that names the step", async () => {
    quiet();
    const { root, form } = await mounted(steppedForm());
    expect(shown(root)).toEqual(["about"]);
    expect(Array.from(root.querySelectorAll("[data-panel]")).map((p) => (p as HTMLElement).dataset.panel)).toEqual(["about", "where", "done"]);
    expect(root.querySelector(".progress")?.textContent).toBe("Step 1 of 3");
    expect(Array.from(root.querySelectorAll("li[data-step]")).map((li) => (li as HTMLElement).dataset.status)).toEqual(["active", "upcoming", "upcoming"]);
    // The DOM contract: the container, and each step inside it, carry their ids.
    const container = root.querySelector<HTMLElement>('[data-container-id="journey"]');
    expect(container?.getAttribute("data-kind")).toBe("steps");
    const step = root.querySelector<HTMLElement>('[data-container-id="where"]');
    expect(step?.getAttribute("data-kind")).toBe("step");
    expect(step?.querySelector('[data-component-id="city"]')).not.toBeNull();
    expect(container?.contains(step)).toBe(true);
    expect(form.adapterOf("journey")).toMatchObject({ from: "binding", name: "ds-steps" });
    // The first step has no Back; every step but the last has Continue.
    expect(root.querySelector(".back")).toBeNull();
    expect(root.querySelector(".next")?.textContent).toBe("Continue");
    // The headings carry the step tag the adapter was given.
    expect(root.querySelector<HTMLElement>("#" + CSS.escape(panel(root, "where").querySelector("h2")!.id))?.dataset.tag).toBe("Step 2 of 3");
  });

  it("checks the step on show when Continue is pressed, and goes to its first error instead of advancing", async () => {
    quiet();
    const { root, form, runtime } = await mounted(steppedForm());
    click(root, ".next");
    await until(form, () => root.activeElement === input(root, "name"));
    expect(shown(root)).toEqual(["about"]);
    expect(root.activeElement).toBe(input(root, "name"));
    expect(runtime.errors().map((error) => error.componentId)).toEqual(["name"]);
    expect(root.querySelector(".next")?.getAttribute("aria-disabled")).toBeNull();
    expect(runtime.state().navigation.currentStepId).not.toBe("where");
  });

  it("opens the next step when the step is clean, records the step as completed, and focuses the new step's heading", async () => {
    quiet();
    const { root, form, runtime } = await mounted(steppedForm());
    type(input(root, "name"), "Ada");
    await settled(form);
    click(root, ".next");
    await until(form, () => shown(root)[0] === "where");
    expect(shown(root)).toEqual(["where"]);
    expect(runtime.state().navigation.currentStepId).toBe("where");
    expect([...runtime.state().navigation.completedSteps]).toContain("about");
    expect(Array.from(root.querySelectorAll("li[data-step]")).map((li) => (li as HTMLElement).dataset.status)).toEqual(["completed", "active", "upcoming"]);
    expect(root.querySelector(".progress")?.textContent).toBe("Step 2 of 3");
    expect(root.activeElement).toBe(panel(root, "where").querySelector("h2"));
    // Back opens the previous step with no check, even with this step's field empty.
    click(root, ".back");
    await until(form, () => shown(root)[0] === "about");
    expect(shown(root)).toEqual(["about"]);
    expect(root.activeElement).toBe(panel(root, "about").querySelector("h2"));
  });

  it("offers an indicator entry only for a step already reached, never an upcoming one", async () => {
    quiet();
    const { root, form } = await mounted(steppedForm());
    const selectable = (): string[] => Array.from(root.querySelectorAll<HTMLElement>("li[data-step]")).map((li) => li.dataset.selectable as string);
    expect(selectable()).toEqual(["no", "no", "no"]);
    type(input(root, "name"), "Ada");
    await settled(form);
    click(root, ".next");
    await until(form, () => shown(root)[0] === "where");
    expect(selectable()).toEqual(["yes", "no", "no"]);
    click(root, 'li[data-step="about"] .entry');
    await until(form, () => shown(root)[0] === "about");
    expect(shown(root)).toEqual(["about"]);
    // An upcoming entry does nothing.
    click(root, 'li[data-step="done"] .entry');
    await settled(form);
    expect(shown(root)).toEqual(["about"]);
  });

  it("opens the step that holds a field when the field is focused, and puts it back when the runtime refuses", async () => {
    quiet();
    const { root, form, runtime, live } = await mounted(steppedForm());
    expect(live().focusField("city")).toBe(true);
    await until(form, () => runtime.state().navigation.currentStepId === "where");
    await settled(form);
    expect(shown(root)).toEqual(["where"]);
    expect(root.activeElement).toBe(input(root, "city"));

    // A runtime that refuses the move leaves the step where it was.
    const refusing = runtimeOf(steppedForm());
    vi.spyOn(refusing, "navigate").mockResolvedValue({ ok: false, currentStepId: "about", reason: "gating-rule" } as Awaited<ReturnType<FormRuntime["navigate"]>>);
    const second = await mounted(steppedForm(), { runtime: refusing });
    second.live().focusField("city");
    await settled(second.form);
    await settled(second.form);
    expect(shown(second.root)).toEqual(["about"]);
  });

  it("holds the buttons while a move is in flight and lets only one through", async () => {
    quiet();
    const runtime = runtimeOf(steppedForm());
    let release: (() => void) | undefined;
    const navigate = vi.spyOn(runtime, "navigate").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, currentStepId: "where" } as Awaited<ReturnType<FormRuntime["navigate"]>>);
        })
    );
    const { root, form } = await mounted(steppedForm(), { runtime });
    type(input(root, "name"), "Ada");
    await settled(form);
    click(root, ".next");
    await until(form, () => navigate.mock.calls.length > 0);
    expect(form.root.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
    expect(root.querySelector(".next")?.getAttribute("aria-disabled")).toBe("true");
    click(root, ".next");
    await settled(form);
    expect(navigate).toHaveBeenCalledTimes(1);
    release?.();
    await until(form, () => root.querySelector("form")?.getAttribute("aria-busy") === null);
    expect(root.querySelector("form")?.getAttribute("aria-busy")).toBeNull();
  });
});

// ── Steps on a runtime that cannot navigate ────────────────────────────────────────────────

describe("live steps: in place, where nothing navigates", () => {
  it("switches in place and keeps the shown step across the draws an edit brings", async () => {
    quiet();
    const { root, form, runtime } = await mounted(steppedForm(), { blind: true });
    type(input(root, "name"), "Ada");
    await settled(form);
    click(root, ".next");
    await until(form, () => shown(root)[0] === "where");
    expect(shown(root)).toEqual(["where"]);
    // The step was reached and passed: the indicator says so, and offers it.
    expect(Array.from(root.querySelectorAll("li[data-step]")).map((li) => (li as HTMLElement).dataset.status)).toEqual(["completed", "active", "upcoming"]);
    // A value typed on the second step draws the form again; it stays on the second step.
    type(input(root, "city"), "Ottawa");
    await settled(form);
    expect(shown(root)).toEqual(["where"]);
    // The runtime was never asked to move.
    expect(runtime.state().navigation.currentStepId).not.toBe("where");
  });

  it("opens a step in place for a field focused in it", async () => {
    quiet();
    const { root, form, live } = await mounted(steppedForm(), { blind: true });
    expect(live().focusField("note")).toBe(true);
    await settled(form);
    expect(shown(root)).toEqual(["done"]);
    expect(root.activeElement).toBe(input(root, "note"));
  });

  it("on the builder canvas shows the step an entry names without checking anything", async () => {
    quiet();
    const { root, form, runtime } = await mounted(steppedForm(), {
      blind: true,
      canvasHooks: { decorateField: (_model, content) => content }
    });
    // Nothing reached, yet every entry opens its step; Continue does not validate.
    expect(Array.from(root.querySelectorAll<HTMLElement>("li[data-step]")).map((li) => li.dataset.selectable)).toEqual(["no", "yes", "yes"]);
    click(root, 'li[data-step="done"] .entry');
    await until(form, () => shown(root)[0] === "done");
    expect(shown(root)).toEqual(["done"]);
    click(root, ".back");
    await until(form, () => shown(root)[0] === "where");
    click(root, ".next");
    await until(form, () => shown(root)[0] === "done");
    expect(runtime.errors()).toEqual([]);
  });
});

// ── Review and print ───────────────────────────────────────────────────────────────────────

describe("live steps: a review and a print draw every step", () => {
  it("draws every step shown, with no Back, Continue or entry, in a review", async () => {
    quiet();
    const { root } = await mounted(steppedForm(), { mode: "readonly" });
    expect(root.querySelector(".ds-steps")?.getAttribute("data-flat")).toBe("yes");
    expect(shown(root)).toEqual(["about", "where", "done"]);
    expect(root.querySelector(".back")).toBeNull();
    expect(root.querySelector(".next")).toBeNull();
    expect(root.querySelector("li[data-step]")).toBeNull();
  });

  it("flattens when the form is drawn for printing and pages again afterwards", async () => {
    quiet();
    const { root, form, live } = await mounted(steppedForm());
    expect(shown(root)).toEqual(["about"]);
    live().setPrinting(true);
    expect(live().printing()).toBe(true);
    await settled(form);
    expect(shown(root)).toEqual(["about", "where", "done"]);
    expect(root.querySelector(".next")).toBeNull();
    live().setPrinting(false);
    await settled(form);
    expect(shown(root)).toEqual(["about"]);
    expect(root.querySelector(".next")).not.toBeNull();
  });
});

// ── Datum's look ───────────────────────────────────────────────────────────────────────────

describe("live steps: Datum's look stands in", () => {
  it("draws the steps by the renderer's adapter when neither binding has one, and records it", async () => {
    quiet();
    const { root, form } = await mounted(steppedForm(), { binding: createTestBinding(lit, { components: { text: textAdapter(lit) } }) });
    expect(root.querySelector(".datum-form__steps")).not.toBeNull();
    expect(root.querySelectorAll(".datum-form__step-list > li")).toHaveLength(3);
    expect(root.querySelector(".datum-form__step-progress-text")?.textContent).toBe("Step 1 of 3");
    expect(root.querySelector(".datum-form__step-tag-number")?.textContent).toBe("1");
    const hidden = Array.from(root.querySelectorAll<HTMLElement>(".datum-form__step-panel")).map((p) => p.hidden);
    expect(hidden).toEqual([false, true, true]);
    expect(form.unsupported()).toContain('journey: component "steps"');
    expect(form.adapterOf("journey")).toMatchObject({ from: "renderer", name: "datum-steps" });
    // The default Continue works like any adapter's.
    type(input(root, "name"), "Ada");
    await settled(form);
    click(root, ".datum-form__step-continue");
    await until(form, () => root.querySelector<HTMLElement>(".datum-form__step-panel[data-step-panel='where']")?.hidden === false);
    expect(root.querySelector<HTMLElement>(".datum-form__step-panel[data-step-panel='where']")?.hidden).toBe(false);
    expect(root.querySelector(".datum-form__step-back")).not.toBeNull();
  });

  it("falls back to it, and reports, when the binding's steps template throws", async () => {
    quiet();
    const broken: StepsAdapter = { kind: "steps", name: "broken", template: () => { throw new Error("no steps today"); } };
    const errors: string[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<{ hook: string; message: string }>).detail.hook + ": " + (event as CustomEvent<{ message: string }>).detail.message));
    const root = host.attachShadow({ mode: "open" });
    const form = mountLive(root, { runtime: runtimeOf(steppedForm()), binding: createTestBinding(lit, { components: { text: textAdapter(lit), steps: broken } }), datum: createDatumStandIn(lit), features: [stepsFeature()] });
    forms.push(form);
    await form.ready;
    expect(errors).toEqual(["template: no steps today"]);
    expect(root.querySelector(".datum-form__steps")).not.toBeNull();
    expect(form.adapterOf("journey")).toMatchObject({ from: "renderer", name: "datum-steps" });
    expect(defaultStepsAdapter.kind).toBe("steps");
  });
});

// ── Button groups ──────────────────────────────────────────────────────────────────────────

describe("live groups: the children one by one", () => {
  const actions: ComponentNode = {
    id: "actions",
    type: "button-group",
    configuration: {},
    children: {
      content: [
        { id: "save", type: "button", configuration: { label: "Save" } },
        { id: "cancel", type: "button", configuration: { label: "Cancel" } }
      ]
    }
  };

  it("hands a group adapter each child drawn on its own, keyed, so a list can draw one item per button", async () => {
    quiet();
    const list: GroupAdapter = {
      kind: "group",
      name: "ds-list",
      template: (s) => lit.html`<ul class="ds-button-group" data-count=${s.items.length}>${s.eachItem((item) => lit.html`<li class="ds-item">${item.content}</li>`)}</ul>`
    };
    const { root, form } = await mounted(steppedForm([actions]), { binding: createTestBinding(lit, { components: { text: textAdapter(lit), button: buttonAdapter(lit), steps: stepsAdapter(lit), "button-group": list } }) });
    const group = root.querySelector<HTMLElement>('[data-container-id="actions"]');
    expect(group?.getAttribute("data-kind")).toBe("button-group");
    const items = Array.from(group?.querySelectorAll("ul.ds-button-group > li.ds-item") ?? []);
    expect(items.map((li) => li.querySelector("button")?.textContent)).toEqual(["Save", "Cancel"]);
    expect(group?.querySelector("ul")?.getAttribute("data-count")).toBe("2");
    // Each child's wrapper is inside its own item, with the DOM contract.
    expect(items[0]?.querySelector('[data-component-id="save"]')).not.toBeNull();
    // A later draw keeps the same nodes.
    const save = root.querySelector('[data-component-id="save"]');
    form.redraw();
    expect(root.querySelector('[data-component-id="save"]')).toBe(save);
  });

  it("still gives an adapter that only wants the children the same drawing as before", async () => {
    quiet();
    const plain: GroupAdapter = { kind: "group", name: "ds-plain", template: (_s, children) => lit.html`<div class="ds-plain">${children}</div>` };
    const { root } = await mounted(steppedForm([actions]), { binding: createTestBinding(lit, { components: { text: textAdapter(lit), button: buttonAdapter(lit), steps: stepsAdapter(lit), "button-group": plain } }) });
    expect(Array.from(root.querySelectorAll(".ds-plain button")).map((b) => b.textContent)).toEqual(["Save", "Cancel"]);
  });
});
