# ADR 0174: Print configuration and the Print workspace

## Status

Accepted.

## Context

What a printed form carries besides its fields is the form's decision (ADR 0035): a heading, a running
header and footer, a scale. A form owner also needs to say which copies a person may print (the
answers, a blank form, a filled-in one), where a page must break, what only paper shows, and what the
running lines say, for instance the reference of the submission just delivered. And an author needs to
see the result without reading a print dialog, which needs a place in the builder that shows the paper.

Print is deliberately the basic path. A designed layout, exact pagination and a header that appears in
every browser belong to a PDF layout (ADR 0043).

## Decision

1. **One configuration block, read with defaults.** `configuration.print` on the form root is a
   `PrintConfiguration` (`core/schema/print.ts`), read by `readPrintConfiguration`, which never throws:
   a key that is missing or of the wrong type takes its default, unknown renditions are dropped, and a
   `defaultRendition` that is not offered is the first offered. The keys (`renditions`,
   `defaultRendition`, `titleOnFirstPage`, `scale`, `header`, `footer`, `journeyPageBreaks`) and their
   defaults are in [`docs/print-support.md`](../print-support.md), section 1. The defaults print what a
   form that says nothing prints: the title at the start of the header, the title at the
   start of the footer, and the localized page-number line at the end of the footer. A slot key that
   is absent takes its default; `""` puts nothing there.

2. **A slot is one line of text with placeholders.** `start` is the side the text starts on (left in a
   left-to-right form, right in a right-to-left one); `end` is the other. A placeholder is a path in
   double braces, never a formula, read by `resolvePrintSlot` (`render/print/slot-text.ts`). Only a
   string or a finite number prints, as plain text; a slot with placeholders is left off the page when
   every one of them (the page counters aside) is empty, whatever words surround them, so
   "Reference {{receipt.reference}}" prints nothing before there is a receipt. The placeholder names
   are in the guide, section 1.

   The text of a slot is translated like any text of the form (`form › print › header|footer ›
   start|end`). Only a slot the author wrote is translated: an empty slot prints nothing and a slot
   left to its default prints the default in every language, whatever the map still holds, and
   emptying or resetting a slot removes its translations in the same undo step.

   `host.` and `receipt.` are separate scopes because they are different things. The host context drives
   rules while the form is filled; it is part of the form's scope and the form already reads it. A
   receipt exists after delivery and describes what the server did with the answers; if it were a
   scope rules could read, a late-arriving reply would re-run them and move the answers' meaning
   under the person. So it reaches print only, as `receipt.`, and it shadows a field stored at
   `receipt`: `{{receipt.reference}}` is always the receipt's.

   The receipt is the notice's `data`. The built-in confirmation fills it from the delivery's reply,
   and a host that shows its own notice sets it itself. Either way `data` is reduced to plain JSON
   before it is kept (a depth, a count of values and a string length are bounded, listed in the guide,
   section 1), and what is past a limit, or is not plain data, is dropped, never cut. A notice with
   only `data` draws nothing on screen or on paper and takes no focus.

3. **A component says where it is drawn and how it breaks.** Per component, `configuration.print`
   (`render/core/print-options.ts`, `readComponentPrintSettings`): `on` (`both`, `screen`, `paper`),
   `show` (ADR 0035), `breakBefore`, `keepTogether` and `note`, with the values in the guide, section 2.
   `screen` is never printed, its contents with it, on a read-only form's print too.

   `keepTogether` applies to a group, panel, fieldset, step, repeating section or data grid
   (`keepTogetherApplies`, read by the inspector and the print model alike), never to a tabs or steps
   container, whose tabs and steps are sections of their own on paper. An unlabelled group kept
   together prints as a run: no heading, its nodes in a renderer-drawn wrapper (`PrintRun`) that
   carries the classes.

   Breaks are classes on the wrappers the renderer draws around every node (`datum-print__break-before`,
   `datum-print__keep-together`), so every print theme honours them without drawing anything. The
   node that leads the form, and the first node inside it at every depth, never break: only the
   title, a receipt notice and headings come before it, and a break there would leave them alone on
   the first sheet. A container draws its heading before its first child, so a break on that child
   is carried by the container instead, outermost first, and the heading is never left alone at the
   foot of the page before.

   **Paper only is limited to what holds no answer.** `paperOnlyApplies` is true for static content,
   images and containers of only those. It is false for any component that carries an answer or
   contains one, for buttons, and for a step, a steps container and a tabs container, which a person
   moves through (left off a screen, a step would be an empty stop). Where it is false, `on: "paper"`
   has no effect and the component is drawn on screen as usual. The reason is that validation knows
   nothing of print: a required field hidden from the screen for paper would block a person from
   submitting over a control they cannot see. The rule is one predicate, read by the screen fold
   (`surface: "screen"` leaves a paper-only component out as it leaves out one a rule hides,
   `surface: "paper"` keeps everything), by the inspector (the choice is disabled with its reason) and
   by the problem the builder shows under the component for a hand-written definition. No runtime,
   kernel or server reads any of it.

