# Print Support

How a form prints from the browser. This guide covers what the Print button produces, what the
form and each component choose, the three renditions, how a print theme shapes the paper, and what
a host can do with the document. The decisions behind it are in
[ADR 0035](adr/0035-print-through-the-readonly-rendition.md) and
[ADR 0174](adr/0174-print-configuration-and-the-print-workspace.md).

Sections 1 and 2 are for form owners, section 4 for print theme authors, and section 5 for host
developers. Sections 3 and 6 apply to everyone.

---

## The big picture

`print()` (and the **Print** button of `<datum-form-host>`'s toolbar) opens the browser's print
dialog on a document built for paper. That document is not the live form:

- **A print model.** The form's read-only render output is folded the way the live form is, and
  every answer is put into words: choice labels, dates in the locale's words, "Not answered" for
  an empty field. Every tab, step and journey page on the person's path becomes a headed section,
  in order. A data grid becomes a table.
- **A print theme.** A print theme draws that model as static markup with its own sheet.
  Datum ships two: `basicPrintTheme` (the default) and `datumPrintTheme` (Datum's look on paper).
  A design-system package can ship one more; GCDS has the worked example.
- **No script.** The document carries `<meta http-equiv="Content-Security-Policy"
  content="script-src 'none'">` and never runs a design system's JavaScript, whatever binding
  draws the form on screen.
- **Only the form.** The document is put into a hidden frame of its own and printed from there,
  so the page around the form (app bar, panels, toolbar) never reaches the paper.
- **Text that wraps.** An answer is a block of text, so a long answer wraps instead of being cut
  off at the edge of a box. A field, and a group's heading with its first field, are kept from
  splitting across a page; a component the author marked can also start a new page or be kept whole
  (section 2).
- **A panel's look.** A panel the author gave a look (`panel-outlined`, `panel-shaded` or
  `panel-card`, section 4) is drawn on paper as a bordered, a shaded or a carded box.
- **A running header and footer, a first-page heading and a scale.** The form chooses them
  (section 1). The header and footer are lines of text that can name the form's title, the date,
  page numbers, a value the person answered and the receipt the server sent back.

Validation errors, warnings, buttons and signatures do not print. Images do not print either. The
document is drawn from the model, not from the live form's tree, so the builder canvas's hooks and
extra styles, the components it shows only because "show hidden" is on, and the form's own header
and footer chrome (ADR 0066) never reach the paper.

The printed document is not the PDF pipeline. That pipeline (the PDF kernel, ADR 0043, described
in [PDF rendering](pdf-rendering.md)) produces a generated PDF with its own layouts and its own
`pdf.exclude` and rendition choices.

---

## 1. Print settings on the form

What a printed form carries besides its fields is the form's decision. It lives on the form root as
a `print` block, edited in the builder's **Print** workspace (the `print` token of the builder's
`features` attribute, ADR 0143). Every key is optional:

| Key | What it does | Default |
|---|---|---|
| `renditions` | The versions a person may print: `answers`, `blank`, `filled` (section 2) | `["answers"]` |
| `defaultRendition` | The version a print without a choice makes | the first offered |
| `titleOnFirstPage` | The form title as a heading at the start of the printed form | `true` |
| `scale` | The size the whole form prints at: `0.8` fits more per page, `1.2` prints larger. Kept within `0.25`-`2`; anything that is not a positive number is `1` | `1` |
| `header`, `footer` | A line of text at the page's `start` and one at its `end` (below) | the title at the start of each; the page number line at the end of the footer |
| `journeyPageBreaks` | Each journey page starts a new sheet | `false` |

```json
{
  "id": "root",
  "type": "form",
  "configuration": {
    "title": "Customer Intake",
    "print": {
      "renditions": ["answers", "blank"],
      "scale": 0.8,
      "footer": { "end": "Page {{page}} of {{pages}} - {{date}}" }
    }
  }
}
```

Unknown renditions are dropped, repeats collapse, an empty list is `["answers"]`, and a `defaultRendition`
that is not offered is the first offered. A key of the wrong type takes its default.

The builder writes only the keys an author changes. The title is the form's **Form title**
property, in the form's current locale. The print document's own title (what "Save as PDF"
proposes as a file name) is the form title. The scale is CSS `zoom` on the form, not a transform:
it changes layout, so page breaks fall where the scaled form needs them.

