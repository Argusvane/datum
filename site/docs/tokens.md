# Tokens

A token is a CSS custom property the form's stylesheet reads. Datum's own look is made of 139 of them: colour, type, spacing, corners, control size, focus ring and layout. A host restyles the form by giving some of them new values. Nothing else about the form's markup or stylesheet needs to change.

This page lists every token, what it styles and the value Datum gives it. [Look and chrome](/look) explains frames, header and footer parts and the other ways to change how a form looks.

## How a host changes them

Tokens are set through `createDatumBinding`, which `datum-form.js` exports. Token names are written without the leading dashes.

```js
import { createDatumBinding } from "./datum-form.js";

const acme = createDatumBinding({
  tokens: { "color-accent": "#00539b", "radius-control": "2px", "font-family": "Georgia, serif" },
  dark: { "color-accent": "#8ab4f8" },
  responsiveTokens: [{ container: "(width < 30em)", tokens: { "spacing-field-gap": "10px" } }]
});

// binding is a property of the element, not an attribute.
document.querySelector("datum-form").binding = acme;
```

| Option | Tokens it sets |
|---|---|
| `tokens` | Values over Datum's light set. |
| `dark` | Values over Datum's dark set, drawn while the form's `colorScheme` is `"dark"`. `false` draws the light set in either scheme. |
| `responsiveTokens` | A list of `{ media, tokens }` or `{ container, tokens }`. `media` is a media query condition without `@media`. `container` is a condition on the form's own width, without `@container`, such as `"(width < 24em)"`. When both are given, `container` wins. |

What happens to the values you give:

- A token you leave out keeps Datum's value.
- A token that falls back to another (`color-input-border` reads `color-border`) follows that one until you set it.
- A name the list below does not contain is kept as a private token, for your own `css` option to read.
- A value is dropped if it contains `{`, `}` or `;`, a closing tag, `@import`, or a `url()` that runs script or carries anything but an image.

### Page CSS reaches only some of them

The form draws inside a shadow root. A custom property set on the `datum-form` element in the page's own CSS inherits into it, but Datum's look declares its own value for many tokens on the form's root inside the shadow root, and a declaration there beats an inherited value. So a page rule such as the one below changes nothing:

```css
datum-form { --color-accent: red; }   /* no effect: the look sets color-accent itself */
```

The column "Look sets it" says which tokens this applies to:

- Of the 139, 49 are set by the light look and 55 by the dark look (6 of those only in the dark set).
- For the rest a page rule on `datum-form` does reach the form, in the light scheme:

```css
datum-form { --radius-frame: 4px; --spacing-frame-padding: 12px; }  /* reaches the form */
```

Do not rely on that split. `createDatumBinding({ tokens })` sets any token, wins in both schemes, and keeps the choice with the code that registers the binding.

Another design system's binding does not read these tokens: they style Datum's own look, and the parts of a form that Datum draws inside a design-system binding take their values from that binding's `fallbackTokens` (see [Writing a binding](/writing-a-binding#what-the-binding-object-holds)).

## The tiers

| Tier | What it is | How many |
|---|---|---|
| `base` | What a design system always publishes: palette, type scale, body spacing, control and button geometry. Set these first. | 43 |
| `derived` | A token whose value is another token (`focus-ring-color` reads `color-accent`), plus the form's own surface and colour scheme. Setting one refines; leaving it out is fine. | 17 |
| `geometry` | A literal a design system rarely prescribes: a control's minimum height, a frame's shadow, the width of a notice's bar. Datum's value stands until you say otherwise. | 79 |

A token's group (palette, state, surface, spacing, type, focus, controls, layout) says what it is about. Two tokens need a note:

- `color-surface` is the form's own page colour, transparent unless set, so a form sits on the host page's colour.
- `color-scheme` is `light` or `dark`, emitted as the CSS `color-scheme` so the browser's own date picker, select list and scrollbars follow the scheme.

The columns of the tables below:

- The Default column is the value Datum's own light look uses.
- The Dark column is the dark set's value where it differs.
- A value written `var(--color-border, ...)` is a fallback chain: the token follows another until set.

## Base tokens


