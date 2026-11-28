# Look and chrome

A form is drawn by a binding. Datum's own binding is the default, so a form looks right with nothing to load and nothing to name. A host that wants other colours, type, frames or header and footer parts restyles that binding or sets chrome on the element, without writing markup.

```html
<script type="module" src="datum-form.js"></script>

<datum-form src="/forms/intake.json"></datum-form>
```

This page covers:

- The colour scheme.
- The options of `createDatumBinding`.
- Chrome parts, frames and the language switcher.
- Fonts.
- How page CSS reaches the form.

The complete list of tokens is on [Tokens](/tokens).

## Datum's own look

The look is a set of tokens for colour, type, spacing and geometry, and the stylesheet that draws them, scoped to the form so nothing leaks into the page. It comes in a light set and a dark set. The `colorScheme` property, `"light"` or `"dark"`, picks one; left out, the form is light.

```js
document.querySelector("datum-form").colorScheme = "dark";
```

`colorScheme` is a property only: there is no attribute for it. The form does not follow the operating system's `prefers-color-scheme`. A page that wants it to follow sets the property itself and keeps it current:

```js
const form = document.querySelector("datum-form");
const dark = matchMedia("(prefers-color-scheme: dark)");
const apply = () => { form.colorScheme = dark.matches ? "dark" : "light"; };
apply();
dark.addEventListener("change", apply);
```

A design-system binding is drawn light unless it names a `darkVariant`, a second binding the builder's picker offers as its dark look.

Setting `colorScheme` on a form drawn by such a binding changes only what the binding itself reads from the scheme; the design system's own dark mode (a `data-bs-theme` attribute, for one) does not reach into the form.

The builder's canvas has its own `scheme` attribute, described in [Customising the builder](/customising-the-builder).

## Restyling it

`createDatumBinding` is exported by `datum-form.js`. Called with no options it is Datum's own look. Its options change the look without changing any markup:

