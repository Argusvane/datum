import type { BuilderController, BuilderMoveTarget } from "../controller/builder-controller.js";
import type { BuilderTextKey, BuilderWords } from "../logic/builder-texts.js";
import type { NestedTreeNodeView } from "../tree-editor/nested-tree-view.js";
import { drawnComponentId, zoneItems } from "../web-component/builder-shared.js";
import { escapeHtml as esc } from "../../render/core/escape-html.js";
import { areaWords } from "./move-texts-en.js";
import { showBuilderModal } from "../web-component/modal-place.js";

/**
 * Moving a component to another place from the canvas: the selection bar's Move to...
 * dialog and the keyboard move mode. A lazy chunk the canvas loads on the first Move to... or
 * `M`, so the builder's entry carries only the button and the keys that ask for it. Where a
 * component may go is the controller's (`moveTargets`, the rules a drop meets); this draws the
 * places and walks them. Nothing here paints a panel: the dialog lives in the canvas's prompt
 * slot, the mode's marker is the drag's own, and the words go to the canvas's live region.
 */

/** The dialog's own layout; it lives inside the dialog, so the canvas without one is unchanged. */
const MOVE_DIALOG_STYLES = `
  .db-move-field { display: grid; gap: var(--db-space-1); margin: 0 0 var(--db-space-3); font-size: var(--db-text-md); color: var(--db-ink); }
`;

/** What the canvas lends the mover: its controller, its roots, its words and the drag's marker. */
export interface CanvasMoveHost {
  controller(): BuilderController | undefined;
  /** The canvas's own shadow root: the prompt slot and the dialog's controls. */
  root: ShadowRoot;
  /** The previewed form's shadow root: the drop zones and the component boxes. */
  previewRoot(): ShadowRoot | undefined;
  words(): BuilderWords;
  announce(text: string): void;
  revealComponent(componentId: string): void;
  /** Puts the drag's insertion marker before `before` in `zone` (at its end without one), the zone outlined. */
  showMarker(zone: HTMLElement, before: Element | undefined): HTMLElement;
  /** Takes the marker and the outline away, as a drag's end does. */
  clearMarker(): void;
  focusCanvas(): void;
  rtl(): boolean;
}

/** One place the keyboard move mode walks: a slot and the position the component would end at there. */
interface MoveStop {
  target: BuilderMoveTarget;
  index: number;
}

export class CanvasMove {
  /** The keyboard move mode: the component, every legal place in order, and the one shown. */
  private moving: { componentId: string; name: string; stops: MoveStop[]; at: number } | undefined;
  /** The open dialog: the component and its targets, by option value. */
  private dialog: { componentId: string; targets: BuilderMoveTarget[] } | undefined;

  constructor(private readonly host: CanvasMoveHost) {}

  /** Whether the keyboard move mode is on (it then takes every key, see {@link key}). */
  public get active(): boolean {
    return this.moving !== undefined;
  }

  private text(key: string, params?: Record<string, string | number>): string {
    // The canvas's words (its locale and the host's catalog), reading this chunk's English too.
    return areaWords(this.host.words()).text(key as BuilderTextKey, params);
  }

  /** What the selection bar calls the component: its outline label, else its id. */
  private nameOf(controller: BuilderController, componentId: string): string {
    const find = (node: NestedTreeNodeView): NestedTreeNodeView | undefined =>
      node.id === componentId ? node : node.slots.flatMap((slot) => slot.children).map(find).find(Boolean);
    return find(controller.treeView())?.label || componentId;
  }

  /** A place's name: its container's (the tree's top as such), with the slot when the container has more than one. */
  private placeName(target: BuilderMoveTarget): string {
    const place = target.depth === 0 ? this.text("move.top") : target.label;
    return target.slotLabel ? this.text("move.slot", { place, slot: target.slotLabel }) : place;
  }