### Header and footer text

`start` is the side the text starts on (left in a left-to-right form, right in a right-to-left
one) and `end` is the other. Each is one line of text. A key left out takes its default; `""`
puts nothing there. Text between `{{` and `}}` is read as it prints:

| Placeholder | Prints |
|---|---|
| `{{title}}` | The form's title, in the print's language |
| `{{date}}` | The day of printing, in the print's language |
| `{{page}}`, `{{pages}}` | The page number and the page count |
| `{{receipt.<path>}}` | A value from the receipt the page showed after delivery (below) |
| `{{host.<path>}}` | A value from the host context the page gave the form |
| any other path | A field's answer, by the path it is stored at, as the printed copy reads it: a value hidden by a rule is left out, and a blank form reads none |

Placeholders are paths, never formulas. Only a string or a finite number prints, as plain text;
a missing value, an object, a list or a boolean prints nothing. A line with no placeholders
prints its text. A line with placeholders is left off the page when every one of them is empty,
whatever words surround them (a page counter always counts as present), so
`Reference {{receipt.reference}}` prints nothing until a receipt exists, and a lone `{{title}}`
on an untitled form prints no band. The line is translated
with the rest of the form's text (the Languages workspace lists it under Print). An empty line
prints nothing, and a line left to its default prints the default, in every language: only a line
the author wrote is translated, and emptying or resetting one removes its translations. The default page
number line is the form text `printPageNumber` ("Page {{page}} of {{pages}}"). A line is a
`@page` margin box, so it is Chromium's (section 3).

`host.` and `receipt.` are two scopes. The host context is part of the form's scope and drives its
rules while it is filled. The receipt exists after delivery and never reaches the rules; it is read
by print alone, and `{{receipt.reference}}` is always the receipt's even when the form stores an
answer at `receipt`.

### The receipt

The receipt is the notice's `data` (`setNotice({ title, data: { reference: "GC-48213" } })`), plain
JSON that is never drawn by itself: a notice with only `data` draws nothing, on the page or on
paper, and takes no focus. The built-in
confirmation (`confirmation`) fills it from the delivery's reply: the first reply that is a plain
object (a parsed JSON body, never a `Response`), or its `receipt` object when it has one. Whatever
the source, it is reduced to plain JSON: objects, arrays, strings, finite numbers, booleans and
`null`; nested at most eight levels, at most 500 values in all, and no string (key or value)
longer than 2000 characters. A value past a limit, or one that is not plain data (a function, a date, a class
instance), is dropped, not cut.

---

## 2. What prints

### Three renditions

`print({ rendition })` chooses what the paper is for:

- `answers` (the default) is a record of what the person gave. An empty field reads
  "Not answered" (the form text `printEmpty`), drawn as a muted note rather than inside a box; an
  unanswered choice reads the same, without its options (a lone checkbox keeps its empty box, and
  only `true` ticks it). Text of spaces alone is no answer, as validation reads it. A choice whose
  stored value no option lists (an answer from before the options changed) prints that value as
  a chosen option of its own; a date the calendar does not have (30 February) prints as stored. A
  password's answer prints as a mask (`••••••••`), as Check answers shows it. A data grid or
  repeating section with no rows reads "Not answered" under its heading.
- `blank` is a paper form to fill in by hand. Text fields leave room to write, a date shows its
  parts in the order the locale writes them, choices show every option, a data grid or a
  repeating section prints empty rows (one whose rows hold groups prints each empty row as its
  groups, headed by the row's name), and a required field carries its mark. It follows the same settings as the other
  two, except that a component printed only when answered (`print.show: "answered"`) prints as on
  screen, since nothing on a blank form is answered.
- `filled` is the paper form's look with the person's answers written in. It draws what `blank`
  draws, with the value inside:

| Field | In `filled` |
|---|---|
| Text, number | The value in a box that grows with it. A prefix or suffix stays beside the box, not joined to the value; a number is in the locale's words. |
| Textarea | The text, the field's rows kept as the least room the box leaves. |
| Date | The parts in the locale's order, each holding its value: the month as the locale's name when the locale words dates that way (March, mars), otherwise digits. An unanswered or unreadable date leaves its boxes empty. |
| Select | Every option, the chosen one marked. |
| Radio, checkboxes, checkbox, file | Every option with the chosen marked, an unanswered one with none marked; the attachments by name. |
| Data grid | The rows the person gave, no padding rows. |
| Unanswered field | An empty box. `filled` never prints "Not answered". |
| Required mark | Not drawn. |

  Which components print is decided exactly as for `answers`, including `print.show: "answered"`.
  A box is never a fixed height, so a long answer, or one long unbroken string, is never clipped.

### A live form and a read-only form

Which components print follows the element's `mode` (the `mode` attribute or property of
`<datum-form>`, `"interactive"` by default, `"readonly"` otherwise).

