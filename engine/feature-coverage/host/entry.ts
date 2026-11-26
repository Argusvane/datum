/*
 * The feature-coverage host page's module (bundled from engine source by ../lib/build.mjs): it
 * mounts a corpus fixture through the ENGINE renderer on a `FormRuntime`, and answers the
 * scenarios' questions about the drawn tree as `window.fc`. It mounts in one of two hosts, named
 * by the page's `?host=` query (run.mjs loads the page once per host):
 *
 *   live     `mountLive` with `createDatumBinding()` and `createDatumFeatures()`, the journey page
 *            module for a journey form: the renderer with nothing around it
 *   element  the real `<datum-form-renderer>` (form-renderer-element.ts), given the same runtime,
 *            binding, data sources and journey kit through its public properties, and driven
 *            through its public methods (validate, settleInput, focusNotice, quietNextPageFocus)
 *
 * Every scenario runs in both hosts unchanged.
 *
 * Everything here reads what a person or an assistive technology meets: the composed tree
 * through open shadow roots, ids and references per root, the deep active element, the text of
 * live regions. The renderer's own lists (`fields()`, `tree()`) say only which nodes the form
 * drew; whether each one carries its contract is read from the DOM.
 */
import type { FormError, HostError } from "../../form-engine/core/errors/form-error.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { stringifyComponentPath } from "../../form-engine/core/tree/component-path.js";
import type { ErrorPresentationConfiguration } from "../../form-engine/render/core/render-contracts.js";
import { EagerJourneyRenderKit } from "../../form-engine/render/core/journey-render-kit-eager.js";
import type { PresentationNode } from "../../form-engine/render/core/presentation-tree.js";
import type { LiveMode } from "../../form-engine/render/live/contract.js";
import { createJourneyPageFeature, type JourneyPageFeature } from "../../form-engine/render/live/journey-page.js";
import type { LiveContext, LiveFeature, LiveForm } from "../../form-engine/render/live/mount.js";
import { DATUM_FORM_RENDERER_TAG, defineDatumFormRendererElement, type DatumFormRendererElement } from "../../form-engine/render/web-component/form-renderer-element.js";
import { registerBinding } from "../../form-engine/render/live/binding-registry.js";
import { createDatumBinding, createDatumFeatures, mountLive, type DatumBindingOptions } from "../../form-engine/render/live/renderer.js";
import { compileFormDefinition, FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { adapterOverrides } from "./adapters.js";
import { prepareBehaviours, type BehaviourOptions, type Prepared } from "./behaviours.js";
import { FIXTURES } from "./fixtures.js";

// ── Types the scenarios read ───────────────────────────────────────────────────────────────

export interface LoadOptions {
  fixture: string;
  mode?: LiveMode;
  locale?: string;
  /** Answers written through the runtime before the first draw. */
  preset?: Record<string, unknown>;
  /** Options of the Datum binding (its seams: controls.errorFocus and the rest). */
  binding?: DatumBindingOptions;
  /**
   * The date's part order as a function cannot cross into the page: a fixed order, or one by the
   * locale's first subtag (`{ en: [...], default: [...] }`), is turned into `fieldOrder.date` here.
   */
  dateOrder?: string[] | Record<string, string[]>;
  errorPresentation?: ErrorPresentationConfiguration;
  /** Behaviour a definition cannot hold (async checks, slow sources, warnings): by recipe name, see behaviours.ts. */
  behaviours?: BehaviourOptions;
  /** Adapters put over Datum's by name (adapters.ts): marks a design system draws and Datum does not. */
  adapters?: string[];
}

/** An element as a report names it. */
export interface Descriptor {
  tag: string;
  id?: string;
  role?: string;
  type?: string;
  /** The nearest field wrapper's, through shadow roots. */
  componentId?: string;
  valuePath?: string;
  /** The nearest container wrapper's. */
  containerId?: string;
  /** `summary` when inside the error summary. */
  region?: string;
  text?: string;
}

/** A broken rule, with where it broke. */
export interface Problem {
  rule: string;
  message: string;
  at?: Descriptor;
}

export interface Announcement {
  text: string;
  politeness: string;
  at: number;
}

/** What the checks read of the renderer's context: the form's own list of what it drew (`LiveContext`, or `LiveForm` behind the element). */
type Probe = Pick<LiveContext, "fields" | "tree" | "request" | "focusErrors">;

/** Which host this page mounts forms in. */
const HOST: "live" | "element" = new URLSearchParams(location.search).get("host") === "element" ? "element" : "live";

interface Mounted {
  host: HTMLElement;
  /** The element, in the `element` host. */
  element: DatumFormRendererElement | undefined;
  /** The form is a journey. */
  journey: boolean;
  /** What `unsupported()` may list for this form (its fixture's `unsupported`). */
  expectedUnsupported: readonly string[];
  /** The journey page module, for a journey form (an agent's quiet page change). */
  journeyPage: JourneyPageFeature | undefined;
  runtime: FormRuntime;
  readonly form: LiveForm;
  readonly context: Probe | undefined;
  events: Array<{ type: string; detail: unknown }>;
  /** How many of `events` the shared runtime assertion has read (`fc.takeBindingErrors`). */
  eventsRead: number;
  announcements: Announcement[];
  observer: MutationObserver;
}

declare global {
  interface Window {
    fc: typeof fc;
  }
}

// ── The composed tree ──────────────────────────────────────────────────────────────────────

/** Every element under `root` matching `selector`, through open shadow roots, in tree order. */
function deepAll(root: ParentNode, selector: string, out: Element[] = []): Element[] {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.matches(selector)) out.push(el);
    if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
  }
  return out;
}

