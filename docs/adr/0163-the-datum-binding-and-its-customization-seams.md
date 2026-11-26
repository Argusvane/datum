# ADR 0163: The Datum binding: its look, its surface and its customization seams

## Status

Accepted.

## Context

Datum ships one official look, its own. It also stands behind every other binding, drawing
whatever that binding does not. A host that wants Datum's behaviour with its own colours, its own
field shell or a different date order should be able to get it by setting options, not by writing
a binding or copying Datum's adapters.

That only works if the markup and the sheet give a host something stable to hold. A control needs a
class that says what it holds, because selecting by attribute cannot tell a text box from a number
box drawn the same way, and is restated for every kind. A reset written as a class and a type
(`.datum-form button`) beats a host's `.my-button`, so the sheet's own resets must lose to a host's
bare class, or every host rule would have to be scoped to win. A field's state has to be reachable on the field, not only on the
control, so a whole field can be dressed "in error" without `:has()`. And every geometric choice
has to be a token, or a host restates the box in css.

The look follows the studio. The builder draws the inspector's controls in the studio look
(ADR 0124): ink `#16171a`, input lines `#7b828c`, the accent `#2f4bd6`, Geist over the system
face, a 10px input corner, a 40px control, pill buttons, 13px/500 labels. The canvas beside the
inspector draws the form with the `datum` binding unless the author picks another. If the form
kept a different look, two styles of input would sit a hand's width apart, and a form rendered on
its own page would look like nothing the builder made.

The form's surface matters as well. The builder shell is themed by `--db-*` tokens, while the
form it previews is drawn by a binding: Datum's own reads the `--color-*` vocabulary of its
stylesheet (`render/live/datum/css.ts`), set on `.datum-form` from its token sets. The canvas sheet
stands in for the page the live form will sit on, so its colour is a property of the form as
drawn, not of the chrome around it: a light form is a light form on a white sheet whatever the
builder's own palette, as a design tool shows a white artboard on a dark canvas. "Supporting a
dark background" means the form itself can be drawn dark, on any host. That needs every colour
Datum's stylesheet reads to be a token, and the form to know its own page and emit `color-scheme`
so the native parts of a control follow.

## Decision

### Datum's look is a binding

`createDatumBinding(options)` (`engine/form-engine/render/live/datum/options.ts`) returns the Datum
binding (id `datum`, label `Datum`). It is a `LiveBinding` like any other (ADR 0162), engine-owned,
with an adapter for every engine type, and it also covers the chrome parts, frames, the summary,
the receipt, the required note, the language switcher and a journey page's heading and actions.
With no options it is Datum's own look. The element draws with it whenever no other binding is
named, and mounts it behind any other binding as `datum`, the source of every fallback.

This binding is where Datum's best practice lives. Errors are worded and tied to their control;
focus after a check lands on the checked option, else the first control, and on a date at the
first part missing in drawn order; read-only stays focusable and readable; a notice is never
drawn as an error. Datum's accessibility claims apply to this binding alone, and only to its
automated results. For a design-system binding Datum claims only that it passes Datum's
integration checks (ADR 0164).

### Its stylesheet is bundled, and every value in it is a token

The binding's CSS (`datum/css.ts`) ships in the module and is adopted into the form's shadow
root. It is never fetched, so the Datum binding never takes the asset path of ADR 0164 and works
on any page, `file://` included. Every value in the sheet is a custom property with an engine
literal as its fallback, and no colour is bare: every colour is `var(--token, <literal>)`, so a
form with no tokens set still paints from the engine's literals.

The manifest of those properties is `datum/tokens.ts` (`FORM_TOKENS`, in tiers `base`, `derived`
and `geometry`), and an engine test (`engine/tests/live-datum-css.test.ts`) holds the manifest and
the sheet to each other both ways, so a token the sheet starts reading is a manifest entry before
it ships. The values themselves are the studio look in `datum/default-tokens.ts`:
`DATUM_TOKENS` for light, `DATUM_DARK_TOKENS` for dark. The rules read the renderer's state hooks
and the form's `data-mode` and `aria-busy`, never state modifier classes; the one modifier they
select on is the field's kind class.

### Control classes, resets and field state

Every control carries `datum-form__control datum-form__control--<kind>`, on the field's own
control and on every option input (`controlClassNames`, `render/live/datum/field-scaffold.ts`).
The sheet selects on the class; the attributes stay in the markup for validation and the browser.

The resets sit at zero specificity, written with `:where()`, so a host's bare class wins by cascade
order alone. The read-only mode's rules stay deliberately strong: they are a mode, not a look.

Field state is on the field, twice. The renderer writes the state hooks on every field wrapper,
whatever binding draws (the hooks are listed in ADR 0162); a binding never writes them, and no
override removes them. Datum's field shell also carries `datum-form__field--<kind>` and the
modifiers `--required`, `--invalid`, `--disabled`, `--readonly` and `--over-limit`
(`fieldClassNames`), so Datum's sheet (for the kind class) and a host's css reach the label, hint,
error and control from one selector. The hooks are the selectors for tests, agent tools and a
host's css across bindings; Datum's `datum-form__*` classes are Datum's markup only.

