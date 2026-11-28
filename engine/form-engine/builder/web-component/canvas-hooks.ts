/**
 * The builder canvas's decoration of the live renderer's drawing: the renderer's
 * {@link CanvasHooks}, template-typed. The renderer and the binding draw the form exactly as a
 * person sees it; these hooks add the canvas's chrome around what was drawn, never inside a
 * binding's leaf markup:
 *
 * - a field's drawing is wrapped in its node (`.db-node`, `data-component-id`): the drag grip,
 *   the hidden tag (Paper only for a component a screen leaves out for paper), the "no options" hint, and the leaf itself under HTML `inert` (edit mode only;
 *   the hooks are not set while the canvas previews), so a click on a control selects the field
 *   and never types into it. A designer's own types (`liveTypes`: the faces a designer lays over
 *   the binding, `canvasComponents`) are the builder's drawing, not a person's form: their leaf
 *   stays live so their fix-it buttons answer a click, and the canvas still takes
 *   their controls out of the Tab order;
 * - a container's drawing (its adapter's, slots and all) is wrapped in its node with the grip and
 *   the type chip, and is never inert: it holds nodes and drop zones of its own;
 * - an empty slot draws a drop zone with the slot's hint.
 *
 * When the canvas draws a tree that is not its controller's own (one journey step) it
 * hands three more things, each absent on every other canvas, which then draws without them:
 *
 * - `tags`: a word on a component's box beside the hidden tag (a journey-only field's "Not sent");
 * - `regionOwner`: what the page's own chrome selects. The regions a journey page draws its
 *   heading, counter and buttons in (`page-header`, `page-actions`) are wrapped, whatever binding
 *   drew them, in one box each (`.db-region`, `data-db-region-owner`) named for the step, its
 *   drawing inert as a field's leaf is: a click on either selects the owner. They are no
 *   `.db-node` and carry no `data-component-id`, so the owner has no second box by its id;
 * - `partOf`: the drawn components that are a part of another's box (a field inside a placed
 *   form container is the placement's): drawn with no node, grip or tag, inert, so a click on one
 *   lands on the box around it; an empty slot inside one draws no drop zone.
 *
 * A slot that holds components has no element drawn for it: the canvas finds where the binding
 * put its components after each draw and marks that element as the slot's drop zone
 * ({@link markDropZones} in builder-shared.ts), so a design system's container keeps its own
 * markup on the canvas.
 *
 * The only module of the builder that draws with lit: the renderer's one copy (render/live/lit.ts).
 */
import { html, nothing, unsafeHTML, type TemplateResult } from "../../render/live/lit.js";
import type { CanvasHooks, FormRegion } from "../../render/live/renderer.js";
import type { View } from "../../render/live/contract.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";
import { readInlineOptions } from "../../core/schema/inline-options.js";
import { readSourceId } from "../../core/schema/data-source-capability.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import { defaultIconSet, renderIcon, type IconSet } from "../../render/icons/icon-set.js";
import { builderText, type BuilderTextOptions } from "../logic/builder-texts.js";

export interface CanvasHooksOptions {
  selectedId: string | undefined;
  /** The tree's root id: its empty slot asks for the form's first component. */
  rootId?: string | undefined;
  /**
   * Declared slot ids per container id, from `declaredSlotsByComponent`: a component that declares
   * slots is a container, even before a child fills one.
   */
  declaredSlots: ReadonlyMap<string, readonly string[]>;
  /** What an empty slot says instead of "Drop components here.", per container id and slot id. */
  emptyHints?: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined;
  /** The icon set the drag grips are drawn from; the default set when omitted. */
  icons?: IconSet | undefined;
  /** The builder's words for the chrome's tags and the empty-slot line; English when absent. */
  words?: BuilderTextOptions | undefined;
  /**
   * The types a designer draws itself (the keys of `canvasComponents`): their leaf is not inert,
   * since its controls are the designer's own (a fix-it), never a person's answer.
   */
  liveTypes?: ReadonlySet<string> | undefined;
  /** A word on a component's box, by drawn id (a journey-only field's "Not sent"), in the caller's words. */
  tags?: ReadonlyMap<string, string> | undefined;
  /**
   * What a click on the page's own chrome selects, and the name its boxes carry, read at each
   * draw (a step's title edit redraws the page anyway, and keeps these hooks); without it the
   * chrome is not wrapped.
   */
  regionOwner?: { id: string; label(): string } | undefined;
  /** Drawn id -> the id whose box it is part of (a field inside a placed form container -> the placement). */
  partOf?: ReadonlyMap<string, string> | undefined;
}

