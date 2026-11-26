/*
 * Behaviour a corpus definition cannot hold, given to a form at load time by name (`recipes`),
 * and the controls a scenario needs to drive it (`window.fcx`).
 *
 * A definition names its fields; what a slow data source answers, whether an async check passes,
 * which warning a stage raises, whether a submission is still in flight is the host's. A
 * scenario asks for the pieces by recipe, holds the slow ones at a gate and lets them go when it
 * has looked at the form in between:
 *
 *   recipes `async-email`  an async stage judging `email` (taken@example.com is taken); gate "email"
 *            `advice`       a stage raising a warning on `nick` and an info on `tip` (both short)
 *            `sources`      data sources `cities` (gate "cities") and `towns` (gate "towns")
 *
 * Everything here reads or drives the same objects a host would: the runtime, the renderer's
 * context, the events. Nothing reaches into the renderer.
 */
import type { DataSourceSet, ValidationContext, ValidationResult, ValidationStage } from "../../form-engine/core/schema/contracts.js";
import type { FormEvent } from "../../form-engine/core/events/event-bus.js";
import type { HostError } from "../../form-engine/core/errors/form-error.js";
import type { FormNotice } from "../../form-engine/core/submission/form-notice.js";
import { defineDataSources } from "../../form-engine/data/host/data-source-set.js";
import type { LiveFeature } from "../../form-engine/render/live/mount.js";
import type { DatumFeatureOptions } from "../../form-engine/render/live/renderer.js";
import type { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";

export interface BehaviourOptions {
  /** Recipe names (see above). */
  recipes?: string[];
  /** Whether the first draw waits for the data sources. */
  dataSourceWait?: "none" | "all";
  /** Resolve `load` as soon as the form is mounted, before its first draw: `fcx.whenReady()` waits for it. */
  hold?: boolean;
}

// ── Gates ──────────────────────────────────────────────────────────────────────────────────

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

/** Named points a slow thing waits at until the scenario lets it go. */
class Gates {
  private readonly waiting = new Map<string, Waiter[]>();
  private readonly passing = new Set<string>();
  private readonly failing = new Map<string, string>();
  private readonly counts = new Map<string, number>();

  hold(name: string): Promise<void> {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    const failure = this.failing.get(name);
    if (failure !== undefined) return Promise.reject(new Error(failure));
    if (this.passing.has(name)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(name, [...(this.waiting.get(name) ?? []), { resolve, reject }]);
    });
  }

  /** Lets the oldest one waiting at `name` go. */
  releaseNext(name: string): boolean {
    const waiters = this.waiting.get(name) ?? [];
    const next = waiters.shift();
    this.waiting.set(name, waiters);
    next?.resolve();
    return next !== undefined;
  }

  /** Lets everything waiting at `name` go; with `keep`, what comes later passes too. */
  release(name: string, keep = false): number {
    const waiters = this.waiting.get(name) ?? [];
    this.waiting.delete(name);
    if (keep) this.passing.add(name);
    for (const waiter of waiters) waiter.resolve();
    return waiters.length;
  }

  /** Fails everything waiting at `name`; with `keep`, what comes later fails too. */
  fail(name: string, message: string, keep = false): number {
    const waiters = this.waiting.get(name) ?? [];
    this.waiting.delete(name);
    if (keep) this.failing.set(name, message);
    for (const waiter of waiters) waiter.reject(new Error(message));
    return waiters.length;
  }

  waitingAt(name: string): number {
    return (this.waiting.get(name) ?? []).length;
  }
  called(name: string): number {
    return this.counts.get(name) ?? 0;
  }
}

const CITIES = [
  { value: "ott", label: "Ottawa" },
  { value: "tor", label: "Toronto" }
];
const TOWNS = [
  { value: "kin", label: "Kingston" },
  { value: "bar", label: "Barrie" }
];

// ── Recipes ────────────────────────────────────────────────────────────────────────────────

interface Recipe {
  stages?(gates: Gates): ValidationStage[];
  dataSources?(gates: Gates): Record<string, Parameters<typeof defineDataSources>[0][string]>;
}

const text = (values: Record<string, unknown>, id: string): string => (typeof values[id] === "string" ? (values[id] as string) : "");

