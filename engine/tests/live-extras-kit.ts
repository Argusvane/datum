/*
 * Shared set-up for the live renderer's field extras (files, tooltips, notices, sources, the
 * count announcer, interim writes): a binding drawn through createBinding(lit), forms, and a
 * mount that listens for binding errors. Not a test file.
 */
import { vi } from "vitest";

import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type {
  AdapterBehaviour,
  BindingErrorDetail,
  CapabilityAnswers,
  FieldAdapter,
  FieldEvents,
  FileFieldState,
  LiveBinding,
  TextFieldState
} from "../form-engine/render/live/contract.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import { noticesView } from "../form-engine/render/live/notices.js";
import { tooltipView } from "../form-engine/render/live/tooltips.js";
import { mountLive, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";

/** Every `on` an adapter was handed, by instance key. */
export const handed = new Map<string, FieldEvents>();

export interface TextAdapterOptions {
  capabilities?: CapabilityAnswers;
  behaviour?: AdapterBehaviour;
  /** Final writes (a pick) instead of interim ones (typing). */
  final?: boolean;
}

/** Stands in for the per-kind state builder (fields.ts): puts the tooltip and the count on the text state. */
export const textState: LiveFeature = {
  id: "kit-text-state",
  fieldState: (state, node) => (node.model.tooltip !== undefined ? ({ ...state, tooltip: node.model.tooltip } as TextFieldState) : undefined)
};

export function textAdapter({ html, nothing, live, ifDefined }: Lit, options: TextAdapterOptions = {}): FieldAdapter<TextFieldState> {
  const capabilities: CapabilityAnswers = { notice: "drawn", pending: "drawn", tooltip: "drawn", characterCount: "drawn", ...(options.capabilities ?? {}) };
  return {
    kind: "field",
    name: "kit-text",
    capabilities,
    ...(options.behaviour ? { behaviour: options.behaviour } : {}),
    template: (s, on) => {
      handed.set(s.key, on);
      const tip = s.tooltip;
      const bubble = tip !== undefined && tip !== "" && capabilities.tooltip === "drawn" ? tooltipView(s, tip) : nothing;
      return html`<label id=${s.labelId} for=${s.id}>${s.label}</label>${bubble}
        ${s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="hint">${s.hint}</p>` : nothing}
        <input
          id=${s.id}
          .value=${live(s.value)}
          ?readonly=${s.readOnly}
          aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)}
          aria-invalid=${ifDefined(s.invalid ? "true" : undefined)}
          @input=${(event: Event) => on.input((event.target as HTMLInputElement).value, options.final === true ? undefined : { interim: true })}
          @change=${() => on.commit()}
        />
        ${s.errors.length > 0 ? html`<p id=${ifDefined(s.errorId)} class="error">${s.message}</p>` : nothing}
        ${noticesView(s)}`;
    }
  };
}

/** A file field as a design system draws one: a list with Remove and Download, a status region, a drop region and an invisible input. */
export function fileAdapter({ html, nothing, ifDefined }: Lit, announcePicks = true): FieldAdapter<FileFieldState> {
  return {
    kind: "field",
    name: "kit-file",
    template: (s, on) => {
      handed.set(s.key, on);
      return html`<label for=${s.id}>${s.label}</label>
        <div class="face" data-file-button>Choose</div>
        <input
          type="file"
          id=${s.id}
          ?multiple=${s.multiple}
          accept=${ifDefined(s.accept)}
          @change=${(event: Event) => {
            const picker = event.target as HTMLInputElement;
            on.files?.(Array.from(picker.files ?? []));
          }}
        />
        <ul>
          ${s.files.map(
            (file) => html`<li data-file=${file.id}>
              ${file.downloadable ? html`<button type="button" class="download" @click=${() => on.download?.(file.id)}>${file.name}</button>` : html`<span>${file.name}</span>`}
              <button type="button" class="remove" @click=${() => on.remove?.(file.id)}>Remove ${file.name}</button>
            </li>`
          )}
        </ul>
        <span role="status" aria-live="polite" class="status" data-file-status ?data-file-announce=${announcePicks}></span>
        <span role="status" class="drop" data-file-drop-status></span>
        ${s.errors.length > 0 ? html`<p class="error">${s.message}</p>` : nothing}`;
    }
  };
}

export function bindingOf(l: Lit, text: FieldAdapter<TextFieldState> = textAdapter(l), extra: Partial<LiveBinding> = {}): LiveBinding {
  return { id: "kit-ds", label: "Kit DS", components: { text, file: fileAdapter(l), select: selectAdapter(l) }, ...extra };
}

export function selectAdapter({ html, nothing }: Lit): FieldAdapter {
  return {
    kind: "field",
    name: "kit-select",
    template: (s) => html`<label for=${s.id}>${s.label}</label><select id=${s.id} aria-describedby=${s.describedBy.length > 0 ? s.describedBy.join(" ") : nothing}></select>`
  };
}

export function definitionOf(children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: {}, children: { content: children } }, ...extra };
}

export function runtimeOf(definition: FormDefinition, stages?: ValidationStage[]): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline(stages ?? [createFieldConstraintsStage(definition.root)]) });
}

export interface Mounted {
  runtime: FormRuntime;
  host: HTMLElement;
  root: ShadowRoot;
  form: LiveForm;
  errors: BindingErrorDetail[];
}

const forms: LiveForm[] = [];

export async function mounted(
  definition: FormDefinition,
  options: Partial<LiveMountOptions> & { runtime?: FormRuntime } = {}
): Promise<Mounted> {
  const runtime = options.runtime ?? runtimeOf(definition);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const errors: BindingErrorDetail[] = [];
  host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
  const form = mountLive(root, { binding: bindingOf(lit), ...options, runtime });
  forms.push(form);
  await form.ready;
  return { runtime, host, root, form, errors };
}

/** Lets queued work run (a macrotask drains the microtasks first), then waits for the draws. */
export async function settled(form: LiveForm): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
}

export async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const wrapper = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`) as HTMLElement;
export const input = (root: ShadowRoot, id: string): HTMLInputElement => wrapper(root, id).querySelector("input") as HTMLInputElement;

export function type(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** Unmounts every form the kit mounted and clears the page; call from afterEach. */
export function cleanUp(): void {
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  handed.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};
