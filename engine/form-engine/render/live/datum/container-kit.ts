/**
 * What Datum's container adapters share: the choices that move a container's drawing
 * (`DatumContainerControls`), headings, class lists, and the layout rules.
 *
 * Containers draw `datum-form__*` classes the Datum stylesheet is written against. A layout's
 * columns and spans are never written as an inline style (a CSP that forbids `style-src-attr`
 * would drop it): the stylesheet holds the rules (`DATUM_CONTAINER_CSS`), and the one number a rule
 * needs (a grid's column count, a cell's span) is set as a custom property through the CSSOM.
 */
import { html, ifDefined, nothing, type TemplateResult } from "../lit.js";
import type { GridState, GroupState, View } from "../contract.js";
import { drawPart, type DatumParts } from "./parts.js";

// ── Controls ───────────────────────────────────────────────────────────────────────────────

/**
 * The choices of the Datum binding that move a container's drawing, each the engine's own
 * default unless a host says otherwise (`createDatumBinding({controls})`). They are the design
 * systems' own differences, kept as seams: USWDS draws a panel as a plain card, GOV.UK's steps
 * are pages, and so on. Names and meanings are those of a design system's markup.
 */
export interface DatumContainerControls {
  /** Whether a panel (and a tab's flat section) is a named region. */
  panelRegion: "named" | "none";
  /** What a steps container's steps are: announced regions with a live progress line, or plain sections under a caption. */
  stepPages: "announced" | "plain";
  /** What the steps indicator's entries are: buttons, or static text. */
  stepSegments: "buttons" | "text";
  /** Whether one step's panel is a named region. */
  stepRegion: "named" | "none";
  /** Where the steps' progress line stands among the indicator's list. */
  stepProgress: "afterList" | "beforeList";
  /** The order of the steps' Back and Continue. */
  actionOrder: "backFirst" | "nextFirst";
  /** What a button group is drawn as: a plain box, or a list of items. */
  buttonGroup: "div" | "list";
  /** Whether a group's fieldset is described by its hint (`described`), or by nothing (`none`). */
  groupDescription: "described" | "none";
  /** A data grid's own error is an alert, or plain text (the summary is then the page's one alert). The fields' `inlineErrors`. */
  inlineErrors: "alert" | "plain";
}

export const DEFAULT_CONTAINER_CONTROLS: Readonly<DatumContainerControls> = Object.freeze({
  panelRegion: "named",
  stepPages: "announced",
  stepSegments: "buttons",
  stepRegion: "named",
  stepProgress: "afterList",
  actionOrder: "backFirst",
  buttonGroup: "div",
  groupDescription: "described",
  inlineErrors: "alert"
});

/** The controls with each unknown or missing choice replaced by the engine's own. */
export function resolveContainerControls(controls: Partial<DatumContainerControls> | undefined): Readonly<DatumContainerControls> {
  if (!controls || typeof controls !== "object") {
    return DEFAULT_CONTAINER_CONTROLS;
  }
  return {
    panelRegion: controls.panelRegion === "none" ? "none" : "named",
    stepPages: controls.stepPages === "plain" ? "plain" : "announced",
    stepSegments: controls.stepSegments === "text" ? "text" : "buttons",
    stepRegion: controls.stepRegion === "none" ? "none" : "named",
    stepProgress: controls.stepProgress === "beforeList" ? "beforeList" : "afterList",
    actionOrder: controls.actionOrder === "nextFirst" ? "nextFirst" : "backFirst",
    buttonGroup: controls.buttonGroup === "list" ? "list" : "div",
    groupDescription: controls.groupDescription === "none" ? "none" : "described",
    inlineErrors: controls.inlineErrors === "plain" ? "plain" : "alert"
  };
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────

/** The host's part templates the containers draw: the legend's mark, a grid's error, the steps' Back. */
export type DatumContainerParts = Pick<DatumParts, "labelMarks" | "errorMessage" | "stepBack">;

/**
 * The legend mark a labelled container asks for (`configuration.legendMark`), drawn through the
 * `labelMarks` part: announced, since a group has no required state to carry it.
 */
export function legendMarkView(s: GroupState | GridState, parts: Readonly<DatumContainerParts> | undefined): View {
  if (s.legendMark === undefined) {
    return nothing;
  }
  const marker = s.words(s.legendMark);
  const required = s.legendMark === "required";
  const drawn = marker === "" ? nothing : html` <span class=${required ? "datum-form__required" : "datum-form__optional"}>${marker}</span>`;
  return drawPart(parts, "labelMarks", { state: s, required, announced: true, marker, default: drawn });
}

/** A data grid's own error, through the `errorMessage` part: an alert unless the form's inline errors are plain. */
export function containerErrorView(s: GridState, inlineErrors: "alert" | "plain", parts: Readonly<DatumContainerParts> | undefined): View {
  if (s.errors.length === 0 || s.errorId === undefined) {
    return nothing;
  }
  const prefix = s.words("errorPrefix");
  const role = inlineErrors === "plain" ? undefined : "alert";
  const message = s.errors.join("; ");
  const drawn = html`<p id=${s.errorId} class="datum-form__error" role=${ifDefined(role)}>${prefix === "" ? nothing : html`<span class="datum-form__visually-hidden">${prefix} </span>`}${message}</p>`;
  return drawPart(parts, "errorMessage", { state: s, id: s.errorId, message, prefix, role, default: drawn });
}

// ── Headings and classes ───────────────────────────────────────────────────────────────────

/** The heading level clamped to what HTML has: a form nested deep still gets a real heading. */
export function headingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, Math.round(level))) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** A heading element of `level`; `focusable` makes it `tabindex="-1"`, a target for the renderer's focus. */
export function heading(level: number, attributes: { id?: string | undefined; className: string; focusable?: boolean }, content: View | string): TemplateResult {
  const id = ifDefined(attributes.id);
  const tabindex = attributes.focusable ? "-1" : nothing;
  switch (headingLevel(level)) {
    case 1:
      return html`<h1 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h1>`;
    case 2:
      return html`<h2 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h2>`;
    case 3:
      return html`<h3 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h3>`;
    case 4:
      return html`<h4 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h4>`;
    case 5:
      return html`<h5 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h5>`;
    default:
      return html`<h6 id=${id} class=${attributes.className} tabindex=${tabindex}>${content}</h6>`;
  }
}

/** A class list from names, skipping empty ones: the leaf kit's one helper. */
export { classes } from "./leaf-kit.js";

/**
 * The `ref` callback that sets one style property (a custom property, a width) on its element
 * through the CSSOM, so no `style` attribute is written and a CSP that forbids inline styles
 * leaves it alone.
 */
export function styleProperty(name: string, value: string | number | undefined): (element?: Element) => void {
  return (element) => {
    if (element instanceof HTMLElement) {
      if (value === undefined) {
        element.style.removeProperty(name);
      } else {
        element.style.setProperty(name, String(value));
      }
    }
  };
}