const RECIPES: Readonly<Record<string, Recipe>> = {
  "async-email": {
    stages: (gates) => [
      {
        id: "email-taken",
        version: "1",
        kind: "async",
        paths: () => ["email"],
        async validate(context: ValidationContext): Promise<ValidationResult> {
          await gates.hold("email");
          return text(context.values, "email") === "taken@example.com"
            ? { errors: [{ id: "email-taken-1", code: "email.taken", componentId: "email", path: "email", stage: "email-taken", source: "custom", parameters: { message: "That email is taken." } } as never] }
            : { errors: [] };
        }
      }
    ]
  },
  advice: {
    stages: () => [
      {
        id: "advice",
        version: "1",
        validate: (context: ValidationContext): ValidationResult => {
          const errors: unknown[] = [];
          if (text(context.values, "nick") !== "" && text(context.values, "nick").length < 4) {
            errors.push({ id: "advice-nick", code: "nick.short", componentId: "nick", path: "nick", severity: "warning", stage: "advice", source: "client", parameters: { message: "That nickname is short." } });
          }
          if (text(context.values, "tip") !== "") {
            errors.push({ id: "advice-tip", code: "tip.saved", componentId: "tip", path: "tip", severity: "info", stage: "advice", source: "client", parameters: { message: "Tips are kept for a week." } });
          }
          return { errors } as ValidationResult;
        }
      }
    ]
  },
  sources: {
    dataSources: (gates) => ({
      cities: async () => {
        await gates.hold("cities");
        return CITIES;
      },
      towns: async () => {
        await gates.hold("towns");
        return TOWNS;
      }
    })
  }
};

// ── What a load takes ──────────────────────────────────────────────────────────────────────

/** What `load` needs of the behaviours a scenario asked for. */
export interface Prepared {
  stages: ValidationStage[];
  dataSources: DataSourceSet | undefined;
  dataSourceWait: "none" | "all" | undefined;
  hold: boolean;
  /** Options for the renderer's own modules (the receipt the host shows). */
  featureOptions: DatumFeatureOptions;
  /** The renderer's modules once built, kept for the controls that reach them. */
  keep(features: readonly LiveFeature[]): void;
  /** Starts recording the runtime's events. */
  watch(runtime: FormRuntime): void;
}

let gates = new Gates();
let notice: FormNotice | undefined;
let kept: readonly LiveFeature[] = [];
let recorded: Array<{ type: string; data: unknown }> = [];
let stopWatching: (() => void) | undefined;

export function prepareBehaviours(options: BehaviourOptions = {}): Prepared {
  gates = new Gates();
  notice = undefined;
  kept = [];
  recorded = [];
  stopWatching?.();
  const stages: ValidationStage[] = [];
  const sources: Record<string, never> = {} as never;
  for (const name of options.recipes ?? []) {
    const recipe = RECIPES[name];
    if (!recipe) throw new Error(`Unknown recipe "${name}"; known: ${Object.keys(RECIPES).join(", ")}`);
    stages.push(...(recipe.stages?.(gates) ?? []));
    Object.assign(sources, recipe.dataSources?.(gates) ?? {});
  }
  return {
    stages,
    dataSources: Object.keys(sources).length > 0 ? defineDataSources(sources) : undefined,
    dataSourceWait: options.dataSourceWait,
    hold: options.hold === true,
    featureOptions: { formNotices: { notice: () => notice } },
    keep(features) {
      kept = features;
    },
    watch(runtime) {
      stopWatching = runtime.events().subscribe("*", (event: FormEvent) => {
        recorded.push({ type: event.type, data: JSON.parse(JSON.stringify(event.data ?? null)) });
      });
    }
  };
}

// ── window.fcx ─────────────────────────────────────────────────────────────────────────────

/** What the controls reach: the mounted form (entry.ts `fc.internals()`). */
interface Internals {
  runtime: FormRuntime;
  form: { updated(): Promise<void>; ready: Promise<void>; focusField(key: string): boolean; settleInput(): void };
  context: { request(): void; fields(): ReadonlyArray<{ key: string; state: { componentId: string } }> } | undefined;
  /** The element, in the element host: the host's receipt and the input settle go through its own methods. */
  element: { notice: FormNotice | undefined; settleInput(): void; focusNotice(): void; painted(): Promise<void> } | undefined;
}
const internals = (): Internals => (window as unknown as { fc: { internals(): Internals } }).fc.internals();

const VERSION = { form: { id: "feature-coverage", version: "1.0.0" }, client: { runtimeVersion: "0.0.0", rendererVersion: "feature-coverage", schemaVersion: "1.0.0" } };

let validating: Promise<unknown> | undefined;
let submitting: Promise<unknown> | undefined;