/** The document and every open shadow root under `root`. */
function rootsUnder(root: Document | ShadowRoot, out: Array<Document | ShadowRoot> = []): Array<Document | ShadowRoot> {
  out.push(root);
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.shadowRoot) rootsUnder(el.shadowRoot, out);
  }
  return out;
}

/** The parent across a shadow boundary. */
function composedParent(node: Node): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function closestDeep(el: Element | null, selector: string): Element | null {
  for (let at: Element | null = el; at; at = composedParent(at)) {
    if (at.matches(selector)) return at;
  }
  return null;
}

/** Text a person meets: text nodes through shadow roots and slots, style and script left out. */
function textOf(node: Node, out: string[] = []): string[] {
  // The element's own line while there is no form to show yet is no part of the form (`fc.loadingLine` reads it).
  if (node instanceof Element && node.hasAttribute("data-datum-loading")) return out;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node as Text).data.replace(/\s+/g, " ").trim();
    if (text) out.push(text);
    return out;
  }
  if (!(node instanceof Element) && !(node instanceof DocumentFragment)) return out;
  if (node instanceof Element && /^(style|script|template)$/i.test(node.localName)) return out;
  if (node instanceof HTMLSlotElement) {
    const assigned = node.assignedNodes({ flatten: true });
    for (const child of assigned.length ? assigned : Array.from(node.childNodes)) textOf(child, out);
    return out;
  }
  const from = node instanceof Element && node.shadowRoot ? node.shadowRoot : node;
  for (const child of Array.from(from.childNodes)) textOf(child, out);
  return out;
}
const text = (node: Node | null | undefined): string => (node ? textOf(node).join(" ") : "");

/** The composed tree as markup, shadow roots written as `<#shadow-root>` blocks. */
function serialize(node: Node, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node as Text).data.replace(/\s+/g, " ").trim();
    return t ? `${pad}${t}\n` : "";
  }
  if (node instanceof DocumentFragment) {
    return Array.from(node.childNodes).map((child) => serialize(child, depth)).join("");
  }
  if (!(node instanceof Element) || /^(style|script)$/i.test(node.localName)) return "";
  const attrs = Array.from(node.attributes).map((a) => (a.value === "" ? ` ${a.name}` : ` ${a.name}="${a.value}"`)).join("");
  const shadow = node.shadowRoot ? `${pad}  <#shadow-root>\n${serialize(node.shadowRoot, depth + 2)}${pad}  </#shadow-root>\n` : "";
  const children = Array.from(node.childNodes).map((child) => serialize(child, depth + 1)).join("");
  return `${pad}<${node.localName}${attrs}>\n${shadow}${children}${pad}</${node.localName}>\n`;
}

function describe(el: Element | null | undefined): Descriptor | null {
  if (!el) return null;
  const field = closestDeep(el, "[data-component-id]");
  const container = closestDeep(el, "[data-container-id]");
  const summary = closestDeep(el, "[data-datum-summary]");
  const t = text(el).slice(0, 80);
  return {
    tag: el.localName,
    ...(el.id ? { id: el.id } : {}),
    ...(el.getAttribute("role") ? { role: el.getAttribute("role") as string } : {}),
    ...(el.getAttribute("type") ? { type: el.getAttribute("type") as string } : {}),
    ...(field ? { componentId: field.getAttribute("data-component-id") as string, valuePath: field.getAttribute("data-value-path") ?? "" } : {}),
    ...(container ? { containerId: container.getAttribute("data-container-id") as string } : {}),
    ...(summary ? { region: "summary" } : {}),
    ...(t ? { text: t } : {})
  };
}