4. **The form offers copies; the host owns the paper.** The renderer's `printRenditions` is the offered
   list and the default; `<datum-form-host>`'s Print button is a menu of the offered copies when there
   is more than one and a plain button when there is one. `print()` without a rendition prints the
   default. An explicit `print({ rendition })` is honoured even when the form does not offer it, since
   the host asked for it. `print({ locale })` prints in another language and leaves the form's own as it
   is. Paper size and margins are the caller's (`page: { size, margin }`); everything else comes from
   the form. `preparePrintDocument(options)` builds the document `print()` would present, and the model
   it is drawn from (`PreparedPrint`), without a frame, an event or a dialog.

5. **The Print workspace.** A seventh builder workspace, after PDF, edits the settings beside a preview
   (`builder/print/`). Left, a column of cards, one a section as the inspector's are; right, one
   continuous sheet under a bar like the canvas's. The layout, the controls and the selection rules are
   described in the guide, section 3. What is decided:

   - **One sheet, not pages.** The preview is the real print document drawn at paper width in a
     same-origin frame, and the browser paginates only when it prints. So the sheet is continuous and
     says "about": a dashed line reads "Page 2 starts about here", and a component with a break of its
     own gets a line in the accent colour that names it. The estimate follows the document's own rules
     against the paper's height less the margins. Margin boxes do not render on screen, so the header
     and footer are drawn as strips at the sheet's ends from the same resolved slots.
   - **The sheet is what the chosen theme draws, or the basic theme.** After the document is drawn, the
     theme's self-check reads it; a theme whose drawers refused, or whose check finds a problem, is
     replaced by the basic theme's document, and the Preview card says so.
   - **Samples are session only.** The Preview card chooses the language, the paper (for the preview
     only) and the sample answers (a scenario of the form's tests, the answers last typed in Try it, a
     pasted submission, or none), and a box holds a sample receipt. None is written into the
     definition, the history or a draft. A form that opens as a journey is drawn from a journey runtime
     of the workspace's own (`BuilderMode.printSession`), seeded from the sample alone and never Try
     it's.
   - **A test page uses the real path.** "Print a test page" calls `print()` with the chosen copy,
     paper and language, so the document goes through `datum-print`, the frame and the dialog.
   - **Scope.** Basic only: anything per copy or exact (a header on a certain copy, a footer on the
     last page, a row's position) is a PDF layout, and the card says so.
   - **Selecting.** A component is selected on the sheet or in the card's Component picker, which is
     the keyboard's way in, and selects it on the form's controller. The click and the outline read
     one rule, the nearest thing around the pointer that stands for a component.
   - **Undo is the form's.** Ctrl or Cmd+Z, and Shift+Z or Y to redo, steps the form's history from
     anywhere in the workspace, and the browser's own undo of a box's text does not run. The pasted
     submission and the sample receipt are the exception: they are the session's, not the form's, so
     in them the keys are the browser's text undo. A write that changes nothing, or leaves an empty
     `print` block, makes no history step and stores no empty block.
   - **Drawn while shown.** While another workspace is on, the sheet is not drawn again and its
     journey runtime is let go.

6. **A lazy chunk behind a feature.** The workspace is a lazy chunk loaded the first time it opens,
   and the builder's `features` token `print` owns it: a list without it leaves the tab, the chunk and
   the settings card out. The builder takes a `printTheme` property and gives it to the canvas's
   renderer and to the workspace, so the sheet and the test page draw as the form will print. The
   agent tools read and write the form's print settings through the same paths.

## Reasoning

- **Text with placeholders, not toggles.** Three booleans (header, footer, page numbers) could say
  only that a title or a number was there. A line of text says "Reference {{receipt.reference}}",
  a form's own case number or a date, with no new setting for each.
- **Paths, never formulas.** A margin box is CSS content; it has no evaluator and a formula would
  need the sandbox. A path is what the PDF's text templates already read, so the same names work.
- **Breaks as wrapper classes.** A theme draws inside the wrapper, so one rule in the renderer's sheet
  serves every theme and a theme cannot forget it.
- **An honest estimate.** The browser does not expose its pagination before printing. A preview drawn
  as sheets would promise what the printer's margins, scale and fonts may move; a continuous sheet
  with "about here" says what is known.

## Consequences

- The running header and footer are CSS page-margin boxes: Chromium draws them, Firefox and Safari do
  not and show their dialog's own. A line that must be on every page in every browser belongs to a PDF
  layout.
- The estimated page starts are not the printer's pagination; the test page is the check.
- A form that sets nothing prints with the engine's defaults, which are what the configuration's
  absent keys read as.
- Anything that varies by copy, or must be exact, is a PDF layout's job (ADR 0043); print stays the
  fast, honest path.
