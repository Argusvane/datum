/**
 * What the Québec design system binding's adapters share. Types come from the engine's contract
 * (type-only imports: the binding never imports lit or the engine at run time bar one pure
 * function); lit arrives through `createBinding(lit, datum)`.
 *
 * The design system's form components (qc-textfield, qc-choice-group, qc-select, qc-checkbox,
 * qc-notice) are Svelte custom elements that WRAP a native control the author writes in the light
 * DOM. In a Datum form that light DOM is inside the form's shadow root, so the controls are
 * reachable by id, by the summary and by the renderer's value channel like any other. The
 * components MOVE nodes around in it (their label, description, count and error are drawn in the
 * component's own shadow tree and then placed beside the input), so a template keeps the wrapped
 * control as the element's static child and puts nothing of lit's between it and the nodes the
 * component inserts.
 *
 * The components insert their label, description and error text as HTML (`{@html}`): every string
 * handed to them as an attribute goes through {@link esc}.
 */
import type { FieldNotice, FieldState, View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit, TemplateResult } from "../../../engine/form-engine/render/live/lit.js";

export type { Lit };

/** A string for a component that inserts its attribute as HTML. */
export const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A class list from names, skipping empty ones. */
export const cls = (...names: ReadonlyArray<string | false | undefined>): string => names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");

/** The error text a component takes: every blocking error, in the order Datum raised them, escaped. */
export const errorText = (s: Pick<FieldState, "errors">): string | undefined => (s.errors.length > 0 ? esc(s.errors.join("; ")) : undefined);

/** The width the author asked for with `qc-size-xs` .. `qc-size-xl` (the binding's vocabulary, `cssClasses`). */
export const sizeOf = (s: Pick<FieldState, "classNames">): string | undefined => s.classNames.map((name) => /^qc-size-(xs|sm|md|lg|xl)$/.exec(name)?.[1]).find(Boolean);

export const hasClass = (s: Pick<FieldState, "classNames">, name: string): boolean => s.classNames.includes(name);

/** A heading of `level` (1 to 6), clamped. */
export const levelOf = (level: number): number => Math.min(6, Math.max(1, Math.round(Number.isFinite(level) ? level : 1)));

/** A heading element at `level` with the given id and class. */
export function headingAt(lit: Lit, level: number, props: { id?: string | undefined; className: string; focusable?: boolean; journey?: boolean }, content: TemplateResult | string): TemplateResult {
  const { html, ifDefined, nothing } = lit;
  const id = ifDefined(props.id);
  const tabindex = props.focusable === true ? "-1" : nothing;
  const journey = props.journey === true ? "" : nothing;
  switch (levelOf(level)) {
    case 1:
      return html`<h1 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h1>`;
    case 2:
      return html`<h2 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h2>`;
    case 3:
      return html`<h3 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h3>`;
    case 4:
      return html`<h4 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h4>`;
    case 5:
      return html`<h5 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h5>`;
    default:
      return html`<h6 id=${id} class=${props.className} tabindex=${tabindex} data-journey-heading=${journey}>${content}</h6>`;
  }
}

/** The design system's warning icon as `FormError` draws it (`qc-icon`, `warning`, red). */
export const errorIcon = (lit: Lit): TemplateResult =>
  lit.html`<qc-icon icon="warning" color="red-regular" width="var(--error-icon-width)" height="var(--error-icon-height)" aria-hidden="true"></qc-icon>`;

/** `FormError`'s markup for an error Datum draws itself (a date, a native select, a grid): the DS's own class and alert role. */
export const formError = (lit: Lit, s: { errors: readonly string[]; errorId?: string | undefined }, extra = ""): View =>
  s.errors.length === 0
    ? lit.nothing
    : lit.html`<div id=${lit.ifDefined(s.errorId)} class=${cls("qc-form-error", extra)} role="alert">${errorIcon(lit)}<span>${s.errors.join("; ")}</span></div>`;