| | Live form (`interactive`) | Read-only form (`readonly`) |
|---|---|---|
| What it is for | A form someone prints to fill in by hand, or to keep a copy of as they have it | A submitted form someone reads back |
| What decides what appears | Each component's `print` settings (below) | What the form shows; only the breaks, paper-only content and screen-only components are read as well |
| A field a rule hides | Left off, unless its choice is `always`, or `answered` and it still holds a value (no note then) | Left off |
| Tabs, steps | Every panel, as a headed section in order | Every panel, as a headed section in order |
| A journey | The pages on the person's path, in order, each a headed section; a page off the path brings only its components whose choice is `always` | The pages on the person's path |

A rule that hides a field is evaluated against the answers at the moment of printing. A journey
page with no title is headed by its first labelled component, as on screen. A component prints
once, on the earliest page that lists it or a container holding it, as Check answers lists it
under the earliest step that asks it. A page off the path
that holds an `always` component is placed at its place in the journey's order, with only those
components. Where no journey kit is loaded (the no-op kit), the form prints whole.

### Which versions a form offers

`renditions` lists the versions a person may print, and `defaultRendition` the one a print without
a choice makes. A form that offers more than one gets a menu on the Print button of
`<datum-form-host>` (its choices are the form texts `printAnswers`, `printBlank` and
`printFilled`); a form that offers one keeps a plain button. `print({ rendition })` is honoured
even for a version the form does not offer, since the caller asked for it.

### The print settings on each component

A component carries a `print` block in its configuration. In the inspector it is the **On paper**
group, the last on the Field tab; the Print workspace edits the same settings
for the component selected on its preview. The form root has none in the inspector: it prints whole
and its block is edited in the Print workspace. A button prints nothing, and generated PDFs do not
read the block.

| Setting (label in the builder) | Key | Values | Default |
|---|---|---|---|
| Shown | `print.on` | `"both"`, `"screen"`, `"paper"` | `"both"` |
| Start on a new page | `print.breakBefore` | `true` | off |
| Keep together | `print.keepTogether` | `true`, on a group, panel, fieldset, step, repeating section or data grid | off |
| When a rule hides it | `print.show` | `"auto"`, `"always"`, `"answered"` | `"auto"` |
| Note on paper | `print.note` | Localized text | the form text `printOnlyIf` |

A missing or unrecognised value takes the default.

**Shown.** `screen` leaves the component off every printed copy, its contents with it, and a journey
page that lists it by id does not bring it back. `paper` draws it only on paper, and only where it
holds no answer and contains none: static content, an image, a container of only those. A field, a
container holding one, a button, a step, a steps container and a tabs container are drawn on screen
whatever the setting says (a step or a tab is something the person moves through), because a person
filling the form must see what they are asked, and validation knows nothing of print (a hidden
required field would block the submit). The inspector disables the choice there and says why, and a
hand-written definition that sets it shows a problem under the component. A builder canvas with
"show hidden" on marks a paper-only component with a Paper only tag. `screen` is read by every
print, live or read-only; a read-only form's print otherwise draws what the form shows.

