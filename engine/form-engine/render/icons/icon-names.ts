/**
 * The engine's icon vocabulary: every glyph its own chrome draws, named for where it goes so a
 * host supplying its own icons knows what each one is for without seeing the
 * drawing it replaces.
 *
 * Two kinds of name. A chrome name (`undo`, `validate`, `drag-handle`) is one control in the
 * builder shell, the canvas toolbar or the form host's action row. A palette name
 * (`field-date`, `container-grid`, `content-heading`) is the glyph the component palette shows
 * for a kind of component; the builder keeps the table from component *types* to these names
 * (`text` and `gcds-text` both land on `field-text`, `tel` on `field-phone`), so a set never
 * has to know a host's type names.
 */
export const DATUM_ICON_NAMES = [
  // --- chrome: the builder shell and canvas toolbar ---
  /** Undo, on the builder's bar. */
  "undo",
  /** Redo, on the builder's bar. */
  "redo",
  /** The preview-width picker's face on the builder's bar. */
  "preview-width",
  /** The binding picker's face on the builder's bar. */
  "binding",
  /** The show-hidden toggle while hidden components are being shown (an open eye). */
  "show-hidden",
  /** The show-hidden toggle while they are not (a crossed eye). */
  "hide-hidden",
  /** The grip on every component on the canvas. */
  "drag-handle",
  /** The activity strip's Form item, which opens the form-level settings panel. */
  "form-panel",
  /** The activity strip's Header & footer item, which opens the form's chrome panel. */
  "chrome-panel",
  /** The activity strip's Components item, which opens the palette. */
  "components-panel",
  /** The collapsed properties panel's reopen button. */
  "properties-panel",
  /** The activity strip's Outline item, which opens the component tree. */
  "outline-panel",
  /** The activity strip's Variables item, which lists what a rule or a PDF text may reference. */
  "variables-panel",
  /** The activity strip's View item, which opens the canvas controls (width, theme, the host's chrome). */
  "view-panel",
  /** The activity strip's Settings item, which opens the builder's own settings (simulated data sources). */
  "settings-panel",
  /** The activity strip's Translations item, which opens the translations catalog. */
  "translations-panel",
  /** The activity strip's Tests item, which opens the form's scenarios. */
  "tests-panel",
  /** The activity strip's Form fields item, which lists the form's fields beside a journey's step. */
  "fields-panel",
  /** The document tabs' menu button (rename, duplicate, default, delete). */
  "document-menu",
  /** The bar's New form button, which puts an empty form in place of the one being edited. */
  "new-form",
  /** The bar's Open button, which opens a form definition from a JSON file in place of this one. */
  "open-form",
  /** The bar's Download button, which saves the form's definition as a JSON file. */
  "download-form",
  // --- chrome: the form host's action row ---
  /** The Validate button. */
  "validate",
  /** The Print button. */
  "print",
  /** The Download PDF button. */
  "pdf",
  // --- palette: fields ---
  "field-text",
  "field-textarea",
  "field-email",
  "field-password",
  "field-phone",
  "field-url",
  "field-number",
  "field-currency",
  "field-slider",
  "field-rating",
  "field-checkbox",
  "field-checkboxes",
  "field-toggle",
  "field-radio",
  "field-select",
  "field-date",
  "field-time",
  "field-datetime",
  "field-file",
  "field-signature",
  // --- palette: actions ---
  "action-button",
  // --- palette: containers ---
  "container-form",
  "container-fieldset",
  "container-section",
  "container-box",
  "container-tabs",
  "container-grid",
  "container-row",
  "container-column",
  "container-table",
  "container-repeater",
  "container-step",
  // --- palette: static content ---
  "content-heading",
  "content-paragraph",
  "content-html",
  "content-divider",
  "content-image",
  "content-header",
  "content-footer",
  "content-link",
  "content-card",
  "content-details",
  "content-notice",
  "content-alert",
  "content-icon",
  "content-error-summary",
  /** The palette's glyph for a component type nothing else names. */
  "component"
] as const;

export type DatumIconName = (typeof DATUM_ICON_NAMES)[number];

export function isDatumIconName(value: unknown): value is DatumIconName {
  return typeof value === "string" && (DATUM_ICON_NAMES as readonly string[]).includes(value);
}
