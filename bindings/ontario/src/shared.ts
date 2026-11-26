/**
 * What the Ontario Design System binding's adapters share. Types come from the engine's contract
 * (type-only imports: the binding never imports lit or the engine at run time, bar `readTypedNumber`);
 * lit arrives through `createBinding(lit, datum)`.
 *
 * Ontario's components are Stencil elements with a shadow root each. Things worth knowing:
 * - A label, a hint and an option list are props Ontario parses as JSON when they are strings, so they
 *   are written as JSON strings: a string prop is written again only when its text changes, and a label
 *   that is itself valid JSON ("123", "true") is not misread as a number.
 * - No component takes `disabled` or `readonly` (a policy of the design system, documented on each
 *   component). The boxes inside take both, set after every draw.
 * - A component does not mark its box `aria-invalid`, and the hint's id (`aria-describedby`) lives in
 *   another shadow root than the box it describes, so it names nothing. Those are the design system's;
 *   what the binding owns is `aria-invalid` and the Datum-drawn descriptions (a field's notices, the
 *   count's limit sentence), which reach the box by element reflection (`reflectDescription`).
 */
import type { FieldNotice, FieldState, View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit } from "../../../engine/form-engine/render/live/lit.js";

export type { Lit };

/** Ontario's components are worded in English or French. */
export const languageOf = (locale: string): "en" | "fr" => (locale.toLowerCase().startsWith("fr") ? "fr" : "en");

/** The one message an Ontario field shows: every error, in the order Datum raised them. */
export const messageOf = (errors: readonly string[]): string | undefined => (errors.length > 0 ? errors.join("; ") : undefined);

/** `caption` as a JSON string: Ontario parses a string caption, and a bare "123" would not survive that. */
export const captionOf = (label: string): string => JSON.stringify({ captionText: label, captionType: "default" });

/** `hint-text` likewise. */
export const hintJson = (hint: string | undefined): string | undefined => (hint === undefined || hint === "" ? undefined : JSON.stringify({ hint, hintContentType: "string" }));

export type Hydrating = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/**
 * Resolves when the first element matching `selector` inside the field, and the Ontario elements it draws
 * in its own shadow root (the hint, the error icon), have drawn themselves. The hint's id reaches the box
 * a render later (`componentDidLoad` awaits the hint component), so one task is allowed after.
 */
