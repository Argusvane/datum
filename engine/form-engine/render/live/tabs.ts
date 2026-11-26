/**
 * The tabs container: a {@link LiveFeature} (`createTabsFeature()`) the host lists in `features`.
 * The adapter draws the strip and the panels; what the renderer owns, whatever binding draws:
 *
 * - which tab shows. Every panel is drawn (a field keeps its nodes and its answer while its tab
 *   is shut) and the choice is kept across draws; a tab an edit removed is simply gone and the
 *   first shows;
 * - the keys: arrows (the previous and next tab, wrapping; reversed in a right-to-left form),
 *   Home and End, with automatic activation as the ARIA tabs pattern has it. The tab is the
 *   element carrying `TabState.tabId`, wherever the binding put it. An adapter that answers
 *   `behaviour.keyboard: "component"` runs its own keys (`goa-tabs`); in the narrow view and in a
 *   flat one there are no tabs to key between;
 * - opening a tab for an error or a focus request on a field inside another tab (`reveal`);
 * - the narrow view: below `binding.tabsNarrowBelow` (the form's width in CSS px, watched by a
 *   ResizeObserver on the form element) `TabsState.narrow` is true and the adapter draws a
 *   contents list over the stacked panels;
 * - the flat view of a review or a print (`TabsState.flat`): every tab headed by its label, in order.
 *
 * `defaultTabsAdapter` is Datum's own tabs (`datum/tabs.ts`), the look drawn when neither the binding
 * nor the Datum binding has a tabs adapter.
 */
import type { PresentationReveal, PresentationTabs } from "../core/presentation-tree.js";
import { behaviourOf, usedContainerCapabilities, type TabsAdapter, type TabsState, type TabState } from "./contract.js";
import { componentTextOf } from "./component-text.js";
import { datumTabsAdapter } from "./datum/tabs.js";
import { html, nothing, type TemplateResult } from "./lit.js";
import type { DrawContext, LiveContext, LiveFeature } from "./mount.js";

const OWNER = "tabs";

/** The look Datum draws a tabs container with when neither the binding nor the Datum binding has a tabs adapter. */
export const defaultTabsAdapter: TabsAdapter = datumTabsAdapter;

/** What the feature keeps for the life of the mount. */
interface TabsMemory {
  /** The tab the person (or an error) opened, by tabs container id. */
  chosen: Map<string, string>;
  /** The tab each container showed in the last draw, and its first. */
  first: Map<string, string>;
  /** The form is narrower than the binding's breakpoint. */
  narrow: boolean;
  /** Tabs containers drawn by the draw in progress. */
  drawn: number;
  observed: HTMLElement | undefined;
  observer: ResizeObserver | undefined;
}

function memoryOf(live: LiveContext): TabsMemory {
  return live.memory<TabsMemory>(OWNER, () => ({ chosen: new Map(), first: new Map(), narrow: false, drawn: 0, observed: undefined, observer: undefined }));
}

export const tabIdOf = (tabsId: string, slotId: string): string => `${tabsId}__tab-${slotId}`;
export const panelIdOf = (tabsId: string, slotId: string): string => `${tabsId}__panel-${slotId}`;

/** The elements a panel's own heading can be, found by tag: the panel's first one that can take focus. */
const PANEL_HEADINGS = "h1[tabindex],h2[tabindex],h3[tabindex],h4[tabindex],h5[tabindex],h6[tabindex],[role=heading][tabindex]";

/**
 * Follows a contents link of the narrow view to its panel, as a link to a section does: the
 * panel's heading takes focus (the panel itself when its heading takes none) and the panel
 * scrolls to the top of the view.
 */
function goToPanel(live: LiveContext, panelId: string): void {
  const panel = live.root.getElementById(panelId);
  if (!(panel instanceof HTMLElement)) {
    return;
  }
  let target = panel.querySelector<HTMLElement>(PANEL_HEADINGS) ?? panel;
  if (!target.hasAttribute("tabindex")) {
    target.tabIndex = -1;
  }
  if (!live.focusElement(target) && target !== panel) {
    target = panel;
    panel.tabIndex = -1;
    live.focusElement(panel);
  }
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "start" });
  }
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────

