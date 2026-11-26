/**
 * The look of what the Ontario Design System binding draws itself. Every colour, size and face is one
 * of the design system's design tokens (`--ontario-*`, the `@ongov/ontario-design-system-design-tokens`
 * package) with the release's own value behind it, so the binding follows the host's tokens when the
 * host serves them and still draws Ontario's look when it does not: Ontario's components carry their
 * CSS in their shadow roots, with the tokens compiled in, and its global stylesheet publishes none.
 *
 * Spacing is Ontario's: its form container spaces fields 40px apart (`--ontario-spacing-7`), and a page
 * alert and a callout carry margins of their own (2rem above, 2.5rem below) in their shadow roots. The form
 * is block flow, so those margins collapse as they do on an Ontario page.
 */

/** Datum's tokens (the custom properties its own adapters read) to Ontario's values: what the Datum adapters draw inside this binding (tabs, files ...). */
export const ONTARIO_FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--font-family": 'var(--ontario-font-open-sans, "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif)',
  "--font-size": "var(--ontario-font-sizes-standard-body-text, 1rem)",
  "--line-height": "var(--ontario-font-line-heights-default, 1.6)",
  "--color-text": "var(--ontario-colour-greyscale-black, #1a1a1a)",
  "--color-muted": "var(--ontario-colour-greyscale-greyscale70, #4d4d4d)",
  "--color-border": "var(--ontario-colour-greyscale-greyscale20, #cccccc)",
  "--color-input-border": "var(--ontario-colour-greyscale-black, #1a1a1a)",
  "--color-input-bg": "var(--ontario-colour-greyscale-white, #ffffff)",
  "--color-panel": "var(--ontario-colour-greyscale-white, #ffffff)",
  "--color-panel-header": "var(--ontario-colour-greyscale-greyscale5, #f2f2f2)",
  "--color-light": "var(--ontario-colour-greyscale-greyscale5, #f2f2f2)",
  "--color-accent": "var(--ontario-colour-system-link, #0066cc)",
  "--color-on-accent": "var(--ontario-colour-greyscale-white, #ffffff)",
  "--color-error": "var(--ontario-colour-accent-dark-red, #d81a21)",
  "--color-error-border": "var(--ontario-colour-system-alert, #cd0000)",
  "--color-error-bg": "var(--ontario-colour-system-alert-light, #fceff0)",
  "--color-success": "var(--ontario-colour-system-success, #118847)",
  "--color-warning": "var(--ontario-colour-system-warning, #ffd440)",
  "--color-info": "var(--ontario-colour-system-information, #1080a6)",
  "--color-dark": "var(--ontario-colour-greyscale-black, #1a1a1a)",
  "--color-on-dark": "var(--ontario-colour-greyscale-white, #ffffff)",
  "--focus-ring-color": "var(--ontario-colour-system-focus, #009adb)",
  "--radius-control": "4px",
  "--radius-button": "4px",
  "--radius-panel": "0",
  "--radius-message": "0",
  "--radius-frame": "0",
  "--control-border-width": "2px"
};