| Token | Group | Default | Dark | Look sets it | What it styles |
|---|---|---|---|---|---|
| `color-text` | palette | `#16171a` | `#e6edf3` | light and dark | The form's text. |
| `color-muted` | palette | `#4e525b` | `#9fb3c8` | light and dark | Field descriptions, option hints, the character count, the optional mark, the required note and the size line under an attached file. |
| `color-accent` | palette | `#2f4bd6` | `#6ea8fe` | light and dark | The default and primary buttons, link-style buttons, the download link on an attached file's name, the active step, and the focus ring's fallback. |
| `color-border` | palette | `#9aa2ad` | `#4a5d70` | light and dark | Input borders (unless color-input-border is set), panel and tab outlines, the step bar, table cells, the status line and the file Remove button. |
| `color-input-bg` | palette | `#ffffff` | `#1b2633` | light and dark | The controls themselves: text inputs, selects, textareas and the language switcher. |
| `color-panel` | palette | `#ffffff` | `#172230` | light and dark | A panel's surface and the active tab. |
| `color-panel-header` | palette | `#eceef1` | `#1f2b3a` | light and dark | A panel's header band. |
| `color-light` | palette | `#eceef1` | `#3a4d62` | light and dark | The light fill: affixes, the --light button, the step numbers, the status line and a notice's ground. |
| `color-dark` | palette | `#16171a` | `#2b3a4a` | light and dark | The dark fill: the --dark button and the help-mark bubble. |
| `color-on-accent` | palette | `#ffffff` | `#0f1720` | light and dark | Text on the filled buttons: primary, start, secondary, success, danger and info, and the active and completed step numbers. |
| `color-on-dark` | palette | `#ffffff` | `#e6edf3` | light and dark | Text on color-dark: the dark button and the help-mark bubble. |
| `color-error` | state | `#b42318` | `#ff7b7b` | light and dark | Inline errors, the over-limit count, the summary's text, links and focus ring, an error notice's edge, and what color-danger falls back to. |
| `color-error-bg` | state | `#fce9e7` | `#2e161b` | light and dark | The error summary's fill and an error notice's, whose words are color-error. |
| `color-error-border` | state | `#d9776d` | `#8a3a40` | light and dark | The error summary's edge. |
| `color-secondary` | state | `#4e525b` | `#9fb3c8` | light and dark | The --secondary button's border and, unless color-secondary-bg says otherwise, its fill. |
| `color-success` | state | `#1e6b3a` | `#3fb950` | light and dark | The --success and --start buttons, a completed step, and a success notice's edge. |
| `color-warning` | state | `#8a4b00` | `#e8a317` | light and dark | The --warning button, which draws color-dark text on it, and a warning notice's edge. |
| `color-info` | state | `#1c6e8c` | `#58c4dd` | light and dark | The --info button and an info notice's edge. |
| `radius-panel` | surface | `14px` |  | light and dark | A panel's corners. |
| `spacing-field-gap` | spacing | `16px` |  | light and dark | The gap between fields, between the rows of a layout, and inside panels, tabs and steps. |
| `spacing-field-inner-gap` | spacing | `6px` |  | light and dark | The gap between a field's label, hint, control and error, and above the character count; zero for a design system that spaces them by margins. |
| `spacing-option-gap` | spacing | `6px` |  | no | The gap between the options of a radio or checkbox group. |
| `font-family` | type | `"Geist", system-ui, -apple-system, "Segoe UI", sans-serif` |  | light and dark | The form's body face, set on its root and inherited by every control. |
| `font-size` | type | `0.875rem` |  | light and dark | The form's body size, inherited by every control and the affixes. |
| `line-height` | type | `1.45` |  | light and dark | The form's body line height, inherited by every control. |
| `font-weight-label` | type | `500` |  | light and dark | Labels, and the legends of radio and checkbox groups. |
| `font-size-label` | type | `0.8125rem` |  | light and dark | Labels and legends. |
| `font-size-hint` | type | `0.8125rem` |  | light and dark | Field descriptions, option hints, the character count, the required note, a group's description and the step labels. |
| `font-size-error` | type | `0.8125rem` |  | light and dark | The inline error text. |
| `font-weight-error` | type | `600` |  | light and dark | The inline error text and the over-limit count. |
| `font-size-title` | type | `1.125rem` |  | light and dark | The form's own title. |
| `font-size-heading` | type | `1rem` |  | light and dark | A chrome heading and a step's heading. |
| `font-size-group-label` | type | `0.875rem` |  | light and dark | A group's label (its legend). |
| `font-size-panel-title` | type | `14px` |  | no | A panel's title. |
| `focus-ring-width` | focus | `2px` |  | no | The focus ring's width. |
| `focus-ring-offset` | focus | `2px` |  | no | The focus ring's offset from the control's edge. |
| `radius-control` | controls | `10px` |  | light and dark | The corner radius of the boxed controls, the affixes and the language switcher. |
| `radius-button` | controls | `999px` |  | light and dark | The buttons' corner radius at every size. |
| `control-border-width` | controls | `1px` |  | no | The boxed controls' and affixes' border width. |
| `control-padding` | controls | `9px 12px` |  | light and dark | The boxed controls' and affixes' padding. |
| `button-padding` | controls | `8px 16px` |  | light and dark | Buttons at their default size; the small and large variants keep their own padding. |
| `button-font-size` | controls | `0.875rem` |  | light and dark | Buttons at their default size. |
| `button-font-weight` | controls | `500` |  | light and dark | Buttons at their default size. |

