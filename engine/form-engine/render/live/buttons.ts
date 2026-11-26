/**
 * Buttons for the live renderer: what a press on a `button` component does, whoever drew it.
 *
 * A button holds no answer. Pressing one reports the person's intent to the host as
 * `datum-form-action` {componentId, action, signature?}, and the host decides what the action
 * means (submit, download, a PDF); nothing is written to the form's state. The adapter draws the
 * control and marks it (`data-button-action`, and `data-button-signature` for a signed submit,
 * contract.ts); this module hears the press on the root, so a design system's button (a custom
 * element, a nested shadow root) needs no handler of its own.
 *
 * A press is dropped, not reported, when the form is not live (read-only or disabled), when the
 * button's field is read-only or disabled, while the form is submitting or changing page (the
 * action would race the one in flight), and on a control that says it is disabled. A whole-form
 * check that is running (`validating`) does not hold a button: a person who left a field and
 * went straight to Submit would otherwise lose the click.
 */
import { BUTTON_ACTION_ATTRIBUTE, BUTTON_SIGNATURE_ATTRIBUTE, FIELD_ID_ATTRIBUTE } from "./contract.js";
import type { LiveContext, LiveFeature } from "./mount.js";

/** The event a pressed button is reported by, on the host. */
export const FORM_ACTION_EVENT = "datum-form-action";

/** `datum-form-action`'s detail for a form's own button. */
export interface FormActionDetail {
  componentId: string;
  action: string;
  /** The signing provider the button asked for (`"webauthn"`), when it is a signed submit. */
  signature?: string;
}

const FIELD_WRAPPER = ".datum-live-field";

/** The first element on the event's path that carries the action mark, inside the form. */
function actionTargetOf(event: Event, root: ShadowRoot): HTMLElement | undefined {
  for (const node of event.composedPath()) {
    if (node === root) {
      return undefined;
    }
    if (node instanceof HTMLElement && node.hasAttribute(BUTTON_ACTION_ATTRIBUTE)) {
      return node;
    }
  }
  return undefined;
}

function disabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

/** The module that reports a form's own buttons. */
export function createButtonsFeature(): LiveFeature {
  return {
    id: "buttons",

    start(live: LiveContext) {
      const onClick = (event: Event): void => {
        const target = actionTargetOf(event, live.root);
        if (target === undefined || !live.mounted() || live.mode !== "interactive") {
          return;
        }
        const wrapper = target.closest<HTMLElement>(FIELD_WRAPPER);
        const componentId = wrapper?.getAttribute(FIELD_ID_ATTRIBUTE) ?? undefined;
        const action = target.getAttribute(BUTTON_ACTION_ATTRIBUTE) ?? "";
        const busy = live.busy();
        if (
          wrapper === null ||
          wrapper === undefined ||
          componentId === undefined ||
          action === "" ||
          disabled(target) ||
          wrapper.hasAttribute("data-readonly") ||
          wrapper.hasAttribute("data-disabled") ||
          busy === "submitting" ||
          busy === "navigating"
        ) {
          return;
        }
        const signature = target.getAttribute(BUTTON_SIGNATURE_ATTRIBUTE) ?? "";
        const detail: FormActionDetail = { componentId, action, ...(signature !== "" ? { signature } : {}) };
        live.emit(FORM_ACTION_EVENT, detail);
      };
      live.root.addEventListener("click", onClick);
      return () => live.root.removeEventListener("click", onClick);
    }
  };
}
