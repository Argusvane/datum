# Print

A form prints from the browser as a document built for paper, not as a screenshot of the screen. Answers are written out as text, long answers wrap, every page of a tabbed or stepped form is included, and the page around the form never reaches the paper. A live form and a read-only form both print.

## Printing from the page

`print()` on the form element opens the browser's print dialog on the printable document.

```js
const form = document.querySelector("datum-form");
await form.print();                          // the answers
await form.print({ rendition: "blank" });    // a paper form to fill in by hand
await form.print({ rendition: "filled" });   // the paper form with the answers written in
await form.print({ page: { size: "A4", margin: "12mm" } });
```

`rendition` is `answers`, `blank` or `filled`; left out, the form's own default prints (the answers unless the form says otherwise).

- **`answers`.** An empty field reads "Not answered".
- **`blank`.** Leaves room to write in text fields, shows every option of a choice and prints empty rows for a data grid.
- **`filled`.** Draws the same paper form with the person's answers in its boxes:
  - A date's parts hold their values.
  - A select shows its options with the chosen one marked.
  - A prefix or suffix stays beside the box.
  - A data grid has the rows that were given.
  - An unanswered field is an empty box.

`page.size` is `auto` (the dialog's own, the default), `A4`, `letter`, `legal` or `A5`. `page.margin` is one to four CSS lengths and defaults to `16mm`.

`<datum-form>` has no Print button of its own: call `print()` from a control of your page's. Printing is a call, not a button action. A [button component](/components) placed in the form has three actions, and none of them prints:

- `submit` validates and submits the form.
- `download` submits, then hands the person the submission as a JSON file. It is the form's own action, not the builder's Download, which saves the form definition.
- `pdf` draws the form as a PDF file.

## What the printed page carries

- The form's answers as text: choice labels rather than values, dates in the locale's words, "Not answered" for an empty field.
- Every tab, step and journey page on the person's path, in order, each as a headed section. A data grid becomes a table.
- A title at the top of the first page, and a running header and footer. By default the header and the footer start with the form's title, and the footer ends with "Page 1 of 3".
- A field is kept whole across a page break, and a group's heading stays with its first field.

Validation messages, buttons, signatures and images do not print. A file field prints the names of its attachments.

## Setting up the printed form in the builder

The builder's **Print** workspace is where the form's print settings live. The `print` token of the builder's `features` attribute turns it on (a builder with no `features` attribute has it). The settings card is on the left and a preview of the printed form is on the right.

The card sets:

- **Versions.** Which copies a person may print: **Answers** (a record of what was given), **Blank form** (empty boxes to fill in by hand) and **Filled form** (the boxes with the answers in them). One stays offered at all times, and one is the default, printed when none is asked for.
- **Page.** The form's title on the first page, and the scale the form prints at, from 25% to 200%. Paper size and margins are set by the page that embeds the form, not here.
- **Header and footer.** One line of text at the start and one at the end of the top and the bottom of every page. An Insert menu adds the placeholders below.
- **Page breaks and what prints.** Each journey page can start a new sheet, and the components that set how they print are listed. Select anything on the preview, or choose it in the **Component** list on the card, to set its own page break, what stays together and where it shows. The same settings are the **On paper** group in the inspector.

The preview is one continuous sheet at paper width, not separate pages: the browser decides the pages only when it prints. A dashed line reads "Page 2 starts about here", and a component that starts a new page on purpose gets a line in the accent colour with its name. The estimate is close but not the printer's own, so use **Print a test page** to see the real thing.

Above the sheet, the toolbar picks the version, the language, the paper (Letter or A4, for the preview only) and the zoom.

- **Sample answers.** Fills the preview so the header and footer have something to show: a test of the form, the answers you last typed in Try it, a pasted submission, or none.
- **Sample receipt.** A box that takes a receipt as JSON.
- **Print a test page.** Prints through the same path a visitor's Print uses.

None of this is saved in the form.

### Header and footer text

A line is plain text with placeholders in double braces, filled in as it prints.

| Placeholder | Prints |
|---|---|
| <code v-pre>{{title}}</code> | The form's title |
| <code v-pre>{{date}}</code> | The day it is printed |
| <code v-pre>{{page}}</code>, <code v-pre>{{pages}}</code> | The page number and the number of pages |
| <code v-pre>{{receipt.reference}}</code> | A value from the receipt (below). Any path in the receipt works |
| <code v-pre>{{host.userName}}</code> | A value the page gave the form as host context |
| <code v-pre>{{applicant.name}}</code> | An answer, by the path it is stored at |

A placeholder is a path, not a formula. Only text and numbers print, and as plain text.

- A placeholder with no value prints nothing.
- A line whose placeholders all print nothing is left off the page, whatever words surround them: <code v-pre>Reference {{receipt.reference}}</code> prints nothing until a receipt exists.
- A page number always counts as printed.

Each line is translated with the rest of the form's text: the Languages workspace lists them under Print.

- Leave a line empty to print nothing there.
- Use **Use the default** to put the original back.

Either one removes that line's translations, so an empty line prints nothing and a default line prints the default in every language.

```json
{
  "configuration": {
    "title": "Customer Intake",
    "print": {
      "renditions": ["answers", "blank"],
      "header": { "start": "{{title}}", "end": "{{date}}" },
      "footer": { "start": "Reference {{receipt.reference}}" }
    }
  }
}
```

Chrome, Edge and other Chromium browsers draw the header and footer. Firefox and Safari do not support the page-margin boxes they need, so those browsers show only their own dialog headers and footers. Paper is always drawn light, whatever colour scheme the page uses.

### A receipt in the header or footer

After a submission is accepted, the server's reply can go on the paper: the printed copy then carries the reference. With the `confirmation` attribute, the form shows its own notice and keeps the reply's data for print. Hand `waitUntil` a promise that resolves with the parsed reply:

```js
form.addEventListener("datum-submit", (event) => {
  if (!event.detail.accepted) return;
  event.detail.waitUntil(
    fetch("/api/submissions", { method: "POST", body: JSON.stringify(event.detail.submission) })
      .then((response) => response.json())   // { "reference": "GC-48213" }
  );
});
```

With the footer line <code v-pre>Reference {{receipt.reference}}</code>, a print after delivery ends each page with "Reference GC-48213", and a print before it shows no footer line.

A page that shows its own notice sets `data` on it, `form.setNotice({ title: "Received", data: { reference } })`. The receipt is read by print only; it does not change the form's rules.

The data is kept as plain JSON, with these limits:

- Nested at most eight levels.
- At most 500 values.
- No text longer than 2000 characters.

Anything past a limit, or anything that is not plain data, is dropped.

## Versions to choose from

A form says which versions it offers.

- A page that puts the form in the `<datum-form-host>` toolbar gets a Print button that becomes a menu when more than one is offered: Answers, Blank form, Filled-in form. A form that offers one keeps a plain button.
- `print()` without a rendition prints the form's default.
- `form.printRenditions` gives `{ offered, default }` for a page that builds its own control.
- Name a `rendition` and it prints even when the form does not offer it.
- `print({ locale: "fr" })` prints in another language and leaves the form's own as it is.
- The three words of the menu are the form texts `printAnswers`, `printBlank` and `printFilled` (see [The form's own words](/form-texts)).

## What each component does on paper

Each field and container has an **On paper** group, the last on the Field tab of the inspector, stored as `configuration.print`.

| Setting | Key | Effect |
|---|---|---|
| Shown | `on` | `both` (the default), `screen` (never printed, nor anything inside it) or `paper` (printed only) |
| Start on a new page | `breakBefore` | A new sheet begins at this component, unless it is the first thing on the form, so the first sheet never holds only the title |
| Keep together | `keepTogether` | A group, panel, fieldset, step, repeating section or data grid is not split across two sheets where it fits on one. Tabs and steps containers do not offer it: their tabs and steps print as sections of their own |
| When a rule hides it | `show` | `auto` (as on screen), `always` (with a note beside it) or `answered` (only while it holds a value) |
| Note on paper | `note` | The text beside an `always` component that a rule is hiding |

**On paper only** works for content a person reads: text, images, and containers of only those. A field the person answers is always shown on screen, because a person must see what they are asked and a hidden required field would stop them sending the form. So are steps and tabs, which a person moves through. The inspector disables the choice there and says why. The canvas marks paper-only content "Paper only" when it shows hidden components.

The note for an `always` field that a rule is hiding is "Complete only if it applies to you." unless you write your own in `print.note`. It is translated with the rest of the form's text.

- A container hidden by a rule stays off paper unless it is `always` too, or holds an `always` component, which it then frames.
- A container set to `answered` prints while any field inside it holds an answer.

```json
{
  "id": "email",
  "type": "text",
  "configuration": {
    "label": "Email",
    "print": { "show": "always", "note": "Complete only if you ticked Subscribe." }
  }
}
```

A read-only form (`mode="readonly"`) prints what it shows. It reads only page breaks, paper-only content and components set to screen only, which never print.

## The print theme

A print theme draws the printable document with its own stylesheet. The `printTheme` property takes one; left out, Datum's basic print theme (`basicPrintTheme`, whose id is `basic`) is used. `datumPrintTheme` draws Datum's own look on paper.

```js
import { datumPrintTheme } from "./datum-form.js";   // or "@argusvane/datum" with a bundler
form.printTheme = datumPrintTheme;
```

Print never loads a design system's scripts, whatever binding draws the form on screen. The printed document carries a content security policy that allows no script. A print theme that restates a design system's look may link its stylesheets and fonts, and falls back to the plain theme when they are missing.

### Writing a print theme

A print theme is an object that turns the form's print model into markup. Datum decides what prints, the wording, the structure, the page set-up and the breaks that keep a field whole; the theme only draws.

| Key | Meaning |
|---|---|
| `id`, `label` | What the theme is called. `id` is reported as `theme` on the `datum-print` event |
| `css` | The theme's stylesheet, applied after the page's own and after the basic theme's |
| `marginBox` | Declarations for the page-margin boxes that carry the running header, the footer and the page numbers. Those boxes inherit nothing from the page |
| `texts` | The theme's own words, as a catalogue of text keys |
| `draw` | Drawers for the kinds of thing on the page. A kind the theme leaves out is drawn by the basic theme |
| `selfCheck(doc)` | Runs once the printed document has loaded. It returns a list of problems, such as a missing stylesheet. Any problem and the whole document prints with the basic theme instead, with a console warning and `fellBack` on the event |

The drawers are `title`, `notice`, `field`, `group`, `grid`, `section` and `content`. Each is handed its node and a context, and returns markup made with the context's `html` tag, which escapes every value that is not markup it made. A theme must draw through that tag, never one it imports.

```js
form.printTheme = {
  id: "acme-print",
  label: "Acme print",
  css: ".acme-title { font: 700 20pt Georgia, serif; border-bottom: 2pt solid #000; }",
  draw: {
    title: (title, { html }) => html`<h1 class="acme-title">${title}</h1>`
  }
};
```

A field node has an `id`, a `type`, a `label`, an optional `hint` and `note`, `required`, `empty` and an `answer` that is one of four shapes: `text`, `choices`, `date-parts` or `files`. The context also has `model` (the title, the locale, the page set-up, the words and the whole tree), `join(parts)`, `heading(level, className, content)` and `drawAll(nodes)`. The types are exported from `datum-form.js` as `PrintTheme`, `PrintDrawers`, `PrintContext` and `PrintModel`.

## Taking the document over

Before the dialog opens, the element raises a cancelable `datum-print` event. Its `detail` holds `html`, the complete document, and `theme`, the id of the print theme it was drawn with, and `fellBack`, the problems that sent a print theme back to the basic one, when any did. Call `preventDefault()` to take the document over, to send it to a PDF service or open it in a window of your own. Nothing then prints.

A print a newer `print()` replaces, or whose element leaves the page before its dialog, opens no dialog.

## Switching print off

The `features` attribute lists what a form can do. A list without `print` makes `print()` reject.

```html
<datum-form src="/forms/intake.json" features="journeys pdf"></datum-form>
```

## When to make a PDF instead

Print gives the browser's output, and it differs a little between browsers: the header and footer are Chromium's, and the pages break where the browser breaks them. Make a [PDF](/pdf) when the document must:

- Look the same everywhere.
- Break at exact places.
- Carry a running line in every browser.
- Differ by version.
- Follow a designed layout.
- Fill in an existing PDF.
- Be tagged or held to PDF/A.
- Be signed.

The `print` settings above are not read by a generated PDF.
