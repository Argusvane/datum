/**
 * The look of what the Fluent UI binding draws itself, from Fluent's own tokens only (the theme
 * sheet the host loads: theme/*.css, or the host's `setTheme()`). Fluent's elements carry their own
 * CSS in their shadow roots; a `fluent-field` styles its slotted label and message itself, so what is
 * here is only what Fluent has no rule for. Written without backticks (it is a template literal).
 */

/**
 * Datum's tokens (FORM_TOKENS, render/live/datum/tokens.ts) in Fluent's values: what the Datum
 * adapters the binding does not replace draw with (steps, data
 * grids, files, signatures, button groups, chrome parts). Each value is a Fluent token, the one
 * Fluent's own component of that role reads (text-input.styles.js for the boxes, button.styles.js for
 * buttons, message-bar.styles.js for the alerts).
 */
export const FLUENT_FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "var(--colorNeutralForeground1)",
  "--color-muted": "var(--colorNeutralForeground3)",
  "--color-accent": "var(--colorBrandBackground)",
  "--color-border": "var(--colorNeutralStroke1)",
  "--color-input-border": "var(--colorNeutralStroke1)",
  "--color-input-bg": "var(--colorNeutralBackground1)",
  "--color-panel": "var(--colorNeutralBackground1)",
  "--color-panel-header": "var(--colorNeutralBackground2)",
  "--color-light": "var(--colorNeutralBackground3)",
  "--color-dark": "var(--colorNeutralBackgroundInverted)",
  "--color-on-accent": "var(--colorNeutralForegroundOnBrand)",
  "--color-on-dark": "var(--colorNeutralForegroundInverted)",
  "--color-choice-mark": "var(--colorCompoundBrandBackground)",
  "--color-secondary": "var(--colorNeutralForeground2)",
  "--color-secondary-bg": "var(--colorNeutralBackground1)",
  "--color-on-secondary": "var(--colorNeutralForeground1)",
  "--color-error": "var(--colorPaletteRedForeground1)",
  "--color-error-border": "var(--colorPaletteRedBorder2)",
  "--color-error-bg": "var(--colorPaletteRedBackground1)",
  "--color-danger": "var(--colorStatusDangerBackground3)",
  "--color-success": "var(--colorPaletteGreenForeground1)",
  "--color-warning": "var(--colorStatusWarningForeground1)",
  "--color-warning-bg": "var(--colorStatusWarningBackground1)",
  "--color-on-warning": "var(--colorNeutralForeground1)",
  "--color-info": "var(--colorNeutralForeground2)",
  "--color-disabled-bg": "var(--colorNeutralBackgroundDisabled)",
  "--color-surface": "var(--colorNeutralBackground1)",
  "--color-frame-surface": "var(--colorNeutralBackground1)",
  "--color-frame-border": "var(--colorNeutralStroke2)",
  "--focus-ring-color": "var(--colorStrokeFocus2)",
  "--focus-ring-width": "var(--strokeWidthThick)",
  "--font-family": "var(--fontFamilyBase)",
  "--font-family-heading": "var(--fontFamilyBase)",
  "--font-size": "var(--fontSizeBase300)",
  "--line-height": "var(--lineHeightBase300)",
  "--font-weight-label": "var(--fontWeightRegular)",
  "--font-size-label": "var(--fontSizeBase300)",
  "--font-size-hint": "var(--fontSizeBase200)",
  "--font-size-error": "var(--fontSizeBase200)",
  "--font-weight-error": "var(--fontWeightRegular)",
  "--font-weight-heading": "var(--fontWeightSemibold)",
  "--radius-control": "var(--borderRadiusMedium)",
  "--radius-button": "var(--borderRadiusMedium)",
  "--radius-panel": "var(--borderRadiusMedium)",
  "--radius-message": "var(--borderRadiusMedium)",
  "--radius-frame": "var(--borderRadiusLarge)",
  "--radius-tooltip": "var(--borderRadiusMedium)",
  "--control-border-width": "var(--strokeWidthThin)",
  // text-input.styles.js: a 32px box, 0 var(--spacingHorizontalMNudge) inside.
  "--control-padding": "0 var(--spacingHorizontalMNudge)",
  "--control-min-height": "32px",
  // button.styles.js: medium button, 5px 12px, semibold.
  "--button-padding": "var(--spacingVerticalSNudge) var(--spacingHorizontalM)",
  "--button-font-size": "var(--fontSizeBase300)",
  "--button-font-weight": "var(--fontWeightSemibold)",
  "--spacing-field-gap": "var(--spacingVerticalL)",
  "--shadow-tooltip": "var(--shadow16)"
};