/** `.qc-label` as `Label.svelte` draws it: the text, then the red required star. */
export const labelText = (lit: Lit, text: string, required: boolean): TemplateResult =>
  lit.html`<span class="qc-label-text">${text}</span>${required ? lit.html`<span class="qc-required" aria-hidden="true">*</span>` : lit.nothing}`;

/** The hint as the toolkit styles a description (`.qc-description`, restated in css.ts outside qc-textfield). */
export const description = (lit: Lit, s: Pick<FieldState, "hint" | "hintId">, extra = ""): View =>
  s.hint === undefined || s.hint === "" ? lit.nothing : lit.html`<div id=${lit.ifDefined(s.hintId)} class=${cls("qc-description", extra)}>${s.hint}</div>`;

/**
 * A field's warnings and info, drawn with the design system's notice (`qc-notice`, types
 * `warning` and `information`) and never in its error styling: no `invalid`, no alert role, never
 * in the summary. The notice carries the `noticeId` the control is described by, and the severity
 * word is read first (Québec's notice names its own type in the page language through its icon
 * label; the form's word is the form's language).
 */
export const notices = (lit: Lit, s: Pick<FieldState, "notices" | "noticeId" | "words">): View =>
  s.notices.length === 0
    ? lit.nothing
    : lit.html`<div id=${lit.ifDefined(s.noticeId)} class="datum-qc-notices" data-notices>${s.notices.map(
        (notice: FieldNotice) =>
          lit.html`<qc-notice type=${notice.severity === "warning" ? "warning" : "information"} data-severity=${notice.severity}><p class="datum-qc-notice-text"><span class="qc-sr-only">${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</span>${notice.message}</p></qc-notice>`
      )}</div>`;

/** `aria-describedby` ids Datum adds to what a component wrote itself, kept across the component's own rewrites. */
interface Kept {
  want: string[];
  added: Set<string>;
}
const kept = new WeakMap<Element, Kept>();

function merge(control: Element): void {
  const record = kept.get(control);
  if (record === undefined) {
    return;
  }
  const current = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const next = current.filter((id) => !record.added.has(id) || record.want.includes(id));
  for (const id of record.want) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  record.added = new Set(record.want);
  const text = next.join(" ");
  if (text === current.join(" ")) {
    return;
  }
  if (text === "") {
    control.removeAttribute("aria-describedby");
  } else {
    control.setAttribute("aria-describedby", text);
  }
}

/**
 * `qc-textfield` writes `aria-describedby` itself (its description, its error, its count), with ids
 * that exist in the form's tree. Datum adds the ones the toolkit does not know: a field's notices
 * and the limit sentence of its count. Written again after every draw and whenever the component
 * rewrites the attribute ({@link keepIds}).
 */
export function addDescribedBy(control: Element | null | undefined, ids: ReadonlyArray<string | undefined>): void {
  if (!control) {
    return;
  }
  const want = ids.filter((id): id is string => typeof id === "string" && id !== "");
  const record = kept.get(control);
  if (record === undefined) {
    kept.set(control, { want, added: new Set() });
  } else {
    record.want = want;
  }
  merge(control);
}

/** Keeps {@link addDescribedBy} true after the component rewrites the attribute; returns the cleanup. */
export function keepIds(control: () => Element | null | undefined): () => void {
  const target = control();
  if (!target) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => merge(target));
  observer.observe(target, { attributes: true, attributeFilter: ["aria-describedby"] });
  return () => observer.disconnect();
}

/**
 * What describes a control a component cannot describe: the help text and the blocking errors, as
 * the element's own `aria-description`. `qc-choice-group` and `qc-checkbox` draw their error in the
 * component's own shadow tree, whose ids a slotted control cannot name. Removed when there is
 * nothing to say.
 */
