/**
 * The journey flow map's surface: the Journeys mode's Map view, put on the canvas in
 * the sheet's place (`showCanvasSurface`) as the preview is. It draws the journey on the page as
 * its steps, one box each, and every way from step to step leaving the step's box — Top down or
 * Left to right — from the designer's view of the tree (drafts laid over) and its graph facts
 * (`journeyFlow`). It is read and select only: a click selects what it shows through the
 * journey's controller, and what is not drawn here is edited in the inspector, the Rules tab,
 * the Step view and the outline beside it. Given the editing hooks (`edit`) it also builds the
 * journey: the bar's Add step and New rule, and a bar on the selected step (Open, Move up, Move
 * down, Duplicate, Delete) in the canvas selection bar's look. The map writes nothing itself:
 * each button names what it means and the mode does it as one undo step on the journey's
 * controller, with the tree operations of the journey's controller.
 *
 * A second map may stand on the same page (Try it's Journey card): every map keeps its state in
 * its own closure, and nothing here is shared between two of them.
 * - `readOnly` draws the same map with no selection, no context actions (a double click opening
 *   a step) and nothing to edit; walking it by keyboard, the direction and the zoom
 *   still work. Its items are images, not buttons (`role="img"`), and its label offers nothing to
 *   select (`journey.map.label.readOnly`); Space on an item is the map's, as the arrows are.
 * - `setState({ currentNodeId, takenEdges })` marks the way taken: the current step (`is-current`
 *   on its group, `aria-current="step"` on its card), the steps already shown (`is-taken`), and
 *   the ways taken (`is-taken` on the line and its chip; the map `has-path`), and says the same
 *   as each card's and route chip's `aria-description` ("Shown", "Taken"). It writes classes and those attributes only, never the picture, and
 *   brings the current step into view inside the map's scroller. With nothing, it clears the
 *   marks. The node ids are the steps' (a card's `data-map-item`), the edge ids the model's
 *   (`journeyMapEdgeId`), which name a route by its written position: a state is the runtime's
 *   walk of the journey as it stands, so set it again whenever the journey changes.
 * - Counts on the bar: "4 steps · 3 errors · 1 warning" (errors and warnings left out at zero), from
 *   the journey's own findings; the longer line (exits, branch points) is what is announced.
 * - `scroller` names the element the map measures its room in and scrolls (default: the canvas
 *   page it sits in, else its parent); `JOURNEY_MAP_STYLES` and `journeyMapStylesInto` give its
 *   stylesheet to the root it is put in. A map given a scroller, or read-only, scrolls only within
 *   it, never the page round it; and a map whose scroller is not the canvas page keeps no room
 *   for the builder's side drawer (`--jm-cover` pinned to nothing on its element). A fitted map
 *   follows its room: the scroller resizing, or the drawer opening, shutting or resizing over
 *   the canvas page (which leaves the page's own size alone), fits it again.
 *
 * The map's own lazy chunk, `datum-builder-journey-map-*.js`, which the designer's chunk loads
 * the first time Map is chosen. Its words are the designer's (`JourneyMapWords`, injected), so
 * it never loads the faces; nothing here runs at import.
 *
 * How it keeps to the builder's paint contract:
 * - **Built once, written only when it changes.** The element and its bar are made once; a
 *   redraw writes the SVG only when its markup differs from what is shown, so a keystroke that
 *   changes nothing on the map touches nothing. A redraw is queued once per task (a microtask),
 *   and the layout is kept per input, so a selection, a hover or a keystroke that leaves every
 *   size alone never lays the map out again.
 * - **View state lives here, never in the markup.** Selection, the highlight, the roving tab
 *   stop and the zoomed size are laid on after each write, from this surface's own state, and
 *   focus goes back to the item that had it.
 * - **Idempotent `show`.** The mode shows the map on every form change; the same journey again
 *   only catches up on what moved while it was hidden. A new journey is drawn afresh and fitted.
 *   A map shown afresh brings the selection (else Start) into view once, below the sticky head
 *   (`--jm-head-room`, which the items' scroll-margin reads); a selection made elsewhere is
 *   brought into view too, after the redraw that puts it on the map when one is queued.
 * - **Marks move only when the selection or the state does**, so a keystroke that changes
 *   nothing on the map writes nothing at all.
 * - **Off the page, it only notes that it is stale**, and catches up when shown; its size
 *   observer runs only while it is shown.
 * - **A listener that throws never reaches the controller's other listeners:** every entry
 *   point reports through `onError` instead.
 *
 * Keyboard (the map is one tab stop, and focus is not selection, so arrowing never raises the
 * unsaved-edits prompt): the arrows walk the items in reading order — a page, its ways out in
 * try order, its ignored routes, the next page; Alt with an arrow follows a way to where it
 * goes, or back to where it came from; Home and End; Space selects, and so does Enter (which
 * opens a step too, once the mode hears `onOpen`); Delete or Backspace on a step deletes it, as
 * the bar's Delete does (never the only step); + (or =), - and 0 zoom in, out and to fit, never with Ctrl or
 * Cmd, which stay the browser's and the canvas's (Cmd+Z undoes); Escape clears the highlight.
 * A zoom keeps the focused item in view and says the scale once the steps rest; Zoom in and
 * Zoom out are aria-disabled at either end. The bar is a toolbar: one tab stop, the arrows
 * between its buttons; so is the selected step's bar, after the picture in the tab order. Focus
 * stays on the button pressed, goes to the step's card when that button turns off (the top
 * step's Move up), and after a delete goes to the step that took its place.
 */
import { journeyFlow, type JourneyFlow } from "../../core/journey/journey-flow.js";
import type { BuilderTextKey, BuilderTextOptions } from "../logic/builder-texts.js";
import { builderText } from "./journey-map-texts-en.js";
import { layoutFlow, type FlowLayout, type FlowLayoutInput } from "./journey-map-layout.js";
import { journeyMapGraph, journeyMapLayoutInput, journeyMapLitEdges, type JourneyMapGraph, type JourneyMapPage, type JourneyMapSource, type JourneyMapWords } from "./journey-map-model.js";
import { normalizeJourneyMapLayout, type JourneyMapLayout } from "./journey-map-preferences.js";
import { journeyMapSvg } from "./journey-map-svg.js";
import { rovingToolbar } from "../web-component/toolbar-roving.js";
import { JOURNEY_MAP_ROOT_CLASS, JOURNEY_MAP_STYLES, journeyMapStylesInto } from "./journey-map-styles.js";

// What a second root needs to hold a map (its stylesheet), and the ids its state names.
export { JOURNEY_MAP_ROOT_CLASS, JOURNEY_MAP_STYLES, journeyMapStylesInto } from "./journey-map-styles.js";
export { journeyMapEdgeId, type JourneyMapWay } from "./journey-map-model.js";

/** The journey the map draws: one per designer build, as the preview's subject is. */
export interface JourneyMapSubject {
  readonly journeyId: string;
  /** The journey's name as the mode shows it, for the map's label. */
  name(): string;
  /** The designer's view of the journey's tree as it stands, drafts laid over (`JourneyDesignView` fits). */
  view(): JourneyMapSource;
  /** The node selected in the journey's controller. */
  selected(): string | undefined;
}

/**
 * What editing from the map asks of the mode, each done as one undo step on the journey's
 * controller (through the unsaved-edits guard). Nodes are the designer's node ids, never page
 * ids. The map leaves a button off when it could not apply (no next step to go to, the only
 * step to delete), so the mode does not repeat those rules.
 */
export interface JourneyMapEdit {
  /** Add step: an empty questions step after `afterNodeId` (the selected step), else at the end; it becomes the selection. */
  addStep(afterNodeId: string | undefined): void;
  /** New rule: a route from `fromNodeId` to `toNodeId` (the next step in order); it becomes the selection. */
  newRule(fromNodeId: string, toNodeId: string): void;
  /** Move up or down: the step one place earlier (-1) or later (1) in the journey's order. */
  moveStep(nodeId: string, delta: -1 | 1): void;
  /** Duplicate: a copy right after the step, with what is on it; it becomes the selection. */
  duplicateStep(nodeId: string): void;
  /** Delete: the step goes, after the confirmation the designer asks for any step. */
  deleteStep(nodeId: string): void;
}