**Breaks.** A component that starts a new page begins a new sheet there, except the component
that leads the form (and the first one inside it), which never breaks: a first sheet holding only
the title or a receipt is never printed. A container kept together is not split across sheets where
it fits on one; a block taller than a page splits where the page ends. A tabs or steps container is
not offered Keep together (its tabs and steps print as sections of their own; a step can be kept
together). An unlabelled group kept together prints as a run with no heading: the renderer's own
`datum-print__run` wrapper around its nodes carries the class. The classes `datum-print__break-before` and
`datum-print__keep-together` sit on the wrapper the renderer draws around each node, so every print
theme honours them. A container draws its heading before its first child, so a break set on that
child is carried by the container instead, outermost first: a named group, a repeating section or
one of its rows, a tab, a step or a journey page starts its sheet with its heading and never leaves
the heading alone at the foot of the page before. `journeyPageBreaks` puts a break before every
journey page but the first.

**When a rule hides it** (live form):

| `print.show` | Inspector wording | Effect |
|---|---|---|
| `auto` | As on screen | Printed as the screen shows it: a field a rule hides is left off |
| `always` | Always, with a note while a rule hides it | Printed even while a rule hides it, with everything inside it (except any inside component whose own choice is `screen`). While a rule hides it, the note follows it. A rule that hides a container it sits in still takes it off paper: set the container to `always` too |
| `answered` | Only when it has an answer | Printed only while its value is not empty (even if a rule hides it: a value kept from before the rule still prints, without a note); dropped otherwise. On a column of a data grid or repeating section, it prints the column while any row answers it. On a container other than a data grid it always leaves the container off, since a container holds no value of its own |

Details:

- **What counts as an answer** (for `answered`): not `undefined`, `null` or `false`, not text of
  spaces alone, not a number that is not finite, not an empty array, and not an object with no
  entry `true` (a checkboxes group with nothing ticked): the same reading as the printed field's
  "Not answered" and validation's required check.
- **Inside an `always` component.** Components below it are kept too (they print even if a rule
  hides them), but only the `always` component itself carries the note.
- **The note.** It prints under the component, only while the component is `always` and a rule
  hides it. It is localized text, resolved in the form's current locale. With no note written,
  the form text `printOnlyIf` prints ("Complete only if it applies to you."), which a form's
  `texts` translations word in other languages.
- **From the logic editor.** The editor of a show, hide or step rule has a box "On paper: print
  it with 'Complete only if…' while the rule hides it". Ticking it sets `print.show` to
  `"always"`. If the field has no note yet, it also writes the rule's own sentence as the note
  (for example "Complete only if Subscribe is ticked."). Unticking it clears `print.show` only;
  the note, reworded or not, stays.

```json
{
  "id": "email",
  "type": "text",
  "configuration": {
    "label": "Email",
    "print": { "show": "always", "note": "Complete only if you ticked Subscribe." }
  },
  "rules": { "visibleWhen": { "kind": "path", "path": "subscribe" } }
}
```

---

## 3. What the printed page looks like, and where

| Browser | Header and footer text | Heading, scale, breaks, wrapped answers |
|---|---|---|
| Chrome, Edge and other Chromium browsers (131 and later) | Drawn, through CSS page-margin boxes | Yes |
| Firefox, Safari | Not drawn: these browsers do not support page-margin boxes. Their own dialog headers and footers (page numbers included) remain available | Yes |

- Chrome's own **"Headers and footers"** option prints *beside* the form's, not instead of them.
  Turn it off for a single page number.
- The page margin is 16 mm, and the paper size comes from the print dialog, unless the host asks
  for others (section 5). The host's size and margins win; everything else comes from the form.
- Paper is light: the print document is drawn on white whatever the page's colour scheme.

### The Print workspace

The builder's Print workspace shows the settings beside the printed form. On the left is a column of cards: the copies offered and
the default, the title and the scale, the four header and footer lines with an Insert button that
opens a menu of placeholders (a button for each, as the builder's other action menus), the components that set how they print with the switch for journey
page breaks, and a Preview card. On the right is one continuous sheet under a bar with the copy
shown, the page estimate, the zoom and the test page.

- **One sheet, not pages.** The preview is the real print document drawn at paper width in a
  same-origin frame, and the browser paginates only when it prints. Where a page is likely to start,
  a dashed line says "Page 2 starts about here"; a component with a break of its own gets a line in
  the accent colour that names it (a tab, step, page or row by its heading). The estimate follows
  the document's rules (a field, a notice and a table row never split; a kept container moves whole
  where it fits; a block taller than a page splits where the page ends, but a container taller than
  a page is cut only by the fields and breaks inside it) against the paper's height less the
  margins, and the printer's own scale, margins and fonts can still move a break. Margin boxes do
  not render on screen, so the header and footer show as strips at the sheet's top and bottom,
  drawn from the same resolved lines. The footer strip is at the foot of the whole sheet, so its
  counters read as the last page ("Page 3 of 3"); the header strip's read as the first.
