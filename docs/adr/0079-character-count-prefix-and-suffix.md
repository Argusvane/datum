# ADR 0079: Character count, prefix and suffix

## Status

Accepted.

## Context

**Character count.** A field with a maximum length that hints the limit to the browser as `maxlength` cuts the answer
short in silence: a person pasting three hundred characters into a two-hundred-character box loses
the last hundred and is told nothing.

The design systems that have a count draw it under the box instead (USWDS's `usa-character-count`,
GOV.UK's `govuk-character-count`, GC Design System's `character-count` on `gcds-input` and
`gcds-textarea`, Québec's `qc-textfield-charcount`), and every one of them removes the `maxlength`
so a person can see how far over a long answer runs and trim it themselves.

Two of them (USWDS, GOV.UK) also settle *how the count is read out*: the visible count changes on
every keystroke and is hidden from assistive technology, and a polite live region repeats it once
typing pauses, so a burst of typing earns one announcement rather than one per key.

**Prefix and suffix.** A price wants its currency sign before the box and a weight its unit after it. GOV.UK
(`govuk-input__prefix` / `__suffix` in a `govuk-input__wrapper`) and USWDS (`usa-input-prefix` /
`usa-input-suffix` in a `usa-input-group`) draw them as part of the box; the other systems
have no component but the same need.

Both systems that have one agree on the accessibility: the affixes are decorative (`aria-hidden`),
and the label or hint must say the unit, because a screen reader that read "£" before every price
box would be reading decoration as content, and one that did not would still need to know the answer
is in pounds.

## Decision

**Character count.**

**1. An option on the `length` capability.** `configuration.characterCount: true` beside a
`maxLength` (a count with no limit has nothing to count down to, so the reader
`readLengthLimits` drops the flag without one). The inspector offers it as "Show character
count" under Validation, after the limits. The render model carries `characterCount` for `text`
and `textarea` fields.

**2. The markup**, inside the control part so the datum binding's `fieldOrder` keeps it with the box,
is two spans (`datum-form__count`, keyed to the field by `data-count-for`): the limit sentence,
visually hidden, which the control is described by (`aria-describedby`, after the description and
before the error), so a screen reader learns the limit with the field; and the status, the count
as it stands, visible and hidden from assistive technology (decision 4 has the live region). Past the
limit the count carries `datum-form__count--over` and the field wrapper
`datum-form__field--over-limit`. The `field-constraints` stage refuses an over-long value on
submit; the count tells the person before then.

**3. The renderer never sets `maxlength`.** It is left off every field with a maximum length,
counted or not. The browser counts in UTF-16 units and stops the typing there, so an answer of
emoji or other characters beyond the Basic Multilingual Plane would be cut at half the limit the
check allows, and a pasted answer would be cut short in silence. The counter and the validation
own the limit, both in code points (`countCharacters`), so an emoji is one. `minlength` stays on
the control as a hint, since it never blocks typing.

**4. The count is live because the form is.** The renderer draws on every value change, so the
status is recomputed from the value with no listener of its own.

- The renderer adds one thing (`render/live/announcer.ts`): a second after the last keystroke in a
  counted control, it writes the status's words into one polite live region for the whole form, for
  the field being typed in only: one announcement per pause, the delay USWDS and GOV.UK use.
- It speaks only for an adapter that answers `characterCount` `drawn` and leaves the announcing to
  the renderer (`behaviour.countsCharacters: "renderer"`, the default).

**5. Wording through `texts`**, page over binding over engine: `countUpTo` (the described limit; "You can enter up to {{max}} characters"),
`countLeft` / `countLeftOne` ("{{n}} characters left", "{{n}} character left"), `countOver` /
`countOverOne` ("{{n}} characters over limit", "{{n}} character over limit") and `countEmpty` (what
an empty field shows; none in the engine, where the whole limit reads as left). Every text takes `{{max}}`,
`{{count}}` (characters typed) and `{{n}}` (left, or over), so a system may count up as well as
down: USWDS opens with "{{max}} characters allowed", Québec draws "{{count}} / {{max}}". A binding
words the count in its language pack and draws it in its design system's markup.

**6. The engine's own look** is the hint style under the box, the error colour once over. There is
no PDF rendition: a printed form has no one typing into it.

**Prefix and suffix.**

**7. Two translatable properties on the single-line fields.** `configuration.prefix` and
`configuration.suffix`, plain strings in the form's default language (their translations live in
the `translations` section, ADR 0158), offered by the `affix` capability under Content beside the
placeholder to the `text` and `number` types (the standard component catalogue sets `affix: true`
for those two; a textarea, a date, a select or a checkbox has no box to flank). The render model
resolves them for the locale like a label.

**8. Who draws them.** The render model hands an adapter `prefix` and `suffix` on the field's
state, and a binding answers the `prefix` and `suffix` drawing capabilities: `drawn` when its
adapter draws them, `none` when it does not (the builder then does not offer them under that
binding). Datum's adapters draw them inside the control part (`affixedControl`,
`render/live/datum/field-scaffold.ts`), so the datum binding's `fieldOrder` keeps them with the
box, and only when the field has an affix: a `<span>` row (`datum-form__control-group`) holding the
prefix, the control and the suffix. A `<span>` rather than a `<div>`, because the field wrapper is a
`<label>`, whose content is phrasing. A character count (decision 2) follows the group.

**9. Datum's look**: each affix is drawn as the box's own edge, with the shared edge dropped and the
inner corners squared so the three read as one control. The edge and corner rules are scoped under
`.datum-form__control-group >` so a host's `border` shorthand on `.datum-form__affix` or its typed
box selector cannot undo them.

**10. A binding draws its design system's anatomy.** A design system with an input group draws
it in its binding's text and number adapters: the reference bindings draw, for example, USWDS's
`usa-input-group` and GOV.UK's `govuk-input__wrapper`. The affixes stay decorative
(`aria-hidden`) whatever draws them.

**Numbers as text boxes.**

**11. Numbers as text boxes.** Several design systems steer away from `type="number"` (its
spinner, its scroll-to-change, its silent rejection of a stray character). The datum binding
draws a number field as a text box with the model's `inputmode` (`decimal`, or `numeric` for a
whole-number step) by default (`controls.number: "text"`; `"number"` draws the native box), and
the renderer reads its value as a number either way. A binding draws what its design system
says.

## Consequences

- An author who turns the count on gets a box that does not truncate; the limit is a visible
  count and a submit-time error. Nothing changes for a field without the flag, other than the
  absent `maxlength`.
- The count is per field, by its rendered id, so a counted field inside a collection row counts
  its own row.
- Word counts (GOV.UK's `maxwords`) are not supported; a limit is in characters, as the
  constraint is.
- The label or description must still carry the unit: the builder's field descriptions say so.
- PDF renditions and print draw the affixes beside the value under every PDF and print theme
  (`render/pdf/standard-renditions.ts`, `render/print/basic.ts`).