  /**
   * The place `componentId` would leave empty by going to `target`, in words, when that place
   * is a journey page: the step stays on every path it was on and shows only its buttons, so
   * the author is told. Not a block, only a warning; `undefined` for any other move.
   * The page is told by its node type, which the journey designer owns, so this lazy chunk does
   * not import the designer for it.
   */
  private leavesEmpty(controller: BuilderController, targets: readonly BuilderMoveTarget[], target: BuilderMoveTarget): string | undefined {
    const source = targets.find((candidate) => candidate.current !== undefined);
    if (!source || source.siblings.length > 0 || (source.parentId === target.parentId && source.slotId === target.slotId)) {
      return undefined;
    }
    const find = (node: NestedTreeNodeView): NestedTreeNodeView | undefined =>
      node.id === source.parentId ? node : node.slots.flatMap((slot) => slot.children).map(find).find(Boolean);
    return find(controller.treeView())?.type === "journey-page" ? this.placeName(source) : undefined;
  }

  /** A position's words: first, after a component already there, or last. */
  private positions(target: BuilderMoveTarget): Array<{ index: number; text: string }> {
    const count = target.siblings.length;
    const positions = [{ index: 0, text: this.text("move.first") }];
    for (let index = 0; index < count - 1; index += 1) {
      const sibling = target.siblings[index]!;
      positions.push({ index: index + 1, text: this.text("move.after", { name: sibling.label || sibling.id }) });
    }
    if (count > 0) {
      positions.push({ index: count, text: this.text("move.last") });
    }
    return positions;
  }

  // --- the dialog -----------------------------------------------------------------------------

  /** Opens the dialog on `componentId`: every place it may go, opening on where it is. */
  public openDialog(componentId: string): void {
    const controller = this.host.controller();
    const slot = this.host.root.querySelector<HTMLElement>("[data-canvas-prompt]");
    if (!controller || !slot || controller.isFixedNode(componentId)) {
      return;
    }
    this.end(false);
    const targets = controller.moveTargets(componentId);
    const own = targets.findIndex((target) => target.current !== undefined);
    if (own < 0) {
      return;
    }
    const name = this.nameOf(controller, componentId);
    this.dialog = { componentId, targets };
    const nowhere = targets.length === 1 && targets[0]!.siblings.length === 0;
    const options = targets
      .map((target, index) => {
        const place = this.placeName(target);
        const text = target.current !== undefined ? this.text("move.here", { place }) : place;
        // Indented by depth, as the outline is: a container's places sit under its parent's.
        return `<option value="${index}"${index === own ? " selected" : ""}>${esc("  ".repeat(target.depth) + text)}</option>`;
      })
      .join("");
    slot.innerHTML = `<dialog class="db-confirm db-move" aria-labelledby="db-move-title" data-prompt data-move-prompt>
        <style>${MOVE_DIALOG_STYLES}</style>
        <h4 id="db-move-title">${esc(this.text("move.title", { name }))}</h4>${nowhere ? `<p data-move-nowhere>${esc(this.text("move.nowhere", { name }))}</p>` : ""}
        <label class="db-move-field"><span>${esc(this.text("move.target"))}</span><select data-move-target>${options}</select></label>
        <label class="db-move-field"><span>${esc(this.text("move.position"))}</span><select data-move-position></select></label>
        <p class="db-move-empties" data-move-empties role="status" hidden></p>
        <div class="db-confirm-actions">
          <button type="button" class="btn" data-move-cancel>${esc(this.text("common.cancel"))}</button>
          <button type="button" class="btn primary" data-move-confirm disabled>${esc(this.text("move.confirm"))}</button>
        </div>
      </dialog>`;
    this.syncPositions();
    const dialog = slot.querySelector<HTMLDialogElement>("dialog")!;
    if (typeof dialog.showModal === "function") {
      showBuilderModal(dialog);
    } else {
      dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>("[data-move-target]")?.focus();
  }

  /** A `change` in the canvas: another place lists its positions; a position turns Move on or off. */
  public changed(target: HTMLElement | null): void {
    if (target?.dataset?.moveTarget !== undefined) {
      this.syncPositions();
    } else if (target?.dataset?.movePosition !== undefined) {
      this.syncConfirm();
    }
  }

  private chosenTarget(): BuilderMoveTarget | undefined {
    const select = this.host.root.querySelector<HTMLSelectElement>("[data-move-target]");
    return select ? this.dialog?.targets[Number(select.value)] : undefined;
  }

  /** The positions of the chosen place: where the component is, in its own slot; else last. */
  private syncPositions(): void {
    const target = this.chosenTarget();
    const select = this.host.root.querySelector<HTMLSelectElement>("[data-move-position]");
    if (!target || !select) {
      return;
    }
    const chosen = target.current ?? target.siblings.length;
    select.innerHTML = this.positions(target)
      .map((position) => `<option value="${position.index}"${position.index === chosen ? " selected" : ""}>${esc(position.text)}</option>`)
      .join("");
    this.syncConfirm();
  }

  /** Move is on once the place chosen is not where the component already is. */
  private syncConfirm(): void {
    const target = this.chosenTarget();
    const position = this.host.root.querySelector<HTMLSelectElement>("[data-move-position]");
    const confirm = this.host.root.querySelector<HTMLButtonElement>("[data-move-confirm]");
    if (confirm) {
      confirm.disabled = !target || !position || target.current === Number(position.value);
    }
    // The confirm line: moving the only member of a journey page leaves it empty. A warning, not a block.
    const controller = this.host.controller();
    const warning = this.host.root.querySelector<HTMLElement>("[data-move-empties]");
    const place = controller && target && this.dialog ? this.leavesEmpty(controller, this.dialog.targets, target) : undefined;
    if (warning) {
      warning.textContent = place !== undefined ? this.text("move.empties", { place }) : "";
      warning.hidden = place === undefined;
    }
  }

  /** Closes the dialog with nothing moved; the canvas takes focus back. */
  public closeDialog(): void {
    this.dialog = undefined;
    const slot = this.host.root.querySelector<HTMLElement>("[data-canvas-prompt]");
    const dialog = slot?.querySelector<HTMLDialogElement>("dialog[data-move-prompt]");
    if (!slot || !dialog) {
      return;
    }
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
    }
    slot.innerHTML = "";
    this.host.focusCanvas();
  }