const outcome = async (run: Promise<unknown> | undefined): Promise<{ done: boolean; threw?: string; value?: unknown }> => {
  if (!run) return { done: true };
  try {
    const value = await run;
    return { done: true, value: JSON.parse(JSON.stringify(value ?? null)) };
  } catch (thrown) {
    return { done: true, threw: thrown instanceof Error ? thrown.message : String(thrown) };
  }
};

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function closestAcross(el: Element | null, selector: string): Element | null {
  for (let at: Element | null = el; at; at = at.parentElement ?? (at.getRootNode() instanceof ShadowRoot ? (at.getRootNode() as ShadowRoot).host : null)) {
    if (at.matches(selector)) return at;
  }
  return null;
}

const fcx = {
  // Gates
  release: (name: string, keep = false): number => gates.release(name, keep),
  releaseNext: (name: string): boolean => gates.releaseNext(name),
  fail: (name: string, message = "down", keep = false): number => gates.fail(name, message, keep),
  waiting: (name: string): number => gates.waitingAt(name),
  called: (name: string): number => gates.called(name),

  /** Resolves once a `hold` load's first draw is ready (a provisional one when a source is still out: not once every source answered). */
  async whenReady(): Promise<number> {
    await internals().form.ready;
    return (window as unknown as { fc: { fields(): unknown[] } }).fc.fields().length;
  },

  // Runtime
  setErrors(errors: HostError[]): number {
    return internals().runtime.setErrors(errors).length;
  },
  setLocale(locale: string): void {
    internals().runtime.setLocale(locale);
  },
  pending(): string[] {
    return [...internals().runtime.pendingPaths()];
  },
  /** The runtime's events since the last take, optionally of some types only. */
  runtimeEvents(types?: string[]): Array<{ type: string; data: unknown }> {
    const taken = recorded.splice(0);
    return types ? taken.filter((e) => types.includes(e.type)) : taken;
  },

  // A whole-form check or a submission left running, to look at the form in between.
  beginValidate(): void {
    validating = internals().runtime.validate();
    validating.catch(() => undefined);
  },
  endValidate: () => outcome(validating),
  beginSubmit(): void {
    submitting = internals().runtime.submit("submit", VERSION as never);
    submitting.catch(() => undefined);
  },
  endSubmit: () => outcome(submitting),

  // The host's receipt
  async setNotice(next: FormNotice | undefined): Promise<void> {
    notice = next;
    const { element, context, form } = internals();
    if (element) {
      element.notice = next;
      await element.painted();
      return;
    }
    context?.request();
    await form.updated();
  },
  /** Whether focus went to the receipt. The element's `focusNotice()` returns nothing: it counts as taken when the notice is there and focus is on its region after it. */
  async focusNotice(): Promise<boolean> {
    const { element } = internals();
    if (element) {
      const had = element.notice !== undefined;
      element.focusNotice();
      await element.painted();
      await new Promise((done) => setTimeout(done, 0));
      return had && (deepActiveElement()?.closest(".datum-form__notice") ?? null) !== null;
    }
    const feature = kept.find((f) => f.id === "form-notices") as (LiveFeature & { focusNotice(): boolean }) | undefined;
    return feature?.focusNotice() ?? false;
  },

  // What the agent layer asks of the form (agent-host.ts)
  /** Reveals and focuses a field by component id: what `revealComponent` does. */
  focusComponent(componentId: string): boolean {
    const field = internals().context?.fields().find((f) => f.state.componentId === componentId);
    return field ? internals().form.focusField(field.key) : false;
  },
  settleInput(): void {
    const { element, form } = internals();
    (element ?? form).settleInput();
  },
  /**
   * The value path the agent host reports as focused (agent-host.ts `focusedValuePath`): the
   * deepest focused element must be a text-entry control; its field's `data-value-path`, else
   * its `data-component-id`.
   */
  focusedValuePath(): string | undefined {
    const deepest = deepActiveElement();
    if (!(deepest instanceof HTMLElement)) return undefined;
    const caret = (deepest instanceof HTMLTextAreaElement) || (deepest instanceof HTMLInputElement && /^(text|search|url|tel|email|password|number|)$/.test(deepest.type));
    if (!caret) return undefined;
    const field = closestAcross(deepest, "[data-component-id]");
    if (!field) return undefined;
    return (closestAcross(field, "[data-value-path]") as HTMLElement | null)?.dataset.valuePath ?? (closestAcross(field, "[data-component-id]") as HTMLElement | null)?.dataset.componentId;
  }
};

(window as unknown as { fcx: typeof fcx }).fcx = fcx;
