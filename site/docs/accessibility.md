# Accessibility

Datum's own form look is checked with automated tools only (axe-core 4.14.1, no manual audit), and the renderer supplies the behaviour that every form needs: an error summary, focus that goes to the first error, labels tied to their fields, keyboard operation of tabs and steps. The rest depends on how the form is written and the page it sits on.

## What is measured

The form that Datum draws in its own look, light and dark, is audited with axe-core in two layers. The report is regenerated from committed baselines, and a test holds it to them.

| Layer | What it sees | What it cannot see |
|---|---|---|
| Markup, axe-core in jsdom | Names, roles, states, relationships, language, list and table semantics, target size markup | Colour, layout, anything a stylesheet decides |
| Browser, axe-core in headless Chrome | The form as painted, including colour contrast under each colour scheme | Hover and focus states, because axe measures the static state |

The audited fixture has one of every standard component. It is audited in three states:

- As an interactive form.
- As a read-only form.
- In French (Canada) after an invalid submit.

The report has no automated findings for the light look or the dark look (axe 4.14.1). It makes no claim of conformance to a WCAG level. It also lists the rules that passed and the one rule axe could not decide (`label-content-name-mismatch`).

Both audits use axe-core 4.14.1.

- The markup layer audits the Datum look.
- The browser layer audits it in headless Chrome, light and dark, each in the three states above.
- The committed baselines hold the results: zero violations and one incomplete rule.

The audit covers the form's own look only. It does not cover the builder, a design-system binding, or a host's restyled tokens, and it cannot see hover and focus states.

These checks catch many problems and not all of them. They do not replace testing with a keyboard and a screen reader, and they cover the form's own markup, not the page around it.

## What the renderer does for every form

- **Error summary.** After an invalid submit the form draws a summary of the blocking errors, each line a link to its field. `error-summary` places it at the top, the bottom, both or `none`.
- **Focus.** After a check that found errors, focus goes to the summary, or to the first field in error, opening the tab or step that hides it.
  - Where focus goes is the design-system binding's choice (Datum's own look goes to the summary); see `controls` in [Look and chrome](/look).
  - A form that sets `accessibility.focusFirstError` to `false` in its [definition](/definition) always keeps focus on the summary, and does not open the tab or step that hides the first error; a form with no summary on screen still goes to the first field.
  - Left out or `true`, focus goes as the binding says.
- **Labels and descriptions.** A field's label and description are tied to its control, and an invalid control is marked invalid.
- **Announcements.** The error summary is an alert, and a notice is an alert or a status depending on its urgency; the submitting line is a polite live region. A character count is not read out per keystroke: once typing pauses, one polite announcement gives the count.
- **Headings.** `heading-level` (1 to 6, default 1) sets the form's top heading, and the headings the form draws itself sit one level under it. A form on a page that already has an `h1` takes `heading-level="2"`. Header and footer parts of type `heading` or `form-title` are not moved by it: their `level` (1 to 3) is the level as written.
- **Tabs and steps.** Tabs follow the ARIA tabs pattern: arrow keys, Home and End move between tabs, and activation is automatic. In steps, the new step's heading takes focus, the current step is marked `aria-current`, and an upcoming step is not a way to skip ahead.
- **Read-only.** `mode="readonly"` keeps the answers as sent, for review.
- **Right to left.** The text direction follows the locale, so a right-to-left language draws the form right to left, and the tab arrow keys follow it.
- **Reduced motion and forced colours.** The look respects `prefers-reduced-motion` and `forced-colors`.

## What an author controls

The renderer can only be as good as the words and structure it is given.

- Write a real label for every field, and a description where the field needs one. A placeholder is not a label.
- Word the messages for the errors people will meet, so the summary tells them what to do.
- Give images alt text, and give the form a title.
- Keep tabs and steps for forms that need them, and name each one.
- Translate the form in the [Languages](/languages) workspace, so people read it in their own language.

## What a host controls

- The page around the form: its `lang`, its landmarks and its own headings. Set `heading-level` so the form's headings continue the page's.
- Colour. The form takes its colours from tokens a host can change, and a host that changes them owns the contrast of the result. See [Look](/look).
- Where the error summary shows, and the `texts` that word the form's own strings.
- The page's own behaviour after a submit: moving focus to a receipt, or to the next step of a larger journey.

## Design-system bindings

Datum claims nothing about the accessibility of a design-system binding. The design system is the authority for its own markup, and a binding draws it as the design system writes it. What Datum checks for a binding is the integration: what Datum passes in, owns or adds. If your form is drawn with a binding, rely on that design system's own accessibility guidance and testing. See [Design-system bindings](/bindings).