/** What the mode hands the map. */
export interface JourneyMapContext {
  /** The layout to draw first: the viewer's remembered one, else the default. */
  layout: JourneyMapLayout;
  /** A click, Enter or Space on something the map draws: select that node (through the unsaved-edits guard). Never called on a read-only map. */
  onSelect?(nodeId: string): void;
  /** Enter or a double click on a step, or the selection bar's Open: that step, opened to be filled. Never called on a read-only map. */
  onOpen?(nodeId: string): void;
  /**
   * A click or Enter on a rule's label or on one of a step's ignored rules: that rule, opened in
   * the Logic editor. `nodeId` is the route's node. Needs `edit`; never called on a
   * read-only map. The route is selected first, as a click always selects.
   */
  onOpenRule?(nodeId: string): void;
  /**
   * Whether the rules can be opened and made in the Logic workspace now (a shell may not offer it:
   * the `features` list, hidden workspaces). Asked each time the bar is drawn and a rule clicked;
   * `false` leaves out the bar's New rule and makes a click on a rule only select it. Default: yes.
   */
  rulesEditable?(): boolean;
  /**
   * What the bar's buttons mean (see {@link JourneyMapEdit}). Without it the bar has no Add step,
   * New rule or selection bar; a read-only map never has them.
   */
  edit?: JourneyMapEdit;
  /** The viewer chose another layout on the map's bar. */
  onLayout?(layout: JourneyMapLayout): void;
  onError?(message: string, cause?: unknown): void;
  /**
   * A map to look at, not to edit (Try it's): no selection marked or made, no double click to
   * open a step; the keys still walk it, and its direction and zoom still work.
   */
  readOnly?: boolean;
  /**
   * Whether the head draws the direction and zoom buttons (default: yes). Try it's card leaves
   * them off: its window is too small to spend on them. The counts line stays, and the keys
   * (+, -, 0) and the scroller's own scrolling still move the picture.
   */
  controls?: boolean;
  /**
   * The element the map measures its room in, watches and scrolls the current step within:
   * given, or found from the map's own element (`null` until it is on the page). Default: the
   * canvas page the map sits in, else its parent.
   */
  scroller?: HTMLElement | ((map: HTMLElement) => HTMLElement | null | undefined);
}

/**
 * The way taken, as a runtime walks it (Try it). `currentNodeId` is the current step's node id
 * (the card's `data-map-item`); `takenEdges` the ways already taken, by the model's edge ids
 * (`journeyMapEdgeId`: `start`, `route:<step>:<index>`, `next:<step>`). Ids the
 * map does not draw mark nothing. A route's id is its written position, as the runtime's
 * decisions name it: after routes are reordered or deleted the same id names another route, so
 * a state is set again from the runtime whenever the journey changes (the map keeps the last
 * one across a redraw, as it was given).
 */
export interface JourneyMapState {
  currentNodeId?: string | undefined;
  takenEdges?: readonly string[] | undefined;
}

/** What the designer adds: the form and the words the map speaks in. */
export interface JourneyMapOptions extends JourneyMapContext {
  /**
   * The designer's words, for a journey of this name and id. The id lets it word a page's title
   * for the preview locale from the page's address, `journeys › <id> › pages › <page id> › title`.
   */
  words(journeyName: string, journeyId: string): JourneyMapWords;
  /** The builder's locale and catalog for the map's own words, read live. English when absent. */
  text?(): BuilderTextOptions | undefined;
}

