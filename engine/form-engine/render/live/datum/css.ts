/**
 * The Datum binding's stylesheet, adopted by the renderer as the binding's `css` (and, inside a
 * design-system binding, as the rules for the fields Datum draws in its place).
 *
 * Datum's adapters draw `datum-form__*` classes on the `datum-form` form element the binding's
 * `formClass` names; every value is a token read with an engine literal as its fallback
 * (`tokens.ts` is the manifest, held to this sheet by an engine test), so a host restyles the
 * form by setting tokens, never by overriding rules. The tokens themselves are set by
 * {@link datumCss}: the light set on `.datum-form`, the dark set on `.datum-form--dark`.
 *
 * The renderer owns the state a field is in and writes it on the field's wrapper as data
 * attributes (`data-invalid`, `data-readonly`, `data-over-limit` ...), and the mode and busy state on
 * the form (`data-mode`, `aria-busy`); the rules read those, not modifier classes. Frames come
 * from the form element's own class (`datum-form--frame-<id>`, the chrome feature's decor).
 *
 * The sheet is one string with no backticks and no interpolation, so it can be adopted as text.
 */
import { DATUM_CHOICE_CSS, DATUM_DARK_CSS, DATUM_DARK_TOKENS, DATUM_TOKENS } from "./default-tokens.js";
import type { DatumTokens } from "./tokens.js";
import { buildThemeStyleVars, responsiveTokensCss, themeStyleVarsToCssText } from "../../core/token-style-vars.js";

