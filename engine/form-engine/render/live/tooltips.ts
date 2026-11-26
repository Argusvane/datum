/**
 * Field help (`configuration.tooltip`) for the live renderer.
 *
 * What a binding answers decides how the help reaches the person:
 * - `drawn`: the adapter draws the mark and its bubble (the standard drawing is {@link tooltipView}),
 *   and the renderer adds the bubble's id to the control's `describedBy`;
 * - `degraded`: the renderer folds the text into the field's hint once (mount.ts), and no bubble
 *   is drawn;
 * - `none`: the help is not drawn and the builder does not offer it.
 *
 * This module is the behaviour of a drawn bubble, which the WCAG 1.4.13 rules ask for: it can be
 * dismissed without moving the pointer or focus (Escape, heard on the document so a pointer
 * resting on a bubble that holds no focus is enough), it stays while the pointer is on it, and it
 * stays until the person closes it. The container (`data-tooltip`) is marked `data-dismissed`
 * while a bubble is closed that way, until the pointer and focus have both left it, so it does
 * not reopen under a resting pointer; the binding's CSS shows the bubble on hover or focus unless
 * the container is dismissed. The mark (`data-tooltip-mark`) is a button for the keyboard: Enter or
 * Space toggles it, and Space does not scroll the page. A click on the mark or the bubble is about
 * the help, not the field, so a label's forwarding of the click to its control is cancelled.
 */
import { html, type TemplateResult } from "./lit.js";
import { TOOLTIP_ATTRIBUTE, TOOLTIP_DISMISSED_ATTRIBUTE, TOOLTIP_MARK_ATTRIBUTE, tooltipIdOf, type FieldState } from "./contract.js";
import type { LiveContext, LiveFeature } from "./mount.js";

const TOOLTIP_SELECTOR = `[${TOOLTIP_ATTRIBUTE}]`;
const MARK_SELECTOR = `[${TOOLTIP_MARK_ATTRIBUTE}]`;

/**
 * The standard mark and bubble for a field's help: a focusable "?" named by the `tooltipHelp`
 * text, describing the control through the bubble's id (`tooltipIdOf`). For an adapter that
 * draws help; its binding's CSS positions and shows the bubble.
 */
export function tooltipView(state: Pick<FieldState, "id" | "words">, text: string): TemplateResult {
  const id = tooltipIdOf(state.id);
  return html`<span class="datum-live-tooltip" data-tooltip
    ><span data-tooltip-mark tabindex="0" role="button" aria-label=${state.words("tooltipHelp")} aria-describedby=${id}>?</span
    ><span id=${id} data-tooltip-text aria-hidden="true">${text}</span></span
  >`;
}

function hovered(element: Element): boolean {
  try {
    return element.matches(":hover");
  } catch {
    return false;
  }
}

export function createTooltipsFeature(): LiveFeature {
  return {
    id: "tooltips",

    start(live: LiveContext) {
      const root = live.root;
      const doc = root.ownerDocument;
      const tooltipOf = (event: Event): HTMLElement | null => {
        const target = event.target;
        return target instanceof Element ? target.closest<HTMLElement>(TOOLTIP_SELECTOR) : null;
      };
      /** Whether the event leaves a dismissed tooltip: its target is not moving into the tooltip itself. */
      const leaving = (tooltip: HTMLElement, event: Event): boolean => {
        const into = (event as MouseEvent | FocusEvent).relatedTarget;
        return tooltip.hasAttribute(TOOLTIP_DISMISSED_ATTRIBUTE) && !(into instanceof Node && tooltip.contains(into));
      };

      const onClick = (event: Event): void => {
        if (tooltipOf(event)) {
          event.preventDefault();
        }
      };
      const onKeydown = (event: Event): void => {
        const key = event as KeyboardEvent;
        const target = key.target;
        const mark = target instanceof Element ? target.closest(MARK_SELECTOR) : null;
        if (!mark || (key.key !== "Enter" && key.key !== " ") || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) {
          return;
        }
        key.preventDefault();
        const tooltip = tooltipOf(event);
        if (tooltip?.hasAttribute(TOOLTIP_DISMISSED_ATTRIBUTE)) {
          tooltip.removeAttribute(TOOLTIP_DISMISSED_ATTRIBUTE);
        } else {
          tooltip?.setAttribute(TOOLTIP_DISMISSED_ATTRIBUTE, "");
        }
      };
      const onMouseout = (event: Event): void => {
        const tooltip = tooltipOf(event);
        const focused = root.activeElement;
        if (tooltip && leaving(tooltip, event) && !(focused && tooltip.contains(focused))) {
          tooltip.removeAttribute(TOOLTIP_DISMISSED_ATTRIBUTE);
        }
      };
      const onFocusout = (event: Event): void => {
        const tooltip = tooltipOf(event);
        if (tooltip && leaving(tooltip, event) && !hovered(tooltip)) {
          tooltip.removeAttribute(TOOLTIP_DISMISSED_ATTRIBUTE);
        }
      };
      /**
       * Escape dismisses every bubble that is showing (under the pointer or holding focus), and is
       * consumed only when one was, so a dialog around the form closes on the next Escape.
       */
      const onEscape = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !live.mounted()) {
          return;
        }
        const focused = root.activeElement;
        let dismissed = false;
        for (const tooltip of Array.from(root.querySelectorAll<HTMLElement>(TOOLTIP_SELECTOR))) {
          if (!tooltip.hasAttribute(TOOLTIP_DISMISSED_ATTRIBUTE) && (hovered(tooltip) || (focused !== null && tooltip.contains(focused)))) {
            tooltip.setAttribute(TOOLTIP_DISMISSED_ATTRIBUTE, "");
            dismissed = true;
          }
        }
        if (dismissed) {
          event.preventDefault();
          event.stopPropagation();
        }
      };

      root.addEventListener("click", onClick);
      root.addEventListener("keydown", onKeydown);
      root.addEventListener("mouseout", onMouseout);
      root.addEventListener("focusout", onFocusout);
      // Captured on the document: the key goes to the focused element, which with the pointer
      // resting on a bubble is not in this form at all.
      doc.addEventListener("keydown", onEscape, true);
      return () => {
        root.removeEventListener("click", onClick);
        root.removeEventListener("keydown", onKeydown);
        root.removeEventListener("mouseout", onMouseout);
        root.removeEventListener("focusout", onFocusout);
        doc.removeEventListener("keydown", onEscape, true);
      };
    }
  };
}
