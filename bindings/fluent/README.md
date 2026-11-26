# @argusvane/datum-binding-fluent

The Fluent UI binding for Datum: it draws Datum's components with Fluent UI Web Components (Fluent 2,
the design system Microsoft Teams draws with), pinned to release **3.2.1** (the
`fluentui-web-components-3.2.1` devDependency alias), themed by the tokens of `@fluentui/tokens`
**1.0.0-alpha.24** (`fluentui-tokens-1.0.0-alpha.24`). Moving either release is a manual refresh.

Datum is not affiliated with or endorsed by Microsoft. Fluent UI is theirs; this binding is an independent reference for it.

It is a reference binding: a demo and a starting point, with no support promise. Its accessibility
is Fluent's.

| folder | what it holds |
|---|---|
| `src/index.ts` | `createBinding(lit, datum)`: the binding object, `selfCheck`, `ready`, `focusTarget` |
| `src/shared.ts` | what every adapter shares: the one message element (`messagesOf`), the box's label and description (`describe`), `readyOf`, `leaving` |
| `src/text.ts` | text, number and textarea |
| `src/fields.ts`, `src/date.ts`, `src/containers.ts`, `src/chrome.ts` | select, radio, checkboxes, the lone checkbox and the button; the date; fieldset and tabs; the summary, receipt, required note, journey page and language switcher (a dropdown) |
| `src/css.ts` | the binding's own rules and `fallbackTokens`, from Fluent tokens only |
| `theme/` | the five theme sheets (generated) and `themes.json` |
| `scripts/generate-theme.mjs` | writes `theme/` from the pinned tokens release |
| `reference/` | Fluent's own markup per case, which the kit compares the binding with |
| `tests/tier2/` | cases for what Fluent has no markup for, against signed-off baselines |
| `docs/side-effects.md` | what Fluent's script does outside the form, measured |

## Tiers