export const DATUM_STYLES = `

  :host { display: block; }
  * { box-sizing: border-box; }
  /*
   * The form states its own typography rather than inheriting it.
   *
   * Isolation is not only about keeping the form's CSS in (which the shadow root
   * handles) — it is equally about keeping the host's out. font-family, font-size,
   * line-height and color all inherit through a shadow boundary, so a form rendered
   * inside a styled host silently took that host's typography: the builder canvas showed the
   * builder theme's own font on the previewed form, which made the preview a lie about what the
   * live form would look like. Every inherited property that affects appearance is therefore
   * set here, from the binding's own tokens, with the engine default as the fallback.
   *
   * The form also owns its surface and its colour scheme. --color-surface is the
   * page the form expects to sit on: transparent by default, so a form with no tokens set takes the
   * host's page as it always has, while a dark set paints its own and the builder's sheet
   * follows it. --color-scheme (light | dark) becomes the CSS color-scheme, so the native parts
   * a stylesheet cannot reach — date pickers, select popups, scrollbars — follow the scheme too.
   */
  .datum-form {
    display: grid;
    gap: var(--spacing-field-gap, 12px);
    font-family: var(--font-family, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
    font-size: var(--font-size, 14px);
    line-height: var(--line-height, 1.45);
    color: var(--color-text, #14212b);
    background: var(--color-surface, transparent);
    color-scheme: var(--color-scheme, normal);
    text-align: start;
    font-weight: 400;
    font-style: normal;
    letter-spacing: normal;
    /*
     * The root is a size container named datum-form, so a binding's css can follow the width
     * the form actually has rather than the viewport's (gcds-error-summary tightens its
     * padding under 24em of its own width). A block-level root takes its inline size from its
     * parent, so inline-size containment changes nothing about how the form is laid out.
     */
    container: datum-form / inline-size;
  }
  /*
   * The frame around the form by preset: outlined is a bordered panel on the
   * form's surface, paper a sheet with its own fill hovering over the page; seamless (the
   * default) adds nothing and gets no class. Every value is a frame token with the binding's
   * general token, then the engine's literal, as its fallback: a binding restyles a built-in
   * through the tokens, or draws it (and frames of its own) through .datum-form--frame-<id>
   * rules in its css.
   */
  .datum-form--frame-outlined, .datum-form--frame-paper {
    padding: var(--spacing-frame-padding, 24px);
    border: 1px solid var(--color-frame-border, var(--color-border, #a9bbcb));
    border-radius: var(--radius-frame, 10px);
  }
  .datum-form--frame-paper {
    background: var(--color-frame-surface, var(--color-surface, #fff));
    box-shadow: var(--shadow-frame, 0 1px 2px rgba(13, 36, 53, .06), 0 8px 24px rgba(13, 36, 53, .07));
  }
  /*
   * The fields column may be capped (each field, and each box a container draws, directly in
   * the form): every government design system limits a form's line length (USWDS 30rem, Ontario 48rem, Québec 825px); a binding sets it here rather than
   * fighting the host's layout in css. None by default: the form is as wide as its host.
   */
  .datum-form > .datum-live-field,
  .datum-form > .datum-live-container > *,
  .datum-form > .datum-form__journey-actions { max-width: var(--layout-max-width, none); min-width: 0; }
  .datum-form__field { display: grid; gap: var(--spacing-field-inner-gap, 4px); min-width: 0; }
  /*
   * Form controls do not inherit font by default; without this they fall to the UA's. The
   * reset is written with :where() so it adds no specificity beyond the root class: a binding's
   * bare class rule (.datum-form__button--lg { font-size }) then outranks it by cascade order
   * alone, instead of every binding having to scope such a rule under .datum-form to win.
   */
  .datum-form :where(input, select, textarea, button) { font-family: inherit; font-size: inherit; line-height: inherit; }
  /*
   * Every value-bearing control carries datum-form__control and its kind (--text, --number,
   * --date, --select, --textarea; --checkbox, --radio, --file). The engine's rules and every
   * binding's address controls through these, and a host-registered type puts the same classes
   * on its own control to take the binding's box.
   */
  .datum-form__control--text,
  .datum-form__control--number,
  .datum-form__control--date,
  .datum-form__control--select,
  .datum-form__control--textarea {
    /*
     * The input border defaults to 3:1 against the control's own background (WCAG 1.4.11's
     * non-text minimum), a step darker than the panel outlines around it. A binding sets
     * --color-border for both, or --color-input-border to treat inputs on their own, and
     * --color-input-bg for the control itself — a dark set's input is a raised dark, not white.
     */
    border: var(--control-border-width, 1px) solid var(--color-input-border, var(--color-border, #7e95ab));
    border-radius: var(--radius-control, 8px);
    padding: var(--control-padding, 7px 9px);
    min-height: var(--control-min-height, auto);
    max-width: var(--control-max-width, none);
    color: inherit;
    background: var(--color-input-bg, #fff);
  }
  .datum-form__control--textarea { resize: vertical; min-height: var(--textarea-min-height, 72px); }
  /*
   * A box between its prefix and suffix: one row, the affixes drawn as the box's
   * own edges — same border, the light fill, the muted text — and the corners between them
   * squared so the three read as one control. The box takes the rest of the row.
   */
  .datum-form__control-group { display: flex; align-items: stretch; max-width: var(--control-max-width, none); }
  .datum-form__control-group > .datum-form__control { flex: 1 1 auto; min-width: 0; max-width: none; }
  .datum-form__affix {
    display: inline-flex; align-items: center; flex: 0 0 auto; white-space: nowrap;
    padding: var(--control-padding, 7px 9px);
    border: var(--control-border-width, 1px) solid var(--color-input-border, var(--color-border, #7e95ab));
    border-radius: var(--radius-control, 8px);
    background: var(--color-light, #eef3f8);
    color: var(--color-muted, #536b7f);
    font-size: var(--font-size, 14px);
  }
  /* The shared edges and inner corners, over a binding's own affix and box rules (a border shorthand, a typed box selector). */
  .datum-form__control-group > .datum-form__affix--prefix { border-right: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .datum-form__control-group > .datum-form__affix--suffix { border-left: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .datum-form__control-group > .datum-form__affix--prefix + .datum-form__control { border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .datum-form__control-group > .datum-form__control:has(+ .datum-form__affix--suffix) { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .datum-form__control-group > .datum-form__control:focus-visible { position: relative; z-index: 1; }
  /*
   * An invalid box says so in its line, not in its message alone (WCAG 1.4.1: the error colour
   * is the second cue beside the text). The state is on the control (aria-invalid, which
   * ariaStates "required" and "none" never write) and always on the renderer's wrapper
   * (data-invalid), so either draws it; written at one class of specificity, after the kind rules
   * and before a binding's css, so a design system's own invalid border outranks it by order and
   * one that draws none gets this. Boxed kinds only: a choice keeps its mark.
   */
  .datum-form__control--text:where([aria-invalid="true"]),
  .datum-form__control--number:where([aria-invalid="true"]),
  .datum-form__control--date:where([aria-invalid="true"]),
  .datum-form__control--select:where([aria-invalid="true"]),
  .datum-form__control--textarea:where([aria-invalid="true"]),
  :where([data-invalid]) .datum-form__control--text,
  :where([data-invalid]) .datum-form__control--number,
  :where([data-invalid]) .datum-form__control--date,
  :where([data-invalid]) .datum-form__control--select,
  :where([data-invalid]) .datum-form__control--textarea,
  :where([data-invalid]) .datum-form__affix { border-color: var(--color-error, #c53a3a); }
  /*
   * A disabled box does not look like a live one: the sunken fill (--color-disabled-bg, the
   * light fill unless a binding says otherwise), the panel line, the muted ink and the not-allowed
   * cursor. WebKit paints a disabled control's text through -webkit-text-fill-color. Not in
   * read-only mode, where the answers are the point of the page (the rule above keeps them at
   * full contrast), and at the same one-class specificity as the invalid rule, so a binding that
   * draws its own disabled state keeps it.
   */
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control--text:where(:disabled),
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control--number:where(:disabled),
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control--date:where(:disabled),
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control--select:where(:disabled),
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control--textarea:where(:disabled) {
    background: var(--color-disabled-bg, var(--color-light, #eef3f8));
    border-color: var(--color-border, #a9bbcb);
    color: var(--color-muted, #536b7f);
    -webkit-text-fill-color: currentColor;
  }
  :where(.datum-form:not([data-mode="readonly"])) .datum-form__control:where(:disabled) { cursor: not-allowed; }
  /*
   * A read-only textarea is displaying an answer, not collecting one, so it shows all of it:
   * no scrollbar, no resize grip, and no minimum height holding open space a short answer does
   * not need. Scoped past the rule above, which would otherwise keep the 72px floor.
   *
   * The height itself is measured and set by the renderer (sizeReadOnlyTextareas), with the
   * rows attribute — the value's own line count — as the floor wherever no script runs.
   *
   * Deliberately *not* field-sizing: content. It looks like the CSS-native answer, but the
   * rows attribute becomes a maximum under it, so the box stops at the authored row count and
   * clips the rest — and because it also caps what the element reports while measuring, it
   * silently defeats the measurement too.
   */
  .datum-form .datum-form__control--textarea[readonly] {
    resize: none;
    overflow: hidden;
    min-height: 0;
  }
  /*
   * In read-only mode the live renderer draws every control read-only, never disabled
   * (text boxes readonly, choices refused and aria-readonly), so they keep focus and full contrast
   * as drawn. A control a rule disables in that mode is a UA "not available" cue,
   * greyed with a washed-out fill; a review's answers are the point of the page, so it too stays
   * at full contrast, in the binding's own ink on the binding's own input background. WebKit paints
   * a disabled control's text through -webkit-text-fill-color and, on iOS, fades the whole
   * control, so both are reset too.
   */
  .datum-form[data-mode="readonly"] .datum-form__control--text:disabled,
  .datum-form[data-mode="readonly"] .datum-form__control--number:disabled,
  .datum-form[data-mode="readonly"] .datum-form__control--date:disabled,
  .datum-form[data-mode="readonly"] .datum-form__control--select:disabled,
  .datum-form[data-mode="readonly"] .datum-form__control--textarea:disabled {
    color: inherit;
    -webkit-text-fill-color: currentColor;
    opacity: 1;
    cursor: default;
  }
  /*
   * A field is a grid, so a checkbox would otherwise stretch across the whole column. Aligned
   * with start rather than left because the form's dir follows the locale: this reads as
   * left-hand in LTR and flips with the rest of the form in RTL.
   */
  .datum-form__field > .datum-form__control--checkbox { justify-self: start; accent-color: var(--color-choice-mark, var(--color-accent, auto)); }
  /* A fieldset in the browser default sense, not the visual one: the group draws no box. */
  .datum-form__radio-group,
  .datum-form__checkbox-group { border: 0; margin: 0; padding: 0; display: grid; gap: var(--spacing-option-gap, 6px); }
  .datum-form__radio-group legend,
  .datum-form__checkbox-group legend { padding: 0; }
  /*
   * The date-parts fieldset draws no box either, and a fieldset's UA min-width
   * would keep it from shrinking inside a grid column; the legend is the field's label.
   */
  .datum-form__date-group { border: 0; margin: 0; padding: 0; min-width: 0; }
  .datum-form__date-group legend { padding: 0; }
  /*
   * The parts sit side by side with a gap, each its word over its own box, sized by the box's
   * size attribute; a row too narrow for the three (a phone, a data grid's cell) wraps them.
   */
  .datum-form__date-parts { display: flex; flex-wrap: wrap; align-items: end; gap: var(--spacing-field-gap, 12px); }
  .datum-form__date-part { display: grid; gap: var(--spacing-field-inner-gap, 4px); max-width: 100%; min-width: 0; }
  .datum-form__date-part select { max-width: 100%; }
  /*
   * A lone checkbox is an option on its own: its box at the start of the label's line, the label,
   * hint and error in a column beside it, as a checkbox in a group is drawn. The box takes the
   * first row of the first column; every other part flows down the second.
   */
  .datum-form__field--checkbox { grid-template-columns: auto minmax(0, 1fr); column-gap: var(--spacing-option-row-gap, 8px); align-items: center; }
  .datum-form__field--checkbox > * { grid-column: 2; }
  .datum-form__field--checkbox > .datum-form__control--checkbox { grid-column: 1; grid-row: 1; margin: 0; }
  /* WCAG 2.5.8: a choice row is at least 24 px tall, so its label and box are a real target. */
  .datum-form__radio-option,
  .datum-form__checkbox-option { min-height: var(--target-min-size, 24px); }
  .datum-form__radio-option,
  .datum-form__checkbox-option { display: flex; gap: var(--spacing-option-row-gap, 8px); align-items: center; }
  /* An option with a hint stacks its label and hint beside the box, the box on the label's line. */
  .datum-form__radio-option:has(.datum-form__option-hint),
  .datum-form__checkbox-option:has(.datum-form__option-hint) { align-items: start; }
  .datum-form__option-text { display: grid; gap: var(--spacing-option-text-gap, 2px); }
  .datum-form__option-hint { font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  /* The tick and the dot take the binding's accent; a form with no tokens set keeps the UA's. */
  .datum-form__radio-option .datum-form__control--radio,
  .datum-form__checkbox-option .datum-form__control--checkbox { margin: 0; accent-color: var(--color-choice-mark, var(--color-accent, auto)); }
  /*
   * Drawn choice marks, select chevron and error icon: opt-in
   * through DatumControls, each a root class these rules hang off. The box is drawn from the
   * control tokens and the glyph is a mask over a token-coloured fill — an icon token carries
   * the SVG and the colour comes from the palette (a data-URI background image could not read
   * a token). A host with a glyph of its own sets the icon token to its SVG (svgDataUri). Under forced colours the native controls
   * return and the masks go, since a mask's fill is what forced colours replace.
   */
  .datum-form--choice-marks-drawn .datum-form__control--checkbox,
  .datum-form--choice-marks-drawn .datum-form__control--radio {
    appearance: none; display: inline-grid; place-items: center; flex: none;
    width: var(--size-choice, 16px); height: var(--size-choice, 16px);
    border: var(--width-choice-border, var(--control-border-width, 1px)) solid var(--color-input-border, var(--color-border, #7e95ab));
    background: var(--color-input-bg, #fff); cursor: pointer;
  }
  .datum-form--choice-marks-drawn .datum-form__control--checkbox { border-radius: var(--radius-choice, 4px); }
  .datum-form--choice-marks-drawn .datum-form__control--radio { border-radius: 50%; }
  .datum-form--choice-marks-drawn .datum-form__control--checkbox::before,
  .datum-form--choice-marks-drawn .datum-form__control--radio::before {
    content: ""; width: 100%; height: 100%; transform: scale(0);
    background-color: var(--color-choice-mark, var(--color-accent, #2f6feb));
    -webkit-mask: var(--icon-check, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M2.5%208.5l3.5%203.5%207.5-8%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
    mask: var(--icon-check, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M2.5%208.5l3.5%203.5%207.5-8%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
  }
  .datum-form--choice-marks-drawn .datum-form__control--radio::before {
    -webkit-mask: var(--icon-radio, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%224%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
    mask: var(--icon-radio, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%224%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
  }
  .datum-form--choice-marks-drawn .datum-form__control--checkbox:checked::before,
  .datum-form--choice-marks-drawn .datum-form__control--radio:checked::before { transform: scale(1); }
  .datum-form--choice-marks-drawn .datum-form__control--checkbox:disabled,
  .datum-form--choice-marks-drawn .datum-form__control--radio:disabled { opacity: var(--opacity-button-disabled, .5); cursor: not-allowed; }
  .datum-form__select-face { position: relative; display: grid; }
  .datum-form__select-face > .datum-form__control--select {
    appearance: none;
    padding-inline-end: calc(var(--spacing-chevron-inset, 9px) * 2 + var(--size-chevron, 12px));
  }
  .datum-form__select-face::after {
    content: ""; position: absolute; top: 50%; inset-inline-end: var(--spacing-chevron-inset, 9px);
    width: var(--size-chevron, 12px); height: var(--size-chevron, 12px); transform: translateY(-50%);
    background-color: currentColor; pointer-events: none;
    -webkit-mask: var(--icon-chevron, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M3%206l5%205%205-5%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
    mask: var(--icon-chevron, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20d%3D%22M3%206l5%205%205-5%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
  }
  .datum-form--error-icon-drawn .datum-form__error::before {
    content: ""; display: inline-block; vertical-align: middle;
    width: var(--size-error-icon, 1em); height: var(--size-error-icon, 1em); margin-inline-end: var(--spacing-error-icon-gap, .35em);
    background-color: currentColor;
    -webkit-mask: var(--icon-error, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%226.5%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M8%204.5v4.5%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%228%22%20cy%3D%2211.75%22%20r%3D%221.1%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
    mask: var(--icon-error, url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%3E%3Ccircle%20cx%3D%228%22%20cy%3D%228%22%20r%3D%226.5%22%20fill%3D%22none%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%2F%3E%3Cpath%20d%3D%22M8%204.5v4.5%22%20stroke%3D%22%23000%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%2F%3E%3Ccircle%20cx%3D%228%22%20cy%3D%2211.75%22%20r%3D%221.1%22%2F%3E%3C%2Fsvg%3E")) center / contain no-repeat;
  }
  @media (forced-colors: active) {
    .datum-form--choice-marks-drawn .datum-form__control--checkbox,
    .datum-form--choice-marks-drawn .datum-form__control--radio,
    .datum-form__select-face > .datum-form__control--select { appearance: auto; }
    .datum-form--choice-marks-drawn .datum-form__control--checkbox::before,
    .datum-form--choice-marks-drawn .datum-form__control--radio::before,
    .datum-form__select-face::after { display: none; }
    .datum-form--error-icon-drawn .datum-form__error::before { forced-color-adjust: none; background-color: CanvasText; }
  }
  /* A file picker sized to its own button, not stretched across the field's grid column. */
  .datum-form__file .datum-form__control--file { justify-self: start; max-width: 100%; min-width: 0; }
  /*
   * The browser's picker drawn in the form's look: its button an outlined button in the accent
   * (the file rows' Remove is the quieter one), the "No file chosen" line in the form's own type.
   */
  .datum-form__control--file { font: inherit; color: inherit; border-radius: var(--radius-button, 8px); }
  .datum-form__control--file::file-selector-button {
    font: inherit; color: var(--color-accent, #2f6feb); background: var(--color-input-bg, #fff);
    border: var(--width-button-border, 1px) solid var(--color-accent, #2f6feb); border-radius: var(--radius-button, 8px);
    padding: var(--button-padding-sm, 4px 10px); margin-inline-end: var(--spacing-file-item-gap, 8px); cursor: pointer;
  }
  .datum-form__control--file:where(:hover:not(:disabled))::file-selector-button { filter: var(--button-hover-filter, none); }
  .datum-form__control--file:disabled { cursor: not-allowed; }
  .datum-form__control--file:disabled::file-selector-button { opacity: var(--opacity-button-disabled, .5); cursor: not-allowed; }
  /*
   * An image is a block that never overflows the form; the frame a missing picture draws (where
   * the builder's author selects it to give a URL) is a dashed panel holding its caption.
   */
  .datum-form__image { margin: 0; }
  .datum-form__image img { display: block; max-width: 100%; height: auto; }
  .datum-form__image--empty {
    display: grid; place-items: center; min-height: 6rem; padding: var(--padding-panel-body, 12px);
    border: var(--width-panel-border, 1px) dashed var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px);
    color: var(--color-muted, #536b7f); font-size: var(--font-size-hint, 12px);
  }
  .datum-form__file-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--spacing-file-list-gap, 4px); }
  .datum-form__file-item { display: flex; align-items: center; gap: var(--spacing-file-item-gap, 8px); flex-wrap: wrap; font-size: var(--font-size-file-item, 13px); }
  /* The name is a download when the bytes are embedded — it reads as the link it is. */
  .datum-form__file-name:where(button) {
    font: inherit; background: none; border: 0; padding: 0; text-align: start;
    color: var(--color-accent, #2f6feb); text-decoration: underline; cursor: pointer;
  }
  .datum-form__file-size, .datum-form__file-empty { font-size: var(--font-size-file-meta, 12px); color: var(--color-muted, #536b7f); }
  .datum-form__file-remove {
    font: inherit; font-size: var(--font-size-file-remove, 12px); color: inherit; background: none;
    border: var(--width-file-remove-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-file-remove, 6px); padding: var(--padding-file-remove, 2px 8px); cursor: pointer;
  }
  /*
   * A labelled container is a <fieldset> its legend names (gcds-fieldset, GOV.UK's and USWDS's
   * fieldset), in the browser default sense, not the visual one: the UA box, inline margin and
   * min-width go. The legend floats: an out-of-flow legend is not the fieldset's rendered
   * legend (HTML §15.3.13), so it lays out as an ordinary grid item the gap spaces, where a
   * rendered legend sits outside the grid and loses it — and a grid item ignores its float.
   */
  .datum-form__group { display: grid; gap: var(--spacing-group-gap, 6px); border: 0; margin: 0; padding: 0; min-width: 0; }
  .datum-form__group > .datum-form__group-label { float: left; padding: 0; }
  /*
   * Headings — the form's title, a group's legend, a panel's title, the chrome heading and a
   * notice's title — take the binding's heading face (--font-family-heading, the body face
   * unless set) at their own size tokens; a design system with a serif heading face or a
   * legend scale of its own sets those rather than restating every heading rule.
   */
  .datum-form__group-label { margin: 0; justify-self: var(--field-part-justify, auto); font-family: var(--font-family-heading, inherit); font-weight: var(--font-weight-heading, 600); font-size: var(--font-size-group-label, 15px); line-height: inherit; }
  /* A group's description reads as a hint under its heading; the grid's gap spaces it. */
  .datum-form__group-description { margin: 0; max-width: var(--text-max-width, none); font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  /* The form's own heading (FormBodyOptions.title); the grid's gap spaces it from the fields. */
  .datum-form__title { margin: 0; font-family: var(--font-family-heading, inherit); font-size: var(--font-size-title, 20px); font-weight: var(--font-weight-heading, 600); line-height: var(--line-height-title, 1.25); }
  /*
   * Chrome (FormBodyOptions.chrome): rows of the form's own grid above and
   * below the fields, so the binding's gap token spaces them like everything else. Each region
   * is a stack of rows, one per part; a row places its part by the part's align — a language
   * switcher at the end of its row (the top-right corner in LTR, and with the rest of an RTL
   * form the top-left), which is where one is looked for; content at the start. A group puts
   * several parts on one row, wrapping when the row is too narrow.
   */
  .datum-form__header, .datum-form__footer { display: grid; gap: var(--spacing-chrome-gap, 8px); }
  .datum-form__chrome-row { display: grid; }
  .datum-form__chrome-row--start { justify-items: start; }
  .datum-form__chrome-row--center { justify-items: center; }
  .datum-form__chrome-row--end { justify-items: end; }
  .datum-form__chrome-row--start > *, .datum-form__chrome-row--center > *, .datum-form__chrome-row--end > * { max-width: 100%; }
  .datum-form__chrome-row > .datum-form__chrome-group,
  .datum-form__chrome-row > .datum-form__chrome-html,
  .datum-form__chrome-row > .datum-form__chrome-text,
  .datum-form__chrome-row > .datum-form__chrome-description { justify-self: stretch; }
  .datum-form__chrome-group { display: flex; flex-wrap: wrap; gap: var(--spacing-chrome-group-gap, 8px 16px); }
  .datum-form__chrome-group--start { justify-content: flex-start; }
  .datum-form__chrome-group--center { justify-content: center; }
  .datum-form__chrome-group--end { justify-content: flex-end; }
  .datum-form__chrome-group--space-between { justify-content: space-between; }
  .datum-form__chrome-group--valign-start { align-items: flex-start; }
  .datum-form__chrome-group--valign-center { align-items: center; }
  .datum-form__chrome-group--valign-end { align-items: flex-end; }
  .datum-form__chrome-image { margin: 0; }
  .datum-form__chrome-image img { display: block; max-width: 100%; height: auto; }
  .datum-form__chrome-heading { margin: 0; font-family: var(--font-family-heading, inherit); font-size: var(--font-size-heading, 17px); font-weight: var(--font-weight-heading, 600); line-height: var(--line-height-heading, 1.3); }
  .datum-form__chrome-text { margin: 0; font-size: var(--font-size-chrome-text, 14px); line-height: var(--line-height-chrome-text, 1.5); }
  .datum-form__chrome-description { margin: 0; font-size: var(--font-size-chrome-text, 14px); line-height: var(--line-height-chrome-text, 1.5); color: var(--color-muted, #536b7f); }
  .datum-form__language-switcher { display: inline-flex; align-items: center; gap: var(--spacing-language-switcher-gap, 6px); }
  .datum-form__language-switcher-label { font-weight: var(--font-weight-language-switcher, 600); font-size: var(--font-size-language-switcher, 13px); }
  .datum-form__language-switcher-select {
    border: var(--control-border-width, 1px) solid var(--color-input-border, var(--color-border, #7e95ab)); border-radius: var(--radius-control, 8px); padding: var(--padding-language-switcher, 5px 8px);
    color: inherit; background: var(--color-input-bg, #fff); cursor: pointer;
  }
  /* Hidden from sight, still announced — see containerLabelHtml. */
  .datum-form__visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }
  /*
   * A field is a grid, so its text parts — label, hint, error, count, a group's legend, the
   * required note — stretch to the column unless the binding says otherwise (auto is the grid's
   * own value, so a form with no tokens set lays its parts out as a plain grid does); a design
   * system whose label is as wide as its words (GC Design System, USWDS) sets
   * --field-part-justify to start once, instead of a rule per part (datum/tokens.ts).
   */
  .datum-form__label { justify-self: var(--field-part-justify, auto); font-weight: var(--font-weight-label, 600); font-size: var(--font-size-label, 14px); }
  /*
   * The optional marker after a label ("(optional)") and the note above the fields that
   * explains the required marker: both worded by the binding or the page (FormTextCatalog),
   * neither drawn unless worded, both read as secondary text.
   */
  .datum-form__optional { font-weight: 400; color: var(--color-muted, #536b7f); }
  .datum-form__required-note { margin: 0; justify-self: var(--field-part-justify, auto); font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  /*
   * The help mark and its bubble. The bubble is anchored to the mark's left edge, so it never
   * runs off the start of a form whose labels sit at the left margin, and it opens downward:
   * upward would put it under whatever a host floats over the top of the form — an app bar,
   * a toolbar — for exactly the first field a person tries it on. Downward it covers only the
   * field's own description and control, and only while the pointer rests on the mark.
   */
  .datum-form__tooltip, [data-tooltip] { position: relative; display: inline-block; vertical-align: text-top; }
  .datum-form__tooltip-mark, [data-tooltip-mark] {
    display: inline-grid; place-items: center;
    width: var(--size-tooltip-mark, 15px); height: var(--size-tooltip-mark, 15px); border-radius: 50%;
    border: 1px solid currentColor; opacity: .55;
    font-size: 10px; font-weight: 700; line-height: 1; cursor: help;
  }
  .datum-form__tooltip-text, [data-tooltip-text] {
    position: absolute; left: -4px; top: calc(100% + 7px); z-index: 3;
    width: max-content; max-width: min(280px, 70vw);
    padding: var(--padding-tooltip, 6px 9px); border-radius: var(--radius-tooltip, 6px);
    background: var(--color-dark, #1f2933); color: var(--color-on-dark, #fff);
    font-size: var(--font-size-tooltip, 12px); font-weight: 400; line-height: 1.35; text-align: start; white-space: normal;
    box-shadow: var(--shadow-tooltip, 0 4px 12px rgba(13, 36, 53, .2));
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .12s ease, visibility .12s;
  }
  .datum-form__tooltip-text::after, [data-tooltip-text]::after {
    content: ""; position: absolute; bottom: 100%; left: 9px;
    border: 5px solid transparent; border-bottom-color: var(--color-dark, #1f2933);
  }
  /*
   * Shown while the mark is hovered or holds focus (WCAG 1.4.13), until Escape dismisses it
   * (the renderer sets data-dismissed); the bubble takes the pointer while shown, so a
   * person can move onto it to read it at length, and a transparent bridge (the mark's row and the
   * gap, as wide as the bubble can be) keeps the hover from breaking on the way. Written at the specificity the old hover-only rule had, so a binding's
   * own .datum-form__tooltip:hover rule still outranks it by order.
   */
  :is(.datum-form__tooltip, [data-tooltip]):where(:hover, :focus-within):not([data-dismissed]) :is(.datum-form__tooltip-text, [data-tooltip-text]) { opacity: 1; visibility: visible; pointer-events: auto; }
  :is(.datum-form__tooltip, [data-tooltip]):where(:hover, :focus-within):not([data-dismissed])::after { content: ""; position: absolute; left: -4px; top: 0; width: min(280px, 70vw); height: calc(100% + 8px); cursor: help; }
  /*
   * Hints, errors and counts may be capped to a reading line (--text-max-width, none by default;
   * Datum's tokens set 65ch, the line length GC Design System holds its text to).
   */
  .datum-form__description { justify-self: var(--field-part-justify, auto); max-width: var(--text-max-width, none); font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  /* The character count: a hint under the control, the error colour once over the limit. */
  .datum-form__count { display: block; justify-self: var(--field-part-justify, auto); margin-top: var(--spacing-field-inner-gap, 4px); max-width: var(--text-max-width, none); font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  .datum-form__count--over { color: var(--color-error, #c53a3a); font-weight: var(--font-weight-error, 400); }
  /*
   * Errors read the binding's own error colour; the summary box takes a tint and an edge of it.
   * Every colour below is a token with the engine's literal as the fallback, so a binding that
   * sets none draws the engine's colours and a dark set can move all of them at once.
   */
  .datum-form__error { justify-self: var(--field-part-justify, auto); max-width: var(--text-max-width, none); font-size: var(--font-size-error, 12px); font-weight: var(--font-weight-error, 400); color: var(--color-error, #c53a3a); }
  /* The summary, the status line and a notice share one message box: its edge, corners and padding. */
  .datum-form__summary {
    border: var(--width-message-border, 1px) solid var(--color-error-border, #efc6c6); background: var(--color-error-bg, #fff5f5);
    border-radius: var(--radius-message, 8px); padding: var(--padding-message, 8px 10px);
  }
  /* A component nothing draws: a note in the summary's box, naming the type, dashed to say something is missing. */
  .datum-form__unknown {
    border: var(--width-message-border, 1px) dashed var(--color-error-border, #efc6c6); background: var(--color-error-bg, #fff5f5);
    border-radius: var(--radius-message, 8px); padding: var(--padding-message, 8px 10px);
  }
  .datum-form__unknown-title { margin: 0; font-family: var(--font-family-heading, inherit); font-size: inherit; font-weight: var(--font-weight-heading, 600); line-height: inherit; color: var(--color-error, #c53a3a); }
  .datum-form__unknown-text { margin: 0; font-size: var(--font-size-error, 12px); }
  .datum-form__summary:focus-visible { outline: 2px solid var(--color-error, #c53a3a); outline-offset: 2px; }
  /* The heading is a real one (a level under the form's), sized like the text around it. */
  .datum-form__summary-heading { margin: 0; font-family: var(--font-family-heading, inherit); font-size: inherit; font-weight: var(--font-weight-heading, 600); line-height: inherit; }
  .datum-form__summary :is(ul, ol) { margin: 6px 0 0; padding-left: 18px; }
  .datum-form__summary li > a,
  .datum-form__summary li > button { display: inline-flex; align-items: center; min-height: var(--target-min-size, 24px); }
  /* Each entry is a link to its field; a click moves focus rather than navigating. */
  .datum-form__summary a { color: var(--color-error, #c53a3a); }
  .datum-form__summary button {
    background: none; border: none; color: var(--color-error, #c53a3a); cursor: pointer; padding: 0;
  }
  /*
   * A submission in flight: the status line says so, with a ring turning beside
   * it, and the regions the person could act on — inert already — dim under it. No fade: a
   * submit that settles within a frame paints and unpaints before the screen shows either.
   */
  .datum-form__status {
    display: flex; align-items: center; gap: 8px;
    border: var(--width-message-border, 1px) solid var(--color-border, #a9bbcb); background: var(--color-light, #eef3f8);
    border-radius: var(--radius-message, 8px); padding: var(--padding-message, 8px 10px);
  }
  .datum-form__status-spinner {
    flex: none; width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid currentColor; border-inline-end-color: transparent;
    animation: datum-form-spin .8s linear infinite;
  }
  @keyframes datum-form-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .datum-form__status-spinner { animation: none; } }
  .datum-form--submitting { cursor: progress; }
  .datum-form--submitting > .datum-form__header,
  .datum-form--submitting > .datum-form__journey-back,
  .datum-form--submitting > .datum-live-field,
  .datum-form--submitting > .datum-live-container > *,
  .datum-form--submitting > .datum-form__journey-actions,
  .datum-form--submitting > .datum-form__footer { opacity: .6; pointer-events: none; }
  /* The host's receipt: the summary's shape, in the outcome's colour. */
  .datum-form__notice {
    display: grid; gap: 6px; border-radius: var(--radius-message, 8px); padding: var(--padding-notice, 10px 12px);
    border: var(--width-message-border, 1px) solid var(--color-success, #2f855a); border-inline-start-width: var(--width-notice-bar, 4px);
    background: var(--color-light, #eef3f8);
  }
  .datum-form__notice--info { border-color: var(--color-info, #2b8aa8); }
  .datum-form__notice--warning { border-color: var(--color-warning, #e8a317); background: var(--color-warning-bg, var(--color-light, #eef3f8)); }
  .datum-form__notice--error { border-color: var(--color-error, #c53a3a); background: var(--color-error-bg, #fff5f5); color: var(--color-error, #c53a3a); }
  .datum-form__notice:focus-visible { outline: 2px solid var(--color-success, #2f855a); outline-offset: 2px; }
  .datum-form__notice--info:focus-visible { outline-color: var(--color-info, #2b8aa8); }
  /* Amber is under 3:1 on a light page, so a warning's focus ring is the form's own ring colour, not its edge. */
  .datum-form__notice--warning:focus-visible { outline-color: var(--focus-ring-color, var(--color-accent, #2f6feb)); }
  .datum-form__notice--error:focus-visible { outline-color: var(--color-error, #c53a3a); }
  .datum-form__notice-title { margin: 0; font-family: var(--font-family-heading, inherit); font-size: var(--font-size-notice-title, 15px); font-weight: var(--font-weight-heading, 600); line-height: inherit; }
  .datum-form__notice-text { margin: 0; }
  .datum-form__notice-details { display: grid; gap: 4px; margin: 0; }
  .datum-form__notice-detail { display: grid; grid-template-columns: max-content 1fr; gap: 0 12px; }
  .datum-form__notice-detail dt { font-weight: 600; }
  .datum-form__notice-detail dd { margin: 0; font-variant-numeric: tabular-nums; }
  .datum-form__button {
    justify-self: start;
    border: var(--width-button-border, 1px) solid var(--color-accent, #2f6feb);
    background: var(--color-accent, #2f6feb);
    color: var(--color-on-accent, #fff); border-radius: var(--radius-button, 8px); padding: var(--button-padding, 8px 16px);
    font-size: var(--button-font-size, 14px); font-weight: var(--button-font-weight, 400); cursor: pointer;
  }
  .datum-form__button:disabled { opacity: var(--opacity-button-disabled, .5); cursor: not-allowed; }
  /*
   * Hover and press, as a filter over whatever fill the variant has — none by default, so the
   * default look is unchanged; a design system that darkens every button the same way
   * (a brightness filter) sets the two tokens once. Written with :where() so the rule
   * stays at one class of specificity and a binding's own --variant:hover rule outranks it.
   */
  .datum-form__button:where(:hover:not(:disabled)) { filter: var(--button-hover-filter, none); }
  .datum-form__button:where(:active:not(:disabled)) { filter: var(--button-active-filter, none); }
  /*
   * Keyboard focus, drawn by the form rather than left to the UA's ring: the binding's focus
   * tokens, falling back to a two-pixel ring in the accent, on everything a person tabs to.
   * :focus-visible, so a pointer press draws none, as the UA would not. --focus-ring-inset is
   * for a design system that also thickens the control's own edge under the ring (GOV.UK's
   * inset shadow); it is a box-shadow, none by default.
   */
  .datum-form__control:focus-visible,
  .datum-form__button:focus-visible,
  .datum-form__file-remove:focus-visible,
  .datum-form__file-name:focus-visible,
  .datum-form__summary a:focus-visible,
  .datum-form__summary button:focus-visible,
  .datum-form__tab:focus-visible,
  .datum-form__step-label:focus-visible,
  .datum-form__tooltip-mark:focus-visible,
  [data-tooltip-mark]:focus-visible,
  :where(.datum-form__html) a:focus-visible,
  .datum-form__journey-back:focus-visible {
    outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb));
    outline-offset: var(--focus-ring-offset, 2px);
    box-shadow: var(--focus-ring-inset, none);
  }
  /*
   * Button emphasis. Each variant reads its own token and falls back to a default
   * palette, so a binding that defines none still gets a usable set, and one that defines
   * color-success recolours every success button in every form at once. The default (no
   * variant class) stays the accent-coloured button forms already had.
   */
  /* Primary restates the default rather than relying on it, so every variant has a rule. */
  .datum-form__button--primary {
    background: var(--color-accent, #2f6feb); border-color: var(--color-accent, #2f6feb);
    color: var(--color-on-accent, #fff);
  }
  /* Start: the large size in the success green, bold — a binding restates it as its own start button. */
  .datum-form__button--start {
    background: var(--color-success, #2f855a); border-color: var(--color-success, #2f855a);
    color: var(--color-on-accent, #fff);
    padding: var(--button-padding-lg, 11px 22px); font-size: var(--button-font-size-lg, 16px); font-weight: var(--button-font-weight-start, 600); border-radius: var(--radius-button-lg, var(--radius-button, 10px));
  }
  /*
   * Secondary: filled in the secondary colour by default; the outline button most design
   * systems draw is two tokens (color-secondary-bg: transparent; color-on-secondary: the
   * secondary colour), no rule.
   */
  .datum-form__button--secondary {
    background: var(--color-secondary-bg, var(--color-secondary, #5b6b7a)); border-color: var(--color-secondary, #5b6b7a);
    color: var(--color-on-secondary, var(--color-on-accent, #fff));
  }
  .datum-form__button--success {
    background: var(--color-success, #2f855a); border-color: var(--color-success, #2f855a);
  }
  .datum-form__button--danger {
    background: var(--color-danger, var(--color-error, #c92a2a));
    border-color: var(--color-danger, var(--color-error, #c92a2a));
  }
  /*
   * Dark text on amber: the palette's own dark, which stays dark under the dark set too — or
   * --color-on-warning, for a dark palette whose "dark" is a light grey the yellow cannot
   * carry.
   */
  .datum-form__button--warning {
    background: var(--color-warning, #e8a317); border-color: var(--color-warning, #e8a317);
    color: var(--color-on-warning, var(--color-dark, #14212b));
  }
  .datum-form__button--info {
    background: var(--color-info, #2b8aa8); border-color: var(--color-info, #2b8aa8);
  }
  .datum-form__button--light {
    background: var(--color-light, #eef3f8); border-color: var(--color-border, #a9bbcb);
    color: var(--color-text, #14212b);
  }
  .datum-form__button--dark {
    background: var(--color-dark, #1f2933); border-color: var(--color-dark, #1f2933);
    color: var(--color-on-dark, #fff);
  }
  /* A button that reads as a link, for a secondary action that should not compete. */
  .datum-form__button--link {
    background: none; border-color: transparent; padding-left: 2px; padding-right: 2px;
    color: var(--color-accent, #2f6feb); text-decoration: underline;
  }
  /* Bare classes suffice: the font reset above is :where()-scoped, so these win by order. */
  .datum-form__button--sm { padding: var(--button-padding-sm, 4px 10px); font-size: var(--button-font-size-sm, 12px); border-radius: var(--radius-button-sm, var(--radius-button, 6px)); }
  .datum-form__button--lg { padding: var(--button-padding-lg, 11px 22px); font-size: var(--button-font-size-lg, 16px); border-radius: var(--radius-button-lg, var(--radius-button, 10px)); }

  /*
   * Author-written content (the html component). Given the same margin discipline as the rest
   * of the form — the form's own grid owns the spacing between components, so the block's last
   * child must not add another gap under it.
   */
  /*
   * The native date picker's button is a focus stop of its own, and Chrome draws its ring there
   * (outline: auto) in the browser's colour; no author state selector reaches it (:focus and
   * :focus-visible after the pseudo-element never match), so the binding's ring colour and offset
   * are set outright — they show only while the UA's ring does.
   */
  .datum-form__control--date::-webkit-calendar-picker-indicator {
    outline-color: var(--focus-ring-color, var(--color-accent, #2f6feb));
    outline-offset: var(--focus-ring-offset, 2px);
  }
  .datum-form__html > :first-child { margin-top: 0; }
  .datum-form__html > :last-child { margin-bottom: 0; }
  .datum-form__html img { max-width: 100%; height: auto; }
  .datum-form__html table { border-collapse: collapse; }
  .datum-form__html th, .datum-form__html td {
    border: 1px solid var(--color-border, #a9bbcb); padding: var(--padding-table-cell, 4px 8px); text-align: start;
  }
  .datum-form__layout { gap: var(--spacing-field-gap, 12px); }
  .datum-form__layout--stack { display: grid; }

  .datum-form__panel {
    display: grid;
    border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb);
    border-radius: var(--radius-panel, 10px);
    background: var(--color-panel, #fff);
    overflow: hidden;
  }
  .datum-form__panel-header {
    padding: var(--padding-panel-header, 8px 12px);
    background: var(--color-panel-header, #eef3f8);
    border-bottom: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb);
  }
  .datum-form__panel-title { margin: 0; font-family: var(--font-family-heading, inherit); font-weight: var(--font-weight-heading, 600); font-size: var(--font-size-panel-title, 14px); line-height: inherit; }
  .datum-form__panel-body { display: grid; gap: var(--spacing-field-gap, 12px); padding: var(--padding-panel-body, 12px); }
  /* A hidden heading leaves the description in sight above the body, inset as the body is. */
  .datum-form__panel > .datum-form__group-description { padding: var(--padding-panel-body, 12px); padding-bottom: 0; }
  /*
   * The panel's looks (the classes the binding declares, look-classes.ts). With none the panel is
   * the card above. Each look changes only the box, never the heading: it stays a real heading
   * drawn at the same size in all four. Plain has no box at all, so it also has no padding to
   * inset the fields from the heading and no clip, which would cut off a focus ring that sits
   * outside a field.
   */
  .datum-form__panel.panel-plain { gap: var(--spacing-field-gap, 12px); border: 0; border-radius: 0; background: none; overflow: visible; }
  .datum-form__panel.panel-plain > .datum-form__panel-header { padding: 0; background: none; border-bottom: 0; }
  .datum-form__panel.panel-plain > .datum-form__panel-body { padding: 0; }
  .datum-form__panel.panel-plain > .datum-form__group-description { padding: 0; }
  .datum-form__panel.panel-outlined { background: none; }
  .datum-form__panel.panel-outlined > .datum-form__panel-header { background: none; border-bottom: 0; padding-bottom: 0; }
  .datum-form__panel.panel-shaded { border: 0; background: var(--color-panel-header, #eef3f8); }
  .datum-form__panel.panel-shaded > .datum-form__panel-header { background: none; border-bottom: 0; padding-bottom: 0; }

  .datum-form__tabs { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__tablist {
    display: flex; flex-wrap: wrap; gap: var(--spacing-tab-gap, 2px);
    border-bottom: var(--width-tab-border, 1px) solid var(--color-border, #a9bbcb);
  }
  .datum-form__tab {
    border: var(--width-tab-border, 1px) solid transparent; border-bottom: none; background: none;
    border-radius: var(--radius-tab, 8px 8px 0 0); padding: var(--padding-tab, 7px 12px); cursor: pointer;
    color: inherit; font: inherit; font-size: var(--font-size-tab, 14px);
    /* Keeps the active tab's bottom edge flush with the list's rule. */
    margin-bottom: calc(-1 * var(--width-tab-border, 1px));
  }
  .datum-form__tab.is-active {
    border-color: var(--color-border, #a9bbcb);
    border-bottom-color: var(--color-panel, #fff);
    background: var(--color-panel, #fff);
    font-weight: var(--font-weight-tab-active, 600);
  }
  .datum-form__tabpanel { display: grid; gap: var(--spacing-field-gap, 12px); }
  /* An author display beats the UA's [hidden] rule, so the inactive panels say so themselves (print re-shows them). */
  .datum-form__tabpanel[hidden] { display: none; }
  /*
   * A tabs container under a breakpoint (DatumControls.tabsFrom): its list items draw no box
   * (the tab stays the tab's box, as without them), the list keeps no list look, and the
   * title and the panel headings show only where the panels stack (the contents view) — a
   * binding whose design system heads a tab panel too shows them in its own css.
   */
  .datum-form__tab-item { display: contents; }
  :where(.datum-form__tabs--responsive) > .datum-form__tablist { margin: 0; padding: 0; list-style: none; }
  .datum-form__tabs-title[hidden] { display: none; }
  :where(.datum-form__tabs--responsive[data-tabs-view="tabs"] > .datum-form__tabpanel) > .datum-form__tabpanel-heading { display: none; }
  .datum-form__tabpanel-heading:focus { outline: none; }
  .datum-form__tabpanel-heading:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb)); outline-offset: var(--focus-ring-offset, 2px); }
  .datum-form__tabs-title, .datum-form__tabpanel-heading { margin: 0; font-family: var(--font-family-heading, inherit); font-weight: var(--font-weight-heading, 600); font-size: var(--font-size-heading, 17px); line-height: inherit; }

  /*
   * A multi-step form: the indicator's entries in a row that wraps, each a
   * numbered label over a segment coloured by its status; the progress line under it; the
   * panels; then Back and Continue. The engine's look is plain; every design-system binding
   * restates its own indicator (USWDS's segments and counter, the "Step n of total" caption
   * of Ontario, GOV.UK, GCDS and Québec) over these classes.
   */
  .datum-form__steps { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__step-indicator { display: grid; gap: var(--spacing-step-gap, 6px); }
  .datum-form__step-list { display: flex; flex-wrap: wrap; gap: var(--spacing-step-gap, 6px); margin: 0; padding: 0; list-style: none; counter-reset: none; }
  .datum-form__step { flex: 1 1 8rem; min-width: 0; border-top: var(--width-step-bar, 4px) solid var(--color-border, #a9bbcb); padding-top: 6px; }
  .datum-form__step--completed { border-top-color: var(--color-success, #2f855a); }
  .datum-form__step--active { border-top-color: var(--color-accent, #2f6feb); }
  .datum-form__step-label {
    display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%;
    border: 0; background: none; padding: 0; color: var(--color-muted, #536b7f); font: inherit; font-size: var(--font-size-hint, 12px); text-align: left; cursor: pointer;
  }
  .datum-form__step-label[aria-disabled="true"], span.datum-form__step-label { cursor: default; }
  .datum-form__step--active .datum-form__step-label { color: var(--color-text, #14212b); font-weight: 600; }
  .datum-form__step-number { display: inline-flex; align-items: center; justify-content: center; width: var(--size-step-number, 1.5em); height: var(--size-step-number, 1.5em); border-radius: 50%; background: var(--color-light, #eef3f8); color: inherit; font-size: 0.9em; }
  .datum-form__step--active .datum-form__step-number { background: var(--color-accent, #2f6feb); color: var(--color-on-accent, #fff); }
  .datum-form__step--completed .datum-form__step-number { background: var(--color-success, #2f855a); color: var(--color-on-accent, #fff); }
  .datum-form__step-progress { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  .datum-form__step-counter { display: none; }
  .datum-form__step-current { display: none; }
  .datum-form__step-panels { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__step-panel { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__step-panel[hidden] { display: none; }
  .datum-form__step-heading { margin: 0; font-family: var(--font-family-heading, inherit); font-weight: var(--font-weight-heading, 600); font-size: var(--font-size-heading, 17px); line-height: inherit; }
  /* The tag inside the heading is a binding's to draw (gcds-stepper's); the progress line carries the count by default. */
  .datum-form__step-tag { display: none; }
  .datum-form__step-heading:focus { outline: none; }
  .datum-form__step-heading:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb)); outline-offset: var(--focus-ring-offset, 2px); }
  .datum-form__step-body { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__step-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-actions-gap, 8px); }
  /* A button activateStep hid: a binding's own display on the button (GOV.UK's inline-block Back link) must not bring it back. */
  .datum-form .datum-form__step-actions > [hidden] { display: none; }

  /* A button group: a wrapping row; as a list, no markers or indent. */
  .datum-form__button-group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-field-gap, 12px); margin: 0; padding: 0; list-style: none; }
  .datum-form__button-group-item { display: flex; }

  /*
   * A grid column stacks its children like the form itself does. The min-width: 0 rules let
   * a control shrink with its track instead of holding its intrinsic width and pushing the
   * neighbouring column out — a grid item's automatic minimum is its content's, all the way
   * down to the input, so every box between the cell and the control has to give it up.
   */
  .datum-form__grid-column {
    display: grid; gap: var(--spacing-field-gap, 12px); align-content: start; min-width: 0;
  }
  .datum-form__grid-column > *,
  .datum-form__grid-column .datum-form__field,
  .datum-form__grid-column .datum-form__field > * { min-width: 0; }

  /*
   * Authored column widths: the grid is a row of twelve tracks and each cell spans its share
   * (--datum-grid-span, written by the shell). A cell with no span — a slot the grid no
   * longer declares — takes the whole row. Fixed tracks cannot auto-fit, so below 600px of
   * the grid's own width every cell takes the whole row instead: the phone-width stacking an
   * equal-column grid gets for free, keyed off the grid rather than the viewport so that the
   * builder's preview width shows it too.
   */
  .datum-form__layout--grid[data-column-widths] { container-type: inline-size; }
  .datum-form__layout--grid[data-column-widths] > .datum-form__grid-column {
    grid-column: span var(--datum-grid-span, 12);
  }
  @container (max-width: 600px) {
    .datum-form__layout--grid[data-column-widths] > .datum-form__grid-column { grid-column: 1 / -1; }
  }

  .datum-form__datagrid { container-type: inline-size; container-name: datum-datagrid; }
  .datum-form__datagrid-scroll { overflow-x: auto; }
  .datum-form__datagrid-table { width: 100%; border-collapse: collapse; }
  .datum-form__datagrid-colhead, .datum-form__datagrid-rownum { text-align: start; vertical-align: bottom; }
  /*
   * A row's heading ("Row 1") starts the row, its line level with the text in the row's first
   * boxes (a box's padding and border), not under its tallest cell.
   */
  .datum-form__datagrid-rownum { vertical-align: top; padding-block-start: 10px; }
  .datum-form__datagrid-cell { vertical-align: top; min-width: 0; }
  .datum-form__datagrid-rownum, .datum-form__datagrid-actions { width: 1%; white-space: nowrap; }
  .datum-form__datagrid-actions { vertical-align: top; }
  .datum-form__datagrid-cell :is(.datum-form__control--text, .datum-form__control--number, .datum-form__control--date, .datum-form__control--select, .datum-form__control--textarea, .datum-form__control-group) { width: 100%; min-width: 0; box-sizing: border-box; }
  /* A date's parts keep their own widths in a cell, side by side, rather than each taking the cell's width. */
  .datum-form__datagrid-cell .datum-form__date-part :is(.datum-form__control--text, .datum-form__control--select) { width: auto; }
  .datum-form__datagrid-add { justify-self: start; }
  /* Row numbers off: the row's name stays for assistive technology, out of view in every layout. */
  .datum-form__datagrid-rowname { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .datum-form__datagrid:where([data-layout="table"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  @container datum-datagrid (width >= 40rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width < 40rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width >= 45rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width < 45rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width >= 54rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width < 54rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width >= 63rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width < 63rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width >= 72rem) { .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody) > :where(tr) > .datum-form__datagrid-cell:where(:not([data-cell-group], .datum-form__datagrid-slot)) .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  @container datum-datagrid (width < 72rem) { .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table), .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody), .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-cell, .datum-form__datagrid-actions, .datum-form__datagrid-rownum) { display: block; width: auto; white-space: normal; }
  .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { display: grid; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > .datum-form__datagrid-head { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; } }
  .datum-form__datagrid-template > table { table-layout: fixed; }
  .datum-form__datagrid-slot > [data-dropzone] { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--spacing-field-gap, 12px); }
  .datum-form__datagrid-slot > [data-dropzone] > [data-component-id] { flex: 1 1 10rem; min-width: 0; }
  /* The template row sits under the column headings, which name its fields: their own labels would
     read twice, so they are hidden while the headings are drawn (a group column keeps its fields'
     labels, as in a row). Headings off, the labels show. */
  .datum-form__datagrid-template > table:has(> .datum-form__datagrid-head) .datum-form__datagrid-slot > [data-dropzone] > [data-component-id] > .datum-form__field > .datum-form__label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

  .datum-form__datagrid-colhead, .datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions { padding: var(--padding-table-cell, 4px 8px); border-bottom: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); }
  .datum-form__datagrid-colhead { font-weight: var(--font-weight-heading, 600); }
  .datum-form__datagrid-rownum { font-weight: var(--font-weight-heading, 600); color: var(--color-muted, #536b7f); }
  .datum-form__datagrid-actions .datum-form__button + .datum-form__button { margin-inline-start: var(--spacing-actions-gap, 8px); }
  .datum-form__datagrid-empty { margin: 0; color: var(--color-muted, #536b7f); }
  .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="stacked"], :not([data-layout])) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; }
  @container datum-datagrid (width < 40rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; } }
  @container datum-datagrid (width < 45rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="5"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; } }
  @container datum-datagrid (width < 54rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="6"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; } }
  @container datum-datagrid (width < 63rem) { .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="auto"]):where([data-columns="7"]) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; } }
  @container datum-datagrid (width < 72rem) { .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody) > .datum-form__datagrid-row { border: var(--width-panel-border, 1px) solid var(--color-border, #a9bbcb); border-radius: var(--radius-panel, 10px); padding: var(--padding-panel-body, 12px); margin-bottom: var(--spacing-group-gap, 6px); }
  .datum-form__datagrid:where([data-layout="auto"]):where(:not([data-columns="1"], [data-columns="2"], [data-columns="3"], [data-columns="4"], [data-columns="5"], [data-columns="6"], [data-columns="7"])) > :where(div) > :where(table) > :where(tbody) > :where(tr) > :where(.datum-form__datagrid-rownum, .datum-form__datagrid-cell, .datum-form__datagrid-actions) { padding: 0; border-bottom: 0; } }

  .datum-form__journey-back {
    justify-self: start; font: inherit; background: none; border: 0; padding: 0;
    color: var(--color-accent, #2f6feb); text-decoration: underline; cursor: pointer;
  }
  .datum-form__journey-back { display: inline-flex; align-items: center; min-height: var(--target-min-size, 24px); min-width: var(--target-min-size, 24px); }
  .datum-form__journey-back[inert] { opacity: .6; }
  .datum-form__journey-actions > .datum-form__button { min-height: var(--target-touch-size, 44px); }
  .datum-form__journey-title { margin: 0; font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  .datum-form__journey-heading { margin: 0; font-family: var(--font-family-heading, inherit); font-size: var(--font-size-title, 20px); font-weight: var(--font-weight-heading, 600); line-height: var(--line-height-title, 1.25); }
  .datum-form__journey-heading:focus { outline: none; }
  .datum-form__journey-heading:focus-visible { outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb)); outline-offset: var(--focus-ring-offset, 2px); }
  .datum-form__journey-progress { display: block; font-size: var(--font-size-hint, 12px); font-weight: normal; color: var(--color-muted, #536b7f); }
  .datum-form__journey-description { margin: 0; }
  .datum-form__journey-redirect { margin: 0; font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  .datum-form[data-journey-page-focus]:focus { outline: none; }
  .datum-form__journey-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-actions-gap, 8px); }
  .datum-form__journey-actions > .datum-form__button[aria-busy="true"] { cursor: progress; }

  /*
   * Marks the renderer owns on a field's wrapper (the binding draws their looks): warnings and
   * info apart from the errors, a file dragged over a file field, and a press on the file face.
   */
  .datum-live-notices { display: grid; gap: var(--spacing-field-inner-gap, 4px); justify-self: var(--field-part-justify, auto); max-width: var(--text-max-width, none); font-size: var(--font-size-hint, 12px); color: var(--color-muted, #536b7f); }
  .datum-live-notice { margin: 0; padding-inline-start: 8px; border-inline-start: 3px solid var(--color-info, #2b8aa8); }
  .datum-live-notice[data-severity="warning"] { border-inline-start-color: var(--color-warning, #e8a317); }
  .datum-live-notice > strong { font-weight: 600; margin-inline-end: .25em; color: var(--color-text, #14212b); }
  .datum-live-field[data-file-drag] .datum-form__control--file { outline: 2px dashed var(--focus-ring-color, var(--color-accent, #2f6feb)); outline-offset: 2px; }
  .datum-live-field[data-file-press] .datum-form__control--file { opacity: .85; }
  .datum-form[aria-busy="true"] .datum-form__button[aria-disabled="true"] { opacity: var(--opacity-button-disabled, .5); cursor: progress; }

  @media print {
    .datum-form .datum-form__tabpanel[hidden], .datum-form .datum-form__step-panel[hidden] { display: grid; }
    .datum-form .datum-form__button,
    .datum-form .datum-form__file-remove,
    .datum-form .datum-form__step-actions,
    .datum-form .datum-form__journey-actions,
    .datum-form .datum-form__journey-back,
    .datum-form .datum-form__language-switcher,
    .datum-form .datum-form__tooltip,
    .datum-form [data-tooltip],
    .datum-form .datum-form__tablist,
    .datum-form .datum-form__step-indicator,
    .datum-form .datum-form__file input[type="file"] { display: none; }
    .datum-form .datum-form__tabpanel-heading { display: block; }
    .datum-form .datum-form__tabpanel[data-tab-label]::before { content: attr(data-tab-label); display: block; font-weight: var(--font-weight-heading, 600); font-size: var(--font-size-heading, 17px); }
    .datum-form .datum-form__tabpanel + .datum-form__tabpanel, .datum-form .datum-form__step-panel + .datum-form__step-panel { margin-block-start: 1rem; }
  }`;

