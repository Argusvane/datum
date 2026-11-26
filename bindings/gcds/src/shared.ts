/**
 * What the GC Design System binding's adapters share. Types come from the
 * engine's contract (type-only imports: the binding never imports lit or the engine at run time);
 * lit arrives through `createBinding(lit, datum)`.
 */
import type { FieldState, FieldNotice, View } from "../../../engine/form-engine/render/live/contract.js";
import type { Lit } from "../../../engine/form-engine/render/live/lit.js";

export type { Lit };

/** GC Design System's components are worded in English or French. */
export const languageOf = (locale: string): "en" | "fr" => (locale.toLowerCase().startsWith("fr") ? "fr" : "en");

/** The one message a GC Design System field shows: every error, in the order Datum raised them. */
export const messageOf = (errors: readonly string[]): string | undefined => (errors.length > 0 ? errors.join("; ") : undefined);

/** A component's `value` property as text. */
export const valueOf = (event: Event): string => String((event.currentTarget as HTMLElement & { value?: unknown }).value ?? "");

/**
 * Whether an address a definition supplies may go into an `href`-like attribute. Relative
 * addresses and fragments pass; of the schemes, only the ones that address rather than execute
 * (`http`, `https`, `mailto`, `tel`), so `javascript:`, `data:` and `vbscript:` never reach the
 * design system's anchors. A browser drops tabs, line breaks and the other control characters
 * from a URL before it reads the scheme, so the scheme is read from a copy without them
 * ("java\tscript:" is `javascript:`); a character reference ahead of the first path, query or
 * fragment character could still spell a scheme, so one beside a colon (written or encoded)
 * fails closed, while "terms&conditions.html" stays a relative address.
 *
 * The binding bundles no engine code, so this is its own small rule; the engine's `isSafeUrl`
 * (the one the html and image components obey) is the wider one, and a test holds this one to
 * never accepting what that one refuses.
 */
export function isSafeAddress(value: string): boolean {
  const normalized = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);
  if (scheme) {
    return ["http", "https", "mailto", "tel"].includes((scheme[1] ?? "").toLowerCase());
  }
  const prefix = /^(?:&#|[^/?#])*/.exec(normalized)?.[0] ?? "";
  return !(/&#?[a-z0-9]+;?/i.test(prefix) && /:|&(?:#0*58|#x0*3a|colon);?/i.test(prefix));
}

export type Hydrating = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** Resolves when the first element matching `selector` inside the field has drawn itself (the library it is built on says when). */
export const readyOf =
  (selector: string) =>
  async (field: HTMLElement): Promise<void> => {
    await (field.querySelector(selector) as Hydrating | null)?.componentOnReady?.();
  };

/** The boxes inside a GC Design System component (they live in its shadow root, or two roots down for a date). */
export const boxesIn = (field: HTMLElement, tag: string): HTMLElement[] => {
  const host = field.querySelector(tag);
  const inner = Array.from(host?.shadowRoot?.querySelectorAll<HTMLElement>("input, textarea, select") ?? []);
  const nested = Array.from(host?.shadowRoot?.querySelectorAll("*") ?? []).flatMap((element) => Array.from(element.shadowRoot?.querySelectorAll<HTMLElement>("input, textarea, select") ?? []));
  return [...inner, ...nested];
};

/**
 * The hint as GC Design System shows it. The renderer has already folded a degraded tooltip and a
 * degraded pending word into `hint`, so this is the state's hint as it comes.
 */
export const hintOf = (s: Pick<FieldState, "hint">): string | undefined => (s.hint !== undefined && s.hint !== "" ? s.hint : undefined);

/**
 * A field's notices (warnings and info), drawn beside a GC Design System component with hint
 * styling, GC Design System's own icon (decorative) and the severity word from the form's texts.
 * GC Design System's notice and alert are page banners with a heading, which does not belong
 * inside a field, so this answers `notice: degraded`.
 * The block carries the id Datum describes the control by (`noticeId`).
 */
export const noticesOf = (lit: Lit, s: Pick<FieldState, "notices" | "noticeId" | "words">): View =>
  s.notices.length === 0
    ? lit.nothing
    : lit.html`<div id=${s.noticeId ?? lit.nothing} class="datum-gcds-notices" data-notices data-describes>${s.notices.map(
        (notice: FieldNotice) =>
          lit.html`<p class="datum-gcds-notice" data-severity=${notice.severity}><gcds-icon name=${notice.severity === "warning" ? "warning-triangle" : "info-circle"} size="text" margin-right="100"></gcds-icon><strong>${s.words(notice.severity === "warning" ? "noticeWarning" : "noticeInfo")}</strong>${notice.message}</p>`
      )}</div>`;

const lastOwn = new WeakMap<HTMLElement, Element[]>();
const reflected = new WeakSet<HTMLElement>();

/**
 * A GC Design System component writes the ids inside its own shadow root (`hint-<id>`,
 * `error-message-<id>`), so an element Datum describes the control by that lives in the form's
 * tree (the notices, the count's limit sentence) cannot be named in the box's `aria-describedby`.
 * Element reflection can: `ariaDescribedByElements` may name an element in an ancestor shadow
 * tree. The elements to add are the ones the adapter marked `data-describes` inside the field.
 * Run after every draw, and again whenever the component rewrites the box's attribute (which
 * resets the reflected list).
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
  const home = box.getRootNode() as ShadowRoot | Document;
  if (attribute) {
    lastOwn.set(box, attribute.split(/\s+/).map((id) => home.getElementById?.(id) ?? null).filter((element): element is HTMLElement => element !== null));
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

/** Keeps `reflectDescription` true after the component redraws its box's attributes; returns the cleanup. */
export function keepDescription(field: HTMLElement, box: () => HTMLElement | null | undefined): () => void {
  const target = box();
  if (!target) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => reflectDescription(field, target));
  observer.observe(target, { attributes: true, attributeFilter: ["aria-describedby"] });
  return () => observer.disconnect();
}

/**
 * A busy press on a `<gcds-button>`: `aria-disabled` on the button inside it. gcds-button copies
 * the host's `aria-*` inward only when it loads and when it is clicked, so an attribute the host
 * gains later never reaches its button. A `ref` callback for lit (`${ref(busyButton(busy))}`): a
 * new one each draw, so it runs every draw, and again once the component has drawn itself.
 */
export const busyButton =
  (busy: boolean) =>
  (element: Element | undefined): void => {
    if (!element) {
      return;
    }
    const apply = (): void => {
      const inner = element.shadowRoot?.querySelector("button");
      if (busy) {
        inner?.setAttribute("aria-disabled", "true");
      } else {
        inner?.removeAttribute("aria-disabled");
      }
    };
    apply();
    void (element as Hydrating).componentOnReady?.().then(apply);
  };
