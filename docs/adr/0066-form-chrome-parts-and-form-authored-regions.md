# ADR 0066: Form Chrome Parts and Form-Authored Header and Footer

## Status
Accepted.

## Context

A real form has something around its fields: a logo, a heading, the form's own title and
description, instructions with links, a language switcher, laid out beside, above or below one
another, in every language the form speaks. Two parties want a say.

A form's author knows the form's identity (its logo, its title, its instructions) and expects
the same header on every page that shows the form. The page knows its own surroundings:
whether it already has language controls, what logo it carries, what it wants to say before the
fields. A header that lived only in host wiring left the author with no way to put a logo on
the form; one that lived only in the definition left the page no way to add or suppress
anything.

A host that mounts the renderer directly also should not have to build a language switcher
itself: a control, a call to `runtime.setLocale()`, and the reconciliation around it (the
runtime throws for a locale outside `localization.supportedLocales`, and the control must not
be left showing a locale the form refused). A switcher built outside the form cannot be reached
by the binding's CSS, which lives in the form's shadow root.

## Decision

### Regions and parts

1. **Two regions, `header` and `footer`, each a list of typed parts.** `FormChromeConfiguration`
   (`core/schema/form-chrome.ts`, re-exported by the render module) is `{ header, footer }` plus the
   host-only keys below.
   - The part types are `language-switcher`, `image` (`src`, `alt`, `href`, `width`, `height`),
     `heading` (`text`, `level` 1–3), `text`, `html` (through `sanitizeStaticHtml`), `form-title`
     and `form-description` (the root's own texts), and `group` (`parts` on one row, `justify`,
     `verticalAlign`).
   - A new kind of chrome is a new member of the union, never a change to the shape a host sets.

2. **Authored parts are strings, host parts are `LocalizedText`.** A form author's part texts (and
   an image's `src`, `href`, `alt`) are plain strings in the form's default language; their
   translations live in the definition's `translations` section under kind `chrome`, keyed by the
   part's `id` (ADR 0158).
   - Every authored part carries an `id`, unique across the header, the footer and groups; the load
     check reports `chrome.part.id.missing` and `chrome.part.id.duplicate`, and the renderer draws a
     part with no usable id in the form's own language rather than in another part's translation.
   - Parts a host adds keep `LocalizedText`, resolved through the host's catalog.
   - A resolved URL is held to the `html` component's rule (`isSafeUrl`); an unsafe or empty one
     draws nothing.

3. **Layout is rows and groups.** A region is a vertical stack; each top-level part is a row,
   placed by its `align` (`start`, `center`, `end`; a switcher defaults to `end`, content to
   `start`, in the writing direction so a right-to-left form mirrors). A `group` puts several
   parts on one row, spread by `justify`, wrapping when narrow. "Beside" is a group; "above"
   and "below" are the order of rows.

4. **The renderer draws the regions with the form.** `chromeFeature()`
   (`render/live/chrome.ts`) draws the header region before the form's title and the footer
   after the fields. The
   regions are Datum's markup whichever binding draws (`.datum-form__header`,
   `.datum-form__footer`, each a stack of `.datum-form__chrome-row`s), and are `inert` while a
   submission is in flight, so a locale cannot change under values chosen in the other. A region
   with nothing to draw draws no element.

### Two sources

5. **The form's author composes chrome, and the definition carries it.** The root's
   `configuration.chrome` holds the `{ header, footer }` shape, read at use by
   `readFormChromeConfiguration`: unknown part types and malformed entries are dropped and
   nothing is rewritten into the definition. The block is an additive optional property. The
   builder edits it in the Header & footer panel (ADR 0103). `chrome.frame` in the same block
   chooses the frame drawn around the form (ADR 0068).

6. **A host sets chrome as wiring.** `<datum-form-renderer>.chrome` (forwarded by
   `<datum-form-host>.chrome`, and a property and JSON attribute on `<datum-form>`) takes the
   same shape plus two host-only keys, `formChrome` and `formLanguageSwitcher`. The short form
   of a host switcher is `<datum-form-host>.languageSwitcher` (a boolean) and the
   `language-switcher` attribute of `<datum-form>`; an explicit `chrome` wins over it.
   Hosts do not supply a locale list: a switcher always offers the form's own
   `localization.supportedLocales`.