// ── The sheet a form is adopted with ───────────────────────────────────────────────────────

/** The drawn controls a form opts into (each a root class the sheet's opt-in rules hang off); the native control otherwise. */
export interface DatumDrawnControls {
  /** Checkboxes and radios drawn from the control tokens and a masked tick or dot. */
  choiceMarks?: "native" | "drawn";
  /** A select drawn with a chevron of its own. */
  selectChevron?: "native" | "drawn";
  /** An inline error led by a drawn icon, so colour is not its only cue (WCAG 1.4.1). */
  errorIcon?: "native" | "drawn";
}

/** Datum's own choice: native marks and chevron, a drawn error icon. */
export const DATUM_DRAWN_CONTROLS: Readonly<Required<DatumDrawnControls>> = Object.freeze({
  choiceMarks: "native",
  selectChevron: "native",
  errorIcon: "drawn"
});

/** The classes of the form element: `datum-form`, the dark palette's, and one per drawn control. */
export function datumFormClass(context: { colorScheme: "light" | "dark" }, drawn: DatumDrawnControls = DATUM_DRAWN_CONTROLS, extra?: string): string {
  const resolved = { ...DATUM_DRAWN_CONTROLS, ...drawn };
  return [
    "datum-form",
    context.colorScheme === "dark" ? "datum-form--dark" : "",
    resolved.choiceMarks === "drawn" ? "datum-form--choice-marks-drawn" : "",
    resolved.selectChevron === "drawn" ? "datum-form--select-chevron-drawn" : "",
    resolved.errorIcon === "drawn" ? "datum-form--error-icon-drawn" : "",
    extra?.trim() ?? ""
  ]
    .filter((name) => name !== "")
    .join(" ");
}

