/*
 * Reading the renderer's shadow DOM through its contract:
 * a field is the element carrying `data-component-id` (its state hooks `data-kind`, `data-required`,
 * `data-invalid`, ... live on it), the answer's place is `data-value-path`, a container is
 * `data-container-id`. A control is found inside its field box by element type, never by a class.
 */

const esc = (id: string): string => id.replace(/"/g, '\\"');

/** The field's wrapper: the element that carries its state hooks. */
export function box(root: ParentNode, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-component-id="${esc(id)}"]`) as HTMLElement;
}

export function boxes(root: ParentNode, id: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-component-id="${esc(id)}"]`)];
}

/** The field's text, number, date or other single control (the first form control inside its box). */
export function control<T extends HTMLElement = HTMLInputElement>(root: ParentNode, id: string): T {
  return (box(root, id)?.querySelector<T>("input, select, textarea") ?? null) as T;
}

/** The field's `<input>` of the given type (a radio or a checkbox of a group is picked with `value`). */
export function inputOf(root: ParentNode, id: string, type: string, value?: string): HTMLInputElement {
  const selector = value === undefined ? `input[type="${type}"]` : `input[type="${type}"][value="${value}"]`;
  return (box(root, id)?.querySelector<HTMLInputElement>(selector) ?? null) as HTMLInputElement;
}

export function selectOf(root: ParentNode, id: string): HTMLSelectElement {
  return (box(root, id)?.querySelector("select") ?? null) as HTMLSelectElement;
}

export function container(root: ParentNode, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-container-id="${esc(id)}"]`)!;
}

/** Whether the field's box says it is invalid (the state hook, not a class). */
export function invalid(root: ParentNode, id: string): boolean {
  return box(root, id)?.hasAttribute("data-invalid") ?? false;
}

/** The words a control's `aria-describedby` points at, joined (what a screen reader reads after its name). */
export function describedBy(element: Element): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ")
    .trim();
}

/** The control's accessible name, from `aria-labelledby`, `aria-label` or its `<label>`. */
export function nameOf(element: Element): string {
  const root = element.getRootNode() as Document | ShadowRoot;
  const labelled = element.getAttribute("aria-labelledby");
  if (labelled) {
    return labelled
      .split(/\s+/)
      .map((id) => root.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .join(" ")
      .trim();
  }
  return (element.getAttribute("aria-label") ?? "").trim();
}

/** One keystroke's worth: the value as typed so far, and the `input` a browser fires for it. */
export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** Leaving the control: the `blur` and the `focusout` a browser fires when focus moves elsewhere. */
export function leave(control: HTMLElement): void {
  control.dispatchEvent(new FocusEvent("blur"));
  control.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
}

/** A pick on a checkbox, radio or select: its `change`. */
export function pick(control: HTMLElement): void {
  control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

/** The error summary (the renderer's own wrapper around whatever the binding draws). */
export function summaryOf(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-datum-summary]");
}

/**
 * The host's receipt: the focusable status or alert region that is not the summary and not an
 * echo copy (hidden from assistive technology).
 */
export function noticeOf(root: ParentNode): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('[role="status"][tabindex="-1"], [role="alert"][tabindex="-1"]')].find(
      (element) => element.getAttribute("aria-hidden") !== "true" && element.closest("[data-datum-summary]") === null
    ) ?? null
  );
}

/** The text of the first heading inside `scope`. */
export function headingText(scope: ParentNode | null): string | undefined {
  return scope?.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.trim();
}

/**
 * The journey page's forward button, by its name: Continue on a page with a next, Submit on the
 * last (Datum's page adapter draws both as the one forward button, `data-journey-continue`).
 */
function journeyForward(root: ParentNode, name: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>("[data-journey-continue]")].find((button) => button.textContent?.trim() === name) ?? null;
}

export function journeyContinue(root: ParentNode): HTMLElement | null {
  return journeyForward(root, "Continue");
}

export function journeySubmit(root: ParentNode): HTMLElement | null {
  return journeyForward(root, "Submit");
}

/** Whether focus is inside the error summary. */
export function inSummary(root: ShadowRoot): boolean {
  return summaryOf(root)?.contains(root.activeElement) === true;
}

/** The ids of the fields the form marks invalid (the state hook), in document order. */
export function invalidIds(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>("[data-component-id][data-invalid]")].map((field) => field.dataset.componentId!);
}

/** The summary's links whose text names a field. */
export function summaryLinks(root: ParentNode): HTMLAnchorElement[] {
  return [...(summaryOf(root)?.querySelectorAll("a") ?? [])];
}

/**
 * The form's status line(s) saying `text`: the live one (`role="status"`) and an echo copy at the
 * other end (hidden from assistive technology), in document order.
 */
export function statusLinesSaying(root: ParentNode, text: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="status"]:not([tabindex]), [aria-hidden="true"]')].filter(
    (element) => element.textContent?.trim() === text && !element.parentElement?.closest(`[aria-hidden="true"]`)
  );
}

/**
 * The receipts the form draws: the live one (a focusable status or alert region) and an echo
 * copy (hidden from assistive technology) holding the same title, in document order.
 */
export function receiptsTitled(root: ParentNode, title: string): HTMLElement[] {
  const heading = (element: Element): string | undefined => element.querySelector("h1, h2, h3, h4, h5, h6")?.textContent?.replace(/^\w+: /, "").trim();
  return [...root.querySelectorAll<HTMLElement>('[role][tabindex="-1"], [aria-hidden="true"]')].filter(
    (element) => element.closest("[data-datum-summary]") === null && heading(element) === title
  );
}

/** The error summaries the form draws: the live one (an alert) and an echo copy after the fields, in document order. */
export function summaryCopies(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".datum-live-summary")];
}

/** Whether `first` stands before `second` in the document. */
export function standsBefore(first: Node, second: Node): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}
