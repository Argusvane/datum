import { vi } from "vitest";

import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { EagerJourneyRenderKit } from "../form-engine/render/core/journey-render-kit-eager.js";
import type { BindingErrorDetail, FieldAdapter, LiveBinding, TextFieldState } from "../form-engine/render/live/contract.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveContext, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

/*
 * Shared setup for the tests of the renderer's modules that draw containers and the form's chrome
 * (summary, tabs, data grid, journey page): a small design-system binding drawn through
 * createBinding(lit), a runtime over a definition, and a mount that records binding errors.
 */

/** A text adapter that shows what the renderer handed it: the hidden label, the error, the ids. */
export function textAdapter({ html, nothing, live, ifDefined }: Lit): FieldAdapter<TextFieldState> {
  return {
    kind: "field",
    name: "ds-text",
    capabilities: { notice: "drawn", pending: "drawn", tooltip: "degraded", hideLabel: "drawn", characterCount: "drawn" },
    template: (s, on) =>
      html`<label id=${s.labelId} for=${s.id} data-hidden=${ifDefined(s.hideLabel ? "true" : undefined)}>${s.label}</label>
        <input
          id=${s.id}
          .value=${live(s.value)}
          ?readonly=${s.readOnly}
          ?disabled=${s.disabled}
          aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
          @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, { interim: true })}
          @change=${() => on.commit()}
        />
        ${s.errors.length > 0 ? html`<p id=${ifDefined(s.errorId)} class="error">${s.message}</p>` : nothing}`
  };
}

/** A button the form owns (a journey page's own submit): counts its presses. */
export const presses: string[] = [];
export function buttonAdapter({ html }: Lit): FieldAdapter {
  return {
    kind: "field",
    name: "ds-button",
    template: (s) => html`<button type="button" id=${s.id} @click=${() => presses.push(s.componentId)}>${s.label}</button>`
  };
}

export function createBinding(l: Lit, extra: Partial<LiveBinding> = {}): LiveBinding {
  return { id: "test-ds", label: "Test DS", components: { text: textAdapter(l), button: buttonAdapter(l) }, ...extra };
}

export function definitionOf(children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content: children } }, ...extra };
}

export function runtimeOf(definition: FormDefinition, stages?: ValidationStage[]): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline(stages ?? [createFieldConstraintsStage(normalizeDataGrids(definition.root))])
  });
}

export interface Mounted {
  runtime: FormRuntime;
  host: HTMLElement;
  root: ShadowRoot;
  form: LiveForm;
  errors: BindingErrorDetail[];
  /** The live context the renderer handed its features. */
  live: () => LiveContext;
  /** Every custom event of this name the host heard. */
  events: (type: string) => CustomEvent[];
}

const forms: LiveForm[] = [];

/** A feature that keeps the live context for a test to drive (`focusErrors()`, `focusField()`, `setPrinting()`). */
function probe(): { feature: LiveFeature; context: () => LiveContext } {
  let held: LiveContext | undefined;
  return {
    feature: {
      id: "probe",
      start(live) {
        held = live;
      }
    },
    context: () => {
      if (!held) {
        throw new Error("the form has not started");
      }
      return held;
    }
  };
}

export function mountOf(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Mounted {
  const runtime = options.runtime ?? runtimeOf(definition);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const errors: BindingErrorDetail[] = [];
  const heard = new Map<string, CustomEvent[]>();
  host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
  for (const type of ["datum-form-action"]) {
    host.addEventListener(type, (event) => heard.set(type, [...(heard.get(type) ?? []), event as CustomEvent]));
  }
  const held = probe();
  const form = mountLive(root, {
    binding: createBinding(lit),
    journeyKit: EagerJourneyRenderKit,
    ...options,
    features: [held.feature, ...(options.features ?? [])],
    runtime
  });
  forms.push(form);
  return { runtime, host, root, form, errors, live: held.context, events: (type) => heard.get(type) ?? [] };
}

export async function mounted(definition: FormDefinition, options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}): Promise<Mounted> {
  const m = mountOf(definition, options);
  await m.form.ready;
  return m;
}

/** Lets queued work run (a macrotask drains the microtasks first), then waits for the draws. */
export async function settled(form: LiveForm): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
}

export function unmountAll(): void {
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  presses.length = 0;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

export const wrapper = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`) as HTMLElement;
export const inputOf = (root: ShadowRoot, id: string): HTMLInputElement => wrapper(root, id).querySelector("input") as HTMLInputElement;

export function type(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** The element focus is on, inside the shadow root. */
export const activeIn = (root: ShadowRoot): Element | null => root.activeElement;