export const FLUENT_CSS = `
  /* Fields stand 16px apart, as Fluent's own field documentation spaces them (field.stories.ts,
     ComponentExamples: a column with row-gap 16px, which is the spacingVerticalL token). The form is
     the column: it holds the fields, the containers (display: contents, so their boxes are its
     items), the summary, the receipt and the page's buttons, so none of those carries a margin of its own. */
  .datum-live { display: flex; flex-direction: column; gap: var(--spacingVerticalL); }
  /* Fluent UI ships no visually-hidden class: a hidden label, the count's limit sentence, an error prefix. */
  .datum-fluent-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  /* The pieces of a field's one message element (shared.ts, messagesOf). The field styles the element. */
  .datum-fluent-severity { font-weight: var(--fontWeightSemibold); }
  .datum-fluent-count--over { color: var(--colorPaletteRedForeground1); }
  /* Tier 2: choice groups. Fluent has no checkbox group; its radio group lays its radios in a column
     (radio-group.styles: gap spacingVerticalL, margin spacingVerticalS spacingHorizontalS as the field's input),
     and the checkbox group takes the same two rules. */
  .datum-fluent-checkbox-group { display: flex; flex-direction: column; gap: var(--spacingVerticalL); margin: var(--spacingVerticalS) var(--spacingHorizontalS); }
  /* A danger button: the primary appearance (button.styles: its background reads the three brand background tokens) with those tokens pointed at Fluent's status tokens for the button alone. */
  .datum-fluent-button--danger { --colorBrandBackground: var(--colorStatusDangerBackground3); --colorBrandBackgroundHover: var(--colorStatusDangerBackground3Hover); --colorBrandBackgroundPressed: var(--colorStatusDangerBackground3Pressed); }
  /* Tier 2: date. A fieldset and legend (Fluent has neither): the legend wears the field label's type
     (field.styles: base 300, regular, the required asterisk in the palette red), the parts stand in a row of
     fluent-fields, the hint and the message are the field's message type under them. */
  .datum-fluent-date { border: 0; margin: 0; padding: 0; min-width: 0; color: var(--colorNeutralForeground1); }
  .datum-fluent-date > legend { padding: 0; font-family: var(--fontFamilyBase); font-size: var(--fontSizeBase300); font-weight: var(--fontWeightRegular); line-height: var(--lineHeightBase300); margin-block-end: var(--spacingVerticalXXS); }
  .datum-fluent-date > legend[data-required]::after { content: "*" / ""; color: var(--colorPaletteRedForeground1); margin-inline-start: var(--spacingHorizontalXS); }
  .datum-fluent-date > .datum-fluent-message { display: block; color: var(--colorNeutralForeground3); font-family: var(--fontFamilyBase); font-size: var(--fontSizeBase200); font-weight: var(--fontWeightRegular); line-height: var(--lineHeightBase200); }
  .datum-fluent-date > .datum-fluent-message:first-of-type { margin-block-end: var(--spacingVerticalXXS); }
  .datum-fluent-date__parts { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--spacingHorizontalM); margin-block-end: var(--spacingVerticalXXS); }
  /* Containers */
  /* A named group: a native fieldset, its legend in Fluent's label tokens (Fluent has no group component). */
  .datum-fluent-fieldset { display: flex; flex-direction: column; gap: var(--spacingVerticalL); min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  .datum-fluent-legend { padding: 0; margin-block-end: var(--spacingVerticalXS); font-family: var(--fontFamilyBase); font-size: var(--fontSizeBase300); line-height: var(--lineHeightBase300); font-weight: var(--fontWeightSemibold); color: var(--colorNeutralForeground1); }
  .datum-fluent-legend.datum-fluent-visually-hidden { margin-block-end: 0; }
  .datum-fluent-legend-required { margin-inline-start: var(--spacingHorizontalXS); color: var(--colorPaletteRedForeground1); }
  .datum-fluent-legend-optional { margin-inline-start: var(--spacingHorizontalXS); font-weight: var(--fontWeightRegular); color: var(--colorNeutralForeground3); }
  .datum-fluent-fieldset-hint { font-family: var(--fontFamilyBase); font-size: var(--fontSizeBase200); line-height: var(--lineHeightBase200); color: var(--colorNeutralForeground3); }
  /* Tabs: the strip over the panels, spaced as Fluent's tablist documentation spaces them (tablist.stories.ts: a column with gap 1rem, the spacingVerticalL token). */
  .datum-fluent-tabs { display: flex; flex-direction: column; gap: var(--spacingVerticalL); }
  .datum-fluent-tabs-legend { font-family: var(--fontFamilyBase); font-size: var(--fontSizeBase300); line-height: var(--lineHeightBase300); font-weight: var(--fontWeightSemibold); color: var(--colorNeutralForeground1); }
  .datum-fluent-tabpanel { display: flex; flex-direction: column; gap: var(--spacingVerticalL); }
  .datum-fluent-tabpanel[hidden] { display: none; }
  /* A heading in a fluent-text: the text component sets the type, the heading takes it (no browser margin or size). */
  .datum-fluent-heading { margin: 0; font: inherit; }

  /* Chrome */
  /* A message bar's icon wears the status colour of its kind (Fluent's message-bar documentation sets a hex colour on the icon; these are the tokens it stands for). */
  .datum-fluent-bar-icon[data-intent="error"] { color: var(--colorStatusDangerForeground1); }
  .datum-fluent-bar-icon[data-intent="success"] { color: var(--colorStatusSuccessForeground1); }
  .datum-fluent-bar-icon[data-intent="warning"] { color: var(--colorPaletteDarkOrangeForeground1); }
  .datum-fluent-bar-icon[data-intent="info"] { color: var(--colorNeutralForeground3); }
  .datum-fluent-summary:focus-visible { outline: var(--strokeWidthThick) solid var(--colorStrokeFocus2); outline-offset: 2px; }
  /* The receipt: the region the renderer focuses holds the bar; Datum's own receipt box rules do not apply to it. */
  .datum-form__notice.datum-fluent-receipt { display: block; padding: 0; border: 0; border-radius: var(--borderRadiusMedium); background: none; color: inherit; }
  .datum-form__notice.datum-fluent-receipt:focus-visible { outline: var(--strokeWidthThick) solid var(--colorStrokeFocus2); outline-offset: 2px; }
  .datum-fluent-receipt-details { display: grid; grid-template-columns: max-content 1fr; gap: var(--spacingVerticalXXS) var(--spacingHorizontalM); margin: var(--spacingVerticalXS) 0 0; }
  .datum-fluent-receipt-details > div { display: contents; }
  .datum-fluent-receipt-details dt { font-weight: var(--fontWeightSemibold); }
  .datum-fluent-receipt-details dd { margin: 0; }
  .datum-fluent-required-note { color: var(--colorNeutralForeground3); }
  .datum-fluent-required-mark { color: var(--colorPaletteRedForeground1); }
  /* A journey page: the progress line leads the heading, the buttons stand in a row. */
  .datum-fluent-progress { display: block; font-size: var(--fontSizeBase300); line-height: var(--lineHeightBase300); font-weight: var(--fontWeightRegular); color: var(--colorNeutralForeground3); }
  .datum-fluent-page-description { margin-block-start: var(--spacingVerticalXS); }
  .datum-fluent-page-actions { display: flex; flex-wrap: wrap; gap: var(--spacingHorizontalS); }
`;