/** The regions a journey page draws its own heading, counter and buttons in: the step's chrome on the canvas. */
const OWNED_REGIONS: ReadonlySet<FormRegion> = new Set<FormRegion>(["page-header", "page-actions"]);

/**
 * What the canvas's stylesheet adds for the hooks' step chrome: the tag's chip (the hidden tag's
 * look, at the box's end corner) and the step chrome's hover and selection outline. Appended to
 * the canvas chrome's sheet; nothing in it matches on a canvas that draws no step.
 */
export const CANVAS_HOOK_STYLES = `
  .db-tag.db-tag--note {
    display: block; top: -10px; bottom: auto; inset-inline-start: auto; inset-inline-end: 0; pointer-events: auto;
    background: var(--db-surface); color: var(--db-ink); border: var(--db-border-w) solid var(--db-line-input);
  }
  .db-node--hidden > .db-tag--note { top: auto; bottom: calc(100% + 4px); }
  .db-region { border-radius: 4px; }
  .db-region:hover { outline: 1px dashed var(--db-accent); outline-offset: 4px; }
  .db-region.db-selected, .db-region.db-selected:hover { outline: 2px solid var(--db-accent); outline-offset: 4px; }
`;

/** The size the drag grip is drawn at, in CSS px. */
const DRAG_HANDLE_SIZE = 12;

/** The choice controls the canvas says "no options" for. */
const NO_OPTIONS_TYPES: ReadonlySet<string> = new Set(["select", "radio", "checkboxes"]);

/**
 * Hover chrome for one component: the drag grip, plus a type chip for a container and a tag for a
 * component a rule is hiding. Nothing else: selecting is a click, deleting is the selection bar's.
 */
function nodeChrome(
  model: RenderComponentModel,
  icons: IconSet,
  words: BuilderTextOptions | undefined,
  container: boolean,
  note: string | undefined,
  paperOnly: boolean
): TemplateResult {
  // The chip reads the type name as stored; a data grid's `dataGrid` reads from the catalog.
  const tag = container
    ? html`<span class="db-tag">${model.type === DATA_GRID_COMPONENT_TYPE ? builderText("canvas.type.dataGrid", undefined, words) : model.type}</span>`
    : nothing;
  // A rule hiding it says Hidden, whatever else holds; one a screen leaves out for paper (kept
  // only while hidden ones are shown, the fold's own mark) says Paper only.
  const hidden = !model.visible
    ? html`<span class="db-tag db-tag--hidden" title=${builderText("canvas.hiddenTitle", undefined, words)}>${builderText("canvas.hidden", undefined, words)}</span>`
    : paperOnly
      ? html`<span class="db-tag db-tag--hidden" data-db-paper-only title=${builderText("canvas.paperOnlyTitle", undefined, words)}>${builderText("canvas.paperOnly", undefined, words)}</span>`
      : nothing;
  // The icon set's markup is trusted like the builder's own.
  return html`<span class="db-handle" draggable="true" data-db-handle=${model.id} title=${builderText("canvas.dragTitle", undefined, words)}>${unsafeHTML(
    renderIcon(icons, "drag-handle", { size: DRAG_HANDLE_SIZE })
  )}</span>${tag}${note === undefined ? hidden : html`${hidden}<span class="db-tag db-tag--note" data-db-tag>${note}</span>`}`;
}

/**
 * Under a choice control with nothing to choose: no data source named and no inline option
 * left. A button that opens the options editor on it (the canvas answers `data-no-options`).
 */
function noOptionsHint(model: RenderComponentModel, words: BuilderTextOptions | undefined): TemplateResult | typeof nothing {
  const configuration = model.node.configuration;
  if (!NO_OPTIONS_TYPES.has(model.type) || readSourceId(configuration) !== undefined || readInlineOptions(configuration).length > 0) {
    return nothing;
  }
  return html`<button type="button" class="db-no-options" data-no-options=${model.id}>${builderText("canvas.noOptions", undefined, words)}</button>`;
}

/** The attributes every drop zone carries, drawn (an empty slot) or marked (`markDropZones`). */
export interface DropZoneAddress {
  parentId: string;
  slotId: string;
}

/**
 * The builder canvas's hooks for the live renderer. Built once per selection, slot layout, hint
 * set, icon set and language (the canvas memoizes them): a new object draws the form again.
 */
