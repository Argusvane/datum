import type { OptionsEditorFrame } from "./builder-shared.js";
import { modalBox, showBuilderModal } from "./modal-place.js";

/**
 * The window-like behaviour every keyed-text dialog shares — the options and messages
 * editors: the author can drag it by its title bar, resize it from the corner (the browser's own `resize: both`) and maximize
 * it, and the repaint that follows an edit draws it back where it was. The state lives on
 * the dialog's view; these helpers read and write it against the `<dialog>` on screen.
 */
export interface DialogFrameState {
  maximized: boolean;
  frame?: OptionsEditorFrame | undefined;
}

/**
 * Remembers where the dialog is and how big it is — once the author has moved it (inline
 * `left`/`top`) or resized it from the corner (the browser writes inline `width`/`height`) —
 * so the repaint that follows an edit draws it back in the same place. While the dialog is
 * drawn maximized (including the repaint that restores it) its rect is the viewport, not a
 * frame worth keeping.
 */
export function captureDialogFrame(dialog: HTMLDialogElement | null | undefined, state: DialogFrameState | undefined): void {
  if (!state || !dialog || dialog.classList.contains("maximized")) {
    return;
  }
  if (dialog.style.left || dialog.style.width || dialog.style.height) {
    const rect = dialog.getBoundingClientRect();
    state.frame = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
}

/**
 * Dragging the title bar moves the dialog; its buttons keep their own click behaviour. The
 * dialog is pinned to explicit coordinates on the first move, so from then on the browser's
 * resize edits those same values. `onEnd` runs when the pointer is released, for the caller
 * to capture the frame.
 */
export function beginDialogDrag(
  event: PointerEvent,
  handle: HTMLElement,
  dialog: HTMLDialogElement | null | undefined,
  state: DialogFrameState | undefined,
  onEnd: () => void
): void {
  if (!state || !dialog || state.maximized || (event.target as HTMLElement).closest("button")) {
    return;
  }
  const start = dialog.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  handle.setPointerCapture(event.pointerId);
  // The dialog is dragged about the builder's own box (modal-place.ts), which is the window's when the builder fills it.
  const box = modalBox(dialog);
  const onMove = (move: PointerEvent): void => {
    const left = Math.min(Math.max(start.left + move.clientX - startX, box.left), Math.max(box.left, box.left + box.width - start.width));
    const top = Math.min(Math.max(start.top + move.clientY - startY, box.top), Math.max(box.top, box.top + box.height - start.height));
    dialog.style.inset = "auto";
    dialog.style.margin = "0";
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
    // Pinned where it is: from here on the browser's resize edits these same values.
    dialog.style.width = `${start.width}px`;
    dialog.style.height = `${start.height}px`;
  };
  const end = (): void => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    onEnd();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  event.preventDefault();
}

/**
 * Shows a keyed-text dialog modally: `showModal()` lifts it into the browser's top layer and
 * makes everything outside it inert until it is answered, and it is kept over the builder's own
 * box (modal-place.ts); where there is no `showModal` (a
 * test DOM) the `open` attribute stands in. Escape — the browser's close request — is handed
 * to `onCancel`. Focus goes to `firstInput` unless the author is already typing somewhere in
 * the dialog (a repaint restored their cell): `showModal` itself lands focus on the first
 * button, which is nowhere to start typing.
 */
export function openDialogModally(dialog: HTMLDialogElement, root: DocumentOrShadowRoot, firstInput: string, onCancel: () => void): void {
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) {
      showBuilderModal(dialog);
    }
  } else {
    dialog.setAttribute("open", "");
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    onCancel();
  });
  const active = root.activeElement;
  const typing =
    !!active &&
    dialog.contains(active) &&
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement);
  if (!typing) {
    (dialog.querySelector<HTMLElement>(firstInput) ?? dialog.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
  }
}