export function describeText(element: Element | null | undefined, s: { hint?: string | undefined; errors: readonly string[] }): void {
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

/** What a group is described by, per field: the ids of the light-DOM elements and the text to fall back on. */
interface GroupSays {
  ids: ReadonlyArray<string | undefined>;
  text: { hint?: string | undefined; errors: readonly string[] };
}
const groupSays = new WeakMap<HTMLElement, GroupSays>();

/**
 * Names what describes a group the toolkit draws: the fieldset in a component's shadow root
 * (`qc-choice-group`). Its error is drawn in that shadow tree, where a control in the form's tree
 * cannot name it by id, but the fieldset can name it, and the form's own elements (the help text,
 * the notices), by element reflection. Without element reflection (`ariaDescribedByElements`) the
 * same words are the fieldset's `aria-description`. Run after every draw ({@link describeGroup})
 * and whenever the component draws or removes its error ({@link keepGroup}).
 */
function reflectGroup(field: HTMLElement, group: HTMLElement): void {
  const says = groupSays.get(field);
  if (says === undefined) {
    return;
  }
  const light = says.ids
    .map((id) => (id === undefined || id === "" ? null : field.querySelector(`[id="${CSS.escape(id)}"]`)))
    .filter((element): element is Element => element !== null);
  if ("ariaDescribedByElements" in group) {
    const own = group.querySelector(".qc-form-error");
    const next = [...(own ? [own] : []), ...light];
    const reflecting = group as HTMLElement & { ariaDescribedByElements: readonly Element[] | null };
    const current = reflecting.ariaDescribedByElements ?? [];
    if (next.length !== current.length || next.some((element, index) => element !== current[index])) {
      reflecting.ariaDescribedByElements = next.length === 0 ? null : next;
    }
    group.removeAttribute("aria-description");
    return;
  }
  describeText(group, says.text);
}

/** Records what describes the group and writes it; `ids` are the form's own elements by id, `text` the fallback. */
export function describeGroup(field: HTMLElement, group: HTMLElement | null | undefined, says: GroupSays): void {
  groupSays.set(field, says);
  if (group) {
    reflectGroup(field, group);
  }
}

/** Writes {@link describeGroup} again whenever the component draws or removes what is inside its shadow root; returns the cleanup. */
export function keepGroup(field: HTMLElement, host: () => Element | null | undefined): () => void {
  const element = host();
  const root = element?.shadowRoot;
  if (!root) {
    return () => undefined;
  }
  const refresh = (): void => {
    const group = root.querySelector<HTMLElement>("fieldset");
    if (group) {
      reflectGroup(field, group);
    }
  };
  const observer = new MutationObserver(refresh);
  observer.observe(root, { childList: true, subtree: true });
  refresh();
  return () => observer.disconnect();
}

/**
 * Resolves when every `tag` in the field has drawn what `drawn` looks for. A Svelte custom element
 * builds its tree after it connects and says nothing when it has (no event, no promise), so the
 * binding looks, frame by frame. Bounded: a component that never draws lets the renderer carry on.
 */
export const readyWhen =
  (tag: string, drawn: (host: Element, field: HTMLElement) => boolean) =>
  async (field: HTMLElement): Promise<void> => {
    await customElements.whenDefined(tag);
    for (let frame = 0; frame < 120; frame += 1) {
      const hosts = Array.from(field.querySelectorAll(tag));
      if (hosts.length > 0 && hosts.every((host) => drawn(host, field))) {
        return;
      }
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  };

/**
 * Refuses the pointer and the keys that open or change a component while the field is read-only
 * (Tab still moves on): the binding's own guard beside the renderer's (`read-only.ts`), which knows
 * native radios, checkboxes and selects only. It reads the `data-readonly` the renderer sets on the
 * wrapper.
 */
export function readOnlyGuard(...tags: string[]): (field: HTMLElement) => () => void {
  return (field) => {
    const refuse = (event: Event): void => {
      if (field.dataset["readonly"] !== "true") {
        return;
      }
      if (event instanceof KeyboardEvent && (event.key === "Tab" || event.key === "Shift")) {
        return;
      }
      if (event.composedPath().some((node) => node instanceof HTMLElement && tags.includes(node.localName))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const types = ["mousedown", "click", "keydown"];
    for (const type of types) {
      field.addEventListener(type, refuse, true);
    }
    return () => {
      for (const type of types) {
        field.removeEventListener(type, refuse, true);
      }
    };
  };
}