export function buildCanvasHooks(options: CanvasHooksOptions): CanvasHooks {
  const icons = options.icons ?? defaultIconSet();
  const words = options.words;
  // A component kept though a screen leaves it out for paper is dimmed as a hidden one is.
  const classes = (model: RenderComponentModel, container: boolean, paperOnly: boolean): string =>
    ["db-node", container ? "db-node--container" : "", model.visible && !paperOnly ? "" : "db-node--hidden", options.selectedId === model.id ? "db-selected" : ""]
      .filter(Boolean)
      .join(" ");

  const partOf = options.partOf;
  /** A part of another's box: no node, no grip, no tag, its drawing inert, so a click lands on the box around it. */
  const part = (id: string, drawn: TemplateResult): TemplateResult | undefined => {
    const owner = partOf?.get(id);
    return owner === undefined ? undefined : html`<div class="db-leaf" inert data-db-part-of=${owner}>${drawn}</div>`;
  };
  const owner = options.regionOwner;

  return {
    decorateField(model: RenderComponentModel, content: TemplateResult, paperOnly?: boolean): TemplateResult {
      const asPart = part(model.id, content);
      if (asPart) {
        return asPart;
      }
      // A component that declares slots but folds to a field (an unknown container type) is still a container to the author.
      const container = options.declaredSlots.has(model.id);
      // The leaf is the binding's drawing: inert in edit mode (the hooks are not set while
      // previewing). A designer's own face stays live: its buttons are the builder's.
      const live = options.liveTypes?.has(model.type) === true;
      const paper = paperOnly === true;
      return html`<div class=${classes(model, container, paper)} data-component-id=${model.id}>${nodeChrome(model, icons, words, container, options.tags?.get(model.id), paper)}<div class="db-leaf" ?inert=${!live}>${content}</div>${noOptionsHint(
        model,
        words
      )}</div>`;
    },

    renderContainer(info, drawn: TemplateResult): TemplateResult | undefined {
      // The root is reached from the strip's Form button, never hovered, clicked or dragged: no
      // node, no grip. Its selection outline is the canvas's (data-db-root on its drop zone).
      if (info.model.parentId === undefined) {
        return undefined;
      }
      const asPart = part(info.model.id, drawn);
      if (asPart) {
        return asPart;
      }
      // Never inert: a container's drawing holds nodes and drop zones of its own.
      const paper = info.paperOnly === true;
      return html`<div class=${classes(info.model, true, paper)} data-component-id=${info.model.id}>${nodeChrome(info.model, icons, words, true, options.tags?.get(info.model.id), paper)}${drawn}</div>`;
    },

    emptySlot(info: { containerId: string; slotId: string }): TemplateResult | typeof nothing {
      // A slot the canvas's view does not list (a placed form container's, or one inside it) takes no drop.
      if (partOf !== undefined && options.declaredSlots.get(info.containerId)?.includes(info.slotId) !== true) {
        return nothing;
      }
      // A slot that takes only some types says which (a journey's pages, a page's routes); a
      // blank hint draws the zone with no words (a Check answers or exit step asks no field).
      const hint = options.emptyHints?.get(info.containerId)?.get(info.slotId);
      const text = hint ?? builderText(info.containerId === options.rootId ? "canvas.dropRoot" : "canvas.drop", undefined, words);
      if (text === "") {
        return html`<div class="db-dropzone db-stack" data-dropzone="true" data-parent-id=${info.containerId} data-slot-id=${info.slotId} data-axis="vertical"></div>`;
      }
      return html`<div class="db-dropzone db-stack" data-dropzone="true" data-parent-id=${info.containerId} data-slot-id=${info.slotId} data-axis="vertical"><p class="db-empty">${text}</p></div>`;
    },

    // The step's heading, counter and buttons, whatever binding drew them: one box per region,
    // both the owner's, named for it, their drawing inert (a click selects the owner, never works
    // the button). Without an owner the hook is absent and the regions are drawn as they are.
    ...(owner !== undefined
      ? {
          decorateRegion(region: FormRegion, view: View): View | undefined {
            if (!OWNED_REGIONS.has(region)) {
              return undefined;
            }
            const selected = options.selectedId === owner.id;
            return html`<div class=${selected ? "db-region db-selected" : "db-region"} data-db-region=${region} data-db-region-owner=${owner.id} role="group" aria-label=${owner.label()}><div class="db-leaf" inert>${view}</div></div>`;
          }
        }
      : {})
  };
}