1. **Fluent's own element.** Text (`fluent-text-input`, a prefix and a suffix in its `start` and `end`
   slots), number (`fluent-text-input` as a text box asking for a number keyboard: Fluent's
   `type="number"` rewrites the box on every keystroke, so "-5" or "1.5" cannot be typed), textarea
   (`fluent-textarea`), select (`fluent-dropdown`), the language switcher (a `fluent-dropdown` in a `fluent-field`), radio (`fluent-radio-group`), checkboxes (a
   `fluent-checkbox` per option in a group field), a lone checkbox, the button (`fluent-button`), tabs
   (`fluent-tablist`, the panels the binding's own), the receipt (`fluent-message-bar`), and a journey
   page's heading (`fluent-text`) and buttons. Each field is a `fluent-field` with its label, the
   asterisk the field draws for a required control, and one message element (hint, error, notices,
   count).
2. **Datum's component in Fluent's HTML and tokens.** The date (three `fluent-text-input`s in a
   `fieldset`), fieldset and legend, the error summary (a `fluent-message-bar` with a title and a list of `fluent-link`s, no style of the binding's own),
   the required note, the character count and a field's
   notices (pieces of its message).
3. **Datum's own adapter, tinted with `fallbackTokens`**, listed in `unsupported()`: data grids, steps,
   files, signatures, button groups, chrome parts.

The number box is Datum's text-drawn number box. The binding reads nothing: it reports the text as typed
with `on.input(text, { interim: true, typed: "number" })`, and the renderer reads it with the form's
locale, as it does for Datum's own text-drawn number ("1,000", or "2,5" and "1 000" in French, are
numbers; "abc" is stored as typed and validation says it is no number). The box keeps what was typed
while the state's `standsFor(text)` says it stands for the stored number, so the caret keeps its place.

## Use

```ts
import { bindings } from "@argusvane/datum";
import { createBinding } from "@argusvane/datum-binding-fluent";

bindings.register(bindings.fromFactory(createBinding), {
  assets: {
    stylesheets: [{ url: "/fluent/theme/teams-light.css" }],
    scripts: [{ url: "/fluent/web-components.min.js" }]   // @fluentui/web-components@3.2.1 dist/web-components.min.js, a module
  }
});
// <datum-form binding="fluent">
```

Instead of a theme sheet, a host may theme with Fluent's own function: `setTheme(teamsDarkTheme)` (the
page's adopted sheets), or `setTheme(teamsDarkTheme, wrapper)` on a light-DOM element that holds the
form (it writes a `data-fluent-theme` scope that inherits into the form's shadow root). Custom properties
inherit through the shadow boundary, so either reaches the form. Do not call `setTheme(theme, formElement)`
on the `<datum-form>` element itself: that adopts the sheet into the form's own shadow root, which the
renderer clears when the form unmounts, and a later `setTheme` only rewrites Fluent's cached, detached
sheet, so a form put back in the page has no tokens.

A host that loads a dark theme sheet also sets `color-scheme: dark` on the form element: Fluent's tokens
carry no colour-scheme token, so Datum's native parts (a file input's button, scrollbars) stay light
otherwise.

A page that enforces Trusted Types lists the `fast-element` policy (Fluent's script makes it) beside
Datum's `datum-assets`.

## Buttons and the textarea's height

Fluent's button has the appearances `primary`, `outline`, `subtle` and `transparent`: no danger, warning,
success or info. Datum's `variant` maps as follows:

| Datum variant | drawn as |
|---|---|
| `secondary`, `light`, `dark` | `appearance="outline"` |
| `link` | `appearance="subtle"` |
| `danger` | `appearance="primary"` and the class `datum-fluent-button--danger`, which points the primary appearance's three brand backgrounds (`--colorBrandBackground`, `...Hover`, `...Pressed`) at `--colorStatusDangerBackground3`, `...Hover` and `...Pressed`, for that button alone |
| `warning`, `success`, `info`, `start`, none | `appearance="primary"` (the brand colour) |

Fluent's textarea has no `rows`: its box is as tall as its `--min-block-size` (52px). The author's `rows`
reach the inner box and set that custom property on the host from script (never an inline `style`
attribute, so a strict `style-src` holds) as `rows` lines of the box's own line height plus its padding
and border. That property is Fluent's own, undocumented; the textarea case in `kit:check` does not
measure it, so re-check a drawn height at a release bump.

## Theme

Fluent ships its themes as JavaScript objects, not CSS. `theme/` holds the stylesheet form of five of
them, every token as a custom property on `:root` (the renderer moves it to the form's `:host`):
`teams-light`, `teams-dark`, `teams-high-contrast` (what the Teams client draws with), `web-light` and
`web-dark`. They are generated, never typed:

```
npm run theme:generate     # after moving the @fluentui/tokens pin
```

The kit and every reference use `teams-light.css`. Dark and high contrast are other sheets (a Teams
tab swaps them with the client's theme), not another binding.

In a Teams tab, map the Teams client's theme (`default`, `dark`, `contrast`, from
`microsoftTeams.app.getContext()` and `registerOnThemeChangeHandler`) to the sheet the binding is
registered with, and set `color-scheme: dark` on the form element for the dark and high contrast ones:

| Teams theme | sheet |
|---|---|
| `default` | `theme/teams-light.css` |
| `dark` | `theme/teams-dark.css` |
| `contrast` | `theme/teams-high-contrast.css` |

Teams draws with React v9 from the same Fluent 2 spec and tokens, so a form drawn here looks like Teams
but is not pixel-equal to it: the equality check compares the binding with the web components' own
markup, not with Teams.

## Where the marketing site serves it from

The marketing site's binding page publishes `dist/web-components.min.js` of the pinned
web-components release and the five theme sheets under `bindings/fluent/files/`
(`site/scripts/binding-assets-spec.mjs`), with a `NOTICE.txt` for each of the two packages and the
tokens package's `LICENSE`. The web-components package ships no licence file (its `package.json` says
MIT). No font or image is served: Fluent names system fonts.

## Checks

```
npm install
npm run typecheck
npm run kit:build          # ES and IIFE bundles, budget 14 KB gzip
npm run kit:check          # package, build, tokens, binding, equality, behaviour, checks, conformance
npm run kit:serve          # the reference and the binding side by side (ports 5200-5219)
```

## Known

What the kit reports today, and why. None is a defect to patch in the binding.

- **Behaviour MV-01 and MV-03** (declared `known` in `binding-check.json`, with the
  reason below: the kit prints a `known defect` line for each in the behaviour header, reports the case as
  `KNOWN` with the exception it still raises, counts it apart from pass and fail, and exits 0 for it; once
  Fluent fixes the defect the case passes and the kit fails it as "listed as known but passes: remove it"):
  a `fluent-field` taken out of the DOM and put back throws in the
  release (FAST's `slottedInputObserver`; docs/side-effects.md). A data grid whose rows can be
  reordered hits the same defect: Move up and Move down move keyed row nodes, and the page raises one
  console exception per Fluent field in the moved row. The values end up right, but the field's
  watching of its control's `required`, `disabled` and `readonly` is not re-bound. Not reported upstream
  (microsoft/fluentui and microsoft/fast issue search finds no issue that names `slottedInputObserver` or
  describes it); `packages/datum/src/field/field.base.ts` on `master` still has the getter and
  `_slottedInputObserver`, and `master` moved to FAST Element v3 (commit cb3684e3c, 2026-06-26), which is in no
  published release (npm `latest` is still 3.2.1). Whether that move fixes it is unverified. Re-check both at the
  next release bump.

Skipped, not failing:

- **Behaviour AF-02**: a browser autofills a native `<select>` only, and Fluent's dropdown draws a
  `[role=combobox]` listbox, so the kit skips the case for this binding.

Notes:

- A `fluent-link` draws its anchor as an empty, inert proxy `a[href]` in its light DOM and keeps the
  link's words in the host. The suite reads such an entry from the host (`bc.summaryLinks()`), so the
  summary's links stay Fluent's own and SUM-01, SUM-02 and SUM-04 pass. The binding's click listener
  calls `stopImmediatePropagation()` after `preventDefault()`, because Fluent's own handler ignores
  `defaultPrevented` and would open a new window on a Cmd/Ctrl click.
- Invalid look: Fluent's text input and textarea draw a red border (`colorPaletteRedBorder2`) from the
  browser's own constraint check on their inner box after the person has edited it
  (`:user-invalid`, `:state(user-invalid)`); the dropdown, radio group and checkbox draw none. The
  public `setCustomValidity()` reaches neither: it does not touch the text input's inner box, the
  textarea's state only follows its own validity pass, and the call fires a native `invalid` event. The
  binding does not call it, so Fluent's web components draw no invalid border for Datum's errors and
  only the message and its icon carry the error colour.