function drawTabs(node: PresentationTabs, draw: DrawContext): ReturnType<DrawContext["container"]> | undefined {
  const live = draw.live;
  if (node.tabs.length === 0) {
    return undefined;
  }
  const memory = memoryOf(live);
  memory.drawn += 1;
  const slotIds = node.tabs.map((tab) => tab.slotId);
  const first = slotIds[0] as string;
  memory.first.set(node.id, first);
  const flat = live.mode === "readonly" || live.printing();
  const chosen = memory.chosen.get(node.id);
  const shown = chosen !== undefined && slotIds.includes(chosen) ? chosen : first;
  // The builder canvas keeps the strip: it is how an author reaches each panel's drop zone.
  const narrow = memory.narrow && !flat && live.options.canvasHooks === undefined;

  const tabs: TabState[] = node.tabs.map((tab) => ({
    slotId: tab.slotId,
    label: tab.label,
    selected: flat || tab.slotId === shown,
    tabId: tabIdOf(node.id, tab.slotId),
    panelId: panelIdOf(node.id, tab.slotId),
    errorCount: tab.errorCount,
    select: () => {
      if (flat) {
        return;
      }
      if (narrow) {
        // Every panel is stacked and shown: following a contents link goes to the panel.
        goToPanel(live, panelIdOf(node.id, tab.slotId));
        return;
      }
      if ((memory.chosen.get(node.id) ?? shown) === tab.slotId) {
        return;
      }
      memory.chosen.set(node.id, tab.slotId);
      live.redraw();
    },
    // An empty tab on the builder canvas shows its drop zone (`emptySlot`), as an empty group slot does.
    content:
      tab.children.length === 0 && live.options.canvasHooks?.emptySlot
        ? html`${live.call("emptySlot", node.key, () => live.options.canvasHooks?.emptySlot?.({ containerId: node.id, slotId: tab.slotId })) ?? nothing}`
        : draw.nodes(tab.children)
  }));

  const hintId = node.hint !== undefined ? `${node.model.accessibility.fieldId}__description` : undefined;
  const state: TabsState = {
    id: node.id,
    key: node.key,
    type: node.type,
    base: node.base,
    ...(node.legend !== undefined ? { legend: node.legend } : {}),
    ...(node.hint !== undefined ? { hint: node.hint } : {}),
    ...(hintId !== undefined ? { hintId } : {}),
    hideLegend: node.hideLegend,
    level: node.level,
    classNames: node.classNames,
    locale: draw.form.locale,
    dir: draw.form.dir,
    words: draw.words,
    text: componentTextOf(node.model.node, draw.form.locale, draw.words.words),
    tabs,
    narrow,
    flat
  };

  const resolved = live.resolve<TabsAdapter>("tabs", node.type, node.base, state);
  let adapter: TabsAdapter = resolved?.adapter ?? defaultTabsAdapter;
  let from: "binding" | "binding-base" | "datum" | "datum-base" | "renderer" = resolved?.from ?? "renderer";
  let via = resolved?.via ?? node.type;
  if (resolved === undefined || resolved.from === "datum" || resolved.from === "datum-base") {
    live.report(`${node.id}: component "${node.type}"`);
    live.warnOnce(`type:${node.type}`, `No adapter of this binding draws "${node.type}" (component "${node.id}"): Datum's draws it.`);
  }
  let drawn = live.call("template", node.key, () => adapter.template(state));
  if (drawn === undefined && adapter !== defaultTabsAdapter) {
    // The binding's template threw: Datum's draws the container, never nothing.
    adapter = defaultTabsAdapter;
    from = "renderer";
    via = node.type;
    drawn = live.call("template", node.key, () => adapter.template(state));
  }
  live.recordAdapter(node.id, { from, via, ...(adapter.name !== undefined ? { name: adapter.name } : {}) });
  live.reportCapabilities(node.id, adapter, usedContainerCapabilities("group", state));

  let inner: TemplateResult = drawn ?? html`${tabs.map((tab) => tab.content)}`;
  const canvas = live.options.canvasHooks?.renderContainer;
  if (canvas) {
    const base = inner;
    inner = live.call("renderContainer", node.key, () => canvas({ model: node.model, kind: "tabs", label: node.legend, slots: new Map(tabs.map((tab) => [tab.slotId, tab.content])) }, base)) ?? base;
  }

  // Whoever draws the strip, the tab is the element carrying the tab's id. A component that runs
  // its own keys (`goa-tabs`) is left alone, as are the narrow and flat views, which have no strip.
  const keyed = behaviourOf(adapter).keyboard !== "component" && !narrow && !flat;
  const onKeydown = keyed
    ? (event: KeyboardEvent): void => {
        const origin = event.composedPath()[0];
        const at = origin instanceof Element ? tabs.findIndex((tab) => tab.tabId === origin.id) : -1;
        if (at < 0) {
          return;
        }
        const rtl = draw.form.dir === "rtl";
        const next =
          event.key === (rtl ? "ArrowLeft" : "ArrowRight")
            ? (at + 1) % tabs.length
            : event.key === (rtl ? "ArrowRight" : "ArrowLeft")
              ? (at - 1 + tabs.length) % tabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : -1;
        if (next < 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const target = tabs[next] as TabState;
        target.select();
        const element = live.root.getElementById(target.tabId);
        if (element instanceof HTMLElement) {
          live.focusElement(element);
        }
      }
    : undefined;
  // Datum's look (its adapter, or the renderer's own default, which is Datum's) inside another binding is tinted by its tokens.
  return draw.container(node, node.base, inner, onKeydown, from !== "binding" && from !== "binding-base");
}

// ── The narrow view ────────────────────────────────────────────────────────────────────────

/** Measures the form against the binding's breakpoint; redraws when the view changes. */
function measure(live: LiveContext, memory: TabsMemory): void {
  const below = live.binding.tabsNarrowBelow;
  const form = memory.observed;
  if (below === undefined || below <= 0 || form === undefined) {
    return;
  }
  const width = form.getBoundingClientRect().width;
  // A form with no box (not rendered, detached) is not narrow.
  const narrow = width > 0 && width < below;
  if (narrow !== memory.narrow) {
    memory.narrow = narrow;
    live.redraw();
  }
}

/** Watches the form's width while tabs are drawn and the binding names a breakpoint. */
function watchWidth(live: LiveContext): void {
  const memory = memoryOf(live);
  const below = live.binding.tabsNarrowBelow;
  if (memory.drawn === 0 || below === undefined || below <= 0 || typeof ResizeObserver !== "function" || live.options.canvasHooks !== undefined) {
    return;
  }
  const form = live.form();
  if (form === null || memory.observed === form) {
    return;
  }
  memory.observer?.disconnect();
  memory.observed = form;
  memory.observer = new ResizeObserver(() => measure(live, memory));
  memory.observer.observe(form);
  measure(live, memory);
}

// ── The feature ────────────────────────────────────────────────────────────────────────────

/** The tabs container as a renderer module. */
export function createTabsFeature(): LiveFeature {
  return {
    id: OWNER,
    start(live) {
      return () => {
        const memory = memoryOf(live);
        memory.observer?.disconnect();
        memory.observer = undefined;
        memory.observed = undefined;
      };
    },
    drawNode: (node, draw) => (node.kind === "tabs" ? drawTabs(node, draw) : undefined),
    reveal(steps: readonly PresentationReveal[], live: LiveContext): boolean {
      const memory = memoryOf(live);
      let changed = false;
      for (const step of steps) {
        if (step.kind !== "tab") {
          continue;
        }
        if ((memory.chosen.get(step.tabsId) ?? memory.first.get(step.tabsId)) !== step.slotId) {
          memory.chosen.set(step.tabsId, step.slotId);
          changed = true;
        }
      }
      return changed;
    },
    afterDraw(_report, live) {
      watchWidth(live);
      memoryOf(live).drawn = 0;
    }
  };
}