/** What a host changes about the Datum look. */
export interface DatumCssOptions {
  /** Tokens over the studio light set (a token the manifest does not name is a private one the host's own css reads). */
  tokens?: DatumTokens;
  /** Tokens over the studio dark set, applied under `.datum-form--dark`. */
  dark?: DatumTokens;
  /** Tokens that change with the viewport or the form's own width (`ResponsiveTokens`). */
  responsiveTokens?: ReadonlyArray<{ media?: string; container?: string; tokens: Record<string, string> }>;
  /** Rules after the sheet and the token sets: a host's own. */
  css?: readonly string[];
}

/** `tokens` as one rule on `selector`; a name or value that would break out of its declaration is dropped. */
export function datumTokenRule(selector: string, tokens: Readonly<Record<string, string>>): string {
  const vars = buildThemeStyleVars({ tokens });
  const body = themeStyleVarsToCssText(vars);
  return body === "" ? "" : `${selector} { ${body} }`;
}

/**
 * The Datum binding's css: the sheet, then the light token set (the studio look, with the host's
 * tokens over it) on `.datum-form`, the dark set on `.datum-form--dark`, the responsive sets, the
 * studio's choice rule and the host's own rules. The dark palette's two rules follow the dark set.
 */
export function datumCss(options: DatumCssOptions = {}): string {
  const light = datumTokenRule(".datum-form", { ...DATUM_TOKENS, ...options.tokens });
  const dark = datumTokenRule(".datum-form.datum-form--dark", { ...DATUM_DARK_TOKENS, ...options.dark });
  const responsive = responsiveTokensCss({ responsiveTokens: options.responsiveTokens });
  return [DATUM_STYLES, light, dark, ...DATUM_DARK_CSS, responsive, DATUM_CHOICE_CSS, ...(options.css ?? [])].filter((part) => part.trim() !== "").join("\n");
}