## Derived tokens


| Token | Group | Default | Dark | Look sets it | What it styles |
|---|---|---|---|---|---|
| `color-input-border` | palette | `#7b828c` | `#6b8194` | light and dark | Input borders alone, for a binding that treats them apart from panel outlines; falls back to color-border. Keep it 3:1 against color-input-bg. |
| `color-choice-mark` | palette | `#16171a` | `#6ea8fe` | light and dark | The mark of a checked radio or checkbox — the dot, the tick — through the native accent-color; falls back to color-accent. A theme drawing its own marks reads it for them. |
| `color-danger` | state | `var(--color-error, #c92a2a)` | `#ff7b7b` | dark only | The --danger button; falls back to color-error. |
| `color-secondary-bg` | state | `var(--color-secondary, #5b6b7a)` |  | no | The --secondary button's fill; falls back to color-secondary. "transparent" draws the outline button most design systems have. |
| `color-on-secondary` | state | `var(--color-on-accent, #fff)` |  | no | Text on the --secondary button; falls back to color-on-accent. An outline secondary sets it to color-secondary. |
| `color-warning-bg` | state | `#fdf1d6` | `#2e2410` | light and dark | A warning notice's fill; falls back to color-light, the ground of a success or info notice, so the amber edge alone sets it apart. color-text sits on it: keep it 4.5:1 against that. |
| `color-disabled-bg` | state | `#eceef1` | `#243245` | light and dark | The fill of a disabled text box, number, date, select or textarea (outside read-only mode, which keeps the answers at full contrast); falls back to color-light. The text on it is color-muted: keep that 4.5:1 against this. |
| `color-surface` | surface | `transparent` | `#0f1720` | dark only | The form's own page: transparent unless set, so the form sits on the host's. A dark binding sets it and paints itself; the builder's canvas sheet takes the same colour. |
| `color-scheme` | surface | `normal` | `dark` | dark only | light or dark, emitted as the form's CSS color-scheme so the native parts a stylesheet cannot reach (date picker, select popup, scrollbars) follow the scheme. |
| `color-frame-surface` | surface | `var(--color-surface, #fff)` | `#172230` | dark only | The fill of the paper frame; falls back to color-surface, then white — paper needs a colour of its own on a transparent form. |
| `color-frame-border` | surface | `var(--color-border, #a9bbcb)` | `#4a5d70` | dark only | The border of the outlined and paper frames (chrome.frame); falls back to color-border. |
| `font-family-heading` | type | `inherit` |  | no | The heading face — the form title, a chrome heading, a group's label, a panel's title, a notice's title, the summary heading and a step heading; the body face unless set. |
| `focus-ring-color` | focus | `var(--color-accent, #2f6feb)` |  | no | The keyboard focus ring on controls, buttons, tabs, step headings and the summary's links; the accent unless set. |
| `color-on-warning` | state | `#ffffff` | `#2b3a4a` | light and dark | Text on the --warning button; falls back to color-dark. A dark palette whose dark fill is light sets it to a dark the yellow can carry. |
| `radius-button-sm` | controls | `var(--radius-button, 6px)` |  | no | The small button's corners; falls back to radius-button. |
| `radius-button-lg` | controls | `var(--radius-button, 10px)` |  | no | The large and start buttons' corners; falls back to radius-button. |
| `width-choice-border` | controls | `var(--control-border-width, 1px)` |  | no | A drawn checkbox's or radio's border width; falls back to control-border-width. |

## Geometry tokens