export const ONTARIO_CSS = `
  /* Fields and groups are spaced as Ontario's form container spaces them: 40px between, the last one's margin taken back so a group ends where its last field does. */
  .datum-live-field, ontario-fieldset { margin-bottom: var(--ontario-spacing-7, 2.5rem); }
  ontario-fieldset { display: block; }
  .datum-ontario-group { margin-bottom: calc(-1 * var(--ontario-spacing-7, 2.5rem)); min-width: 0; }
  /* Ontario's buttons take no disabled: aria-disabled on the button inside, dimmed here. */
  ontario-button[aria-disabled="true"] { opacity: 0.6; cursor: not-allowed; }
  /* A field's notices: Ontario's callout without a heading, the severity word bold. */
  .datum-ontario-notices p { margin: 0; }
  /* Beside a component: the limit for screen readers, the figure as Ontario's hint. */
  .datum-ontario-count { margin-top: var(--ontario-spacing-2, 0.5rem); }
  .datum-ontario-count ontario-hint-text { display: block; margin-bottom: calc(-1 * var(--ontario-spacing-4, 1rem)); }
  .datum-ontario-count--over ontario-hint-text::part(hint-text) { color: var(--ontario-colour-accent-dark-red, #d81a21); }
  /* The error line, as ErrorMessage draws it inside a component. */
  .datum-ontario-error { display: flex; align-items: flex-start; margin: calc(-1 * var(--ontario-spacing-1, 0.25rem)) 0 var(--ontario-spacing-2, 0.5rem); color: var(--ontario-colour-accent-dark-red, #d81a21); max-width: 48rem; }
  .datum-ontario-error__content { margin-left: var(--ontario-spacing-2, 0.5rem); margin-top: 0.125rem; }
  .datum-ontario-hint { color: var(--ontario-colour-greyscale-greyscale70, #4d4d4d); margin: 0 0 var(--ontario-spacing-4, 1rem); max-width: 48rem; width: 100%; }
  /* The error summary is Ontario's page alert with its links slotted, in the design system's own list and link styles; only the focus mark is the binding's. */
  .datum-ontario-summary-box:focus-visible { outline: 4px solid var(--ontario-colour-system-focus, #009adb); outline-offset: 2px; }
  /* The host's receipt: the alert carries the look; the region is where focus lands. */
  .datum-ontario-receipt:focus-visible { outline: 4px solid var(--ontario-colour-system-focus, #009adb); outline-offset: 2px; }
  .datum-ontario-receipt p { margin: 0 0 var(--ontario-spacing-3, 0.75rem); }
  .datum-ontario-receipt__details { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--ontario-spacing-1, 0.25rem) var(--ontario-spacing-4, 1rem); }
  .datum-ontario-receipt__details > div { display: contents; }
  .datum-ontario-receipt__details dt { font-weight: 700; }
  .datum-ontario-receipt__details dd { margin: 0; }
  /* Steps: a panel is a block; the indicator and the heading lead it. */
  .datum-ontario-step { display: grid; gap: var(--ontario-spacing-5, 1.5rem); }
  .datum-ontario-step[hidden] { display: none; }
  .datum-ontario-step > :is(h1, h2, h3, h4, h5, h6) { margin: 0; }
  /* A data grid row's buttons (each ends the group it sits in, so it carries the margin the group takes back), and the buttons that close a step or a journey page. */
  .datum-ontario-row-actions { display: flex; flex-wrap: wrap; gap: var(--ontario-spacing-4, 1rem); margin-bottom: var(--ontario-spacing-7, 2.5rem); }
  .datum-ontario-page-actions { display: flex; flex-wrap: wrap; gap: var(--ontario-spacing-4, 1rem); }
  .datum-ontario-steps > .datum-ontario-page-actions { margin-top: var(--ontario-spacing-7, 2.5rem); }

  /* Tier 2: Datum's date drawn in Ontario's HTML. The pieces ontario-date-input, ontario-input and the fieldset carry in their shadow roots, from the tokens. */
  .datum-ontario-date { border: 0; margin: 0; padding: 0; min-width: 0; }
  .datum-ontario-legend { display: block; padding: 0; margin: 0 0 var(--ontario-spacing-4, 1rem); width: 100%; max-width: 38.75em; hyphens: auto; white-space: normal;
    color: var(--ontario-colour-greyscale-black, #1a1a1a); font-family: var(--ontario-font-raleway-modified, "Raleway Modified", "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif); font-size: 1.1875rem; font-weight: 700; line-height: 1.5; }
  .datum-ontario-flag { font-family: var(--ontario-font-open-sans, "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif); font-size: 1rem; font-weight: 400; }
  .datum-ontario-flag::before { content: " "; }
  .datum-ontario-date__group { display: flex; flex-wrap: wrap; }
  .datum-ontario-date__part { display: flex; flex-direction: column; margin-right: var(--ontario-spacing-5, 1.5rem); }
  .datum-ontario-date__label { display: block; margin: 0; font-weight: var(--ontario-font-weights-semi-bold, 600); }
  .datum-ontario-input { display: block; box-sizing: border-box; width: 100%; max-width: 12ex; margin: var(--ontario-spacing-4, 1rem) 0 0; padding: 0.625rem var(--ontario-spacing-4, 1rem);
    border: 2px solid var(--ontario-colour-greyscale-black, #1a1a1a); border-radius: 4px; background: var(--ontario-colour-greyscale-white, #ffffff);
    color: var(--ontario-colour-greyscale-black, #1a1a1a); font-family: var(--ontario-font-open-sans, "Open Sans", "Helvetica Neue", Helvetica, Arial, sans-serif); font-size: 1rem; line-height: 1.5; transition: box-shadow 0.1s ease-in-out; }
  .datum-ontario-input:focus, .datum-ontario-input:active { box-shadow: 0 0 0 4px var(--ontario-colour-system-focus, #009adb); outline: 4px solid transparent; }
  .datum-ontario-input--invalid { border: 0.125rem solid var(--ontario-colour-system-alert, #cd0000); }
  .datum-ontario-input:disabled { opacity: 0.6; }
`;