Headings and the summary are semantic. The panel title, step heading, notice title and summary
heading are heading elements at a level under the form's own (`headingLevel`, the
`<datum-form heading-level>` attribute), and the summary's entries are links to their fields. The class lists
and the sheet's rules are in [`docs/binding-authoring.md`](../binding-authoring.md), section 5.

### Accessibility the Datum binding writes

These hold under the default `controls.ariaStates` (`"marked"`); the code is in
`render/live/datum/` (`choice-fields.ts`, `date.ts`, `groups.ts`, `field-scaffold.ts`).

- **A group's required marker is words.** It is announced in the group's legend, and the checkbox
  and date fieldsets carry no `aria-required`, because a `group` role has no required state. The
  radio group keeps it, since `radiogroup` supports it. A control's own label keeps the marker
  hidden from assistive technology, because `aria-required` on the control carries it.
- **An invalid date marks every part.** Each part gets `aria-invalid` and an `aria-describedby`
  that names the field's error id, so a screen reader focused on one part hears what is wrong. The
  fieldset keeps its own description.
- **Per-input state on radios and checkboxes is `controls.choiceState`.** `"group"` (the default)
  puts the state on the group only. `"each"` puts `aria-required`, `aria-invalid` and
  `aria-describedby` (the input's hint, then the group's error) on every input, because some
  screen readers do not read a group's description. The native `required` attribute is never
  written: the browser's own validation bubble would answer an implicit submit, and on a checkbox
  it demands every box.
- **A labelled container is a `<fieldset>` named by its `<legend>`.** The legend carries
  `datum-form__group-label` and the id `<instance key>__group-label` (`groupLabelId`), and the
  fieldset carries `aria-labelledby` and `aria-describedby`. A legend is outside the heading
  outline, so the group's label does not follow `headingLevel`; panel titles and step headings do.
  Datum's sheet floats the legend so that it lays out as a grid item.

### Geometry and focus are tokens

Border widths, radii, padding, minimum heights, the focus ring, label, hint, error and heading
type, button padding and spacing are tokens, each with the engine's literal as its fallback; the
manifest lists them. A `:focus-visible` rule on controls, buttons, summary links and tabs draws the
ring from the focus tokens, so a form with no tokens set shows an accent-coloured ring in place of
the browser's.

### The Datum token sets are the studio look, in literals

`DATUM_TOKENS` and `DATUM_DARK_TOKENS` (`render/live/datum/default-tokens.ts`) set the palette,
type and geometry the studio token list holds, each value copied as a literal rather than read
through `var(--db-*)`: a form must stand on a page the builder is not on. Which studio token
each Datum token is copied from is a table in [`docs/binding-authoring.md`](../binding-authoring.md),
section 5, under "Tokens". The 40px control is
`control-min-height: 40px` with `control-padding: 9px 12px`. The card line (`color-border`) is
`#9aa2ad`, the studio's `db-line-card`. The studio has no info colour;
`color-info` is `#1c6e8c`, a teal in its register that carries white text. A host changes any of
it through `createDatumBinding({ tokens, dark })`.

Native choice controls sit at the studio's size (20px, and the option row at 14px text keeps
its 24px target through `--target-min-size`), stay native, and are painted through
`accent-color` from `color-choice-mark`, unless a host sets `controls.choiceMarks: "drawn"`. The
face is the builder's, loaded by the builder: `font-family` names Geist first and falls back to
the system stack, and the binding loads no font.

Light and dark share the geometry and type (`STUDIO_GEOMETRY`). The dark set keeps its own palette,
drawn to its own floors, so the two are one form in two palettes. Text, muted text, the accent, the
error and white text on every filled button variant hold 4.5:1 on white and on the light well; the
input line holds 3:1, the error line 3:1, and the well stays 1.15:1 off the surface. The dark set
names every colour the sheet reads, so no light fallback shows through, at 4.5:1 text, 3:1 input
borders and surface steps an HDR display cannot flatten. `engine/tests/datum-token-contrast.test.ts`
resolves every text-on-fill and boundary-on-fill pair the stylesheet draws, in both sets, against
the WCAG 2.2 AA floors.

### The form owns its surface and scheme; dark is not a separate binding

`.datum-form` reads `--color-surface` (default `transparent`) for its background and
`--color-scheme` (default `normal`) for the CSS `color-scheme` property. The light set leaves both
unset, so a light form on the builder's canvas sheet, in a host's card or on a bare page takes that
surface. The dark set owns both: it paints its own surface and sets `dark`, which reaches the date
picker, the select popup and the scrollbars a stylesheet cannot.

The dark set is applied on `.datum-form--dark`, which the binding's `formClass` adds while the
host's colour scheme is dark (`colorScheme` on the element; `createDatumBinding({ tokens, dark })`
lays a host's sets over the two, and `dark: false` keeps the light look in either scheme). A
`prefers-color-scheme` response is not part of the engine's defaults: a form is embedded in a page
whose scheme the host decides, and the host passes it as `colorScheme`.