export interface JourneyMap {
  /** The surface the canvas shows in the sheet's place. */
  readonly element: HTMLElement;
  /** Its stylesheet, which travels with it into the canvas's shadow root. */
  readonly styles: string;
  /** Puts the stylesheet into the root the map is put in (a shadow root, or a document), once: for a map that is not the canvas's surface. */
  stylesInto(root: ShadowRoot | Document): void;
  readonly visible: boolean;
  readonly subject: JourneyMapSubject | undefined;
  readonly layout: JourneyMapLayout;
  /** The zoom asked for: a factor, or `"fit"` while it follows the page. */
  readonly zoomLevel: number | "fit";
  /** Made to look at, not to edit (`JourneyMapContext.readOnly`). */
  readonly readOnly: boolean;
  /** The way taken as last set, a copy; `undefined` when cleared. */
  readonly state: JourneyMapState | undefined;
  /** Puts `subject` on the map, or catches up on what moved while it was hidden; a new subject is fitted. */
  show(subject: JourneyMapSubject): void;
  /** The journey changed (with no subject, the form it reads did): redrawn once this task is done, or when next shown. Another subject's change is ignored. A `live` change (a draft keystroke) waits until the typing rests, then draws once. */
  refresh(subject?: JourneyMapSubject, live?: boolean): void;
  hide(): void;
  /** The journey's selection moved: marked on the map, and brought into view unless the map made it. */
  select(subject: JourneyMapSubject): void;
  /** Draws the journey another way, fitted again; the map's bar says which. */
  setLayout(layout: JourneyMapLayout): void;
  /**
   * Marks the way taken (see {@link JourneyMapState}) with classes only — the picture is not
   * drawn again — and brings the current step into view inside the scroller. Called with
   * nothing (or with neither field), it clears the marks. Kept across redraws.
   */
  setState(state?: JourneyMapState): void;
  zoom(value: number | "fit"): void;
  dispose(): void;
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
/** Fit never draws smaller: 11px chips at 0.6 are about 7px, the least that still reads. */
const FIT_MIN = 0.6;
/** What a surface not on the page yet measures (and jsdom, which lays nothing out). */
const FALLBACK_ROOM = 300;
/** Layouts kept per map: the four ways of drawing the journey as it stands. */
const LAYOUTS_KEPT = 4;
/** How long the counts must rest before they are announced: typing a title says nothing per key. */
const ANNOUNCE_DELAY_MS = 800;
/** How long typing in a route's condition box must rest before the map is drawn again. */
const LIVE_REFRESH_DELAY_MS = 150;
/** How long a run of zoom steps must rest before the scale is said: one word per run, not per key. */
const ZOOM_ANNOUNCE_DELAY_MS = 300;
/** The room under the head, as the stylesheet gives it. */
const HEAD_GAP = 12;

/** The map's chrome. Every author-visible word carries its builder key: `data-map-tx` for text, `data-map-tx-<attribute>` for an attribute; `relabel` writes them in the builder's locale. */
const MARKUP = `
  <div class="jm-head" data-map-head>
    <div class="jm-bar" role="toolbar" data-map-tx-aria-label="journey.map.bar" data-map-bar>
      <div class="seg" role="group" data-map-tx-aria-label="journey.map.direction">
        <button type="button" class="seg-btn" data-map-direction="down" aria-pressed="true" data-map-tx-title="journey.map.direction.down.title"><span aria-hidden="true">↓</span> <span data-map-tx="journey.map.direction.down">Top down</span></button>
        <button type="button" class="seg-btn" data-map-direction="right" aria-pressed="false" data-map-tx-title="journey.map.direction.right.title"><span aria-hidden="true">→</span> <span data-map-tx="journey.map.direction.right">Left to right</span></button>
      </div>
      <div class="jm-zoom" role="group" data-map-tx-aria-label="journey.map.zoom">
        <button type="button" class="jm-btn" data-map-zoom="out" data-map-tx-aria-label="journey.map.zoom.out" data-map-tx-data-tip="journey.map.zoom.out">−</button>
        <button type="button" class="jm-btn" data-map-zoom="in" data-map-tx-aria-label="journey.map.zoom.in" data-map-tx-data-tip="journey.map.zoom.in">+</button>
        <button type="button" class="jm-btn" data-map-zoom="fit"><span data-map-tx="journey.map.fit">Fit</span></button>
        <button type="button" class="jm-btn" data-map-zoom="actual" data-map-tx-aria-label="journey.map.actual" data-map-tx-data-tip="journey.map.actual.title">100%</button>
      </div>
      <div class="jm-edit" data-map-edit>
        <button type="button" class="jm-btn" data-map-rule aria-disabled="true"><span data-map-tx="journey.map.rule">New rule</span></button>
        <button type="button" class="jm-btn jm-btn--primary" data-map-add><span data-map-tx="journey.map.add">Add step</span></button>
      </div>
    </div>
    <p class="jm-status" data-map-status></p>
    <p class="jm-problem" data-map-problem hidden></p>
    <p class="jm-sr" data-map-announce role="status" aria-live="polite"></p>
  </div>
  <div class="jm-stage" data-map-stage></div>
  <div class="jm-selzone" data-map-selzone hidden>
    <div class="jm-selbar" role="toolbar" data-map-selbar>
      <span class="jm-selname" data-map-selname></span>
      <button type="button" class="jm-selopen" data-map-sel="open" data-map-tx-title="journey.map.sel.open.title"><span data-map-tx="journey.map.sel.open">Open</span></button>
      <button type="button" class="jm-selbtn" data-map-sel="up" data-map-tx-aria-label="journey.map.sel.up" data-map-tx-data-tip="journey.map.sel.up.title" data-tip-side="top"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4"></path></svg></button>
      <button type="button" class="jm-selbtn" data-map-sel="down" data-map-tx-aria-label="journey.map.sel.down" data-map-tx-data-tip="journey.map.sel.down.title" data-tip-side="top"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M4 9l4 4 4-4"></path></svg></button>
      <button type="button" class="jm-selbtn" data-map-sel="duplicate" data-map-tx-aria-label="journey.map.sel.duplicate" data-map-tx-data-tip="journey.map.sel.duplicate.title" data-tip-side="top"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2"></path></svg></button>
      <button type="button" class="jm-selbtn jm-selbtn--delete" data-map-sel="delete" data-map-tx-aria-label="journey.map.sel.delete" data-map-tx-data-tip="journey.map.sel.delete.title" data-tip-side="top"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9"></path></svg></button>
    </div>
  </div>
`;

/** `[name="value"]` with the value quoted for a selector (no `CSS.escape` under jsdom). */
function byAttribute(name: string, value: string): string {
  return `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

/** Whether focus is on `element` or inside it, as its own document or shadow root sees it. */
function holdsFocus(element: Element): boolean {
  const active = (element.getRootNode() as Document | ShadowRoot).activeElement;
  return active !== null && active !== undefined && element.contains(active);
}

function focusElement(element: Element | null | undefined): void {
  const target = element as (Element & { focus?: () => void }) | null | undefined;
  if (typeof target?.focus === "function") {
    target.focus();
  }
}

function px(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function size(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Writes an attribute only when it moves: a write of the same value still invalidates style and the accessibility tree. */
function setAttr(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function scrollTo(target: Element | null | undefined): void {
  if (target && typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function sameLayout(a: JourneyMapLayout, b: JourneyMapLayout): boolean {
  return a.direction === b.direction;
}

/** A state as the map keeps it: a copy, or `undefined` for nothing to mark. */
function stateOf(value: JourneyMapState | undefined): JourneyMapState | undefined {
  const current = typeof value?.currentNodeId === "string" && value.currentNodeId !== "" ? value.currentNodeId : undefined;
  const taken = Array.isArray(value?.takenEdges) ? value.takenEdges.filter((id): id is string => typeof id === "string") : [];
  if (current === undefined && taken.length === 0) {
    return undefined;
  }
  return { ...(current !== undefined ? { currentNodeId: current } : {}), takenEdges: taken };
}

/** The map's surface: see the module comment. */
export function createJourneyMap(options: JourneyMapOptions): JourneyMap {
  const element = document.createElement("div");
  element.className = JOURNEY_MAP_ROOT_CLASS;
  element.setAttribute("data-journey-map", "");
  element.innerHTML = MARKUP;
  const readOnly = options.readOnly === true;
  if (readOnly) {
    element.setAttribute("data-read-only", "");
  }
  // The buttons that build the journey, and the bar on the selected step: only a map the mode
  // gave the means to edit, and never one that only looks.
  const edit = readOnly ? undefined : options.edit;
  if (edit) {
    element.setAttribute("data-editable", "");
  } else {
    for (const each of element.querySelectorAll("[data-map-edit], [data-map-selzone]")) {
      each.remove();
    }
  }
  const head = element.querySelector<HTMLElement>("[data-map-head]")!;
  const bar = element.querySelector<HTMLElement>("[data-map-bar]")!;
  // A map that draws no controls (Try it's card): the bar is put away, the counts line kept.
  if (options.controls === false) {
    bar.hidden = true;
  }
  const stage = element.querySelector<HTMLElement>("[data-map-stage]")!;
  // An empty line as wide as the side drawer's cover, for the size observer: the drawer opening,
  // shutting or being dragged lies over the scroller without resizing it, so this is what moves.
  // Styled through the style object, which a strict style-src allows where an attribute is not.
  const coverGauge = document.createElement("div");
  coverGauge.setAttribute("data-map-cover", "");
  coverGauge.setAttribute("aria-hidden", "true");
  for (const [name, value] of [
    ["display", "block"],
    ["width", "var(--jm-cover, 0px)"],
    ["height", "0"],
    ["overflow", "hidden"],
    ["visibility", "hidden"],
    ["pointer-events", "none"]
  ] as const) {
    coverGauge.style.setProperty(name, value);
  }
  element.append(coverGauge);
  const statusEl = element.querySelector<HTMLElement>("[data-map-status]")!;
  const problemEl = element.querySelector<HTMLElement>("[data-map-problem]")!;
  const announceEl = element.querySelector<HTMLElement>("[data-map-announce]")!;
  const addButton = element.querySelector<HTMLElement>("[data-map-add]");
  const ruleButton = element.querySelector<HTMLElement>("[data-map-rule]");
  const selZone = element.querySelector<HTMLElement>("[data-map-selzone]");
  const selBar = element.querySelector<HTMLElement>("[data-map-selbar]");
  const selName = element.querySelector<HTMLElement>("[data-map-selname]");
  const selButtons = [...element.querySelectorAll<HTMLButtonElement>("[data-map-sel]")];
  const zoomInButton = element.querySelector<HTMLElement>('[data-map-zoom="in"]')!;
  const zoomOutButton = element.querySelector<HTMLElement>('[data-map-zoom="out"]')!;
  const barButtons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
  const textOf = (): BuilderTextOptions | undefined => options.text?.();
  const say = (key: BuilderTextKey, params?: Record<string, string | number>): string => builderText(key, params, textOf());

  let layout = normalizeJourneyMapLayout(options.layout);
  let subject: JourneyMapSubject | undefined;
  let visible = false;
  let disposed = false;
  /** The journey changed while the map was hidden: drawn again when shown. */
  let stale = false;
  let queued = false;
  let graph: JourneyMapGraph | undefined;
  /** The view the graph was drawn from: what a selection is placed through until the next draw. */
  let drawnView: JourneyMapSource | undefined;
  let drawn: FlowLayout | undefined;
  let lastSvg = "";
  let zoomSetting: number | "fit" = "fit";
  let scale = 1;
  /** The side drawer's cover (the stage's start padding) the last fit was measured beside. */
  let fittedCover: number | undefined;
  /** The roving tab stop: the item Tab lands on. */
  let current: string | undefined;
  /** The item (or `edge:<key>`) whose lines are lit. */
  let lit: string | undefined;
  /** Set while the map selects, so its own selection is not scrolled to. */
  let fromMap = false;
  /** What the selection marks on the picture stand for: laid on again only when it moves, or after a write. */
  let marked: string | undefined;
  /** The selection the map last marked, kept across writes: one that moved with no word to the map (an add selects what it adds) is brought into view when drawn. */
  let markedId: string | undefined;
  /** A selection made elsewhere while a redraw is queued (a page added, an undo): brought into view once drawn. */
  let scrollPending = false;
  /** Shown afresh (from another view or tab, or another journey): the selection brought into view once on the page. */
  let revealPending = false;
  /** Where Alt+Arrow followed each item from, so Alt+Arrow back returns there. */
  const cameFrom = new Map<string, string>();
  const flows = new WeakMap<object, JourneyFlow>();
  const layouts = new Map<string, FlowLayout>();
  let observer: ResizeObserver | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let zoomTimer: ReturnType<typeof setTimeout> | undefined;
  let announced = "";
  /** The way taken (setState), laid on after each write. */
  let state: JourneyMapState | undefined;
  /** What the state marks on the picture stand for: laid on again only when it moves, or after a write. */
  let stateMarked: string | undefined;
  /** A step deleted from the map and the step that takes its place: focus goes there once it is drawn gone. */
  let afterDelete: { gone: string; next: string | undefined } | undefined;
  /** A current step set before it could be brought into view (not drawn, or off the page): brought into view once it can. */
  let stateScrollPending = false;

  const fail = (message: string, error: unknown): void => {
    try {
      options.onError?.(message, error);
    } catch {
      // A host's error handler that throws has said all it can.
    }
  };

  // --- the drawing ------------------------------------------------------------------------

  const flowOf = (view: JourneyMapSource): JourneyFlow | undefined => {
    const journey = view.check.journey;
    if (journey === undefined) {
      return undefined;
    }
    let flow = flows.get(view);
    if (!flow) {
      flow = journeyFlow(journey);
      flows.set(view, flow);
    }
    return flow;
  };

  const layoutOf = (input: FlowLayoutInput): FlowLayout => {
    const key = JSON.stringify(input);
    const kept = layouts.get(key);
    if (kept) {
      layouts.delete(key);
      layouts.set(key, kept);
      return kept;
    }
    const made = layoutFlow(input);
    layouts.set(key, made);
    if (layouts.size > LAYOUTS_KEPT) {
      layouts.delete(layouts.keys().next().value as string);
    }
    return made;
  };

  const svgEl = (): SVGSVGElement | null => stage.querySelector<SVGSVGElement>("svg.jm-svg");
  const itemEl = (key: string): SVGElement | null => stage.querySelector<SVGElement>(byAttribute("data-map-item", key));
  const itemOf = (target: EventTarget | null): string | undefined =>
    (target as Element | null)?.closest?.("[data-map-item]")?.getAttribute("data-map-item") ?? undefined;
  const focusedItem = (): string | undefined => {
    const active = (stage.getRootNode() as Document | ShadowRoot).activeElement;
    return active && stage.contains(active) ? itemOf(active) : undefined;
  };

  /** The element the map's room is measured in and scrolled within (see `JourneyMapContext.scroller`). */
  const scrollerOf = (): HTMLElement | null => {
    const given = options.scroller;
    if (typeof given === "function") {
      return given(element) ?? null;
    }
    if (given !== undefined) {
      return given;
    }
    return element.closest<HTMLElement>(".canvas-page") ?? element.parentElement;
  };

  /**
   * The room the page gives the map: its scroller's content box, less the head when the head is
   * inside it (it sticks inside the scroller's padding); and how far down the scroller's top the
   * head reaches. A scroller that is the map's own stage (Try it's card) has the head above it.
   */
  const room = (): { width: number; height: number; headRoom: number; viewHeight: number } => {
    const scroller = scrollerOf();
    let width = scroller?.clientWidth ?? 0;
    let height = scroller?.clientHeight ?? 0;
    let top = 0;
    if (scroller && typeof getComputedStyle === "function") {
      const style = getComputedStyle(scroller);
      top = px(style.paddingTop);
      width -= px(style.paddingLeft) + px(style.paddingRight);
      height -= top + px(style.paddingBottom);
    }
    // What the scroller shows below its padding, before the head takes its part: the room the
    // selected step's bar sticks to the foot of (the map is at least as tall as this).
    const viewHeight = height;
    const headHeight = (scroller && !scroller.contains(head) ? 0 : head.offsetHeight) + HEAD_GAP;
    height -= headHeight;
    return { width: width > 0 ? width : FALLBACK_ROOM, height: height > 0 ? height : FALLBACK_ROOM, headRoom: top + headHeight, viewHeight };
  };

  /**
   * What an item scrolled into view (a selection, a focused item) keeps clear above it: the
   * sticky head, which otherwise covers it (the stylesheet's scroll-margin-top reads it).
   */
  const applyHeadRoom = (headRoom: number): void => {
    const value = `${Math.round(headRoom)}px`;
    if (element.style.getPropertyValue("--jm-head-room") !== value) {
      element.style.setProperty("--jm-head-room", value);
    }
  };

  /** Fits across the flow only (width for Top down, height for Left to right), never below what reads, never above its own size. */
  const fitScale = (available: { width: number; height: number }): number => {
    if (!drawn || drawn.width <= 0 || drawn.height <= 0) {
      return 1;
    }
    const across = layout.direction === "down" ? available.width / drawn.width : available.height / drawn.height;
    return Math.min(1, Math.max(FIT_MIN, across));
  };

  /**
   * The builder's side drawer lies over the canvas page alone (the stylesheet's --jm-cover reads
   * its width): a map scrolled anywhere else (Try it's card, on the far edge) starts at its own
   * edge, so it pins the cover to nothing on itself. The canvas's map writes nothing here.
   */
  const applyCover = (): void => {
    const scroller = scrollerOf();
    if (!scroller) {
      return;
    }
    const want = scroller.classList.contains("canvas-page") ? "" : "0px";
    if (element.style.getPropertyValue("--jm-cover") !== want) {
      // The room an inspector takes is the canvas's too: a map in a card of its own has its whole width.
      for (const name of ["--jm-cover", "--jm-props"]) {
        if (want === "") {
          element.style.removeProperty(name);
        } else {
          element.style.setProperty(name, want);
        }
      }
    }
  };

  const applyZoom = (): void => {
    applyCover();
    const available = room();
    element.style.setProperty("--jm-view-w", `${Math.round(available.width)}px`);
    if (edit && available.viewHeight > 0) {
      element.style.setProperty("--jm-view-h", `${Math.round(available.viewHeight)}px`);
    }
    applyHeadRoom(available.headRoom);
    // Fitted beside the side drawer, which the picture starts clear of (the stage's padding).
    if (zoomSetting === "fit") {
      fittedCover = px(getComputedStyle(stage).paddingLeft);
      scale = fitScale({ ...available, width: available.width - fittedCover });
    } else {
      scale = zoomSetting;
    }
    const svg = svgEl();
    if (svg && drawn) {
      svg.setAttribute("width", size(drawn.width * scale));
      svg.setAttribute("height", size(drawn.height * scale));
    }
    // At either end, the step that way does nothing, and says so.
    setAttr(zoomInButton, "aria-disabled", String(scale >= ZOOM_MAX));
    setAttr(zoomOutButton, "aria-disabled", String(scale <= ZOOM_MIN));
  };

  /** Where a selected node is on the map: the item that draws it, and the page it is on. */
  const placeOf = (id: string): { item?: string; page?: string } => {
    if (!graph) {
      return {};
    }
    if (drawnView && id === drawnView.tree.id) {
      // The root: Start alone is marked, though End selects it too.
      return { item: "$start" };
    }
    for (const node of graph.nodes) {
      if (node.kind !== "page") {
        continue;
      }
      if (node.item === id) {
        return { item: id };
      }
      if (node.stubs.some((stub) => stub.item === id)) {
        return { item: id, ...(node.item !== undefined ? { page: node.item } : {}) };
      }
    }
    const chip = graph.edges.find((edge) => edge.label?.item === id);
    if (chip) {
      // A route's line leaves its step's card.
      return { item: id, ...(chip.from.startsWith("page:") ? { page: chip.from.slice(5) } : {}) };
    }
    const holder = drawnView?.index.pageOf.get(id);
    return holder ? { page: holder.nodeId } : {};
  };

  /**
   * Who says `aria-current`: the selected item says "true", the current step's card "step"; the
   * current step's wins where they meet. Written only where it moves.
   */
  const applyCurrent = (): void => {
    const want = new Map<Element, string>();
    const selected = stage.querySelector("[data-map-item].is-selected");
    if (selected) {
      want.set(selected, "true");
    }
    const step = state?.currentNodeId !== undefined ? itemEl(state.currentNodeId) : null;
    if (step && stage.querySelector(`.is-current${byAttribute("data-map-node", `page:${state!.currentNodeId}`)}`)) {
      want.set(step, "step");
    }
    for (const each of stage.querySelectorAll("[aria-current]")) {
      if (!want.has(each)) {
        each.removeAttribute("aria-current");
      }
    }
    for (const [each, value] of want) {
      setAttr(each, "aria-current", value);
    }
  };

  /** The selection marked on the picture (the marks moved only when it did: a keystroke that leaves it touches nothing), and brought into view when `scroll`. A read-only map marks none. */
  const applySelection = (scroll: boolean): void => {
    syncEdit();
    const id = readOnly ? undefined : subject?.selected();
    markedId = id;
    const place = id !== undefined ? placeOf(id) : {};
    const mark = id === undefined ? "" : JSON.stringify([id, place.item ?? "", place.page ?? ""]);
    if (mark === marked && !scroll) {
      return;
    }
    const itemElement = place.item !== undefined ? itemEl(place.item) : null;
    const pageGroup = place.page !== undefined ? stage.querySelector(`.jm-page${byAttribute("data-map-node", `page:${place.page}`)}`) : null;
    if (mark !== marked) {
      marked = mark;
      for (const each of stage.querySelectorAll(".is-selected")) {
        each.classList.remove("is-selected");
      }
      for (const each of stage.querySelectorAll(".is-within")) {
        each.classList.remove("is-within");
      }
      itemElement?.classList.add("is-selected");
      pageGroup?.classList.add("is-within");
      applyCurrent();
    }
    if (scroll) {
      bringIntoView(itemElement ?? pageGroup);
    }
  };

  /**
   * `target` brought into view inside the map's scroller alone (never the page around it), clear
   * of the sticky head: the current step in a card that scrolls, as Try it's does.
   */
  const scrollWithin = (target: Element | null): void => {
    const scroller = scrollerOf();
    if (!target || !scroller || typeof target.getBoundingClientRect !== "function") {
      return;
    }
    const outer = scroller.getBoundingClientRect();
    const inner = target.getBoundingClientRect();
    const top = outer.top + room().headRoom;
    const gap = HEAD_GAP;
    let dy = 0;
    if (inner.top < top) {
      dy = inner.top - top;
    } else if (inner.bottom > outer.bottom - gap) {
      dy = Math.min(inner.bottom - outer.bottom + gap, inner.top - top);
    }
    let dx = 0;
    if (inner.left < outer.left + gap) {
      dx = inner.left - outer.left - gap;
    } else if (inner.right > outer.right - gap) {
      dx = Math.min(inner.right - outer.right + gap, inner.left - outer.left - gap);
    }
    if (dy !== 0) {
      scroller.scrollTop += dy;
    }
    if (dx !== 0) {
      scroller.scrollLeft += dx;
    }
  };

  /**
   * Whether the map keeps its scrolling to its scroller: one given a scroller, or read-only (Try
   * it's card, in a panel of the builder), never moves the page or panel around it. The canvas's
   * map scrolls as it always has, every scroller round the item (`scrollIntoView`).
   */
  const contained = options.scroller !== undefined || readOnly;

  /** `target` brought into view: inside the scroller alone when {@link contained}, else the canvas's way. */
  const bringIntoView = (target: Element | null | undefined): void => {
    if (contained) {
      scrollWithin(target ?? null);
    } else {
      scrollTo(target);
    }
  };

  /** The current step's group on the picture, when the state names one it draws. */
  const currentGroup = (): Element | null =>
    state?.currentNodeId !== undefined ? stage.querySelector(`.jm-page${byAttribute("data-map-node", `page:${state.currentNodeId}`)}`) : null;

  /**
   * The way taken in words, for a screen reader, beside the classes that draw it: a step's card
   * says "Shown" (the current one says `aria-current="step"`), a route's chip
   * on the way taken "Taken", as its accessible description. The picture's markup has none.
   */
  const applyStateWords = (): void => {
    const want = new Map<Element, string>();
    for (const group of stage.querySelectorAll(".jm-page.is-taken")) {
      const node = group.getAttribute("data-map-node") ?? "";
      const cardEl = node.startsWith("page:") ? itemEl(node.slice(5)) : null;
      if (cardEl) {
        want.set(cardEl, say("journey.map.state.shown"));
      }
    }
    for (const chipEl of stage.querySelectorAll("[data-map-item][data-edge].is-taken")) {
      want.set(chipEl, say("journey.map.state.taken"));
    }
    for (const each of stage.querySelectorAll("[aria-description]")) {
      if (!want.has(each)) {
        each.removeAttribute("aria-description");
      }
    }
    for (const [each, value] of want) {
      setAttr(each, "aria-description", value);
    }
  };

  /**
   * The way taken marked on the picture (see the module comment): classes only, moved only when
   * the state does (or after a write), and the current step brought into view when `scroll`.
   */
  const applyState = (scroll: boolean): void => {
    const mark = state === undefined ? "" : JSON.stringify([state.currentNodeId ?? "", [...(state.takenEdges ?? [])].sort()]);
    if (mark !== stateMarked) {
      stateMarked = mark;
      for (const name of ["is-current", "is-taken"]) {
        for (const each of stage.querySelectorAll(`.${name}`)) {
          each.classList.remove(name);
        }
      }
      const taken = new Set(state?.takenEdges ?? []);
      const touched = new Set<string>();
      let drawnTaken = 0;
      for (const edge of graph?.edges ?? []) {
        if (!taken.has(edge.key)) {
          continue;
        }
        const drawnEdge = stage.querySelectorAll(byAttribute("data-edge", edge.key));
        for (const each of drawnEdge) {
          each.classList.add("is-taken");
        }
        drawnTaken += drawnEdge.length > 0 ? 1 : 0;
        touched.add(edge.from).add(edge.to);
      }
      element.classList.toggle("has-path", drawnTaken > 0);
      const currentKey = state?.currentNodeId !== undefined ? `page:${state.currentNodeId}` : undefined;
      for (const key of touched) {
        const group = stage.querySelector(byAttribute("data-map-node", key));
        if (group && key !== currentKey) {
          group.classList.add("is-taken");
        }
      }
      currentGroup()?.classList.add("is-current");
      applyCurrent();
      applyStateWords();
    }
    if (scroll || stateScrollPending) {
      const group = currentGroup();
      if (group && visible && element.isConnected) {
        stateScrollPending = false;
        scrollWithin(group);
      } else if (scroll) {
        stateScrollPending = state?.currentNodeId !== undefined;
      }
    }
  };

  /** Shown afresh: the current step, else the selection, else Start, brought into view once the surface is on the page. */
  const reveal = (): void => {
    if (!revealPending || !visible || !element.isConnected || !graph) {
      return;
    }
    revealPending = false;
    const step = currentGroup();
    if (step) {
      stateScrollPending = false;
      scrollWithin(step);
      return;
    }
    const first = graph.readingOrder[0];
    bringIntoView(
      stage.querySelector("[data-map-item].is-selected") ?? stage.querySelector(".jm-page.is-within") ?? (first !== undefined ? itemEl(first) : null)
    );
  };

  /** The roving tab stop on `key` (tabindex only; focus stays where it is). */
  const rove = (key: string): SVGElement | null => {
    const target = itemEl(key);
    if (!target) {
      return null;
    }
    if (current !== undefined && current !== key) {
      itemEl(current)?.setAttribute("tabindex", "-1");
    }
    current = key;
    target.setAttribute("tabindex", "0");
    return target;
  };

  /** After a write, every item is `tabindex="-1"`: the stop goes back, or to the selection, else to Start. */
  const applyRoving = (): void => {
    let target = current !== undefined ? itemEl(current) : null;
    if (!target) {
      target = stage.querySelector<SVGElement>("[data-map-item].is-selected") ?? stage.querySelector<SVGElement>("[data-map-item]");
      current = target?.getAttribute("data-map-item") ?? undefined;
    }
    target?.setAttribute("tabindex", "0");
  };

  const applyHighlight = (): void => {
    for (const edge of stage.querySelectorAll(".jm-edge.is-lit")) {
      edge.classList.remove("is-lit");
    }
    const keys = lit !== undefined && graph ? journeyMapLitEdges(graph, lit) : new Set<string>();
    element.classList.toggle("is-lighting", keys.size > 0);
    for (const key of keys) {
      stage.querySelector(`.jm-edge${byAttribute("data-edge", key)}`)?.classList.add("is-lit");
    }
  };

  const setLit = (key: string | undefined): void => {
    if (key === lit) {
      return;
    }
    lit = key;
    applyHighlight();
  };

  /** Whether the text moved. */
  const setText = (target: HTMLElement, text: string): boolean => {
    if (target.textContent === text) {
      return false;
    }
    target.textContent = text;
    return true;
  };

  /** The counts, said once they rest: never a word per keystroke. */
  const announce = (status: string): void => {
    if (announceTimer !== undefined) {
      clearTimeout(announceTimer);
      announceTimer = undefined;
    }
    if (status === announced) {
      return;
    }
    announceTimer = setTimeout(() => {
      announceTimer = undefined;
      if (visible && !disposed) {
        announced = status;
        announceEl.textContent = say("journey.map.announce", { status });
      }
    }, ANNOUNCE_DELAY_MS);
  };

  const draw = (): void => {
    stale = false;
    relabel();
    const target = subject;
    if (!target) {
      return;
    }
    const pending = scrollPending;
    scrollPending = false;
    try {
      // A selection made elsewhere while this draw was queued, or one that moved with the change
      // (an add selects what it adds, with no selection event): brought into view once drawn.
      const selected = target.selected();
      const scroll = pending || (selected !== undefined && selected !== markedId);
      const view = target.view();
      const words = options.words(target.name(), target.journeyId);
      const next = journeyMapGraph(view, flowOf(view), readOnly ? { ...words, readOnly: true } : words, graph);
      graph = next;
      drawnView = view;
      drawn = layoutOf(journeyMapLayoutInput(next, layout));
      // The head first, so the room below it is measured as it now stands.
      let headMoved = setText(statusEl, next.bar);
      headMoved = setText(problemEl, next.problem ?? "") || headMoved;
      if (problemEl.hidden !== (next.problem === undefined)) {
        problemEl.hidden = next.problem === undefined;
        headMoved = true;
      }
      const svg = journeyMapSvg(next, drawn);
      if (svg !== lastSvg) {
        const hadFocus = holdsFocus(stage);
        stage.innerHTML = svg;
        lastSvg = svg;
        marked = undefined;
        stateMarked = undefined;
        // Everything the markup leaves out, laid on again (see the module comment).
        applyZoom();
        applySelection(scroll);
        applyState(false);
        applyRoving();
        applyHighlight();
        if (hadFocus && current !== undefined) {
          focusElement(itemEl(current));
        }
      } else {
        if (headMoved) {
          // A taller or shorter head: less or more room for the picture, and to keep clear.
          applyZoom();
        }
        applySelection(scroll);
        applyState(false);
      }
      settleAfterDelete();
      announce(next.status);
    } catch (error) {
      fail(say("journey.map.fail.draw"), error);
    }
  };

  // --- selecting and moving ------------------------------------------------------------------

  const selectNode = (id: string): void => {
    if (readOnly) {
      return;
    }
    fromMap = true;
    try {
      options.onSelect?.(id);
    } catch (error) {
      fail(say("journey.map.fail.select"), error);
    } finally {
      fromMap = false;
    }
  };

  const selectOf = (key: string): string | undefined => itemEl(key)?.getAttribute("data-select") ?? undefined;

  /** Whether an item stands for a rule: a route's label, or one of a step's ignored rules. */
  const isRuleItem = (item: string | undefined): boolean =>
    item !== undefined &&
    graph !== undefined &&
    (graph.edges.some((edge) => edge.kind === "route" && edge.label?.item === item) ||
      graph.nodes.some((node) => node.kind === "page" && node.stubs.some((stub) => stub.item === item)));

  /** Whether the rules open in the Logic workspace from this map: an editable map whose mode can ask for it, and a shell that has it. */
  const rulesOpen = (): boolean => !readOnly && edit !== undefined && options.onOpenRule !== undefined && (options.rulesEditable?.() ?? true);

  /** A click or Enter on a rule opens it in the Logic editor, when the mode can (an editable map only). */
  const openRule = (item: string | undefined): void => {
    if (!rulesOpen() || item === undefined || !isRuleItem(item) || !options.onOpenRule) {
      return;
    }
    try {
      options.onOpenRule(item);
    } catch (error) {
      fail(say("journey.map.fail.edit"), error);
    }
  };

  /** The item that stands for a node: Start, End or a step's card. */
  const nodeItem = (key: string): string | undefined => graph?.nodes.find((candidate) => candidate.key === key)?.item;

  /** The node an item draws: Start, End or a step's card (not a chip, a stub or "+n more"). */
  const nodeKeyOf = (item: string): string | undefined => graph?.nodes.find((node) => node.item === item)?.key;

  // --- building the journey ------------------------------------------------------------------

  /** The steps the map can edit, in the journey's order: the cards that stand for a node of the tree. */
  const stepsOf = (): JourneyMapPage[] =>
    graph ? graph.nodes.filter((node): node is JourneyMapPage => node.kind === "page" && node.item !== undefined).sort((a, b) => a.index - b.index) : [];

  /** The step the selection is in: the step itself, or one of its routes, questions or stubs. */
  const selectedStep = (): string | undefined => {
    const id = subject?.selected();
    if (id === undefined || !graph) {
      return undefined;
    }
    const place = placeOf(id);
    const step = place.page ?? place.item;
    return step !== undefined && stepsOf().some((node) => node.item === step) ? step : undefined;
  };

  /** Whether focus is nowhere in particular: on the page, the canvas that holds the map, or the map itself. */
  const focusLost = (): boolean => {
    const active = (element.getRootNode() as Document | ShadowRoot).activeElement;
    return !active || active === document.body || active.classList?.contains("canvas-page") === true || element.contains(active);
  };

  /** The selected step's bar is one Tab stop over its enabled buttons; this puts the stop right at once. */
  const syncSel = selBar ? rovingToolbar(selBar, "button[data-map-sel]") : (): void => undefined;

  /**
   * The bar's buttons and the selected step's bar, from the selection and the steps drawn: Add
   * step says where it goes, New rule is on while a step other than the last is selected, and the
   * step's bar is there while a step (or something in it) is selected. Written only where it moves.
   */
  const syncEdit = (): void => {
    if (!edit || !graph) {
      return;
    }
    const list = stepsOf();
    const id = selectedStep();
    const at = id === undefined ? -1 : list.findIndex((node) => node.item === id);
    if (addButton) {
      setAttr(addButton, "title", say(at >= 0 ? "journey.map.add.title.after" : "journey.map.add.title.end"));
    }
    if (ruleButton) {
      const can = at >= 0 && at < list.length - 1;
      // A shell without the Logic workspace could not open the rule New rule makes: the button is not offered.
      const offered = options.rulesEditable?.() ?? true;
      if (ruleButton.hidden === offered) {
        ruleButton.hidden = !offered;
      }
      setAttr(ruleButton, "aria-disabled", String(!can));
      setAttr(ruleButton, "title", say(can ? "journey.map.rule.title" : "journey.map.rule.title.none"));
    }
    const step = at >= 0 ? list[at] : undefined;
    if (!selZone || !selBar || !selName) {
      return;
    }
    if (selZone.hidden !== (step === undefined)) {
      selZone.hidden = step === undefined;
    }
    if (!step) {
      return;
    }
    setText(selName, step.name);
    setAttr(selBar, "aria-label", say("journey.map.sel.bar", { name: step.name }));
    const off: Record<string, boolean> = { open: false, up: at === 0, down: at === list.length - 1, duplicate: false, delete: list.length === 1 };
    for (const button of selButtons) {
      const action = button.dataset.mapSel ?? "";
      const want = off[action] === true;
      if (button.disabled !== want) {
        const hadFocus = (button.getRootNode() as Document | ShadowRoot).activeElement === button;
        button.disabled = want;
        if (want && hadFocus) {
          // The button went off under the author's hands (the top step's Move up): focus goes to the step's card.
          moveTo(step.item);
        }
      }
      if (action === "delete") {
        setAttr(button, "data-tip", say(want ? "journey.map.sel.delete.only" : "journey.map.sel.delete.title"));
      }
    }
    syncSel();
  };

  /** What a button of the bar or a key asks of the mode for step `id`, if the step can take it. */
  const stepAction = (action: string, id: string): void => {
    const list = stepsOf();
    const at = list.findIndex((node) => node.item === id);
    if (!edit || at < 0) {
      return;
    }
    try {
      switch (action) {
        case "open":
          options.onOpen?.(id);
          break;
        case "up":
          if (at > 0) {
            edit.moveStep(id, -1);
          }
          break;
        case "down":
          if (at < list.length - 1) {
            edit.moveStep(id, 1);
          }
          break;
        case "duplicate":
          edit.duplicateStep(id);
          break;
        case "delete":
          if (list.length > 1) {
            // Focus goes to the step that takes its place, once it is drawn gone (after the confirmation).
            afterDelete = { gone: id, next: (list[at + 1] ?? list[at - 1])?.item };
            edit.deleteStep(id);
          }
          break;
      }
    } catch (error) {
      fail(say("journey.map.fail.edit"), error);
    }
  };

  /** Focus to the step that took a deleted step's place, once the step is drawn gone and focus has nowhere to be. */
  const settleAfterDelete = (): void => {
    if (!afterDelete || itemEl(afterDelete.gone)) {
      return;
    }
    const { next } = afterDelete;
    afterDelete = undefined;
    if (next !== undefined && itemEl(next) && focusLost()) {
      moveTo(next);
    }
  };

  /** Alt+Arrow on: from a chip to where its route goes; from Start or a page to its first way out. */
  const follow = (item: string): string | undefined => {
    if (!graph) {
      return undefined;
    }
    const chip = graph.edges.find((edge) => edge.label?.item === item);
    if (chip) {
      return nodeItem(chip.to);
    }
    const key = graph.nodes.find((candidate) => candidate.item === item)?.key;
    const first = key === undefined ? undefined : graph.edges.filter((edge) => edge.from === key).sort((a, b) => a.order - b.order)[0];
    if (!first) {
      return undefined;
    }
    return first.label?.item ?? nodeItem(first.to);
  };

  /** Alt+Arrow back: where the item was followed from, else what leads to it first in reading order. */
  const back = (item: string): string | undefined => {
    if (!graph) {
      return undefined;
    }
    const remembered = cameFrom.get(item);
    if (remembered !== undefined && itemEl(remembered)) {
      return remembered;
    }
    const chip = graph.edges.find((edge) => edge.label?.item === item);
    if (chip) {
      return nodeItem(chip.from);
    }
    const holder = graph.nodes.find((node) => node.kind === "page" && (node.stubs.some((stub) => stub.item === item) || node.more?.item === item));
    if (holder && holder.kind === "page") {
      return holder.item;
    }
    const key = nodeKeyOf(item);
    const node = key === undefined ? undefined : graph.nodes.find((candidate) => candidate.key === key);
    if (!node) {
      return undefined;
    }
    const order = graph.readingOrder;
    const sources = graph.edges
      .filter((edge) => edge.to === node.key)
      .map((edge) => edge.label?.item ?? nodeItem(edge.from))
      .filter((source): source is string => source !== undefined && itemEl(source) !== null)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return sources[0];
  };

  const moveTo = (key: string | undefined): void => {
    if (key === undefined) {
      return;
    }
    const target = rove(key);
    if (target) {
      focusElement(target);
      setLit(key);
    }
  };

  const zoom = (value: number | "fit"): void => {
    zoomSetting = value === "fit" ? "fit" : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    applyZoom();
  };

  /**
   * The author zooms (the bar, or a key): the item with focus kept in view as the picture
   * grows or shrinks round it, and the scale said once the steps rest.
   */
  const zoomBy = (value: number | "fit"): void => {
    zoom(value);
    if (current !== undefined && holdsFocus(stage)) {
      bringIntoView(itemEl(current));
    }
    if (zoomTimer !== undefined) {
      clearTimeout(zoomTimer);
    }
    zoomTimer = setTimeout(() => {
      zoomTimer = undefined;
      if (visible && !disposed) {
        const end = scale >= ZOOM_MAX ? say("journey.map.zoom.max") : scale <= ZOOM_MIN ? say("journey.map.zoom.min") : "";
        announceEl.textContent = say("journey.map.zoom.announce", { percent: Math.round(scale * 100), end });
      }
    }, ZOOM_ANNOUNCE_DELAY_MS);
  };

  const onStageKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || !graph) {
      return;
    }
    const from = itemOf(event.target) ?? current;
    const order = graph.readingOrder.filter((item) => itemEl(item) !== null);
    const step = (delta: number): void => {
      const at = from !== undefined ? order.indexOf(from) : -1;
      const next = at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta));
      moveTo(order[next]);
    };
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        if (event.altKey) {
          const to = from !== undefined ? follow(from) : undefined;
          if (to !== undefined && from !== undefined) {
            cameFrom.set(to, from);
            moveTo(to);
          }
        } else {
          step(1);
        }
        break;
      case "ArrowUp":
      case "ArrowLeft":
        if (event.altKey) {
          moveTo(from !== undefined ? back(from) : undefined);
        } else {
          step(-1);
        }
        break;
      case "Home":
        moveTo(order[0]);
        break;
      case "End":
        moveTo(order[order.length - 1]);
        break;
      case "Enter":
        if (readOnly) {
          handled = false;
        } else if (from !== undefined) {
          const id = selectOf(from);
          if (id !== undefined) {
            selectNode(id);
            // A step is opened as well as selected, and a rule opens in the Logic editor; anything else Enter only selects.
            if (edit && options.onOpen && stepsOf().some((node) => node.item === from)) {
              stepAction("open", from);
            } else {
              openRule(from);
            }
          }
        }
        break;
      case "Delete":
      case "Backspace": {
        const list = stepsOf();
        const step = edit && from !== undefined ? list.find((node) => node.item === from) : undefined;
        if (step?.item !== undefined && list.length > 1) {
          stepAction("delete", step.item);
        } else {
          handled = false;
        }
        break;
      }
      case " ":
        if (readOnly) {
          // Nothing to select; the item has the keys, as it has the arrows, so Space does not
          // scroll the card or the page out from under it.
          handled = from !== undefined;
        } else if (from !== undefined) {
          const id = selectOf(from);
          if (id !== undefined) {
            selectNode(id);
          }
        }
        break;
      case "+":
      case "=":
        zoomBy(scale * ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomBy(scale / ZOOM_STEP);
        break;
      case "0":
        zoomBy("fit");
        break;
      case "Escape":
        if (lit === undefined) {
          handled = false;
        } else {
          setLit(undefined);
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  };

  // --- the bar ---------------------------------------------------------------------------

  // One Tab stop, arrows between the buttons (the builder's toolbars all rove alike).
  rovingToolbar(bar);

  const syncBar = (): void => {
    element.setAttribute("data-direction", layout.direction);
    for (const button of barButtons) {
      const { mapDirection } = button.dataset;
      if (mapDirection !== undefined) {
        button.setAttribute("aria-pressed", String(mapDirection === layout.direction));
      } else if (button.dataset.mapZoom === "fit") {
        button.title = say(layout.direction === "down" ? "journey.map.fit.title.down" : "journey.map.fit.title.right");
      }
    }
  };
  syncBar();

  let labelled: { locale: string | undefined; catalog: unknown } | undefined;
  /** The chrome's words, written when the builder's locale or its catalog moved (and at the start). */
  const relabel = (): void => {
    const text = textOf();
    if (labelled !== undefined && labelled.locale === text?.locale && labelled.catalog === text?.catalog) {
      return;
    }
    labelled = { locale: text?.locale, catalog: text?.catalog };
    for (const el of element.querySelectorAll<HTMLElement>("[data-map-tx], [data-map-tx-title], [data-map-tx-aria-label], [data-map-tx-data-tip]")) {
      for (const attribute of [...el.attributes]) {
        if (attribute.name === "data-map-tx") {
          const value = builderText(attribute.value as BuilderTextKey, undefined, text);
          if (el.textContent !== value) {
            el.textContent = value;
          }
        } else if (attribute.name.startsWith("data-map-tx-")) {
          setAttr(el, attribute.name.slice("data-map-tx-".length), builderText(attribute.value as BuilderTextKey, undefined, text));
        }
      }
    }
    syncBar();
  };
  relabel();

  const applyLayout = (next: JourneyMapLayout): boolean => {
    if (sameLayout(next, layout)) {
      return false;
    }
    layout = next;
    syncBar();
    // Drawn another way: fitted again, the selection and the tab stop kept.
    zoomSetting = "fit";
    if (visible && subject) {
      draw();
    } else {
      stale = true;
    }
    return true;
  };

  bar.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || !bar.contains(button)) {
      return;
    }
    try {
      const { mapDirection, mapZoom } = button.dataset;
      if (mapDirection === "down" || mapDirection === "right") {
        if (applyLayout({ direction: mapDirection })) {
          options.onLayout?.({ ...layout });
        }
        return;
      }
      if (mapZoom !== undefined) {
        if (button.getAttribute("aria-disabled") !== "true") {
          zoomBy(mapZoom === "in" ? scale * ZOOM_STEP : mapZoom === "out" ? scale / ZOOM_STEP : mapZoom === "actual" ? 1 : "fit");
        }
        return;
      }
      if (button.hasAttribute("data-map-add") && edit) {
        try {
          edit.addStep(selectedStep());
        } catch (error) {
          fail(say("journey.map.fail.edit"), error);
        }
        return;
      }
      if (button.hasAttribute("data-map-rule") && edit && button.getAttribute("aria-disabled") !== "true") {
        const list = stepsOf();
        const from = selectedStep();
        const at = from === undefined ? -1 : list.findIndex((node) => node.item === from);
        const to = list[at + 1]?.item;
        try {
          if (from !== undefined && to !== undefined) {
            edit.newRule(from, to);
          }
        } catch (error) {
          fail(say("journey.map.fail.edit"), error);
        }
        return;
      }
    } catch (error) {
      fail(say("journey.map.fail.bar"), error);
    }
  });

  selBar?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-map-sel]");
    const id = selectedStep();
    if (!button || button.disabled || id === undefined) {
      return;
    }
    stepAction(button.dataset.mapSel ?? "", id);
  });
  selBar?.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (key.altKey || key.ctrlKey || key.metaKey) {
      return;
    }
    if (key.key === "Escape") {
      // Back to the step the bar is about.
      const id = selectedStep();
      if (id !== undefined) {
        key.preventDefault();
        moveTo(id);
      }
    }
  });

  // --- the picture's events ------------------------------------------------------------------

  stage.addEventListener("click", (event) => {
    const target = (event.target as Element | null)?.closest?.("[data-select]");
    if (!target || !stage.contains(target)) {
      return;
    }
    const item = itemOf(target);
    if (item !== undefined) {
      rove(item);
    }
    const id = target.getAttribute("data-select");
    if (id && !readOnly) {
      selectNode(id);
      openRule(item);
    }
  });
  stage.addEventListener("dblclick", (event) => {
    const target = (event.target as Element | null)?.closest?.("[data-select]");
    const item = target ? itemOf(target) : undefined;
    // A step opens as Enter opens it. A rule's first click already opened it in the Logic workspace
    // (the Journeys mode is on its way out), and it is no step: nothing is left to open.
    if (item !== undefined && stepsOf().some((node) => node.item === item)) {
      stepAction("open", item);
    }
  });
  stage.addEventListener("keydown", (event) => {
    try {
      onStageKey(event as KeyboardEvent);
    } catch (error) {
      fail(say("journey.map.fail.key"), error);
    }
  });
  stage.addEventListener("mouseover", (event) => {
    const target = event.target as Element | null;
    const item = itemOf(target);
    const edge = item === undefined ? target?.closest?.(".jm-edge")?.getAttribute("data-edge") : undefined;
    setLit(item ?? (edge ? `edge:${edge}` : focusedItem()));
  });
  stage.addEventListener("mouseleave", () => setLit(focusedItem()));
  stage.addEventListener("focusin", (event) => {
    const item = itemOf(event.target);
    if (item !== undefined) {
      rove(item);
      setLit(item);
    }
  });
  stage.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (!next || !stage.contains(next)) {
      setLit(undefined);
    }
  });
  // A palette drag over the map must not aim at the sheet it hides (the preview's guard).
  for (const type of ["dragenter", "dragover", "drop"]) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }

  // --- the room it has ---------------------------------------------------------------------

  const observe = (): void => {
    if (observer || typeof ResizeObserver !== "function") {
      return;
    }
    const scroller = element.isConnected ? scrollerOf() : null;
    if (!scroller) {
      return;
    }
    observer = new ResizeObserver((entries) => {
      if (!visible || disposed || !drawn) {
        return;
      }
      // The scroller resized: the room is measured again. The cover moved alone: a fit is
      // measured again beside it only when the cover the picture starts clear of is not the one
      // it was fitted beside; a zoom of its own stays as it is.
      const scrollerMoved = entries.some((entry) => entry.target !== coverGauge);
      if (scrollerMoved || (zoomSetting === "fit" && px(getComputedStyle(stage).paddingLeft) !== fittedCover)) {
        applyZoom();
      }
    });
    // Its border box: the scroller's own scrollbar coming and going (the canvas's take 10px)
    // never moves it, so a fit that brings one on cannot refit, lose it and refit again.
    observer.observe(scroller, { box: "border-box" });
    // Only the canvas page lies under the drawer: elsewhere the cover is pinned to nothing.
    if (scroller.classList.contains("canvas-page")) {
      observer.observe(coverGauge);
    }
  };

  const unobserve = (): void => {
    observer?.disconnect();
    observer = undefined;
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
  };

  /**
   * Once the surface is on the page: its room observed, and a fit measured again. A mode's
   * surface goes up only when the mode's activation is done, after the map was shown, so a map
   * shown while off the page looks again shortly, a few times at most.
   */
  const settle = (tries = 0): void => {
    if (!visible || disposed || settleTimer !== undefined) {
      return;
    }
    if (element.isConnected) {
      try {
        observe();
        if (zoomSetting === "fit" && drawn) {
          applyZoom();
        }
        reveal();
        applyState(false);
      } catch (error) {
        fail(say("journey.map.fail.shown"), error);
      }
      return;
    }
    if (tries < 20) {
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        settle(tries + 1);
      }, 25);
    }
  };

  return {
    element,
    styles: JOURNEY_MAP_STYLES,
    stylesInto(root) {
      journeyMapStylesInto(root);
    },
    get visible() {
      return visible;
    },
    get subject() {
      return subject;
    },
    get layout() {
      return { ...layout };
    },
    get zoomLevel() {
      return zoomSetting;
    },
    get readOnly() {
      return readOnly;
    },
    get state() {
      return state === undefined ? undefined : { ...state, takenEdges: [...(state.takenEdges ?? [])] };
    },
    show(next) {
      if (disposed) {
        return;
      }
      const wasVisible = visible;
      visible = true;
      if (!element.isConnected) {
        settle();
      } else {
        observe();
      }
      // Shown afresh, the canvas scrolled wherever the view before it was: the selection is
      // brought into view (else Start), now or once the surface is on the page (settle).
      if (!wasVisible || next !== subject) {
        revealPending = true;
      }
      if (next !== subject) {
        // Another journey, or another build of it: drawn afresh, and fitted.
        subject = next;
        graph = undefined;
        drawnView = undefined;
        drawn = undefined;
        lastSvg = "";
        marked = undefined;
        markedId = undefined;
        scrollPending = false;
        current = undefined;
        lit = undefined;
        announced = "";
        cameFrom.clear();
        afterDelete = undefined;
        zoomSetting = "fit";
        stage.replaceChildren();
        draw();
      } else if (stale || !graph) {
        draw();
      } else {
        // Nothing moved in the journey: what may have is the selection, and the room it has.
        try {
          applySelection(false);
          if (!wasVisible) {
            applyZoom();
          }
        } catch (error) {
          fail(say("journey.map.fail.shown"), error);
        }
      }
      try {
        reveal();
        applyState(false);
      } catch (error) {
        fail(say("journey.map.fail.shown"), error);
      }
    },
    refresh(changed, live) {
      if (disposed || (changed !== undefined && changed !== subject)) {
        return;
      }
      if (liveTimer !== undefined) {
        clearTimeout(liveTimer);
        liveTimer = undefined;
      }
      if (live === true && visible) {
        liveTimer = setTimeout(() => {
          liveTimer = undefined;
          this.refresh(changed);
        }, LIVE_REFRESH_DELAY_MS);
        return;
      }
      if (!visible) {
        stale = true;
        return;
      }
      if (queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed) {
          return;
        }
        if (!visible) {
          stale = true;
          return;
        }
        draw();
      });
    },
    hide() {
      if (liveTimer !== undefined) {
        stale = true;
      }
      visible = false;
      if (liveTimer !== undefined) {
        clearTimeout(liveTimer);
        liveTimer = undefined;
      }
      revealPending = false;
      scrollPending = false;
      unobserve();
      if (announceTimer !== undefined) {
        clearTimeout(announceTimer);
        announceTimer = undefined;
      }
      if (zoomTimer !== undefined) {
        clearTimeout(zoomTimer);
        zoomTimer = undefined;
      }
      setLit(undefined);
    },
    select(changed) {
      if (disposed || changed !== subject || !graph) {
        return;
      }
      try {
        const scroll = visible && !fromMap;
        if (scroll && queued) {
          // Drawn once this task is done (a page added, an undo): the new item is not on the
          // map yet, so it is brought into view by that draw.
          scrollPending = true;
        }
        applySelection(scroll);
        if (!holdsFocus(stage)) {
          // Tab lands on what is selected, when the map draws it.
          const selected = stage.querySelector("[data-map-item].is-selected")?.getAttribute("data-map-item");
          if (selected) {
            rove(selected);
          }
        }
      } catch (error) {
        fail(say("journey.map.fail.selection"), error);
      }
    },
    setLayout(value) {
      if (disposed) {
        return;
      }
      applyLayout(normalizeJourneyMapLayout({ ...layout, ...(typeof value === "object" && value !== null ? value : {}) }));
    },
    zoom(value) {
      zoom(value);
    },
    setState(value) {
      if (disposed) {
        return;
      }
      const next = stateOf(value);
      const moved = (next?.currentNodeId ?? "") !== (state?.currentNodeId ?? "");
      state = next;
      try {
        applyState(moved && next?.currentNodeId !== undefined);
      } catch (error) {
        fail(say("journey.map.fail.shown"), error);
      }
    },
    dispose() {
      disposed = true;
      visible = false;
      if (liveTimer !== undefined) {
        clearTimeout(liveTimer);
        liveTimer = undefined;
      }
      unobserve();
      if (announceTimer !== undefined) {
        clearTimeout(announceTimer);
        announceTimer = undefined;
      }
      if (zoomTimer !== undefined) {
        clearTimeout(zoomTimer);
        zoomTimer = undefined;
      }
      subject = undefined;
      graph = undefined;
      state = undefined;
      element.remove();
    }
  };
}
