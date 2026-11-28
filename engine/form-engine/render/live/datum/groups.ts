/**
 * Datum's group containers: the ones that draw their children inside a box of their own and
 * hold nothing else. Each is a {@link GroupAdapter}: the renderer draws the children (keyed, in
 * their wrappers) and hands them in; the adapter says where they go.
 *
 * - The generic group (`fieldset`, `container`): a fieldset named by its
 *   legend and described by its hint when the author gave it a name, else no element of its own
 *   (the children stack against the form's grid), unless the author gave it classes or a layout.
 * - `panel`: a card with a heading, a region named by it.
 * - `grid` (the layout container): one cell per column slot, equal columns that wrap on a narrow
 *   form, or authored spans of a twelve-track row.
 * - `step` outside a steps container: a section headed by its label.
 * - `button-group`: a wrapping row of buttons, or a list of them.
 * - `form` (the root) and `tab` (a tab's own container): no group, the children alone. The
 *   root's label names the `<form>` element (`formLabelled`), a tab's is its tab's.
 *
 * A layout's numbers (columns, spans) are set as custom properties through the CSSOM, never as a
 * `style` attribute; {@link DATUM_CONTAINER_CSS} holds the rules that read them.
 */
import type { GroupAdapter, GroupState } from "../contract.js";
import { html, ifDefined, nothing, ref, type TemplateResult } from "../lit.js";
import { lastLookOnly } from "../look-classes.js";
import { classes, heading, legendMarkView, resolveContainerControls, styleProperty, type DatumContainerControls, type DatumContainerParts } from "./container-kit.js";

export interface DatumGroupOptions {
  controls?: Partial<DatumContainerControls> | undefined;
  /** The host's part templates: the legend's mark (`labelMarks`). */
  parts?: Pick<DatumContainerParts, "labelMarks"> | undefined;
}

/** The rules the group containers' layouts need; the Datum stylesheet adopts them with its own. */
export const DATUM_CONTAINER_CSS = `
  .datum-form__layout--grid { display: grid; gap: var(--spacing-field-gap, 12px); grid-template-columns: repeat(var(--datum-columns, 2), minmax(0, 1fr)); }
  .datum-form__layout--grid[data-fit="auto"] { grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--layout-grid-column-min, 220px)), 1fr)); }
  .datum-form__layout--grid[data-column-widths] { grid-template-columns: repeat(12, minmax(0, 1fr)); }
`;

/** The id of a container's legend or heading, unique per instance (a container in a data grid's row has its own). */
export const groupLabelId = (state: Pick<GroupState, "key">): string => `${state.key}__group-label`;