  /** Move: the chosen place and position, then the dialog closes. */
  public confirmDialog(): void {
    const state = this.dialog;
    const target = this.chosenTarget();
    const index = Number(this.host.root.querySelector<HTMLSelectElement>("[data-move-position]")?.value);
    const controller = this.host.controller();
    this.closeDialog();
    if (state && target && controller && Number.isInteger(index)) {
      this.commit(controller, state.componentId, target, index);
    }
  }

  /** One move, through the unsaved-edits guard, said in the live region once it has landed. */
  private commit(controller: BuilderController, componentId: string, target: BuilderMoveTarget, index: number): void {
    if (target.current === index) {
      this.host.announce(this.text("move.unchanged"));
      return;
    }
    // Read before the move: afterwards the component is no longer in the place it left.
    const emptied = this.leavesEmpty(controller, controller.moveTargets(componentId), target);
    // Said from the move itself: held behind the unsaved-edits prompt, it lands after Save or Apply.
    controller.requestMoveTo(componentId, target.parentId, index, target.slotId, (moved) => {
      const place = controller.parentOf(componentId);
      if (moved && place?.parentId === target.parentId && place.slotId === target.slotId) {
        const said = this.text("move.moved", { place: this.placeName(target), n: place.index + 1, total: target.siblings.length + 1 });
        this.host.announce(emptied !== undefined ? `${said}. ${this.text("move.emptied", { place: emptied })}` : said);
      }
    });
  }

  // --- the keyboard move mode ------------------------------------------------------------------

  /** The component's box on the sheet. */
  private box(componentId: string): HTMLElement | undefined {
    return [...(this.host.previewRoot()?.querySelectorAll<HTMLElement>(".db-node[data-component-id]") ?? [])].find((node) => node.dataset.componentId === componentId);
  }