| Token | Group | Default | Dark | Look sets it | What it styles |
|---|---|---|---|---|---|
| `button-hover-filter` | controls | `none` |  | no | A filter over every button under the pointer — brightness(90%) for a design system that darkens all its buttons the same way; none by default. |
| `button-active-filter` | controls | `none` |  | no | A filter over every button while pressed; none by default. |
| `radius-frame` | surface | `14px` |  | light and dark | The corner radius of the outlined and paper frames. |
| `shadow-frame` | surface | `0 1px 2px rgba(13, 36, 53, .06), 0 8px 24px rgba(13, 36, 53, .07)` | `0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .45)` | dark only | The paper frame's drop shadow; "none" for a flat design system. |
| `spacing-frame-padding` | surface | `24px` |  | no | The room between a frame's edge and the fields. |
| `target-min-size` | controls | `24px` |  | no | The smallest height of a choice row, a summary link and the Back link (WCAG 2.5.8). |
| `target-touch-size` | controls | `44px` |  | no | The minimum height of a journey's Continue, Submit and Back buttons, the size a thumb needs. |
| `layout-max-width` | layout | `none` |  | no | Caps the width of the fields column — the line-length limit every government design system puts on a form. |
| `layout-grid-column-min` | layout | `220px` |  | no | How narrow a grid column may get before the grid wraps it onto the next row. |
| `focus-ring-inset` | focus | `none` |  | no | An inset box-shadow under the ring, for a design system that thickens the control's own edge on focus. |
| `control-min-height` | controls | `40px` |  | light and dark | The boxed controls' minimum height. |
| `control-max-width` | controls | `min(75ch, 100%)` |  | light and dark | The boxed controls' maximum width. |
| `text-max-width` | layout | `65ch` |  | light and dark | Caps the width of the text under a control — the hint, the error, the character count and a group's description — to a reading line (65ch in the studio themes). |
| `textarea-min-height` | controls | `72px` |  | no | The textarea's minimum height. |
| `field-part-justify` | spacing | `auto` |  | no | How a field's text parts — label, hint, error, count, a group's legend, the required note — sit in the field's grid: auto (the engine's: a grid item stretches to its column), or start, as wide as their words (as some design systems draw their labels). One token instead of a rule per part. |
| `spacing-option-row-gap` | spacing | `8px` |  | no | The gap between a radio or checkbox and its label. |
| `spacing-option-text-gap` | spacing | `2px` |  | no | The gap between an option's label and its hint. |
| `spacing-group-gap` | spacing | `6px` |  | no | The gap between a labelled group's legend, description and body. |
| `spacing-file-list-gap` | spacing | `4px` |  | no | The gap between the rows of attached files. |
| `spacing-file-item-gap` | spacing | `8px` |  | no | The gap between a file row's name, size and controls. |
| `spacing-chrome-gap` | spacing | `8px` |  | no | The gap between the rows of the form's header and footer. |
| `spacing-chrome-group-gap` | spacing | `8px 16px` |  | no | The row and column gaps between the parts of a chrome group. |
| `spacing-language-switcher-gap` | spacing | `6px` |  | no | The gap between the language switcher's label and its select. |
| `spacing-tab-gap` | spacing | `2px` |  | no | The gap between tabs. |
| `spacing-step-gap` | spacing | `6px` |  | no | The gap between the entries of a step indicator, and between the indicator and its progress line. |
| `spacing-actions-gap` | spacing | `8px` |  | no | The gap between a step's Back and Continue. |
| `radius-message` | surface | `10px` |  | light and dark | The corners of the error summary, the status line and a notice. |
| `radius-tooltip` | surface | `8px` |  | light and dark | The help bubble's corners. |
| `radius-tab` | surface | `8px 8px 0 0` |  | no | A tab's corners. |
| `radius-file-remove` | controls | `6px` |  | no | A file row's Remove button corners. |
| `padding-message` | spacing | `8px 10px` |  | no | The padding of the error summary and the status line. |
| `padding-notice` | spacing | `10px 12px` |  | no | A notice's padding. |
| `padding-panel-header` | spacing | `8px 12px` |  | no | A panel header's padding. |
| `padding-panel-body` | spacing | `12px` |  | no | A panel body's padding. |
| `padding-tab` | spacing | `7px 12px` |  | no | A tab's padding. |
| `padding-tooltip` | spacing | `6px 9px` |  | no | The help bubble's padding. |
| `padding-file-remove` | spacing | `2px 8px` |  | no | A file row's Remove button padding. |
| `padding-table-cell` | spacing | `4px 8px` |  | no | A cell of a table inside author-written html. |
| `padding-language-switcher` | spacing | `5px 8px` |  | no | The language switcher select's padding. |
| `button-padding-sm` | controls | `4px 10px` |  | no | The small button's padding. |
| `button-padding-lg` | controls | `11px 22px` |  | no | The large and start buttons' padding. |
| `button-font-size-sm` | controls | `12px` |  | no | The small button's size. |
| `button-font-size-lg` | controls | `16px` |  | no | The large and start buttons' size. |
| `button-font-weight-start` | controls | `600` |  | no | The start button's weight — the big call to action is bold. |
| `font-weight-heading` | type | `600` |  | no | Every heading the form draws: its title, a chrome heading, a group's legend, a panel's title, a notice's title, the summary heading and a step heading. |
| `font-size-notice-title` | type | `15px` |  | no | A notice's title. |
| `font-size-chrome-text` | type | `14px` |  | no | A chrome text or description part. |
| `line-height-chrome-text` | type | `1.5` |  | no | A chrome text or description part. |
| `line-height-title` | type | `1.25` |  | no | The form's own title. |
| `line-height-heading` | type | `1.3` |  | no | A chrome heading. |
| `font-size-file-item` | type | `13px` |  | no | A row of attached files. |
| `font-size-file-meta` | type | `12px` |  | no | The size line under an attached file, and the read-only file field's "none" line. |
| `font-size-file-remove` | type | `12px` |  | no | A file row's Remove button. |
| `font-size-tab` | type | `14px` |  | no | A tab's caption. |
| `font-weight-tab-active` | type | `600` |  | no | The active tab's caption. |
| `font-size-tooltip` | type | `12px` |  | no | The help bubble's text. |
| `font-size-language-switcher` | type | `13px` |  | no | The language switcher's label. |
| `font-weight-language-switcher` | type | `600` |  | no | The language switcher's label. |
| `width-message-border` | surface | `1px` |  | no | The edge of the error summary, the status line and a notice. |
| `width-notice-bar` | surface | `4px` |  | no | The bar down a notice's start edge, in the outcome's colour. |
| `width-button-border` | controls | `1px` |  | no | The buttons' border width. |
| `width-panel-border` | surface | `1px` |  | no | A panel's outline and the rule under its header. |
| `width-tab-border` | surface | `1px` |  | no | A tab's outline and the rule under the tab list. |
| `width-step-bar` | surface | `4px` |  | no | The bar over each entry of a step indicator, coloured by its status. |
| `width-file-remove-border` | controls | `1px` |  | no | A file row's Remove button border width. |
| `size-step-number` | spacing | `1.5em` |  | no | The circle around a step's number. |
| `size-tooltip-mark` | spacing | `15px` |  | no | The help mark beside a label. |
| `shadow-tooltip` | surface | `0 4px 12px rgba(13, 36, 53, .2)` |  | no | The help bubble's drop shadow. |
| `opacity-button-disabled` | controls | `.5` |  | no | How far a disabled button fades. |
| `icon-check` | controls | an SVG data URI |  | no | The tick of a drawn checkbox (controls.choiceMarks: "drawn"): an SVG data URI the engine masks in color-choice-mark. A theme's own glyph goes here (svgDataUri). |
| `icon-radio` | controls | an SVG data URI |  | no | The dot of a drawn radio, masked in color-choice-mark. |
| `icon-chevron` | controls | an SVG data URI |  | no | The chevron of a drawn select (controls.selectChevron: "drawn"), masked in the control's text colour. |
| `icon-error` | controls | an SVG data URI |  | no | The icon before an inline error (controls.errorIcon: "drawn"), masked in color-error. |
| `size-choice` | controls | `16px` |  | no | A drawn checkbox's or radio's box. |
| `radius-choice` | controls | `4px` |  | no | A drawn checkbox's corners (a radio is round). |
| `size-chevron` | controls | `12px` |  | no | A drawn select chevron's box. |
| `spacing-chevron-inset` | controls | `9px` |  | no | The room between a drawn chevron and the select's end edge; the select's end padding leaves twice this plus the chevron. |
| `size-error-icon` | controls | `1em` |  | no | A drawn error icon's box. |
| `spacing-error-icon-gap` | controls | `.35em` |  | no | The gap between a drawn error icon and the message. |