function deepActive(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

const idsOf = (value: string | null): string[] => (value ?? "").split(/\s+/).filter((id) => id !== "");

const LIVE_REGIONS = "[aria-live],[role=status],[role=alert],[role=log]";
/** The attributes that name other elements by id, each id of which must resolve in the same root. */
const ID_REFERENCES = ["aria-describedby", "aria-labelledby", "aria-controls", "aria-errormessage", "aria-owns", "aria-activedescendant"];
const CONTROLS = "input:not([type=hidden]),select,textarea,button";

// ── The page's state ───────────────────────────────────────────────────────────────────────

const consoleLog: Array<{ type: string; text: string }> = [];
for (const type of ["warn", "error"] as const) {
  const original = console[type].bind(console);
  console[type] = (...args: unknown[]) => {
    consoleLog.push({ type, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 500) });
    original(...args);
  };
}

const EVENTS = ["datum-binding-error", "datum-form-action", "datum-error", "datum-change", "datum-locale", "datum-locale-applied", "datum-locale-rejected"];
let current: Mounted | undefined;

function need(): Mounted {
  if (!current) throw new Error("No form mounted: call fc.load() first.");
  return current;
}

/** The binding's options with the load's date order (`LoadOptions.dateOrder`) and named adapters as the binding takes them. */
function bindingOptionsOf(options: LoadOptions): DatumBindingOptions {
  const renderers = adapterOverrides(options.adapters);
  const given = renderers ? { ...options.binding, renderers: { ...options.binding?.renderers, ...renderers } } : (options.binding ?? {});
  const order = options.dateOrder;
  if (order === undefined) return given;
  const date = Array.isArray(order) ? order : (locale: string): readonly string[] => order[locale.split("-")[0] as string] ?? order.default ?? ["day", "month", "year"];
  const base = Array.isArray(given.fieldOrder) ? { parts: given.fieldOrder } : (given.fieldOrder ?? {});
  return { ...given, fieldOrder: { ...base, date: date as never } };
}

function runtimeFor(definition: FormDefinition, fixture: (typeof FIXTURES)[string], behaviours?: Prepared): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const compiled = compileFormDefinition(definition, {}).definition;
  const dataSources = behaviours?.dataSources ?? fixture.dataSources?.();
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(compiled.root), ...(behaviours?.stages ?? [])]),
    journeyEngine: EagerJourneyEngine,
    versionContext: { formVersion: definition.version, schemaVersion: definition.schemaVersion, rendererVersion: "feature-coverage" },
    ...(dataSources ? { dataSources } : {})
  });
}

/**
 * Records every text a live region comes to say: each batch of childList or characterData
 * mutations inside a region that leaves it non-empty is one announcement, the same words written
 * again included (a live region reads what is written into it, so a clear-and-set of the words
 * already there is said again). A region whose text changed without a record reaching this
 * observer (one in a nested shadow root) is caught by comparing its text with what it last held.
 */
function recordAnnouncements(root: ShadowRoot, into: Announcement[]): MutationObserver {
  const said = new WeakMap<Element, string>();
  const started = performance.now();
  const regionOf = (node: Node): Element | null => closestDeep(node instanceof Element ? node : node.parentElement, LIVE_REGIONS);
  const look = (records: MutationRecord[]): void => {
    const written = new Set<Element>();
    for (const record of records) {
      if (record.type !== "childList" && record.type !== "characterData") continue;
      const region = regionOf(record.target);
      if (region) written.add(region);
    }
    for (const region of deepAll(root, LIVE_REGIONS)) {
      const now = text(region);
      const changed = now !== (said.get(region) ?? "");
      said.set(region, now);
      if (now && (changed || written.has(region))) {
        into.push({ text: now, politeness: region.getAttribute("aria-live") ?? region.getAttribute("role") ?? "", at: Math.round(performance.now() - started) });
      }
    }
  };
  const observer = new MutationObserver(look);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  return observer;
}

/** Blocking errors by the value path they belong to (a form-level error under ""). */
function blockingByPath(errors: readonly FormError[]): Map<string, FormError[]> {
  const out = new Map<string, FormError[]>();
  for (const error of errors) {
    if (error.severity !== undefined && error.severity !== "error") continue;
    const key = error.path !== undefined ? stringifyComponentPath(error.path) : (error.componentId ?? "");
    out.set(key, [...(out.get(key) ?? []), error]);
  }
  return out;
}

function containerIdsOf(nodes: readonly PresentationNode[], drawn: ReadonlySet<string>, out: Set<string>): boolean {
  // A container is expected in the DOM when it holds a drawn field (a panel not shown holds none).
  let holds = false;
  for (const node of nodes) {
    if (node.kind === "field") {
      if (drawn.has(node.key)) holds = true;
      continue;
    }
    const children = "children" in node && Array.isArray(node.children) ? (node.children as PresentationNode[]) : [];
    const inside = containerIdsOf(children, drawn, out);
    if (inside && node.kind !== "page") out.add(node.id);
    holds = holds || inside;
  }
  return holds;
}