/** The legend and the description under it, when the container has a name. */
function legendAndHint(s: GroupState, parts: DatumGroupOptions["parts"]): TemplateResult {
  return html`<legend id=${groupLabelId(s)} class=${classes("datum-form__group-label", s.hideLegend && "datum-form__visually-hidden")}>${s.legend}${legendMarkView(s, parts)}</legend>${
    s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="datum-form__group-description">${s.hint}</p>` : nothing
  }`;
}

/** The labelled group a container with a legend is drawn inside: a fieldset named by its legend and described by its hint. */
function labelled(s: GroupState, describe: boolean, inner: TemplateResult, parts: DatumGroupOptions["parts"]): TemplateResult {
  return html`<fieldset class="datum-form__group" aria-labelledby=${groupLabelId(s)} aria-describedby=${describe && s.hint !== undefined ? ifDefined(s.hintId) : nothing}>${legendAndHint(s, parts)}${inner}</fieldset>`;
}

// ── The generic group ──────────────────────────────────────────────────────────────────────

export function createDatumGroupAdapter(options: DatumGroupOptions = {}): GroupAdapter {
  const controls = resolveContainerControls(options.controls);
  return {
    kind: "group",
    name: "datum-group",
    capabilities: { hideLabel: "drawn" },
    template(s: GroupState, children: TemplateResult): TemplateResult {
      // A stack is organisational: no element, so its children stack against the form's own grid.
      // One the author gave classes to gets an element, a class with nothing to land on is not a class.
      const bare = s.layout.kind === "stack" && s.classNames.length === 0;
      const columns = s.layout.kind === "grid" ? s.layout.columns : undefined;
      const box = bare
        ? children
        : html`<div class=${classes("datum-form__layout", `datum-form__layout--${s.layout.kind}`, ...s.classNames)} ${ref(styleProperty("--datum-columns", columns))}>${children}</div>`;
      return s.legend !== undefined ? labelled(s, controls.groupDescription !== "none", box, options.parts) : box;
    }
  };
}

// ── The form root and a tab's own container ────────────────────────────────────────────────

/**
 * The form root (`form`) and a `tab` container in a tabs slot: neither is a group of its own.
 * The form is the `<form>` the renderer draws; one fieldset around every question, named by the
 * form's label, would have a screen reader say that name again with each field. A tab's panel is
 * already a region named by its tab, so a fieldset inside it would name the same content twice.
 * Their children stack against the form's grid, in a layout box only where the author gave a
 * layout or classes (as the generic group does without a legend), and the label is not drawn
 * here: the renderer names the `<form>` by the root's (`formLabelled`), a tab is named by its tab.
 */
export function createDatumUngroupedAdapter(name: string): GroupAdapter {
  return {
    kind: "group",
    name,
    // A hidden label is honoured: no label is drawn at all. The form root's name is the `<form>`'s
    // own (`aria-label`, set by the renderer); a tab's name is its tab's.
    capabilities: { hideLabel: "drawn" },
    formLabelled: true,
    template(s: GroupState, children: TemplateResult): TemplateResult {
      const bare = s.layout.kind === "stack" && s.classNames.length === 0;
      const columns = s.layout.kind === "grid" ? s.layout.columns : undefined;
      return bare
        ? children
        : html`<div class=${classes("datum-form__layout", `datum-form__layout--${s.layout.kind}`, ...s.classNames)} ${ref(styleProperty("--datum-columns", columns))}>${children}</div>`;
    }
  };
}

// ── Panel ──────────────────────────────────────────────────────────────────────────────────

export function createDatumPanelAdapter(options: DatumGroupOptions = {}): GroupAdapter {
  const controls = resolveContainerControls(options.controls);
  return {
    kind: "group",
    name: "datum-panel",
    capabilities: { hideLabel: "drawn" },
    template(s: GroupState, children: TemplateResult): TemplateResult {
      const hasLegend = s.legend !== undefined;
      // Labelled by its heading the section is a region, unless the design system draws a panel as a plain card.
      const named = hasLegend && controls.panelRegion !== "none";
      // The description stays in sight when the heading is hidden: hiding the label hides the label only.
      const description = s.hint !== undefined ? html`<p id=${ifDefined(s.hintId)} class="datum-form__group-description">${s.hint}</p>` : nothing;
      const visibleHeader = hasLegend && !s.hideLegend;
      const title = hasLegend ? heading(s.level + 1, { id: groupLabelId(s), className: "datum-form__panel-title" }, html`${s.legend}${legendMarkView(s, options.parts)}`) : nothing;
      const header = visibleHeader
        ? html`<div class="datum-form__panel-header">${title}${description}</div>`
        : html`${hasLegend ? html`<div class="datum-form__panel-header datum-form__visually-hidden">${title}</div>` : nothing}${description}`;
      // The panel is described by its description, as a named group is.
      const described = s.hint !== undefined && s.hintId !== undefined && controls.groupDescription !== "none";
      return html`<section class=${classes("datum-form__panel", ...lastLookOnly(s.classNames))} aria-labelledby=${named ? groupLabelId(s) : nothing} aria-describedby=${described ? s.hintId : nothing}>${header}<div class="datum-form__panel-body">${children}</div></section>`;
    }
  };
}

// ── Layout grid ────────────────────────────────────────────────────────────────────────────

export function createDatumLayoutGridAdapter(options: DatumGroupOptions = {}): GroupAdapter {
  const controls = resolveContainerControls(options.controls);
  return {
    kind: "group",
    name: "datum-layout-grid",
    capabilities: { hideLabel: "drawn" },
    template(s: GroupState): TemplateResult {
      const spans = s.spans;
      const cells = s.slots.map(
        (slot, index) => html`<div class="datum-form__grid-column" data-grid-column=${slot.slotId} ${ref(styleProperty("--datum-grid-span", spans?.[index]))}>${slot.content}</div>`
      );
      // The legend stands outside the grid, as a group label: inside, it would be a cell.
      const grid = html`<div
        class=${classes("datum-form__layout", "datum-form__layout--grid", ...s.classNames)}
        data-columns=${ifDefined(s.layout.columns)}
        data-column-widths=${ifDefined(spans !== undefined ? spans.join(",") : undefined)}
        data-fit=${spans === undefined ? "auto" : nothing}
      >${cells}</div>`;
      return s.legend !== undefined ? labelled(s, controls.groupDescription !== "none", grid, options.parts) : grid;
    }
  };
}

// ── A step outside a steps container ───────────────────────────────────────────────────────

export function createDatumStepAdapter(options: DatumGroupOptions = {}): GroupAdapter {
  const controls = resolveContainerControls(options.controls);
  const named = controls.stepPages !== "plain" && controls.panelRegion !== "none" && controls.stepRegion !== "none";
  return {
    kind: "group",
    name: "datum-step",
    capabilities: { hideLabel: "drawn" },
    template(s: GroupState, children: TemplateResult): TemplateResult {
      // The fold gives a step with no name its id as the legend, so it is always headed.
      return html`<section class=${classes("datum-form__step-panel", ...s.classNames)} data-step-panel=${s.id} aria-labelledby=${named ? groupLabelId(s) : nothing}>${heading(
        s.level + 1,
        { id: groupLabelId(s), className: classes("datum-form__step-heading", s.hideLegend && "datum-form__visually-hidden"), focusable: true },
        s.legend ?? s.id
      )}<div class="datum-form__step-body">${children}</div></section>`;
    }
  };
}

// ── Button group ───────────────────────────────────────────────────────────────────────────

export function createDatumButtonGroupAdapter(options: DatumGroupOptions = {}): GroupAdapter {
  const controls = resolveContainerControls(options.controls);
  return {
    kind: "group",
    name: "datum-button-group",
    capabilities: {},
    template(s: GroupState): TemplateResult {
      const className = classes("datum-form__button-group", ...s.classNames);
      // A list draws one item per button; a button that drew nothing (hidden) has no item.
      return controls.buttonGroup === "list"
        ? html`<ul class=${className}>${s.eachItem((item) => html`<li class="datum-form__button-group-item">${item.content}</li>`)}</ul>`
        : html`<div class=${className}>${s.eachItem((item) => item.content)}</div>`;
    }
  };
}
