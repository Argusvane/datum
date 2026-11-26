/**
 * What the Alberta Design System binding's adapters share. Types come from the engine's contract
 * (type-only imports: the binding never imports lit or the engine at run time, bar one pure
 * function); lit arrives through `createBinding(lit, datum)`.
 *
 * Every Alberta component is a Svelte custom element with its own open shadow root. A property is
 * a string ("true" / "false", never a bare attribute) and a removed attribute reads as null, so
 * every attribute here always carries a string. A control says `_change` (a custom event, composed,
 * `detail` `{ name, value }`) and `_blur`; `goa-form-item` owns the label, help text and error
 * message around the control.
 */
import type { FieldNotice, FieldState, TextFieldState, View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";

export type { Lit };

/** An Alberta component host (a `goa-*` element). */
export type Goa = HTMLElement;

/** A property as Alberta reads it: the string "true" or "false". */
export const bool = (value: boolean): string => (value ? "true" : "false");

/** The one message a goa-form-item shows: every blocking error, in the order Datum raised them. */
export const messageOf = (errors: readonly string[]): string => errors.join("; ");

/** goa-form-item's `requirement`: a field that is not disabled and is required says so. */
export const requirementOf = (s: Pick<FieldState, "required" | "disabled">): string => (s.required && !s.disabled ? "required" : "");

/**
 * The detail a goa-* `_change` event carries. Read from the event, never from the element:
 * a goa-input's `value` property catches up on keyup, the event's detail is what the box held.
 */
export const detailOf = (event: Event): { name?: string; value?: unknown; checked?: boolean } => ((event as CustomEvent).detail ?? {}) as { name?: string; value?: unknown; checked?: boolean };

/** The native control inside a goa-* component: `goa-input` gives its `<input>`, `goa-textarea` its `<textarea>`, `goa-dropdown` its combobox `<input>` or native `<select>`. */
export function boxIn(field: HTMLElement, tag: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  const host = field.querySelector(tag);
  return host?.shadowRoot?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select") ?? null;
}

/**
 * Resolves when every `tag` in the field has drawn `inner` in its shadow root. The goa-* components
 * say nothing when they have drawn (no `componentOnReady`, no event): a Svelte custom element builds
 * its tree after it connects, so the binding looks, frame by frame. Bounded: a component that never
 * draws lets the renderer carry on.
 */
export const readyWhen =
  (tag: string, inner: string) =>
  async (field: HTMLElement): Promise<void> => {
    await customElements.whenDefined(tag);
    for (let frame = 0; frame < 120; frame += 1) {
      const hosts = Array.from(field.querySelectorAll(tag));
      if (hosts.length > 0 && hosts.every((host) => host.shadowRoot?.querySelector(inner))) {
        return;
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  };

/** A field's notices (warnings and info), drawn as Alberta's callout and never as an error. */
export const noticesOf = (lit: Lit, s: Pick<FieldState, "notices" | "noticeId" | "words">): View =>
  s.notices.length === 0
    ? lit.nothing
    : lit.html`<div id=${s.noticeId ?? lit.nothing} class="datum-goa-notices" data-notices data-describes>${s.notices.map(
        (notice: FieldNotice) =>
          lit.html`<goa-callout type=${notice.severity === "warning" ? "important" : "information"} emphasis="low" arialive="off" data-severity=${notice.severity}><span class="datum-goa-sr-only">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span>${notice.message}</goa-callout>`
      )}</div>`;

/**
 * The count under a text box: the limit sentence for assistive technology only (it
 * carries the id Datum describes the control by), and the figure as it stands, hidden from
 * assistive technology since it changes on every keystroke. In goa-textarea's own counter face;
 * announcing it is the renderer's.
 */
export const countLine = (lit: Lit, s: TextFieldState): View =>
  s.characterCount === undefined
    ? lit.nothing
    : lit.html`<div class=${s.characterCount.over ? "datum-goa-count datum-goa-count--over" : "datum-goa-count"}>
        <span id=${s.characterCount.limitId} class="datum-goa-sr-only" data-describes>${s.characterCount.limit}</span>
        <span aria-hidden="true">${s.characterCount.status}</span>
      </div>`;

/**
 * `goa-form-item` around a control. `type` is the control family goa-form-item spaces for
 * ("text-input", "textarea", "checkbox-list", "radio-group"). The hint, the error and the label are
 * the component's: it writes `aria-label`, `aria-required` and `aria-describedby` onto the control
 * itself, with ids inside its own shadow root.
 */
export function formItem(lit: Lit, s: FieldState, type: string, control: View, below: View = lit.nothing): TemplateResult {
  return lit.html`<goa-form-item
    label=${s.hideLabel ? "" : s.label}
    helptext=${s.hint ?? ""}
    error=${messageOf(s.errors)}
    requirement=${requirementOf(s)}
    type=${type}
    >${control}${below}</goa-form-item
  >`;
}

const lastOwn = new WeakMap<HTMLElement, Element[]>();
const reflected = new WeakSet<HTMLElement>();

/**
 * goa-form-item writes `aria-describedby` onto the control with ids of its own shadow root
 * (`helptext-…`, `error-…`), so an element Datum describes the control by that lives in the form's
 * tree (the notices, the count's limit sentence) cannot be named in that attribute. Element
 * reflection can: `ariaDescribedByElements` may name an element in an ancestor shadow tree. The
 * elements to add are the ones the adapter marked `data-describes` inside the field. Run after
 * every draw, and again whenever the component rewrites the attribute (which resets the list).
 */
export function reflectDescription(field: HTMLElement, box: HTMLElement | null | undefined): void {
  if (!box || !("ariaDescribedByElements" in box)) {
    return;
  }
  const reflecting = box as HTMLElement & { ariaDescribedByElements: readonly Element[] | null };
  const outside = Array.from(field.querySelectorAll<HTMLElement>("[data-describes]"));
  if (outside.length === 0 && !reflected.has(box)) {
    return;
  }
  const attribute = box.getAttribute("aria-describedby");
  if (attribute) {
    // The component's own ids live in its goa-form-item's shadow root.
    const item = field.querySelector("goa-form-item");
    const homes: Array<ShadowRoot | Document | undefined> = [item?.shadowRoot ?? undefined, box.getRootNode() as ShadowRoot | Document];
    lastOwn.set(
      box,
      attribute
        .split(/\s+/)
        .map((id) => homes.map((home) => home?.getElementById?.(id) ?? null).find((element) => element !== null) ?? null)
        .filter((element): element is HTMLElement => element !== null)
    );
  }
  const own = (lastOwn.get(box) ?? []).filter((element) => element.isConnected);
  const next = [...own, ...outside];
  const current = reflecting.ariaDescribedByElements ?? [];
  if (next.length === current.length && next.every((element, index) => element === current[index])) {
    return;
  }
  reflected.add(box);
  reflecting.ariaDescribedByElements = next;
}

/**
 * What describes a control that goa-form-item cannot describe it with: its help text (the renderer
 * folds a tooltip, a pending word and a worked-out line into it) and its blocking errors, as the
 * control's own `aria-description`. goa-form-item writes ids of its own shadow root into
 * `aria-describedby`, which a control in another shadow root cannot resolve, so without this a screen
 * reader on the control hears neither. Written again on every draw; removed when there is nothing to say.
 */
export function describeText(element: HTMLElement | null | undefined, s: Pick<FieldState, "hint" | "errors">): void {
  if (!element) {
    return;
  }
  const text = [s.hint, ...s.errors].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  if (text === "") {
    element.removeAttribute("aria-description");
  } else if (element.getAttribute("aria-description") !== text) {
    element.setAttribute("aria-description", text);
  }
}

/** Keeps `reflectDescription` true after the component rewrites the control's attribute; returns the cleanup. */
export function keepDescription(field: HTMLElement, box: () => HTMLElement | null | undefined): () => void {
  const target = box();
  if (!target) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => reflectDescription(field, target));
  observer.observe(target, { attributes: true, attributeFilter: ["aria-describedby"] });
  return () => observer.disconnect();
}

/** A heading of `level` (1 to 6), clamped. */
export const levelOf = (level: number): number => Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)));
