/*
 * Shared set-up for the tests of Datum's own drawing of the chrome, the lines around the fields,
 * the buttons, files, signatures and static blocks: the Datum parts as a binding and a mount
 * through `mountLive` with the renderer's modules; `drawDatum` mounts a form with the whole Datum
 * binding. Not a test file.
 */
import { vi } from "vitest";

import type { ValidationStage } from "../form-engine/core/schema/contracts.js";
import { normalizeDataGrids } from "../form-engine/core/schema/data-grid.js";
import type { FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import type { BindingErrorDetail, FieldAdapter, LiveBinding, TextFieldState } from "../form-engine/render/live/contract.js";
import { createDatumChromeFiles, type DatumChromeFilesOptions } from "../form-engine/render/live/datum/chrome-files.js";
import { createDatumBinding, createDatumFeatures, type DatumBindingOptions, type DatumFeatureOptions } from "../form-engine/render/live/datum/options.js";
import { lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveContext, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";

const { html, nothing, live, ifDefined } = lit;

/** A text box with a label, an error line and its ids: enough of a field for a summary to link to. */
export const textStandIn: FieldAdapter<TextFieldState> = {
  kind: "field",
  name: "stand-in text",
  capabilities: { notice: "drawn", pending: "degraded", tooltip: "degraded", hideLabel: "drawn" },
  template: (s, on) =>
    html`<label id=${s.labelId} for=${s.id}>${s.label}</label>
      <input id=${s.id} .value=${live(s.value)} aria-invalid=${ifDefined(s.invalid ? "true" : undefined)} aria-describedby=${ifDefined(s.describedBy.length > 0 ? s.describedBy.join(" ") : undefined)} @input=${(event: Event) => on.input((event.target as HTMLInputElement).value)} @change=${() => on.commit()} />
      ${s.errors.length > 0 ? html`<p id=${ifDefined(s.errorId)}>${s.message}</p>` : nothing}`
};

/** The Datum parts as a binding (plus a text stand-in), the way the binding assembly spreads them. */
export function partsBinding(options: DatumChromeFilesOptions = {}, extra: Partial<LiveBinding> = {}): LiveBinding {
  const parts = createDatumChromeFiles(options);
  return { id: "datum-parts", label: "Datum parts", ...parts, components: { ...parts.components, text: textStandIn }, ...extra };
}

export function definitionOf(children: ComponentNode[], extra: Partial<FormDefinition> = {}, rootConfiguration: Record<string, unknown> = {}): FormDefinition {
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration: rootConfiguration, children: { content: children } }, ...extra };
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
  live: () => LiveContext;
  events: (type: string) => CustomEvent[];
}

const forms: LiveForm[] = [];