export const readyOf =
  (selector: string) =>
  async (field: HTMLElement): Promise<void> => {
    const host = field.querySelector(selector) as Hydrating | null;
    await host?.componentOnReady?.();
    const nested = Array.from(host?.shadowRoot?.querySelectorAll<Hydrating>("*") ?? []).filter((element) => element.localName.startsWith("ontario-"));
    await Promise.all(nested.map((element) => element.componentOnReady?.()));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

/** The boxes inside an Ontario component (they live in its shadow root). */
export const boxesIn = (field: HTMLElement, tag: string): Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> =>
  Array.from(field.querySelector(tag)?.shadowRoot?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select") ?? []);

/** Ontario has no disabled or read-only state: the boxes inside take both, and `aria-invalid` (no component writes it). */
export function applyModes(field: HTMLElement, tag: string, s: Pick<FieldState, "disabled" | "readOnly" | "invalid">): void {
  for (const box of boxesIn(field, tag)) {
    box.disabled = s.disabled;
    if (box instanceof HTMLSelectElement) {
      box.setAttribute("aria-readonly", String(s.readOnly));
    } else if (box.type !== "checkbox" && box.type !== "radio") {
      box.readOnly = s.readOnly;
    }
    if (s.invalid) {
      box.setAttribute("aria-invalid", "true");
    } else {
      box.removeAttribute("aria-invalid");
    }
  }
}

/**
 * A field's notices (warnings and info), drawn as Ontario's own callout with no heading (its yellow
 * highlight for a warning, its teal for information) with the severity word from the form's texts
 * read first. Never the error colour, never `aria-invalid`. The block carries the id Datum describes
 * the control by (`noticeId`).
 */
export const noticesOf = (lit: Lit, s: Pick<FieldState, "notices" | "noticeId" | "words">): View =>
  s.notices.length === 0
    ? lit.nothing
    : lit.html`<div id=${s.noticeId ?? lit.nothing} class="datum-ontario-notices" data-notices data-describes>${s.notices.map(
        (notice: FieldNotice) =>
          lit.html`<ontario-callout highlight-colour=${notice.severity === "warning" ? "yellow" : "teal"}><p data-severity=${notice.severity}><strong>${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo").trim()}</strong> ${notice.message}</p></ontario-callout>`
      )}</div>`;

/**
 * The count under the box. Ontario has no character count and no `maxlength`-free counter, so the
 * limit sentence is read by assistive technology only (it carries the id Datum describes the control by)
 * and the figure as it stands is Ontario's hint, hidden from them (it changes on every keystroke; the
 * renderer's announcer reads it out once typing pauses).
 */
export const countOf = (lit: Lit, s: { characterCount?: { limit: string; limitId: string; status: string; over: boolean } | undefined }): View =>
  s.characterCount === undefined
    ? lit.nothing
    : lit.html`<div class=${s.characterCount.over ? "datum-ontario-count datum-ontario-count--over" : "datum-ontario-count"}>
        <span class="ontario-show-for-sr" id=${s.characterCount.limitId} data-describes>${s.characterCount.limit}</span>
        <ontario-hint-text aria-hidden="true" hint=${s.characterCount.status}></ontario-hint-text>
      </div>`;

/**
 * The field's help once more, in the form's own tree and out of sight (`hidden`: still read as a
 * description when something names it). Ontario's hint component draws the visible hint, but its id lives
 * in a shadow root below the box it describes, so nothing can name it; this copy is what the box is
 * described by (`reflectDescription`). It carries the id the state names for the hint and holds whatever
 * the renderer folded into it (a tooltip, the pending word, a worked-out line).
 */
export const describedHint = (lit: Lit, s: Pick<FieldState, "hint" | "hintId">): View =>
  s.hint === undefined || s.hint === "" ? lit.nothing : lit.html`<span hidden id=${s.hintId ?? lit.nothing} data-describes data-hint-copy>${s.hint}</span>`;

const reflected = new WeakSet<HTMLElement>();

/**
 * Names what Datum drew beside an Ontario component (its notices, the count's limit sentence: the
 * elements marked `data-describes` in the field) and the component's own error line in the box's
 * description, by element reflection: an IDREF cannot reach into the component's shadow root, and
 * reflection can name an element in an ancestor tree. The component's own hint sits in a nested shadow
 * root, below the box, which reflection cannot name (the design system's). Run after every draw and
 * again whenever the component rewrites the box's `aria-describedby`, which resets the reflected list.
 */
export function reflectDescription(field: HTMLElement, host: Element | null | undefined, control: HTMLElement | null | undefined, first: readonly Element[] = []): void {
  if (!host || !control || !("ariaDescribedByElements" in control)) {
    return;
  }
  const outside = Array.from(field.querySelectorAll<HTMLElement>("[data-describes]"));
  const error = host.shadowRoot?.querySelector<HTMLElement>(".ontario-error-messaging:not(.ontario-error__hidden)") ?? null;
  const next = [...first, ...outside, ...(error ? [error] : [])];
  const reflecting = control as HTMLElement & { ariaDescribedByElements: readonly Element[] | null };
  if (next.length === 0 && !reflected.has(control)) {
    return;
  }
  const current = reflecting.ariaDescribedByElements ?? [];
  if (next.length === current.length && next.every((element, index) => element === current[index])) {
    return;
  }
  reflected.add(control);
  reflecting.ariaDescribedByElements = next;
}

/**
 * Keeps `reflectDescription` true after the component redraws: when it rewrites the box's
 * `aria-describedby` (which resets the reflected list) or shows or hides its error line. Returns the cleanup.
 */
export function keepDescription(field: HTMLElement, host: () => Element | null | undefined, control: () => HTMLElement | null | undefined, first: () => readonly Element[] = () => []): () => void {
  const target = control();
  const root = host()?.shadowRoot;
  if (!target || !root) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => reflectDescription(field, host(), target, first()));
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-describedby", "class"] });
  return () => observer.disconnect();
}

const forwarding = new WeakSet<Element>();

/**
 * An `<ontario-button>` host cannot take focus (its shadow root has no `delegatesFocus`, and the host
 * no tabindex), so `focus()` on it did nothing. The renderer puts focus back on a row button, or on
 * the grid's Add button, by the element it finds in the form's tree, which is the host: `focus()` on
 * the host is sent to the button inside. Focus is then inside the host, so the form's root reports
 * the host as its active element and the renderer's check that focus landed holds.
 */
function forwardFocus(element: Element): void {
  if (forwarding.has(element) || !(element instanceof HTMLElement)) {
    return;
  }
  forwarding.add(element);
  const own = element.focus;
  element.focus = (options?: FocusOptions): void => {
    const inner = element.shadowRoot?.querySelector("button");
    if (inner) {
      inner.focus(options);
    } else {
      own.call(element, options);
    }
  };
}

/**
 * A busy press on an `<ontario-button>`: `aria-disabled` on the button inside it (Ontario's buttons
 * take no `disabled` by policy). A `ref` callback for lit (`${ref(busyButton(busy))}`): a new one each
 * draw, so it runs every draw, and again once the component has drawn itself. The host carries
 * `aria-disabled` too, for the binding's CSS to dim it and for a reader of the form's own tree. The
 * host also sends `focus()` to the button inside ({@link forwardFocus}).
 */
export const busyButton =
  (busy: boolean) =>
  (element: Element | undefined): void => {
    if (!element) {
      return;
    }
    forwardFocus(element);
    const apply = (): void => {
      const inner = element.shadowRoot?.querySelector("button");
      if (busy) {
        inner?.setAttribute("aria-disabled", "true");
      } else {
        inner?.removeAttribute("aria-disabled");
      }
    };
    if (busy) {
      element.setAttribute("aria-disabled", "true");
    } else {
      element.removeAttribute("aria-disabled");
    }
    apply();
    void (element as Hydrating).componentOnReady?.().then(apply);
  };

/**
 * A heading at a level (h1 to h6) in Ontario's heading classes: lit cannot template a tag name, so
 * the six are written out. `tabindex` makes it a place focus can be sent (a journey page's heading, a step's).
 */
export function headingOf(lit: Lit, level: number, attributes: { id?: string | undefined; className?: string | undefined; tabindex?: string | undefined }, content: unknown): View {
  const { html, ifDefined } = lit;
  const id = ifDefined(attributes.id);
  const className = ifDefined(attributes.className);
  const tabindex = ifDefined(attributes.tabindex);
  switch (Math.min(6, Math.max(1, Math.round(level)))) {
    case 1:
      return html`<h1 id=${id} class=${className} tabindex=${tabindex}>${content}</h1>`;
    case 2:
      return html`<h2 id=${id} class=${className} tabindex=${tabindex}>${content}</h2>`;
    case 3:
      return html`<h3 id=${id} class=${className} tabindex=${tabindex}>${content}</h3>`;
    case 4:
      return html`<h4 id=${id} class=${className} tabindex=${tabindex}>${content}</h4>`;
    case 5:
      return html`<h5 id=${id} class=${className} tabindex=${tabindex}>${content}</h5>`;
    default:
      return html`<h6 id=${id} class=${className} tabindex=${tabindex}>${content}</h6>`;
  }
}