- **What the sheet shows.** What the chosen print theme draws, or the basic theme's document when
  the theme's drawers refused or its `selfCheck` found a problem; the Preview card says so.
- **Samples are the session's.** The Preview card picks the language, the paper (Letter or A4, for
  the preview only) and the sample answers: a test of the form (the Tests feature), the answers
  last typed in Try it, a pasted submission, or none. A box holds a sample receipt, the JSON the
  receipt placeholders read. None of these is saved in the definition, the history or a draft. With
  no sample, a field placeholder reads nothing, as on a blank form. A form that opens as a journey
  is drawn from a journey runtime of the workspace's own (`BuilderMode.printSession`), from the
  sample answers alone; Try it's own run is never touched. A line's `{{host.<path>}}` reads the
  host values given in Try it's Settings.
- **A test page uses the real path.** **Print a test page** calls `print()` with the chosen copy,
  paper and language, so the document goes through the `datum-print` event, the frame and the
  dialog: what it makes is what a person's Print makes.
- **Basic only.** Anything that differs by copy or must be exact (a header on a certain copy, a
  footer on the last page, a row's position) is a PDF layout's, and the card says so.
- **Selecting.** The component under the pointer takes the canvas's thin dashed outline and the
  selected one its solid ring. Pressing a component on the sheet, or choosing it in the card's
  Component picker (every component that prints, in the form's order, by name and type: the
  keyboard's way in), selects it on the form's controller and shows how it prints. The click and
  the outline read one rule, the nearest thing around the pointer that stands for a component: a
  tab's or a repeating section's row stands for the tabs or repeating-section component; a journey
  page stands for the component around it; and the box of a tabs or steps component spans its
  tabs' or steps' sections, which have no wrapper of their own (each step section names its
  container in the print model). The same settings are the
  inspector's **On paper** group on that component; the form root has no Print section there. The
  Variables panel lists the print names in this workspace, and the Languages workspace lists the
  four line texts under a Print group.
- **Undo is the form's.** Ctrl or Cmd+Z, and Shift+Z or Y to redo, step the form's history from
  anywhere in the workspace, as on the canvas and in the inspector, and the browser's own undo of a
  box's text does not run. The pasted submission and the sample receipt are the exception: they are
  the session's, so in them the keys are the browser's text undo. A typed value still waiting is
  written first, so one press undoes the edit just made, and the box typed in then shows the
  form's value. A write that changes nothing, or leaves an
  empty `print` block, makes no history step and stores no empty block.
- **Drawn while shown.** While another workspace is on, the sheet is not drawn again and the
  workspace's journey runtime is let go; back in Print it is measured again and drawn once.
- **The theme.** The builder takes a `printTheme` property and gives it to the canvas's renderer
  and to the workspace, so the sheet and the test page draw as the form will print. The agent
  tools read and write the form's print settings through the same paths as the inspector.

## 4. Print themes

A print theme decides what the paper looks like. It is separate from the binding that draws the
form on screen: the binding's own look never reaches print, and print never loads the binding's
script. The one look the form itself chooses, a panel's, does reach paper (below). `<datum-form>` and `<datum-form-renderer>` print with `basicPrintTheme` unless their
`printTheme` property names another:

```js
import { datumPrintTheme } from "@argusvane/datum";
form.printTheme = datumPrintTheme;   // Datum's face, ink and shapes, from its light token set
```

A theme is a plain object (`PrintTheme`):

| Member | What it is |
|---|---|
| `id`, `label` | its name |
| `css` | its sheet: after the host's stylesheets, and after the basic theme's, which draws what this one leaves out |
| `marginBox` | declarations for the page-margin boxes (the running header and footer lines); they inherit nothing from the page |
| `texts` | its words, under the page's texts and the form's translations, over the binding's language pack and the engine's English |
| `draw` | drawers by node kind (`title`, `notice`, `field`, `group`, `grid`, `section`, `content`), each optional: a kind it leaves out is drawn by the basic theme |
| `selfCheck(doc)` | run once the document's sheets and fonts have loaded; any problem prints the whole form with the basic theme instead |

### A panel's look on paper

A `panel` can carry one of four looks as a `cssClass` (`panel-plain`, `panel-outlined`,
`panel-shaded`, `panel-card`: the same names every binding draws on screen). The print model puts
the chosen one on that panel's group as `PrintGroup.look` (`"plain" | "outlined" | "shaded" |
"card"`). When several look classes are written the last one wins, and a class that is not one of
the four is ignored. Only a labelled `panel` carries a look: a fieldset, a tabs or steps
container, a grid and a journey page never do, and an unlabelled panel still dissolves into the
fields around it with no box. No class means no `look`.

A theme draws it from its own tokens, in every rendition:

| Look | On paper |
|---|---|
| none, `plain` | The theme's own group, exactly as it draws one without a look. The screen's default for a panel (Datum's card, GCDS's plain) never decides what paper does |
| `outlined` | A border of at least 1px around the whole group, heading inside, with padding |
| `shaded` | A light surface behind the whole group, with padding and no border. The shade stays legible in greyscale and the sheet asks the browser to print it (`print-color-adjust: exact`) |
| `card` | The border, and the heading on a shaded band across the top of the box |

The drawn group's element carries the look as a class beside the theme's group class
(`dp-group dp-group--card` in the basic and Datum themes, `gp-group gp-group--card` in GCDS's), and
the theme's sheet holds the rules. A box that splits across pages keeps its border, its fill and
its padding on both pages (`box-decoration-break: clone`), and the heading stays with what follows
it (`datum-print__keep`). The basic theme uses system greys, Datum's theme its light tokens (its
group is already a bordered box, so `outlined` is that box under its own name), and GCDS's theme
the `--gcds-*` tokens its looks on screen read, all of which `tokens.json` lists. A theme that
draws its own `group` reads `group.look` to do the same.

What a theme does not control:

- **Markup it did not make with the tag it is handed.** Each drawer is handed `context.html`, the
  `printHtml` template tag, which escapes every value. A drawer that returns a raw string (or a plain
  object shaped like markup, or markup made by another copy of the tag), or throws, sets the theme
  aside, and so does a `selfCheck` that reports a problem; the form prints with the basic theme
  (with a console warning and `fellBack` on `datum-print`). A theme built as its own package
  therefore bundles no engine code and draws through the tag it is handed.
- **The renderer's sheet,** which comes last: the page box (size, margins, the margin boxes with
  the header and footer text), the scale, the breaks that keep a field, a table row or a heading
  with what follows, the author's breaks, and answers that wrap. It names only the renderer's wrappers
  (`.datum-print__*`), so it holds under every theme. A theme marks a group's heading and hint
  `datum-print__keep` to keep them with the first field.
- **What prints and its words.** The print model decides which components appear (section 2),
  and every answer arrives already worded.

A theme draws the renditions from `model.rendition`, and declares which it draws:
`PrintTheme.renditions` lists them (absent means `["answers", "blank"]`). The three renditions hand a
drawer different shapes, so a theme must handle `filled` explicitly. Under `filled` a text field's
`text` is the value alone (with `prefix` and `suffix` apart, not joined), a select arrives as
`choices` with every option listed and the chosen one marked, a date as `date-parts` whose parts
carry a `value` (with the whole date worded in `text` for a table cell), and an unanswered field has
`empty: true` and no words to draw. A theme that does not handle them would draw its `answers`
drawing over those shapes and misdraw all three, so the renderer does not let it: asked for a
rendition the theme does not declare, the whole document is printed with the basic theme and
`fellBack` says why. `basicPrintTheme`, `datumPrintTheme` and GCDS's theme declare and draw all
three.

A design-system print theme leans on the design system's stylesheet and fonts. The host gives
print the same `assets` it gives the binding. For a theme other than Datum's two, the
stylesheets and font sheets are linked into the print document, and scripts never are. GCDS's
theme (`bindings/gcds/print/`) restates label, hint, input, radio, checkbox, legend, heading and
table from GCDS's tokens. Its `selfCheck` requires every token its `tokens.json` lists, so a host
that gives no stylesheet prints with the basic theme. [Writing a design-system
binding](binding-authoring.md), section 12, covers writing one.

---

## 5. What a host can do

- **Print from script.** `<datum-form>.print()` and `<datum-form-renderer>.print()` do what the
  button does. Without a rendition they print the form's default; `print({ rendition: "blank" })`
  prints the paper form, `print({ rendition: "filled" })` the paper form with the answers in it, and
  `print({ locale: "fr" })` prints in another language and leaves the form's own as it is (its
  data sources are asked in that language too, so a choice's label is the one they word in it).
  `print({ page: { size, margin } })` sets the paper: `size` is `auto` (the dialog's, the
  default), `A4`, `letter`, `legal` or `A5`; `margin` is one to four CSS lengths (default
  `16mm`). `printRenditions` on the form, the renderer and the host element gives the versions
  the form offers and its default, for a page with a control of its own. The toolbar button can be restyled through `::part(print)` (its label through
  `::part(print-label)`), or hidden and replaced by the host's own control. Its label is the form
  text `printLabel`. While a print the toolbar started is still in flight, pressing Print (or a
  choice in its menu) again starts no second one.
- **Leave print out.** With the `features` attribute (ADR 0143), a form that omits `print` hides
  the Print button, and `print()` rejects, naming the feature.
- **Build the document without printing it.** `preparePrintDocument(options)` on
  `<datum-form-renderer>` takes the options `print()` takes and returns the document with the model
  it is drawn from and the theme id (`PreparedPrint`), with no frame, no `datum-print` event and no
  dialog. It is what the builder's Print workspace previews.
- **The hidden frame.** `presentPrintDocument` parses the document with `DOMParser` and brings its
  nodes into an `about:blank` frame appended to `document.body` (nothing goes through
  `document.write`), waits for its stylesheets, fonts and images (4 seconds at most, then prints
  anyway), and calls the frame's `print()`. The frame is removed on `afterprint`, on the next
  print, or when the element leaves the page, never on a timer, which would tear a still-open
  dialog's document away. A print a newer `print()` superseded, or whose element left the page
  (not merely moved within one task) before its dialog, opens none: it is checked again once the
  wait is over, right before the frame's `print()`, and its frame is removed. The `datum-print`
  event bubbles.
- **Take the document over.** Before the dialog, the renderer dispatches a cancelable, composed
  `datum-print` event. Its `detail` is `{ html, theme, fellBack? }`: the complete document, the id
  of the theme it is drawn with, and why the chosen theme was set aside when it was. Calling
  `preventDefault()` hands the document to the host (a PDF service, a window of its own), and
  nothing prints.
- **Build the document elsewhere.** The engine's render barrel (`@argusvane/datum-engine/render`) exports
  the pieces, and they are pure:
  - `readPrintSource(runtime, options)` reads the print source from a runtime;
  - `preparePrint(source, { theme, assets, base })` and `buildPrintDocument(model, options)`
    build the document;
  - `printModelOf(source)` gives the model.

  A Node process can build the same document for a headless browser. `presentPrintDocument` is
  the frame step the element uses.
- **Content security policy and Trusted Types.** The frame takes the page's policy. Its sheets
  are applied as constructed sheets, so a `style-src` without `'unsafe-inline'` holds. On a page
  that enforces Trusted Types, print parses the document through a policy named `datum-print`,
  which the page allows beside `lit-html` (and `datum-assets` where a binding loads a script).
  [Host security](host-security.md) has the details.

---

## 6. Limits

- **Signatures and images do not print.** A file field prints its attachments' names.
- **Wide grids** print at the page's width: there is no landscape choice for one table.
- **Right-to-left** forms set `dir` on the document and swap the margin boxes' sides; their
  layout under each theme is not checked.
- **No per-print override.** The print choice is authored on the form; a host cannot pass "print
  this field anyway" at the moment of printing.
- **No exact pagination, and nothing per version.** A header that differs by version, a footer on the
  last page only, a running line in every browser, and page breaks that land the same on every
  printer belong to the PDF pipeline ([PDF rendering](pdf-rendering.md)).
