/**
 * Where the builder's modal dialogs sit: over the builder's own box, not the window.
 *
 * Every prompt and editor the builder raises is a `<dialog>` opened with `showModal()`, because
 * the top layer is the one place nothing on the page can stack above or clip, and a modal dialog
 * is the one thing nothing can be clicked past. The top layer is laid out against the window,
 * though, so a builder embedded in a page would centre its prompt in the middle of the window
 * (away from the field being edited, when the builder sits lower on the page) and dim a page that
 * is not its own.
 *
 * So the dialog stays modal and in the top layer, and is told where the builder is: the visible
 * part of the shell's box, as its four insets from the window's edges (one property, in the order
 * `inset` takes them) and a size, written as custom properties on the dialog. The dialog styles read them (`MODAL_INSET`, `MODAL_W`, `MODAL_H`) with
 * the window as the fallback, and the backdrop is clipped to the same box (`MODAL_BACKDROP_CLIP`),
 * so only the builder dims. A builder that fills the window (the page layout, Full window) gets
 * the insets of the window, so the dialog fills it. The box is followed while the dialog is
 * open, since the page can still be scrolled under a modal dialog.
 */

/** The shell element whose box the dialogs keep to. */
const FRAME_TAG = "datum-builder";
/** The shell's visible box inside its shadow root (the host may be taller than what is drawn). */
const FRAME_BOX = '[data-shell="wrap"]';
/**
 * Less of the builder in view than this and a dialog would not fit in it: the window is used
 * instead, as it is where there is no layout to measure (a test DOM).
 */
const MIN_BOX = { width: 280, height: 220 };

const PROPERTIES = ["--db-modal-inset", "--db-modal-w", "--db-modal-h"] as const;

/** The dialog's `inset`: the builder's box, or the window where none was measured. */
export const MODAL_INSET = "var(--db-modal-inset, 0px)";
/** The width a dialog sizes itself against: the builder's box, or the window's. */
export const MODAL_W = "var(--db-modal-w, 100vw)";
/** The height a dialog sizes itself against: the builder's box, or the window's. */
export const MODAL_H = "var(--db-modal-h, 100vh)";
/**
 * The backdrop's declaration that keeps the scrim to the builder's box. The backdrop inherits
 * the properties from its dialog; an engine that does not hand them over falls back to the
 * whole window, which is the scrim as it was.
 */
export const MODAL_BACKDROP_CLIP = `clip-path: inset(${MODAL_INSET});`;

export interface ModalBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function viewportBox(): ModalBox {
  const root = document.documentElement;
  return { left: 0, top: 0, width: root?.clientWidth || window.innerWidth || 0, height: root?.clientHeight || window.innerHeight || 0 };
}

/** The builder shell a node belongs to, through however many shadow roots; the outermost host where there is no shell (a designer on its own). */
function frameOf(node: Node): Element | undefined {
  let outermost: Element | undefined;
  // A shadow root is told by its host, not by `instanceof`: the panels also run where there is no ShadowRoot global.
  for (let host = (node.getRootNode() as Partial<ShadowRoot>).host; host; host = (host.getRootNode() as Partial<ShadowRoot>).host) {
    outermost = host;
    if (host.localName === FRAME_TAG) {
      break;
    }
  }
  if (!outermost) {
    return undefined;
  }
  return outermost.shadowRoot?.querySelector(FRAME_BOX) ?? outermost;
}

/** The part of the builder's box that is in view, or `undefined` when too little of it is (or nothing can be measured). */
function visibleFrameBox(node: Node): ModalBox | undefined {
  const frame = frameOf(node);
  if (!frame || typeof frame.getBoundingClientRect !== "function" || typeof document === "undefined") {
    return undefined;
  }
  const rect = frame.getBoundingClientRect();
  const view = viewportBox();
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, view.width);
  const bottom = Math.min(rect.bottom, view.height);
  const box = { left, top, width: right - left, height: bottom - top };
  return box.width >= MIN_BOX.width && box.height >= MIN_BOX.height ? box : undefined;
}

/**
 * The box a builder dialog is kept to, in window coordinates: the visible part of its builder,
 * or the window. For code that places a dialog itself (a drag keeps it inside this).
 */
export function modalBox(dialog: Element): ModalBox {
  return visibleFrameBox(dialog) ?? viewportBox();
}

/** Writes the builder's box onto the dialog for its styles to read; clears it where the window is the box. */
export function placeModal(dialog: HTMLElement): void {
  const box = visibleFrameBox(dialog);
  if (!box) {
    for (const property of PROPERTIES) {
      dialog.style.removeProperty(property);
    }
    return;
  }
  const view = viewportBox();
  const px = (value: number): string => `${Math.max(0, Math.round(value * 100) / 100)}px`;
  // One value, in the order `inset` takes its four: top, right, bottom, left.
  dialog.style.setProperty("--db-modal-inset", [box.top, view.width - box.left - box.width, view.height - box.top - box.height, box.left].map(px).join(" "));
  dialog.style.setProperty("--db-modal-w", px(box.width));
  dialog.style.setProperty("--db-modal-h", px(box.height));
}

const followed = new WeakSet<HTMLElement>();

/**
 * Places the dialog over its builder and keeps it there while it is open: the page scrolls under
 * a modal dialog, and the window can be resized. The following ends when the dialog closes or
 * leaves the document (a repaint replaces the element; the new one is followed when it is shown).
 */
export function followModalBox(dialog: HTMLElement): void {
  placeModal(dialog);
  if (followed.has(dialog) || typeof window === "undefined") {
    return;
  }
  followed.add(dialog);
  let queued = false;
  const isOpen = (): boolean => dialog.isConnected && dialog.hasAttribute("open");
  const stop = (): void => {
    followed.delete(dialog);
    window.removeEventListener("scroll", onMove, true);
    window.removeEventListener("resize", onMove);
    dialog.removeEventListener("close", stop);
  };
  const update = (): void => {
    queued = false;
    if (!isOpen()) {
      stop();
      return;
    }
    placeModal(dialog);
  };
  function onMove(): void {
    if (queued) {
      return;
    }
    queued = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(update);
    } else {
      update();
    }
  }
  // Capture: a scroll does not bubble, and the builder may sit in a scroller that is not the window.
  window.addEventListener("scroll", onMove, { capture: true, passive: true });
  window.addEventListener("resize", onMove);
  dialog.addEventListener("close", stop);
}

/**
 * `dialog.showModal()` for a builder dialog: modal and in the top layer as ever, over the
 * builder's box. Throws what `showModal()` throws; a caller that guards for a DOM without modal
 * dialogs keeps its guard.
 */
export function showBuilderModal(dialog: HTMLDialogElement): void {
  dialog.showModal();
  followModalBox(dialog);
}