function probe(): { feature: LiveFeature; context: () => LiveContext } {
  let held: LiveContext | undefined;
  return {
    feature: {
      id: "probe",
      start(context) {
        held = context;
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

export async function mounted(
  definition: FormDefinition,
  options: Partial<LiveMountOptions> & { runtime?: FormRuntime; parts?: DatumChromeFilesOptions } = {}
): Promise<Mounted> {
  const runtime = options.runtime ?? runtimeOf(definition);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const errors: BindingErrorDetail[] = [];
  const heard = new Map<string, CustomEvent[]>();
  host.addEventListener("datum-binding-error", (event) => errors.push((event as CustomEvent<BindingErrorDetail>).detail));
  for (const type of ["datum-form-action", "datum-locale-applied", "datum-locale-rejected"]) {
    host.addEventListener(type, (event) => heard.set(type, [...(heard.get(type) ?? []), event as CustomEvent]));
  }
  const held = probe();
  const { parts, ...mountOptions } = options;
  const form = mountLive(root, {
    binding: partsBinding(parts),
    ...mountOptions,
    features: [held.feature, ...(options.features ?? [])],
    runtime
  });
  forms.push(form);
  await form.ready;
  return { runtime, host, root, form, errors, live: held.context, events: (type) => heard.get(type) ?? [] };
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
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}

export const wrapper = (root: ShadowRoot, id: string): HTMLElement => root.querySelector<HTMLElement>(`.datum-live-field[data-component-id="${id}"]`) as HTMLElement;

// ── The whole Datum binding ───────────────────────────────────────────────────────────────

/** A form mounted with the Datum binding (`options`) and the renderer modules it comes with, drawn and settled. */
export async function drawDatum(
  definition: FormDefinition,
  options: DatumBindingOptions = {},
  mount: Omit<Partial<LiveMountOptions>, "features" | "runtime"> & { runtime?: FormRuntime; featureOptions?: DatumFeatureOptions; extraFeatures?: LiveFeature[] } = {}
): Promise<Mounted> {
  const { featureOptions, extraFeatures, ...rest } = mount;
  const binding = createDatumBinding(options);
  const m = await mounted(definition, { binding, datum: binding, features: [...createDatumFeatures(options, featureOptions), ...(extraFeatures ?? [])], ...rest });
  await settled(m.form);
  return m;
}

export interface DrawnMarkup extends Mounted {
  /** The drawn form's inner HTML. */
  html: string;
  /** Its text, whitespace collapsed. */
  text: string;
}

/**
 * A form tree (or the children of an empty root) drawn by the Datum binding in `locale`, with
 * `values` set first: what a test that asserts what the render model comes to on the page reads.
 */
export async function markupOf(
  tree: ComponentNode | ComponentNode[],
  options: {
    locale?: string;
    translations?: FormTranslations;
    values?: Record<string, unknown>;
    mode?: LiveMountOptions["mode"];
    binding?: DatumBindingOptions;
    definition?: Partial<FormDefinition>;
    /** More mount options (the form's `texts`). */
    mount?: Omit<Partial<LiveMountOptions>, "features" | "runtime">;
  } = {}
): Promise<DrawnMarkup> {
  const locale = options.locale ?? "en";
  const base = definitionOf(Array.isArray(tree) ? tree : []);
  const definition: FormDefinition = {
    ...base,
    ...(Array.isArray(tree) ? {} : { root: tree }),
    ...(options.translations ? { translations: options.translations } : {}),
    ...(locale !== "en"
      ? { localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: locale, label: locale }] } }
      : {}),
    ...options.definition
  };
  const runtime = runtimeOf(definition);
  if (locale !== "en") {
    runtime.setLocale(locale);
  }
  for (const [path, value] of Object.entries(options.values ?? {})) {
    runtime.setValue(path, value);
  }
  const m = await drawDatum(definition, options.binding ?? {}, { runtime, ...options.mount, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  return Object.assign(m, { html: bodyHtml(m), text: bodyText(m) });
}

/** The text of the drawn form, its whitespace collapsed. */
export function bodyText(m: Pick<Mounted, "root">): string {
  return (m.root.querySelector("form")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The inner HTML of the drawn form, without the template engine's comment markers. */
export function bodyHtml(m: Pick<Mounted, "root">): string {
  return (m.root.querySelector("form")?.innerHTML ?? "").replace(/<!--[\s\S]*?-->/g, "");
}

/** Attributes the old string markup carried on controls that the wrapper or the renderer's modules own now. */
export const OWNED_BY_RENDERER: readonly string[] = ["data-component-id", "data-value-path", "data-file-remove", "data-file-download", "data-focus-error", "data-focus-field"];

/**
 * A node as a comparable string: tag, attributes (sorted, minus `ignore`), children, text with
 * its whitespace collapsed; comments (the template engine's markers) are left out.
 */
export function shape(node: Node, ignore: readonly string[] = OWNED_BY_RENDERER): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ").trim();
  }
  if (!(node instanceof Element)) {
    return "";
  }
  const attributes = Array.from(node.attributes)
    .filter((attribute) => !ignore.includes(attribute.name))
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
    .sort()
    .join(" ");
  const children = Array.from(node.childNodes)
    .map((child) => shape(child, ignore))
    .filter((part) => part !== "")
    .join(" ");
  return `<${node.localName}${attributes === "" ? "" : ` ${attributes}`}>${children}</${node.localName}>`;
}