| Option | What it changes |
|---|---|
| `id`, `label` | The binding's id (default `datum`) and its name in a picker. |
| `tokens` | Token values over the light set. See [Tokens](/tokens). |
| `responsiveTokens` | Token values that change with the viewport or with the form's own width. |
| `dark` | Token values over the dark set; `false` draws the light look in either scheme. |
| `css` | A string or a list of strings: extra rules, adopted after the stylesheet and the token sets. |
| `frame` | Frame presets beside `seamless`, `outlined` and `paper`. See [Frames of your own](#frames-of-your-own). |
| `parts` | The drawing of 13 pieces of the form. See [Parts](#parts). |
| `renderers` | An adapter for a component type in place of Datum's, or a function that receives Datum's and returns one that wraps it. A container type takes a container adapter the same way. The adapter shapes are on [Writing a binding](/writing-a-binding). |
| `chrome` | The same for chrome parts, by part type (`image`, `heading`, and so on). |
| `languageSwitcher` | A function that draws the language switcher. It receives the switcher's state and Datum's own drawing to wrap. |
| `controls` | Native-control choices. See [Controls](#controls). |
| `fieldOrder` | The order of a field's parts: a list of `label`, `description`, `control` and `error`, each once, or `{ parts, date }`, where `date` is the order of a date's parts (`day`, `month`, `year`) or a function of the locale. |
| `texts`, `messages` | The binding's own wording, by locale: `{ "fr": { key: "text" } }`. `texts` words the form's own strings, `messages` its validation messages. |
| `cssClasses` | The author classes (`configuration.cssClass`) the binding gives a meaning to. The builder's Style tab offers them. |
| `formClass` | More classes on the form's root element. |

```js
import { createDatumBinding } from "./datum-form.js";

const acme = createDatumBinding({
  id: "acme",
  label: "Acme",
  tokens: { "color-accent": "#00539b", "radius-control": "2px", "font-family": "Georgia, serif" },
  dark: { "color-accent": "#8ab4f8" }
});

// binding is a property of the element, not an attribute.
document.querySelector("datum-form").binding = acme;
```

To make the binding available by name, call `bindings.register(acme)` (also exported by `datum-form.js`) and set `binding = "acme"`.

### Parts

`parts` takes a function per part. Each receives the part's values and `default`, Datum's own drawing of it, and returns what is drawn: `default` itself, `default` wrapped, or a drawing of its own made from the values. A part is a lit template over typed values, never an HTML string. A part that throws or returns nothing draws Datum's own, and the throw is logged once.

| Part | What it draws |
|---|---|
| `labelMarks` | The required or optional mark after a label or legend. |
| `tooltipMark` | The help mark beside a label. |
| `errorMessage` | A field's inline error. |
| `optionRow` | One radio or checkbox row. |
| `fieldShell` | The whole field: the shell around its parts in order. |
| `button` | An action button. |
| `stepBack` | The steps container's Back. |
| `summary` | The error summary. |
| `notice` | The host's receipt after a delivered submission. |
| `status` | The line that says a submission is in flight. |
| `requiredNote` | The sentence that explains the required mark. |
| `journeyHeading` | A journey page's heading. |
| `journeyActions` | A journey page's Continue and Back. |

What the renderer owns stays outside a part: the field's wrapper and its state attributes, the ids a part names, the field order, focus.

### Controls

`controls` picks how Datum draws native controls. Anything left out keeps Datum's choice, shown first.

| Key | Values | What it decides |
|---|---|---|
| `choiceMarks` | `native`, `drawn` | Checkbox and radio marks drawn by the browser, or by Datum. |
| `errorIcon` | `drawn`, `none`, `native` | Whether an inline error is led by an icon. |
| `summaryList` | `unordered`, `ordered` | The error summary's list. |
| `errorFocus` | `summary`, `field` | Where focus goes after a check that found errors: the summary, or the first field in error. |
| `tabsFrom` | `always`, a number or a width such as `"640px"` or `"40em"` | The form width under which a tabs container takes its narrow view, a contents list over the stacked panels. `em` is read at 16px. |
| `number` | `text`, `number` | The box a `number` field draws: a text box with a number keyboard, or the browser's number box. |
| `textareaRows` | a number (4) | How many rows a text area opens with. |
| `selectPlaceholder` | `hidden`, `listed` | Whether a required select's empty option stays in its list or is only its caption. An optional select always lists it, and choosing it clears the answer. The caption shows whenever the answer is none of the options. |
| `selectChevron` | `native`, `drawn` | A select face that carries a drawn chevron. |
| `choiceState` | `group`, `each` | A choice group's state on the group, or on each option as well. |
| `ariaStates` | `marked`, `required`, `none` | Which of the required and invalid states controls and groups carry as ARIA states. |
| `optionHint` | `described`, `named` | An option's hint describes it, or is part of its name. |
| `groupDescription` | `described`, `none` | Whether a group is described by its hint and error. |
| `groupError` | `last`, `afterLegend` | A choice group's error after its options, or between its legend and its options. |
| `inlineErrors` | `alert`, `plain` | An inline error is an alert, or plain text (the summary is then the page's one alert). |
| `panelRegion`, `stepRegion` | `named`, `none` | Whether a panel, or one step's panel, is a named region. |
| `stepPages` | `announced`, `plain` | Steps as announced regions with a live progress line, or plain sections. |
| `stepSegments` | `buttons`, `text` | The step indicator's entries as buttons, or static text. |
| `stepProgress` | `afterList`, `beforeList` | Where the progress line stands among the indicator's list. |
| `actionOrder` | `backFirst`, `nextFirst` | The order of Back and Continue. |
| `buttonGroup` | `div`, `list` | A button group drawn as a box, or a list. |
| `date` | an object | The date's controls: `control` (`parts` or `native`), `month` (`text` or `select`), `monthLabel` (`long` or `numbered`), `sizes`, `partClass`, `autocomplete`, `partHints`. The parts complete with the `autocomplete` token and their own suffix (`bday` and `bday-day` both give `bday-day`, `bday-month` and `bday-year`), `off` and `on` stay as they are, and the `native` box takes the token without a suffix (`bday`). The month select names the Gregorian months in every locale. |
| `languageLinks` | an object | Draws the language switcher as links. `current` (`omit`, `text`, `link`), `heading`, `abbreviation`, `separator`, `names`, `className`, `linkClass`. |

## Chrome

The header and footer around a form are made of parts. A host sets them once on the element, as JSON in the `chrome` attribute or the `chrome` property, for every form the page serves:

```html
<datum-form src="/forms/intake.json" chrome='{
  "header": [{ "type": "image", "src": "/logo.svg", "alt": "Acme" }],
  "footer": [{ "type": "text", "text": "Questions? Call 555 0100." }],
  "frame": "outlined"
}'></datum-form>
```

A form's author can place parts too, in the definition at `root.configuration.chrome`, with the same `header`, `footer` and `frame`. A definition's part needs an `id`, unique across the header and the footer and the groups inside them:

```json
{
  "root": {
    "id": "root",
    "type": "form",
    "configuration": {
      "chrome": {
        "header": [{ "id": "logo", "type": "image", "src": "/logo.svg", "alt": "Acme" }],
        "footer": [{ "id": "help", "type": "text", "text": "Questions? Call 555 0100." }]
      }
    },
    "children": { "content": [] }
  }
}
```

A host's part needs no `id`. A definition with a part that has none, or two parts with the same one, fails the definition's structure check (`chrome.part.id.missing`, `chrome.part.id.duplicate`); on a page the form still draws such a part, without its translations.

A region is a vertical stack of rows. Each part at the top of a region is one row. A `group` puts several parts on one row.

### Part types

Every part may carry `align`: `start`, `center` or `end`, the part's place on its row in the writing direction. It defaults to `end` for a language switcher and `start` for everything else, and is ignored inside a group, whose `justify` places its parts.

| Type | Settings | What it draws |
|---|---|---|
| `image` | `src` (required), `alt`, `href`, `width`, `height` | A picture. `alt` left out makes it decorative. `href` wraps it in a link. `width` and `height` are whole CSS pixels of 1 or more. |
| `heading` | `text` (required), `level` (1 to 3, default 2) | A heading. |
| `text` | `text` (required) | A paragraph of plain text. |
| `html` | `html` (required) | Markup with links, lists and tables, reduced to the same allowlist as the `html` component. |
| `form-title` | `level` (1 to 3, default 1) | The form's own title, from the root's `title`. Nothing without one. |
| `form-description` | none | The form's description, from the root's `description`. Nothing without one. |
| `language-switcher` | `label` (default "Language"), `hideLabel` | A control over the form's own languages, in the order and under the labels the form gives them. |
| `group` | `parts` (required), `justify` (`start`, `center`, `end`, `space-between`; default `space-between`), `verticalAlign` (`start`, `center`, `end`; default `center`) | Several parts on one row. They wrap when the row is too narrow. Groups nest to 32 levels. |

What is dropped or left out:

- A part whose type is unknown, or that lacks its required setting, is dropped.
- A picture whose `src` fails the URL rule draws nothing. The rule admits a relative URL, `http` and `https`, and an image `data:` URL; an `href` is held to it as well.
- `html` keeps links, lists, tables, images and the usual inline and block tags and drops scripts, styles, event handlers and `style` attributes.

A host's texts (`text`, `html`, `label`, `alt`, `src`, `href`) are a string, or an object with the words per language, which the form picks from:

```json
{ "type": "text", "text": { "default": "Questions? Call 555 0100.", "locales": { "fr": "Des questions? Appelez le 555 0100." } } }
```

A definition's texts are strings in the form's default language, translated in the Languages workspace.

A part's `level` is the heading level as written, whatever `heading-level` says. See [Heading level](#heading-level).

### Who decides the frame

A frame is the look drawn around the form: `seamless` sits in the page, `outlined` draws a panel, `paper` lifts the form over the page. Three inputs name one: the form's author, the host's default, and a flag that makes the host's win. The `frame` and `frame-fixed` attributes are shorthand for `chrome.frame`.

| Notation | Means |
|---|---|
| The author's pick in the builder, or `chrome.frame` in the definition | The author's frame. A string. |
| `chrome='{ "frame": "outlined" }'`, or the `chrome` property | The host's frame: a default. The author's pick wins over it. |
| `chrome='{ "frame": { "id": "outlined", "fixed": true } }'` | The host's frame, fixed: it wins whatever the author picked. |
| `frame="outlined"` | Shorthand for `chrome.frame: "outlined"`. |
| `frame="outlined" frame-fixed` | Shorthand for `chrome.frame: { id: "outlined", fixed: true }`. |

The winner:

1. The host's frame, when it is fixed or the author picked none.
2. Otherwise the author's.
3. Otherwise `seamless`. A frame id that nothing draws is drawn as `seamless`.

The shorthand attributes keep working when the page also sets `chrome`. They are merged into it.

- Where both name the same setting, the `chrome` wins whole: with `chrome.frame` set, `frame` and `frame-fixed` are not used.
- A string `chrome.frame` is never fixed, so `frame-fixed` beside it does nothing; write the object form.
- With a `chrome` that names no frame, `frame` and `frame-fixed` apply as they would alone.

`formChrome: "exclude"` does not touch frames: a host that wants a plain form on its own card sets `{ "id": "seamless", "fixed": true }`.

```html
<datum-form src="/forms/intake.json" frame="paper" frame-fixed></datum-form>
```

### Frames of your own

A frame is a label and some CSS. `createDatumBinding({ frame })` adds one under an id of lower-case letters, digits and hyphens. The id becomes the class `datum-form--frame-<id>` on the form's root, and the builder's frame picker offers the label.

```js
const branded = createDatumBinding({
  frame: {
    brand: {
      label: { default: "Brand", locales: { fr: "Marque" } },
      css: ".datum-form--frame-brand { border-top: 6px solid var(--color-accent); padding: var(--spacing-frame-padding); }"
    }
  }
});
```

A frame under the id of a built-in one relabels or restyles it. The three built-in frames are drawn from the tokens `color-frame-surface`, `color-frame-border`, `radius-frame`, `shadow-frame` and `spacing-frame-padding`.

### Who draws the language switcher

The language switcher can be asked for by the page (the attribute or a part) or by the form's author, and dropped three ways. They all answer one question, who owns the header, and they combine in a fixed order.

| Notation | Means |
|---|---|
| `language-switcher` on the element | Shorthand for a host `language-switcher` part in the header. Merged into `chrome`, after the header parts it lists. Adds nothing when `chrome` has a `language-switcher` part of its own, in the header, the footer or a group: that part is the one drawn. |
| A `language-switcher` part in the host's `chrome` | A host switcher, in the region and place the host put it. |
| A `language-switcher` part in the definition | The author's switcher. The Languages workspace's Language switcher row places one in the header, the footer or both. |
| `formLanguageSwitcher: false` in `chrome` | Drops the author's switchers. |
| `formChrome: "exclude"` in `chrome` | Draws the host's parts alone, the author's header and footer parts and switcher included. |
| `translations` left out of `features` | No switcher at all, and no host or author switcher either. |

For one region, the parts drawn are chosen in this order:

1. `formChrome: "exclude"`: the host's parts only.
2. `formLanguageSwitcher: false`: the author's parts without their switchers, then the host's parts, switchers included.
3. The author placed a switcher: it stays where the author put it. The host's switcher parts are dropped, and the host's `label` and `hideLabel` word the author's switcher. The rest of the host's parts follow the author's.
4. Otherwise: the author's parts, then the host's.

There is one switcher. The form's options are the form's own languages, never the host's.

### A live example

Pick who composes the header and footer: the page, the form's author, or both. The page's parts go in through the `chrome` property, and the author's arrive with the definition.

- Choose Both to see the `language-switcher` attribute, which is the page's switcher and not a part set in `chrome`, fill the slot the author left for one.
- Choose The page replaces the author's header to see `formChrome: "exclude"` draw the page's parts alone.

The code under the choices is the page that runs.

<LiveExample name="chrome" />

## Heading level

`heading-level` (1 to 6, default 1) is the level of the form's top heading. The headings the form draws itself sit one level under it, so a form on a page that already has an `h1` takes `heading-level="2"`.

Chrome parts do not follow it. A `heading` part has a `level` of its own (1 to 3, default 2) and a `form-title` part likewise (default 1), and each is the heading level as written, whatever `heading-level` says. When you set `heading-level` and add either part, set the part's `level` to match.

## Fonts

The `font-family` token sets the form's face. Datum's own value begins with Geist, followed by the system faces, so the form draws in Geist only when the page has loaded it. A shadow root cannot register a font, so the page declares the `@font-face` itself, in its own document. Datum ships Geist beside the builder's files, under the SIL Open Font License:

```css
@font-face {
  font-family: "Geist";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url("/datum/builder-fonts/geist-variable.woff2") format("woff2");
}
```

To use another face, declare it the same way and set `font-family` through `tokens`. A design-system binding's fonts are listed in its `assets.fonts`; see [Design-system bindings](/bindings).

## Reaching the form from page CSS

The form draws inside a shadow root, so the page's selectors do not match the form's markup.

- **Tokens and `css`.** The supported route is the binding: `tokens` for values, `css` for extra rules. The `css` rules are adopted inside the form's shadow root, so they can use the form's own class names (`datum-form__field`, `datum-form__label` and so on, which show in the browser's developer tools). Those names belong to the form's internals and can change; prefer tokens.
- **A component's own class.** An author's `cssClass` setting adds classes to the component's element, and a binding's `cssClasses` names the ones it gives a meaning to.
- **Custom properties from the page.** A custom property set on `datum-form` reaches only the tokens the look does not set itself. See [Tokens](/tokens#page-css-reaches-only-some-of-them).
- **`::part(form)`.** The element exposes one CSS part, `form`, the box that holds the form. `datum-form::part(form) { max-width: 40rem; margin: auto; }` places it. Nothing inside it is a part.

## The builder and PDFs

The builder has its own look, set with its `theme` and `scheme` attributes, independent of the form on its canvas; see [Customising the builder](/customising-the-builder). A PDF is drawn with a PDF theme, set with `pdf-theme`; see [PDFs](/pdf).

## Another design system

Drawing the form in another design system's own markup and components is the work of a binding. See [Design-system bindings](/bindings), and [Writing a binding](/writing-a-binding) to make one.
