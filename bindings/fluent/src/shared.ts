/**
 * What every Fluent UI adapter shares. Types come from the engine's contract (type-only imports: the
 * binding never imports lit or the engine at run time); lit arrives through `createBinding(lit, datum)`.
 *
 * Use these from every module (fields.ts, containers.ts, chrome.ts) rather than writing your own:
 * - `messagesOf(lit, s)`: the ONE element a `fluent-field` takes in its `message` slot (hint, errors,
 *   notices, count). Never put a `flag` attribute on it or on anything in it.
 * - `describe(box, field, s)`: names and describes the box inside a Fluent component (after every draw).
 * - `readyOf(selector)`, `settle(elements)`: wait for Fluent elements to have drawn themselves.
 * - `boxOf(host)`, `valueOf(event)`, `leaving(on)`.
 */
import type { FieldEvents, FieldNotice, FieldState, TextFieldState, View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit } from "../../../engine/form-engine/render/live/lit.js";

export type { Lit };

/** The visually-hidden class the binding's css defines (Fluent UI ships none). */
export const VISUALLY_HIDDEN = "datum-fluent-visually-hidden";

/** A component's `value` property as text (`fluent-text-input`, `fluent-textarea`: the event's current target). */
export const valueOf = (event: Event): string => String((event.currentTarget as HTMLElement & { value?: unknown }).value ?? "");

/** The native box a Fluent text component draws in its shadow root (`<input id="control">`, `<textarea id="control">`). */
export const boxOf = (host: Element | null | undefined): HTMLInputElement | HTMLTextAreaElement | null =>
  host?.shadowRoot?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea") ?? null;

/** Every distinct `fluent-*` tag at or under `scope` (the light tree only: a Fluent element's own shadow content is its own). */
const fluentElements = (scope: ParentNode): HTMLElement[] =>
  Array.from(scope.querySelectorAll<HTMLElement>("*")).filter((element) => element.localName.startsWith("fluent-"));

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Resolves once the Fluent elements given have drawn themselves. Fluent's elements are FAST elements:
 * each is defined by the host's script (`customElements.whenDefined`), renders its template
 * synchronously when it connects, and runs what reacts to its slots and attributes (a field labelling
 * its input, a text input hiding its empty label) on FAST's update queue, which is flushed in a
 * `requestAnimationFrame` callback (`Updates.next()` in @microsoft/fast-element is that same frame;
 * the bundle does not export it). Two frames cover a reaction that queues another.
 */
export async function settle(elements: readonly Element[]): Promise<void> {
  const tags = new Set(elements.map((element) => element.localName));
  await Promise.all(Array.from(tags, (tag) => customElements.whenDefined(tag)));
  await frame();
  await frame();
}

/** A field's `ready`: its own Fluent elements, never the whole form. */
export const readyOf =
  (selector = "*") =>
  async (field: HTMLElement): Promise<void> => {
    await settle(fluentElements(field).filter((element) => element.matches(selector)));
  };

/** The binding's `ready` stand-in: every Fluent element in the form. */
export const readyAll = async (root: ShadowRoot): Promise<void> => {
  await settle(fluentElements(root));
};

/**
 * Leaving a field: Fluent's own `change` commits, and a `blur` commits unless a change just did. Shared
 * across draws (a draw between the change and the blur must not make the blur commit a second time).
 * Only the `change` the component emits from its host counts: a composed `change` dispatched on the
 * box inside (what a test or an extension may send) reaches the host too, and is the same edit.
 */
const settled = new WeakSet<EventTarget>();
export const leaving = (on: FieldEvents) => ({
  change: (event: Event): void => {
    if (event.composedPath()[0] !== event.currentTarget) {
      return;
    }
    if (event.currentTarget) {
      settled.add(event.currentTarget);
    }
    on.commit();
  },
  blur: (event: Event): void => {
    if (event.currentTarget && settled.delete(event.currentTarget)) {
      return;
    }
    on.commit();
  },
  focus: (event: Event): void => {
    if (event.currentTarget) {
      settled.delete(event.currentTarget);
    }
  }
});

/** A notice's severity word and message, as one line. */
const noticeLine = (lit: Lit, s: Pick<FieldState, "words">, notice: FieldNotice): View =>
  lit.html`<div class="datum-fluent-notice" data-severity=${notice.severity}><span class="datum-fluent-severity">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span> ${notice.message}</div>`;

/**
 * Fluent's error mark: the 12px ErrorCircle glyph of Fluent's icon set, filled from the theme's danger
 * colour, drawn the way Fluent's own field documentation draws a message's icon (an `aria-hidden` SVG
 * of `1em`, its `fill` a token: field.stories.ts, `SuccessIcon`).
 */
export const errorIcon = (lit: Lit): View =>
  lit.html`<svg fill="var(--colorStatusDangerForeground1)" aria-hidden="true" width="1em" height="1em" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg"><path d="M6 11A5 5 0 1 0 6 1a5 5 0 0 0 0 10Zm-.75-2.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Zm.26-4.84a.5.5 0 0 1 .98 0l.01.09v2.59a.5.5 0 0 1-1 0V3.41Z" fill="var(--colorStatusDangerForeground1)"></path></svg>`;