7. **Host chrome is read like the author's.** A host that lets administrators write chrome JSON
   could otherwise break out of an attribute or a class name through a group's `justify` and
   `verticalAlign`, an image's `width` and `height`, or `align`.
   - The renderer reads the host's chrome with `readHostChromeConfiguration`, which reads parts as
     `readFormChromePart` does and keeps `formChrome` and `formLanguageSwitcher`.
   - The renderer writes only known keywords and finite positive sizes, and draws nothing for a text
     that does not resolve to a string.
   - A binding's chrome adapter is handed the resolved part, never the host's raw object.

8. **The host's parts meet the author's by one rule** (`resolveRegionParts`):
   - `formChrome: "exclude"` on the host's configuration draws the host's parts alone.
   - Otherwise the author's parts draw first and the host's after them, per region.
   - There is one language switcher. An author who placed one (anywhere, in a group or not)
     decided where it goes; a host that adds one (`chrome`, or the `languageSwitcher` /
     `language-switcher` shorthand) fills that slot instead of adding a second, and its
     `label` and `hideLabel` word the author's control. `formLanguageSwitcher: false` drops the
     author's switcher instead and keeps the host's, for a page with language controls of its
     own.

   The host decides whether a switcher shows; the author may decide where.

### The language switcher

9. **The renderer owns the switch; the binding draws the control.** A switcher's adapter is handed a
   `LanguageSwitcherState` (`render/live/contract.ts`): the current locale, the options, the worded
   label, a control id, and `switchTo(code)`.
   - `switchTo` calls `runtime.setLocale()` and reports the outcome as `datum-locale-applied` /
     `datum-locale-rejected` (composed, so they bubble through `<datum-form-host>`); it answers
     `false` when the form refused, so a select is put back to the current locale.
   - Nodes are kept between draws, so focus stays on the switcher across the draw the switch causes.
   - `<datum-locale-select>` remains for the builder canvas's own switcher.

10. **The option list is the form's.** A switcher offers `localization.supportedLocales` in
    their order, each under its authored label, else named in its own language through
    `Intl.DisplayNames`, else its code (`supportedLocaleOptions`, the one place a locale's label
    is decided; see ADR 0158 for how locales are declared). A switcher with fewer than two
    locales draws nothing. The engine's default label is English ("Language"); a multilingual
    host passes a `LocalizedText` label.

### Bindings, canvas, paper

11. **A binding draws any part.** A part's look is `binding.chrome[<part type>]` (a `ChromeAdapter`,
    handed a `ChromeState` with the part resolved and `content`, the renderer's own drawing of it),
    else Datum's (`render/live/datum/chrome.ts`).
    - The switcher is `binding.languageSwitcher`, else Datum's labelled select, one option per
      locale, each with its `lang`.
    - `createLanguageLinks` is the other way design systems draw it: one link per language, the
      current one as plain text or a marked link.
    - The GCDS reference binding (`bindings/gcds/src/chrome.ts`) draws the real
      `<gcds-lang-toggle>`, which offers the other of its two languages; the click switches the form
      in place.

12. **The canvas previews the form's chrome; print and PDF carry none.** The renderer element
    reads the root's chrome itself, so the builder canvas, the same element over the preview
    runtime, shows what the author composed, and a switcher picked there routes to the
    controller's locale like the toolbar's select. The canvas mounts the renderer without host
    chrome. Chrome parts carry no component id, so selection and drag ignore them. Print and the
    PDF pipeline draw no chrome: the paper shows the form (ADR 0035).

## Reasoning

Chrome stays out of the host-only world because the form's identity belongs to the form; it
stays out of the definition-only world because whether the page already has a switcher is the
page's fact. Putting the switcher decision in the definition alone would write host wiring into
a form that several applications show.
The merge rule keeps both: one switcher, placed by the author, enabled by the host.

The option list is the form's rather than a host-supplied list so that the same definition
names its languages the same way under every host and binding.

## Consequences

- A form can carry its logo, title and instructions to every page that shows it, and a page can
  still add its own parts around them or replace them, with one property and one switcher.
- A binding draws the switcher and the other parts with its design system's markup through its
  `chrome` and `languageSwitcher` adapters; Datum's own classes are `.datum-form__chrome-*` and
  `.datum-form__language-switcher*`.
- Datum's parts carry `data-chrome-part="<part type>"`, which a host or a test can find them by.