  /**
   * Starts the mode on the selection: every position in every place it may go, in reading
   * order, starting where it is. Nothing changes until Enter.
   */
  public start(): void {
    const controller = this.host.controller();
    const componentId = controller?.selectedComponentId();
    if (!controller || componentId === undefined || componentId === controller.rootId() || controller.isFixedNode(componentId)) {
      return;
    }
    this.end(false);
    const stops = controller
      .moveTargets(componentId)
      .flatMap((target) => Array.from({ length: target.siblings.length + 1 }, (_, index): MoveStop => ({ target, index })));
    const at = stops.findIndex((stop) => stop.target.current === stop.index);
    const name = this.nameOf(controller, componentId);
    if (at < 0) {
      return;
    }
    if (stops.length < 2) {
      this.host.announce(this.text("move.nowhere", { name }));
      return;
    }
    this.moving = { componentId, name, stops, at };
    this.box(componentId)?.classList.add("db-dragging");
    this.show(true);
  }

  /** Shows the place: the drag's insertion marker there, its tab or step opened, and says it. */
  private show(first = false, edge = false): void {
    const moving = this.moving;
    if (!moving) {
      return;
    }
    const stop = moving.stops[moving.at]!;
    const root = this.host.previewRoot();
    const zone = [...(root?.querySelectorAll<HTMLElement>("[data-dropzone]") ?? [])].find(
      (candidate) => candidate.dataset.parentId === stop.target.parentId && candidate.dataset.slotId === stop.target.slotId
    );
    if (zone && root) {
      const beforeId = stop.target.siblings[stop.index]?.id;
      // The component drawn at that place, wherever the binding put it (a list item, a cell), as a drag finds it.
      const before = beforeId === undefined ? undefined : zoneItems(zone).find((item) => drawnComponentId(item) === beforeId);
      const marker = this.host.showMarker(zone, before);
      // The tab or step the place is on opens (the renderer's reveal).
      this.host.revealComponent(stop.target.parentId);
      marker.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } else {
      this.host.clearMarker();
    }
    const at = this.text("move.at", { place: this.placeName(stop.target), n: stop.index + 1, total: stop.target.siblings.length + 1 });
    this.host.announce(first ? this.text("move.start", { name: moving.name, at }) : edge ? this.text("move.edge", { at }) : at);
  }

  /** Ends the mode with nothing moved; `cancelled` says so in the live region. */
  public end(cancelled: boolean): void {
    const moving = this.moving;
    if (!moving) {
      return;
    }
    this.moving = undefined;
    this.host.clearMarker();
    this.box(moving.componentId)?.classList.remove("db-dragging");
    if (cancelled) {
      // The walk opened the steps and tabs it passed through; Escape puts the component's own back.
      this.host.revealComponent(moving.componentId);
      this.host.announce(this.text("move.cancelled"));
    }
  }

  /** A key while the mode is on: arrows, Home and End walk; Enter moves; Escape and Tab cancel; the rest do nothing. */
  public key(event: KeyboardEvent): void {
    const moving = this.moving;
    if (!moving) {
      return;
    }
    if (event.key === "Tab") {
      this.end(true);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const last = moving.stops.length - 1;
    const step = (to: number): void => {
      const at = Math.min(last, Math.max(0, to));
      // Clamped at either end: a live region given the same words says nothing, so the end is named.
      const edge = at === moving.at;
      moving.at = at;
      this.show(false, edge);
    };
    switch (event.key) {
      case "ArrowDown":
        step(moving.at + 1);
        return;
      case "ArrowUp":
        step(moving.at - 1);
        return;
      case "ArrowRight":
      case "ArrowLeft":
        step(moving.at + ((event.key === "ArrowRight") !== this.host.rtl() ? 1 : -1));
        return;
      case "Home":
        step(0);
        return;
      case "End":
        step(last);
        return;
      case "Escape":
        this.end(true);
        return;
      case "Enter": {
        const stop = moving.stops[moving.at]!;
        const controller = this.host.controller();
        this.end(false);
        if (controller) {
          this.commit(controller, moving.componentId, stop.target, stop.index);
        }
        return;
      }
    }
  }
}