/** The form the element has mounted; an error when it has none (a mount that failed, or not yet made). */
function needLive(element: DatumFormRendererElement): LiveForm {
  const live = element.live;
  if (!live) throw new Error("The element has mounted no form.");
  return live;
}

/** Resolves once every change so far is drawn: the element's `painted()` (a pending mount made first), else the form's `updated()`. */
async function settle(m: Mounted): Promise<void> {
  if (m.element) {
    await m.element.painted();
  } else {
    await m.form.updated();
  }
}

// ── window.fc ──────────────────────────────────────────────────────────────────────────────

const fc = {
  ready: true,
  fixtures(): string[] {
    return Object.keys(FIXTURES);
  },

  /** Which host forms are mounted in (`?host=` on the page's URL). */
  host: HOST,

  /** Mounts a corpus fixture into a fresh host in #stage; resolves once the first draw is ready. */
  async load(options: LoadOptions): Promise<{ source: string; draws: number; unsupported: string[]; fields: Array<{ key: string; componentId: string; valuePath: string }> }> {
    const fixture = FIXTURES[options.fixture];
    if (!fixture) throw new Error(`Unknown fixture "${options.fixture}"; known: ${Object.keys(FIXTURES).join(", ")}`);
    fc.unmount();
    const definition = fixture.definition();
    const behaviours = prepareBehaviours(options.behaviours);
    const runtime = runtimeFor(definition, fixture, behaviours);
    behaviours.watch(runtime);
    if (options.locale) runtime.setLocale(options.locale);
    for (const [path, value] of Object.entries(options.preset ?? {})) runtime.setValue(path, value);
    const element = HOST === "element" ? (defineDatumFormRendererElement(), document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement) : undefined;
    const host: HTMLElement = element ?? document.createElement("div");
    host.dataset.fcHost = options.fixture;
    const root = element ? (element.shadowRoot as ShadowRoot) : host.attachShadow({ mode: "open" });
    const events: Mounted["events"] = [];
    for (const type of EVENTS) {
      host.addEventListener(type, (event) => {
        let detail: unknown = null;
        try {
          detail = JSON.parse(JSON.stringify((event as CustomEvent).detail ?? null));
        } catch {
          detail = String((event as CustomEvent).detail);
        }
        events.push({ type, detail });
      });
    }
    const announcements: Announcement[] = [];
    const observer = recordAnnouncements(root, announcements);
    const bindingOptions = bindingOptionsOf(options);
    const binding = createDatumBinding(bindingOptions);
    const journey = definition.journey !== undefined;
    const dataSources = behaviours.dataSources ?? fixture.dataSources?.();
    const base = { host, element, journey, expectedUnsupported: fixture.unsupported ?? [], runtime, events, eventsRead: 0, announcements, observer };
    let mounted: Mounted;
    if (element) {
      if (options.errorPresentation) throw new Error("The element has no errorPresentation setting: a scenario that sets one runs in the live host only.");
      // The element's own settings; nothing of the renderer is reached around it.
      element.runtime = runtime;
      element.binding = binding;
      if (options.mode) element.mode = options.mode;
      if (dataSources) element.dataSources = dataSources;
      if (behaviours.dataSourceWait) element.dataSourceWait = behaviours.dataSourceWait;
      if (journey) element.journeyKit = EagerJourneyRenderKit;
      document.getElementById("stage")?.append(element);
      // The mount is queued for the end of this task; the form it makes is the element's `live`.
      await new Promise((done) => setTimeout(done, 0));
      mounted = {
        ...base,
        journeyPage: undefined,
        get form(): LiveForm {
          return needLive(element);
        },
        get context(): Probe | undefined {
          const live = element.live;
          return live ? { fields: () => live.fields(), tree: () => live.tree(), request: () => live.request(), focusErrors: () => live.focusErrors() } : undefined;
        }
      };
    } else {
      document.getElementById("stage")?.append(host);
      const journeyPage = journey ? createJourneyPageFeature() : undefined;
      let probed: LiveContext | undefined;
      // A probe module keeps the renderer's context: how a host's validate() takes focus to the errors.
      const probe: LiveFeature = { id: "feature-coverage-probe", start(live) { probed = live; } };
      const datumFeatures = createDatumFeatures(bindingOptions, behaviours.featureOptions);
      behaviours.keep(datumFeatures);
      const form = mountLive(root, {
        runtime,
        binding,
        datum: binding,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.errorPresentation ? { errorPresentation: options.errorPresentation } : {}),
        ...(dataSources ? { dataSources } : {}),
        ...(behaviours.dataSourceWait ? { dataSourceWait: behaviours.dataSourceWait } : {}),
        ...(journey ? { journeyKit: EagerJourneyRenderKit } : {}),
        features: [...datumFeatures, ...(journeyPage ? [journeyPage] : []), probe]
      });
      mounted = {
        ...base,
        journeyPage,
        form,
        get context(): Probe | undefined {
          return probed;
        }
      };
    }
    current = mounted;
    if (behaviours.hold) {
      mounted.form.ready.catch(() => undefined);
      return { source: fixture.source, draws: 0, unsupported: [], fields: [] };
    }
    await mounted.form.ready;
    await settle(mounted);
    return { source: fixture.source, draws: mounted.form.draws(), unsupported: mounted.form.unsupported(), fields: fc.fields() };
  },

  /** The mounted form's objects, for the controls in behaviours.ts. */
  internals(): { runtime: FormRuntime; form: LiveForm; context: Probe | undefined; element: DatumFormRendererElement | undefined } {
    const m = need();
    return { runtime: m.runtime, form: m.form, context: m.context, element: m.element };
  },

  unmount(): void {
    if (!current) return;
    current.observer.disconnect();
    if (current.element) {
      // Taking the runtime away unmounts at once; the element leaving the page would do it a task later.
      current.element.runtime = undefined;
    } else {
      current.form.unmount();
    }
    current.host.remove();
    current = undefined;
  },

  /** Resolves once every change so far is drawn; the number of draws. */
  async updated(): Promise<number> {
    const m = need();
    await settle(m);
    return m.form.draws();
  },

  fields(): Array<{ key: string; componentId: string; valuePath: string }> {
    return (need().context?.fields() ?? []).map((f) => ({ key: f.key, componentId: f.state.componentId, valuePath: f.state.valuePath }));
  },

  /**
   * What a host's validate() does: the whole-form check, the draw, then focus to the errors. In
   * the element host, the element's own `validate()`, and "focused" is whether focus is inside it.
   */
  async validate(): Promise<{ errors: number; focused: boolean }> {
    const m = need();
    if (m.element) {
      await m.element.validate();
      await settle(m);
      const errors = m.runtime.errors().filter((e) => e.severity === undefined || e.severity === "error").length;
      return { errors, focused: errors > 0 && (m.host.shadowRoot as ShadowRoot).activeElement !== null };
    }
    const errors = await m.runtime.validate();
    await m.form.updated();
    const focused = m.context?.focusErrors() ?? false;
    await m.form.updated();
    return { errors: errors.length, focused };
  },

  values(): unknown {
    return JSON.parse(JSON.stringify(need().runtime.state().values));
  },
  errors(): Array<{ code: string; componentId?: string; path?: string; severity?: string; message?: string }> {
    return need().runtime.errors().map((e) => ({
      code: e.code,
      ...(e.componentId !== undefined ? { componentId: e.componentId } : {}),
      ...(e.path !== undefined ? { path: stringifyComponentPath(e.path) } : {}),
      ...(e.severity !== undefined ? { severity: e.severity } : {}),
      ...(e.message !== undefined ? { message: e.message } : {})
    }));
  },
  setValue(path: string, value: unknown): void {
    need().runtime.setValue(path, value);
  },
  /** Errors a host learned outside validation (a server's verdict), as `runtime.setErrors` takes them. */
  setErrors(errors: HostError[]): void {
    need().runtime.setErrors(errors);
  },
  /** The rows of a collection as the runtime holds them, and their stable keys. */
  rows(collectionPath: string): { rows: unknown[]; keys: readonly string[] } {
    const { runtime } = need();
    return { rows: JSON.parse(JSON.stringify(runtime.rows(collectionPath))), keys: runtime.entryKeys(collectionPath) };
  },
  /** The journey as the runtime sees it now: the page, the pages on the path, whether it is busy or done. */
  journey(): { pageId: string | undefined; path: string[]; index: number | undefined } | undefined {
    const view = need().runtime.journeyView();
    if (!view) return undefined;
    return { pageId: view.pageId, path: [...view.path], index: view.index };
  },
  /** The runtime's current locale. */
  locale(): string {
    return need().runtime.state().locale;
  },
  unsupported(): string[] {
    return need().form.unsupported();
  },
  /** An agent's page move (agent tools `navigate`): the journey page module quieted first, released once the move settles. */
  async quietPageMove(to: "next" | "back"): Promise<{ quieted: boolean; pageId: string | undefined }> {
    const m = need();
    if (!m.journey) throw new Error("Not a journey form.");
    const release = m.element ? m.element.quietNextPageFocus() : (m.journeyPage as JourneyPageFeature).quietNextPageFocus();
    try {
      await (to === "next" ? m.runtime.nextPage() : m.runtime.previousPage());
      await settle(m);
    } finally {
      release();
    }
    await settle(m);
    return { quieted: true, pageId: m.runtime.journeyView()?.pageId };
  },
  /**
   * An agent's submit (what `<datum-form>` does for one): the element's quiet asked for first and
   * released once the submit settles. The live host has no element to quiet (`quieted: false`):
   * the renderer alone treats every submit as the person's.
   */
  async quietSubmit(): Promise<{ quieted: boolean; accepted: boolean }> {
    const m = need();
    const release = m.element?.quietNextPageFocus();
    let accepted = false;
    try {
      const version = { form: { id: "feature-coverage", version: "1.0.0" }, client: { runtimeVersion: "0.0.0", rendererVersion: "feature-coverage", schemaVersion: "1.0.0" } };
      accepted = (await m.runtime.submit("submit", version as never)).accepted;
      await settle(m);
    } finally {
      release?.();
    }
    await settle(m);
    return { quieted: release !== undefined, accepted };
  },
  /** The person's own submit (nothing quieted): whether the runtime accepted it. */
  async pageSubmit(): Promise<boolean> {
    const m = need();
    const version = { form: { id: "feature-coverage", version: "1.0.0" }, client: { runtimeVersion: "0.0.0", rendererVersion: "feature-coverage", schemaVersion: "1.0.0" } };
    const accepted = (await m.runtime.submit("submit", version as never)).accepted;
    await settle(m);
    return accepted;
  },
  /** A page move nobody quieted (what a host's own call to the runtime does). */
  async pageMove(to: "next" | "back"): Promise<string | undefined> {
    const m = need();
    await (to === "next" ? m.runtime.nextPage() : m.runtime.previousPage());
    await settle(m);
    return m.runtime.journeyView()?.pageId;
  },
  events(): Mounted["events"] {
    return need().events;
  },
  /**
   * The datum-binding-error events the mounted form raised since the last call: the shared
   * runtime assertion's read. The count lives on the mounted form, so a new load starts at its
   * own first event (one raised while it mounts included).
   */
  takeBindingErrors(): Mounted["events"] {
    if (!current) return [];
    const fresh = current.events.slice(current.eventsRead);
    current.eventsRead = current.events.length;
    return fresh.filter((event) => event.type === "datum-binding-error");
  },
  consoleTake(): Array<{ type: string; text: string }> {
    return consoleLog.splice(0);
  },
  /** The announcements recorded since the last take. */
  announcements(): Announcement[] {
    const m = need();
    return m.announcements.splice(0);
  },
  /** What every live region says now. */
  liveText(): Array<{ politeness: string; text: string; at: Descriptor | null }> {
    return deepAll(need().host.shadowRoot as ShadowRoot, LIVE_REGIONS).map((region) => ({
      politeness: region.getAttribute("aria-live") ?? region.getAttribute("role") ?? "",
      text: text(region),
      at: describe(region)
    }));
  },

  hostElement(): HTMLElement {
    return need().host;
  },

  // ── The element's own settings (the element host only) ─────────────────────────────────────

  /**
   * Sets one of the element's public properties (what a host page does) and resolves once the
   * form it draws is drawn. A scenario that calls it runs in the element host only.
   */
  async setElement(name: "binding" | "assets" | "extraStyles" | "colorScheme" | "mode", value: unknown): Promise<void> {
    const m = need();
    if (!m.element) throw new Error("setElement: the live host has no element; a scenario that sets its properties runs in the element host only.");
    (m.element as unknown as Record<string, unknown>)[name] = value;
    await new Promise((done) => setTimeout(done, 0));
    await settle(m);
  },
  /** Registers a binding on the page under `id`, made of Datum's with the named adapter sets over it (adapters.ts). */
  registerBinding(id: string, adapters: string[]): void {
    const renderers = adapterOverrides(adapters);
    registerBinding(createDatumBinding({ id, label: id, ...(renderers ? { renderers } : {}) }));
  },
  /** What the element says it draws for a type (`capabilitiesOf`): the answers per drawing capability, the field kind and where the adapter comes from. */
  capabilitiesOf(type: string): { kind: string; from: string; answers: Record<string, string> } | null {
    const m = need();
    if (!m.element) throw new Error("capabilitiesOf: the live host has no element.");
    return m.element.capabilitiesOf(type) ?? null;
  },
  /** Which adapter drew an instance (a field's key or a container's id), as the form reports it. */
  adapterOf(key: string): { from: string; via: string; name?: string } | null {
    return need().form.adapterOf(key) ?? null;
  },
  /** Marks the drawn `<form>` so a later read tells a draw from a mount: a remount makes a new element. */
  markForm(): void {
    const form = (need().host.shadowRoot as ShadowRoot).querySelector("form");
    if (!form) throw new Error("markForm: no form is drawn.");
    (form as unknown as Record<string, unknown>).__fcMark = true;
  },
  /** Whether the `<form>` drawn now is the one `markForm` marked. */
  formMarked(): boolean {
    const form = (need().host.shadowRoot as ShadowRoot).querySelector("form");
    return (form as unknown as Record<string, unknown> | null)?.__fcMark === true;
  },
  /** The value of a computed style on the first element matching `selector` (deep), e.g. an outline colour an `extraStyles` rule sets. */
  computed(selector: string, property: string): string | null {
    const el = deepAll(need().host.shadowRoot as ShadowRoot, selector)[0];
    return el ? getComputedStyle(el).getPropertyValue(property) : null;
  },
  describe,
  active(): Descriptor | null {
    return describe(deepActive());
  },
  /** Elements matching `selector` anywhere in the form, through shadow roots. */
  query(selector: string): Descriptor[] {
    return deepAll(need().host.shadowRoot as ShadowRoot, selector).map((el) => describe(el) as Descriptor);
  },
  /** The composed text of the form, or of the first element matching `selector`. */
  composedText(selector?: string): string {
    const root = need().host.shadowRoot as ShadowRoot;
    return text(selector ? deepAll(root, selector)[0] : root);
  },
  /** The element's "loading" line while it has no form to show (the element host only): its text, else null. */
  loadingLine(): string | null {
    const line = deepAll(need().host.shadowRoot as ShadowRoot, "[data-datum-loading]")[0];
    return line ? (line.textContent ?? "") : null;
  },
  composedHtml(): string {
    return serialize(need().host.shadowRoot as ShadowRoot);
  },
  /** Attribute and property facts of the first element matching `selector` (deep). */
  facts(selector: string): Record<string, unknown> | null {
    const el = deepAll(need().host.shadowRoot as ShadowRoot, selector)[0];
    if (!el) return null;
    const control = el as HTMLInputElement;
    const attributes: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) attributes[a.name] = a.value;
    return {
      attributes,
      value: "value" in control ? control.value : undefined,
      checked: "checked" in control ? control.checked : undefined,
      disabled: "disabled" in control ? control.disabled : undefined,
      readOnly: "readOnly" in control ? control.readOnly : undefined,
      inert: (el as HTMLElement).inert || closestDeep(el, "[inert]") !== null,
      describedText: idsOf(el.getAttribute("aria-describedby")).map((id) => text((el.getRootNode() as ShadowRoot).getElementById(id)))
    };
  },

  // ── Shared assertions (lib/shared.mjs runs them after every step a scenario marks) ─────────

  /** DOM contract: every drawn field's wrapper carries data-component-id and data-value-path; every container holding a drawn field carries data-container-id. */
  contract(): Problem[] {
    const m = need();
    const root = m.host.shadowRoot as ShadowRoot;
    const problems: Problem[] = [];
    const drawn = m.context?.fields() ?? [];
    if (drawn.length === 0) problems.push({ rule: "contract", message: "the renderer reports no drawn field" });
    for (const field of drawn) {
      const wrapper = deepAll(root, "[data-instance]").find((el) => el.getAttribute("data-instance") === field.key);
      if (!wrapper) {
        problems.push({ rule: "contract", message: `field ${field.key}: no wrapper in the DOM` });
        continue;
      }
      const expectedPath = field.node.model.valuePath ?? field.state.valuePath;
      if (wrapper.getAttribute("data-component-id") !== field.node.model.id) {
        problems.push({ rule: "contract", message: `field ${field.key}: data-component-id is ${JSON.stringify(wrapper.getAttribute("data-component-id"))}, expected "${field.node.model.id}"`, at: describe(wrapper) as Descriptor });
      }
      if (wrapper.getAttribute("data-value-path") !== expectedPath) {
        problems.push({ rule: "contract", message: `field ${field.key}: data-value-path is ${JSON.stringify(wrapper.getAttribute("data-value-path"))}, expected "${expectedPath}"`, at: describe(wrapper) as Descriptor });
      }
      if (!wrapper.hasAttribute("data-kind")) {
        problems.push({ rule: "contract", message: `field ${field.key}: no data-kind`, at: describe(wrapper) as Descriptor });
      }
    }
    for (const el of deepAll(root, "[data-component-id]")) {
      if (!el.hasAttribute("data-value-path")) problems.push({ rule: "contract", message: "a data-component-id element without data-value-path", at: describe(el) as Descriptor });
    }
    const tree = m.context?.tree();
    if (tree) {
      const expected = new Set<string>();
      containerIdsOf(tree.nodes, new Set(drawn.map((f) => f.key)), expected);
      const present = new Set(deepAll(root, "[data-container-id]").map((el) => el.getAttribute("data-container-id")));
      for (const id of expected) {
        if (!present.has(id)) problems.push({ rule: "contract", message: `container ${id}: holds a drawn field but no element carries data-container-id="${id}"` });
      }
    }
    return problems;
  },

  /** Every id an ARIA reference (ID_REFERENCES) or a label's `for` names resolves in the same root; ids are unique per root. */
  references(): Problem[] {
    const problems: Problem[] = [];
    for (const root of rootsUnder(need().host.shadowRoot as ShadowRoot)) {
      const seen = new Map<string, number>();
      for (const el of Array.from(root.querySelectorAll("[id]"))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
      for (const [id, count] of seen) {
        if (count > 1) problems.push({ rule: "ids", message: `id "${id}" appears ${count} times in one root` });
      }
      for (const el of Array.from(root.querySelectorAll(`${ID_REFERENCES.map((attr) => `[${attr}]`).join(",")},label[for]`))) {
        for (const attr of [...ID_REFERENCES, "for"]) {
          if (attr === "for" && el.localName !== "label") continue;
          for (const id of idsOf(el.getAttribute(attr))) {
            if (!root.getElementById(id)) problems.push({ rule: "references", message: `${attr}="${id}" resolves to nothing in its root`, at: describe(el) as Descriptor });
          }
        }
      }
    }
    return problems;
  },

  /**
   * Datum draws every engine type: `unsupported()` lists nothing but what the fixture is made to
   * hold that nothing draws (its `unsupported` entries).
   */
  unsupportedProblems(): Problem[] {
    const m = need();
    return m.form
      .unsupported()
      .filter((entry) => !m.expectedUnsupported.includes(entry))
      .map((entry) => ({ rule: "unsupported", message: `unsupported() lists ${JSON.stringify(entry)}` }));
  },

  /**
   * The form root and a tab's own container are no group: a fieldset named by the form's label
   * is said again with every field, and a tab's panel is already named by its tab.
   */
  structureProblems(): Problem[] {
    const problems: Problem[] = [];
    for (const wrapper of deepAll(need().host.shadowRoot as ShadowRoot, '.datum-live-container:is([data-kind="form"],[data-kind="tab"])')) {
      for (const child of Array.from(wrapper.children)) {
        if (child.localName === "fieldset" || child.getAttribute("role") === "group") {
          problems.push({ rule: "structure", message: `the ${wrapper.getAttribute("data-kind")} container ${wrapper.getAttribute("data-container-id")} is drawn as a group`, at: describe(child) as Descriptor });
        }
      }
    }
    return problems;
  },

  /** A form control has at most one <label> (several labels make one run-on name). */
  labels(): Problem[] {
    const problems: Problem[] = [];
    for (const el of deepAll(need().host.shadowRoot as ShadowRoot, "input:not([type=hidden]),select,textarea")) {
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 1) problems.push({ rule: "names", message: `${labels.length} labels name one control`, at: describe(el) as Descriptor });
    }
    return problems;
  },

  /**
   * aria-invalid iff a blocking error is described: a field with a blocking error (the runtime's,
   * by value path) has an aria-invalid control, data-invalid on its wrapper, and every
   * aria-invalid element there is described by text carrying the error; a field without one has
   * neither.
   */
  invalidity(): Problem[] {
    const m = need();
    const root = m.host.shadowRoot as ShadowRoot;
    const problems: Problem[] = [];
    const blocking = blockingByPath(m.runtime.errors());
    for (const field of m.context?.fields() ?? []) {
      const wrapper = deepAll(root, "[data-instance]").find((el) => el.getAttribute("data-instance") === field.key);
      if (!wrapper) continue;
      const path = field.state.valuePath;
      const has = blocking.has(path) || (field.state.row === undefined && blocking.has(field.state.componentId));
      const invalid = deepAll(wrapper, "[aria-invalid]").filter((el) => el.getAttribute("aria-invalid") !== "false");
      const at = describe(wrapper) as Descriptor;
      if (has) {
        if (invalid.length === 0) problems.push({ rule: "invalid", message: `${path}: a blocking error, but no aria-invalid element`, at });
        if (!wrapper.hasAttribute("data-invalid")) problems.push({ rule: "invalid", message: `${path}: a blocking error, but no data-invalid on the wrapper`, at });
        const message = field.state.message;
        for (const el of invalid) {
          const described = idsOf(el.getAttribute("aria-describedby")).map((id) => text((el.getRootNode() as ShadowRoot).getElementById(id))).join(" ");
          if (!message || !described.includes(message)) {
            problems.push({ rule: "invalid", message: `${path}: aria-invalid element not described by its error ${JSON.stringify(message ?? "")} (described: ${JSON.stringify(described)})`, at: describe(el) as Descriptor });
          }
        }
      } else {
        for (const el of invalid) problems.push({ rule: "invalid", message: `${path}: aria-invalid="${el.getAttribute("aria-invalid")}" without a blocking error`, at: describe(el) as Descriptor });
        if (wrapper.hasAttribute("data-invalid")) problems.push({ rule: "invalid", message: `${path}: data-invalid without a blocking error`, at });
      }
    }
    return problems;
  },

  /** Controls inside the form, for a scenario that walks them all. */
  controls(): Descriptor[] {
    return fc.query(CONTROLS);
  }
};

window.fc = fc;