/**
 * The one element a `fluent-field` shows under its control. Every element in the field's `message`
 * slot takes the same grid area, so several would overlap: the hint, the errors, the notices and the
 * character count are pieces of this one element, in that order, each carrying the id Datum
 * describes the control by. It is a `fluent-text size="200"`, as Fluent's field documentation writes
 * a hint (field.stories.ts, `Hint`); the field styles it (neutral foreground 3, base 200 type).
 *
 * It never carries `flag`: the field shows a flagged message only while the slotted control's native
 * validity has that flag, and Datum words its own errors without one. An unflagged message always shows.
 */
export function messagesOf(lit: Lit, s: Pick<TextFieldState, "hint" | "hintId" | "errors" | "errorId" | "notices" | "noticeId" | "words"> & { characterCount?: TextFieldState["characterCount"] }): View {
  const { html, nothing } = lit;
  const hint = s.hint !== undefined && s.hint !== "" ? s.hint : undefined;
  const count = s.characterCount;
  if (hint === undefined && s.errors.length === 0 && s.notices.length === 0 && count === undefined) {
    return nothing;
  }
  const prefix = s.words("errorPrefix");
  return html`<fluent-text slot="message" size="200" class="datum-fluent-message"
    >${hint === undefined ? nothing : html`<div id=${s.hintId ?? nothing} class="datum-fluent-hint">${hint}</div>`}${s.errors.length === 0
      ? nothing
      : html`<div id=${s.errorId ?? nothing} class="datum-fluent-error">${errorIcon(lit)} ${prefix === "" ? nothing : html`<span class=${VISUALLY_HIDDEN}>${prefix}</span>`}${s.errors.join("; ")}</div>`}${s.notices.length === 0
      ? nothing
      : html`<div id=${s.noticeId ?? nothing} class="datum-fluent-notices">${s.notices.map((notice) => noticeLine(lit, s, notice))}</div>`}${count === undefined
      ? nothing
      : html`<div class=${count.over ? "datum-fluent-count datum-fluent-count--over" : "datum-fluent-count"}
          ><span id=${count.limitId} class=${VISUALLY_HIDDEN}>${count.limit}</span><span aria-hidden="true">${count.status}</span></div
        >`}</fluent-text
  >`;
}

type Reflecting = Element & { ariaLabelledByElements: readonly Element[] | null; ariaDescribedByElements: readonly Element[] | null };

const sameList = (a: readonly Element[] | null, b: readonly Element[]): boolean => (a ?? []).length === b.length && b.every((element, index) => a?.[index] === element);

/**
 * Names and describes the box a Fluent component draws in its own shadow root.
 *
 * Measured in the kit's Chromium on 3.2.1 (Accessibility.getFullAXTree): `aria-describedby` on the
 * `fluent-text-input` host (what Fluent's field documentation writes, and what the field itself does
 * with `aria-labelledby`) names and describes the host, a `generic` node, and never the focused
 * `textbox` inside it, which had no name and no description. `ariaLabelledByElements` and
 * `ariaDescribedByElements` set on the inner box (element reflection may name an element in an
 * ancestor shadow tree) gave the textbox its name and its description. So Datum's ids are wired by
 * reflection on the box, and nothing is written on the host (the field's own `aria-labelledby` there
 * is Fluent's). The label is the field's `<label slot="label">` (`labelId`); the description is the
 * ids of `describedBy`, resolved in the form's tree, in Datum's order. `aria-invalid` goes on the box
 * too, while `invalid`, never "false". Idempotent: run after every draw.
 */
export function describe(box: HTMLElement | null | undefined, field: HTMLElement, s: Pick<FieldState, "labelId" | "describedBy" | "invalid">): void {
  if (!box) {
    return;
  }
  const home = field.getRootNode() as ShadowRoot | Document;
  const byId = (id: string): Element | null => home.getElementById?.(id) ?? null;
  if ("ariaLabelledByElements" in box) {
    const reflecting = box as unknown as Reflecting;
    const label = byId(s.labelId);
    const labels = label ? [label] : [];
    if (!sameList(reflecting.ariaLabelledByElements, labels)) {
      reflecting.ariaLabelledByElements = labels;
    }
    const described = s.describedBy.map(byId).filter((element): element is Element => element !== null);
    if (!sameList(reflecting.ariaDescribedByElements, described)) {
      reflecting.ariaDescribedByElements = described;
    }
  }
  if (s.invalid) {
    box.setAttribute("aria-invalid", "true");
  } else {
    box.removeAttribute("aria-invalid");
  }
}

/** Sets or removes a plain attribute on a box a Fluent component does not forward it to. */
export function setAttr(box: Element | null | undefined, name: string, value: string | undefined): void {
  if (!box) {
    return;
  }
  if (value === undefined) {
    box.removeAttribute(name);
  } else if (box.getAttribute(name) !== value) {
    box.setAttribute(name, value);
  }
}