### The builder sheet follows the drawn form

`.canvas-surface` reads `--db-sheet-bg` (default `#fff`). After each draw the canvas reads the
drawn `<form>`'s computed background and writes it to `--db-sheet-bg`, or removes it when the form
is transparent (`syncSheetColour`, `builder/web-component/builder-panels.ts`). The sheet's border,
corners and shadow remain builder chrome. `--db-sheet-bg` is not a builder-theme token: a builder
theme must not pin it, and never recolours the form. A dark builder draws the canvas in the dark
scheme when the binding has a dark look (Datum's, or a binding's dark variant), else light
(`canvasColorScheme`, ADR 0157), and the sheet follows what is drawn.

### Datum's sheet follows GC Design System's practices

The Datum stylesheet follows the GC Design System's accessibility practices, written at low
specificity so a host's `css` for the same state outranks them: an invalid line on the control, a
help bubble that meets WCAG 1.4.13, a disabled look (`--color-disabled-bg`, `#eceef1` light and `#243245` dark, the panel line, the muted ink and `cursor: not-allowed`), 320px reflow, a focus ring that reaches the
native date picker, font sizes in rem, hints, errors and counts at 13px with a drawn icon on the
error, a number drawn as a text box with a numeric `inputmode`, an error summary that takes focus
on an invalid submit, a default notice that leads with its kind word, and a dark affix at 4.5:1.
The rules are listed in the guide, section 5, and held by
`engine/tests/default-themes-gc-practices.test.ts`, with `datum-token-contrast.test.ts` and
`live-datum-css.test.ts`.

### The seams

Each option of `createDatumBinding` is typed and draws through lit templates; none takes an HTML
string. They are `tokens`, `responsiveTokens` and `dark`, `css` and `formClass`, `frame`, `parts`,
`renderers`, `chrome` and `languageSwitcher`, `controls`, `fieldOrder`, and `texts`, `messages`
and `cssClasses`. What each sets is in the guide, section 5. Datum always declares the four panel
looks (ADR 0162); a host's classes join them, and a panel with none ticked is the card.

A part or override always stays inside the leaf. The field's wrapper, its state hooks, the ids
the state names, the write guard and the focus rules are the renderer's, out of a part's reach. A
part that returns `undefined` draws Datum's own; one that throws does too, and the throw is
reported on the console once per part. `composeDatumOptions(base, ...more)` builds one option set
on top of another.

### Why options, not a theme registry

The options cover every way of restyling Datum's look: tokens, dark, frames, parts, per-type
renderers, control choices and field order. Because they are typed and template-shaped, a host
customizes without a registry of looks, and the live form and the builder canvas draw from the
same binding object. Hosts and the builder pass the options with the same `binding`
setting they use for any binding.

## Reasoning

- **Literals, not `var(--db-*)`.** A form has to stand on a page the builder is not on, so the
  studio look is copied, not referenced.
- **Native choice controls, not drawn marks,** because the inspector paints its own the same way.
- **Kept, deliberately:** the error stays below the control (GC Design System puts it above), the `*` required mark stays, the native date input stays the default (parts per
  field), the secondary button stays filled, and dark is the host's choice.
- Classes by kind rather than attribute selectors let one rule serve every control that holds the
  same kind of answer. Zero-specificity resets let a host beat the engine by order instead of by
  specificity wars. State hooks written by the renderer are the same under every binding, so a
  host's or a test's selector does not depend on the binding's markup. Tokens for geometry turn a
  restated box into one line.
- The form owns its surface because a form's colour is a property of the form as drawn, and the
  builder's sheet is only the page it stands on.

## Consequences

- One binding to maintain for Datum's look. `engine/tests/live-datum-options.test.ts` holds each
  seam to a change in the drawn tree.
- Every form drawn with the `datum` binding shows the studio look, on the canvas and on its own
  page, and so does whatever a design-system binding leaves to Datum's adapters (tinted by that
  binding's `fallbackTokens`, ADR 0162).
- A host restyles Datum's form mostly through token values (`createDatumBinding({ tokens })`)
  and adds rules through `css` only for what no token reaches.
- Paper is light: Datum's print look comes from the same light tokens (`datumPrintTheme`,
  ADR 0035), and the dark set never reaches print. `DEFAULT_PDF_THEME` (`datum-pdf`) is paper's
  own: authored in points, not taken from the screen's pixels (ADR 0098).
- A host's own component CSS can read `--color-accent` (falling back to `currentColor`); under the
  Datum binding the token is set, so it follows it.
- A design-system binding draws with its own design system's CSS; none of the rules above reach
  what it draws. When it leaves the form's background transparent, the builder's sheet stays
  white.
- A host embedding the live form on a card of its own should paint the card in the form's surface
  colour, or a dark form shows a light frame.
