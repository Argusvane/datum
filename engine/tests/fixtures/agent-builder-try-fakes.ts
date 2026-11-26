/**
 * The `try_it` tests' page: the fake Try it adapter
 * (`fixtures/agent-builder-adapters.ts`, built on, never edited) on the `uiStub`, with the one
 * Try it state the page has: the shell's `trying` (what `ui.trying()` and the catalogue's own
 * checks read) and the adapter's are the same flag here, as on the real page, so turning Try it
 * on through the adapter is what the shell sees.
 *
 * `journeyTryPage` swaps the tried runtime for a journey's: a real `FormRuntime` over the
 * form-tests journey (`AGENT_JOURNEY_FORM`) whose pages run under node ids of their own
 * (`n-intro`, `n-contact`, …), as the Journeys designer's preview runs them, with the
 * adapter's `pageIdOf` / `nodeIdOf` mapping between the two.
 */
import { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import type { BuilderToolUi } from "../../form-engine/agent/builder/host.js";
import type { BuilderFeature } from "../../form-engine/builder/web-component/builder-features.js";
import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";
import type { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../form-engine/core/schema/data-grid.js";
import { agentBuilder, contactRequestController, contactRequestRoot, uiStub, type AgentBuilder, type UiStub, type UiStubState } from "./agent-builder.js";
import { fakeTryIt, type FakeTryIt, type FakeTryItState } from "./agent-builder-adapters.js";
import { AGENT_JOURNEY_FORM, agentRuntime } from "./agent-form.js";

export interface TryPage {
  builder: AgentBuilder;
  controller: BuilderController;
  stub: UiStub;
  tryIt: FakeTryIt & {
    /** How many `onSubmit` listeners are live now (subscribed through the adapter, not yet dropped). */
    listeners(): number;
  };
}

export interface TryPageOptions {
  root?: ComponentNode;
  tryIt?: Partial<FakeTryItState>;
  stub?: Partial<UiStubState>;
  featureOn?: Partial<Record<BuilderFeature, boolean>>;
  /** More `ui` members laid over the stub's (a designer's active controller, …). */
  ui?: Partial<BuilderToolUi>;
}

/** A builder page with Try it over `root` (default: contact-request); Try it off unless `tryIt.trying`. */
export function tryPage(options: TryPageOptions = {}): TryPage {
  const stub = uiStub(options.stub);
  const controller = contactRequestController(options.root !== undefined ? { root: options.root } : {});
  const fake = fakeTryIt(controller, options.tryIt);
  // Live `onSubmit` listeners counted around the fake's own, so a test sees a dropped subscription.
  let live = 0;
  const onSubmit = fake.adapter.onSubmit;
  fake.adapter.onSubmit = (listener) => {
    const off = onSubmit(listener);
    live += 1;
    let dropped = false;
    return () => {
      if (!dropped) {
        dropped = true;
        live -= 1;
      }
      off();
    };
  };
  const tryIt: TryPage["tryIt"] = Object.assign(fake, { listeners: () => live });
  const initial = tryIt.state.trying || stub.state.trying;
  // One flag for the shell and the adapter, as the page has.
  Object.defineProperty(tryIt.state, "trying", {
    get: () => stub.state.trying,
    set: (value: boolean) => {
      stub.state.trying = value;
    },
    enumerable: true,
    configurable: true
  });
  stub.state.trying = initial;
  stub.state.tryIt = tryIt.adapter;
  Object.assign(stub.ui, options.ui ?? {});
  const builder = agentBuilder({ controller, ui: stub, ...(options.featureOn !== undefined ? { featureOn: options.featureOn } : {}) });
  return { builder, controller, stub, tryIt };
}

/** A form with a table (a data grid of 1 to 3 rows: Qty, Note) beside contact-request's fields. */
export function tableRoot(settings: Record<string, unknown> = { minRows: 1, maxRows: 3 }): ComponentNode {
  const root = contactRequestRoot();
  (root.children?.content as ComponentNode[]).splice(3, 0, {
    id: "items",
    type: DATA_GRID_COMPONENT_TYPE,
    configuration: { label: "Items", ...settings },
    collection: {},
    children: {
      content: [
        { id: "qty", type: "number", configuration: { label: "Qty" } },
        { id: "note", type: "text", configuration: { label: "Note" } }
      ]
    }
  });
  return root;
}

/** A form with a hidden field, a read-only one and a calculation, for the writability cases. */
export function guardedRoot(): ComponentNode {
  const root = contactRequestRoot();
  (root.children?.content as ComponentNode[]).splice(
    3,
    0,
    { id: "secret", type: "text", configuration: { label: "Secret" }, rules: { visibleWhen: 'topic = "other"' } },
    { id: "locked", type: "text", configuration: { label: "Locked", readonly: true } },
    { id: "quantity", type: "number", configuration: { label: "Quantity" } },
    { id: "double", type: "number", configuration: { label: "Double" }, rules: { value: "quantity * 2" } }
  );
  return root;
}

/** A journey form (default: the form-tests journey) with its pages renamed `n-<page>`: the node ids its preview runs them under. */
export function journeyUnderNodes(source: FormDefinition = AGENT_JOURNEY_FORM): FormDefinition {
  const definition = structuredClone(source) as FormDefinition & { journey: { journeys: Array<{ pages: Array<{ id: string; routes?: Array<{ to: string }> }> }> } };
  for (const journey of definition.journey.journeys) {
    for (const page of journey.pages) {
      page.id = `n-${page.id}`;
      for (const route of page.routes ?? []) {
        if (!route.to.startsWith("$")) {
          route.to = `n-${route.to}`;
        }
      }
    }
  }
  return definition;
}

export interface JourneyTryPage extends TryPage {
  journey: FormRuntime;
}

export interface JourneyTryPageOptions extends TryPageOptions {
  /** The journey form tried (default: the form-tests journey); its first journey is the one Try it runs. */
  journey?: FormDefinition;
}

/**
 * Try it in the Journeys designer: the tried runtime is a journey's (a real `FormRuntime` over
 * {@link journeyUnderNodes}), `where` names the journey, and page ids map to node ids.
 */
export function journeyTryPage(options: JourneyTryPageOptions = {}): JourneyTryPage {
  const source = options.journey ?? AGENT_JOURNEY_FORM;
  const first = (source.journey?.journeys ?? [])[0] as { id: string; pages: Array<{ id: string }> } | undefined;
  const page = tryPage({ ...options, tryIt: { where: { workspace: "journeys", journeyId: first?.id ?? "main" }, ...options.tryIt }, stub: { workspace: "journeys", mode: "journeys", ...options.stub } });
  const journey = agentRuntime(journeyUnderNodes(source));
  for (const { id } of first?.pages ?? []) {
    page.tryIt.state.pages.set(`n-${id}`, id);
  }
  const adapter = page.tryIt.adapter;
  adapter.runtime = () => (page.tryIt.state.trying ? journey : undefined);
  adapter.typed = () => {
    const state = journey.state();
    return { values: { ...state.values }, dirty: new Set(state.dirty) };
  };
  return { ...page, journey };
}

export { BuilderController };
