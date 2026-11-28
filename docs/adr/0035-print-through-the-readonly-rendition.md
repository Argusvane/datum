# ADR 0035: Print: the read-only rendition, a live form, and print drawn apart from the live binding

## Status
Accepted.

## Context

A person filling in a form wants a copy of it on paper, or as the PDF the print dialog can
save. The `"pdf"` render mode is the PDF kernel's paged document
([ADR 0043](0043-pdf-rendering-portable-kernel.md)), with its own semantics, pagination policy
and provider seam; it is not what the print dialog shows. Generated PDFs keep their own
`pdf.exclude` and rendition choices (ADR 0043), and the PDF programs read no print setting.

Two things make a naive `window.print()` the wrong answer. The renderer is a web component
embedded in a host page, and a host may float a fixed toolbar over a canvas that scrolls
internally: printing the page prints the app bar, the rails and one viewport's worth of the
form, and every host would have to write its own print rules to fix that. And the live form is
built to be typed into (a one-line input cannot wrap a long answer, a file field offers a
picker, a design system's components hydrate with script), none of which belongs on paper. A
form drawn by a binding (ADR 0162) is a poor source for paper: a design system's web components
may not have hydrated by the time the print dialog opens, and hydrated ones clip long answers
and split across pages. Print may not run a design system's script or take answers into markup
unescaped.

A form is also printed in one of two situations that need different paper. A submitted form
someone reads back should print what it shows. A live form printed to fill in by hand should not
drop a field because a rule hides it for the current answers: a blank printout that loses every
field a rule could show leaves the person nowhere to write. A tab, a step, a journey page or a
collapsed part must also not keep what it holds off the paper.

## Decision

1. **What prints is a print model of the read-only rendition.** `print()` reads a fresh
   `readonly` render output off the runtime (`readPrintSource`, `render/print/model.ts`) and
   folds it the way the live form is folded: every tab, step and journey page on the person's
   path as a headed section in order, grids as table rows. Every answer is worded before
   drawing. Errors, notices, buttons and signatures never print. A read-only or disabled form
   prints what it shows; a live one follows each component's `print.show` (decision 10).
   `rendition: "blank"` prints a paper form to fill in by hand. **There is no new
   `RenderMode`**: print is a presentation of the read-only form, not a document model.

2. **A print theme draws static markup.** A `PrintTheme` (`render/print/theme.ts`) is a set of
   drawers from the model to markup made by the `printHtml` tag, which escapes every value that
   is not markup it made, plus a sheet. The renderer owns what prints, the wording, the
   structure, the page set-up and the breaks that keep a field whole. `basicPrintTheme` is the
   default and needs nothing from the host; `datumPrintTheme` prints Datum's face. A host sets
   another through `<datum-form-renderer>.printTheme`. A drawer that throws or returns anything
   but `printHtml` markup, or a theme's `selfCheck` that reports a problem in the loaded
   document, prints the whole form with the basic theme instead, with a console warning.

3. **The document runs no script.** `buildPrintDocument` (`render/print/document.ts`) writes a
   complete document with `script-src 'none'`. The host's `assets` stylesheets and fonts are
   linked (absolute, with their integrity) for a theme other than Datum's two; scripts never
   are. A design system's components would not have hydrated when the dialog opens.

4. **The renderer presents it through a hidden same-origin frame.**
   `presentPrintDocument` (`render/web-component/print-frame.ts`) brings the document into an
   `about:blank` frame appended to `document.body`, waits for its sheets, fonts and images, and
   calls the frame's `print()`. Only the form reaches the paper, whatever the host has around
   it. The frame is reclaimed on `afterprint`, on the next print, or when the element
   disconnects, never on a timer. The wait and the parse are in
   [`docs/print-support.md`](../print-support.md), section 5. The frame's print fires its
   `beforeprint` and `afterprint` on the frame's window, not the page's. The page's own print
   (the browser's Print command) is not this document: it prints the live form as the binding
   draws it, and from the page window's `beforeprint` to its `afterprint` (or while `print`
   media matches) the live form draws every tab and step as a headed section in order
   (`setPrinting`, ADR 0081's flat view). A `features` list without `print` leaves that print as
   the screen draws it.

5. **A cancelable `datum-print` event is the host's seam.** Before presenting, the renderer
   dispatches `datum-print` carrying the document HTML, the theme and, when it fell back, why.
   `preventDefault()` hands the document to the host (a PDF service, a window of its own) and
   opens no frame.

6. **The button is the engine's, beside Validate.** `<datum-form-host>` carries a Print button
   on its actions row, exposed as `::part(print)` the way Validate is `::part(validate)`, and
   forwards the click to the renderer's `print()`. When the form offers more than one rendition
   the button opens a menu of them (ADR 0174). A host composing the bare renderer calls
   `print()` itself.

7. **Builder chrome and form chrome never print.** Print draws from the model, not from the
   live form's tree, so canvas hooks, `extraStyles` and shown-hidden components (ADR 0028) do
   not reach the paper, and neither does the form's header and footer chrome (ADR 0066).

8. **What the printed form carries is the form's own configuration.** `configuration.print`
   on the form root is read by `readPrintConfiguration` (`core/schema/print.ts`) and edited in
   the builder's Print workspace (ADR 0174). A form that says nothing prints its answers with a
   running header and footer carrying its title, a page number line at the end of the footer,
   and a heading on the first page, at scale `1`. The scale is CSS `zoom`, which changes
   layout, so page breaks fall where the scaled form needs them. The paper itself
   (`page: { size, margin }`) is the caller's.

**Two prints: a live form and a read-only form**

9. **Two prints.** A form in `mode="readonly"` prints exactly what it shows, and reads only the
   breaks, paper-only content and `on: "screen"` (ADR 0174). A live form (`interactive`) prints
   by each component's print setting. Either way the print is built from the read-only render
   output, never from what the live form has drawn. `print({ rendition: "blank" })` prints
   either as a paper form to fill in by hand, every answer left empty with room to write; it
   follows the same settings, except that a component printed only when answered prints as on
   screen. `print({ rendition: "filled" })` prints that paper form with the answers written in;
   what prints follows the `answers` rules exactly.

10. **The print setting, per component** (`configuration.print`, `render/core/print-options.ts`).
    `print.on` says where it is drawn (screen, paper or both; paper-only is limited to what
    holds no answer, ADR 0174). `print.show` says what a live print does while a rule hides the
    component: `auto` leaves it as on screen, `always` prints it with its contents and a note,
    `answered` prints it only when it holds an answer (a column of a data grid or repeating
    section, when any row answers it). `print.breakBefore` and
    `print.keepTogether` are the breaks (ADR 0174), and `print.note` is the text printed beside
    a field printed `always` while a rule hides it. A read-only print reads the breaks and
    `print.on` and no other setting. `livePrintPlan(root)` turns the settings into a decision
    per component, which the print model applies for a live print alone; screen renders and the
    builder's canvas read none. The values and the note's default wording are in
    [`docs/print-support.md`](../print-support.md), section 2.

11. **Flat, both prints.** The print model holds no hidden panel to open: every tab and every
    step is a headed section in order, a group is its heading and its fields, a grid is table
    rows. What the paper looks like is the print theme's (decisions 2 and 15). A host that
    cancels `datum-print` and keeps the document gets the same paper.

12. **Authoring sits where the author is looking.** The settings are an "On paper" group on the
    inspector's Field tab, and a show rule's editor offers "print it while the rule hides it",
    which sets `print.show: "always"` and, when the field has no note, writes the rule's own
    sentence as the note. The form root has no inspector group: its print block is edited in the
    Print workspace (ADR 0174).

13. **Journeys print the person's path.** The print reads the read-only render output, which the
    render bridge never draws as a journey's page (`buildRuntimeRenderOutput` applies
    `journeyView` to interactive renders only), and takes the journey's pages from the runtime's
    `journeyView`: each page on the person's path is a headed section, in path order, titled by
    the page's title (else its first labelled component), holding the components the page lists.
    Each component is printed once, on the earliest page that lists it or a container holding it,
    the rule Check answers lists a field by (ADR 0172). A live print adds each page off the path that holds a component printed whatever the rules
    say, at its place in the journey's order, with only those components. A journey kit that
    cannot pick a page's components (the no-op kit, ADR 0144) prints the form whole.

**Print is drawn apart from the live binding**

14. **The print model is the input of a pure function.** `print()` (`<datum-form-renderer>`, and
    `<datum-form>`, which forwards to it) builds a `PrintModel` (`printModelOf`,
    `render/print/model.ts`). The model is the presentation fold (ADR 0162) of the read-only
    output, with every word already chosen: choice labels with each option marked (a stored value
    no option lists as a chosen option of its own), dates and numbers formatted for the locale
    through `Intl` (a date the calendar does not have as stored), "Not answered" (for text of
    spaces alone too), a password's answer as a mask, prefixes and suffixes. It
    carries:
    - the rendition (`answers`, `blank`, `filled`; decision 9). A call that names none prints the
      form's default rendition (ADR 0174). `filled` reuses the shapes of the other two: a text
      answer is the value alone with its `prefix`/`suffix` apart; a select is `choices` with the
      chosen option marked; a date is `date-parts` whose parts carry a `value`; a data grid has
      only the rows given; an unanswered field is `empty` with no words to draw;
    - the title, `lang` and `dir`, and the page set-up (size and margins from the caller; from
      the form's `configuration.print` the running header and footer, resolved to text and page
      counters, the title on the first page, the scale and the journey page breaks);
    - the structure: groups, grids as table rows, and tabs, steps and journey pages as headed
      sections in order;
    - a panel's look: a labelled `panel` whose `cssClass` holds one of the four shared look
      classes (`render/live/look-classes.ts`, ADR 0162) carries it as `PrintGroup.look`; the last
      one written wins. No other container carries one, and an unlabelled panel still dissolves
      into the fields around it.

15. **A theme declares its renditions, and the renderer owns everything but the drawing.** A
    node kind the theme leaves out is drawn by the basic theme. Beyond what decision 2 lists,
    the renderer owns the margin boxes, the breaks the author sets (carried as the classes
    `datum-print__break-before` and `datum-print__keep-together` on the wrapper the renderer
    draws around every node), the wait for sheets and fonts, the self-check and the fallback.
    The theme only draws.

    It draws the rendition the model carries (`model.rendition`) and declares the renditions it
    draws in `renditions` (absent: `answers` and `blank`). `filled` hands a drawer shapes the
    other two never do, so a theme that does not handle it would misdraw all three. The
    renderer's contract is therefore that a theme declares the renditions it draws: asked for
    another, the whole document is printed with the basic theme and `fellBack` says why, through
    the same fallback a refusing drawer takes. `basicPrintTheme`, `datumPrintTheme` and the GCDS
    theme declare all three, `filled` as the `blank` form's boxes with the answers inside them (a
    box grows with its answer, never a fixed height, so a long answer is not clipped).

    A group's look is drawn in every rendition by every shipped theme, from the theme's own
    tokens. Paper's default is the theme's own group, whatever the binding's default on screen
    is, so a form prints the same whichever binding drew it; only a look the author chose
    changes the box. The four looks, and how a box that splits across pages keeps its border,
    are in [`docs/print-support.md`](../print-support.md), section 4.

16. **Markup a theme hands back is `SafeHtml`.** Every drawer returns `SafeHtml`, and the only
    way to make one is the `printHtml` tag (`render/print/safe-html.ts`). The tag escapes every
    value that is not already `SafeHtml`. The brand lives in a module-private `WeakSet`, so an
    object shaped like `SafeHtml` is not one. A theme draws with the tag it is handed in its
    context (`context.html`), which belongs to the engine copy that drew the form, so a theme
    built as a separate package bundles no engine code. A drawer that returns a plain string, or
    markup made by another copy of the tag, is refused, and so is a self-check that reports a
    problem; either way the whole document prints with the basic theme, with a console warning
    and `fellBack` on the event. A theme that forgets to escape an answer cannot put it into the
    document as markup.

17. **The print document is pure, and the frame parses it.** The `script-src 'none'` policy of
    decision 3 is a `<meta http-equiv="Content-Security-Policy">` tag in a complete,
    self-contained HTML document. The document is pure, so a host can build one under Node for a
    server's headless browser. In the browser, `preparePrintDocument(options)` on the renderer
    builds the same document `print()` would present, with the model it is drawn from
    (`PreparedPrint`), and presents nothing: a page that shows the print itself, such as the
    builder's Print workspace, draws that. The host's stylesheets and fonts are the same `assets`
    list the binding draws with (ADR 0164). Datum's own print themes need nothing from the host,
    so no host file is linked for them. The frame parses the document with `DOMParser` and brings
    its nodes in; nothing goes through `document.write`.

18. **The print themes Datum ships.** `basicPrintTheme` is system fonts, black on white, with
    drawn choice marks. It is the default (`printTheme` unset) and the fallback behind every
    other theme. `datumPrintTheme` is the basic markup in the Datum binding's light tokens (ADR
    0163); paper is light whatever the page's scheme, and the dark token set never reaches
    print. `bindings/gcds/print` (`gcdsPrintTheme`) is the worked example of a design system's
    print theme: GC Design System's stylesheet ships only tokens and fonts without its script,
    so that theme restates its components from `--gcds-*` tokens, and its self-check requires
    the tokens its `tokens.json` lists.

## Reasoning

A print model rather than the live form's DOM: the live form is drawn by a binding whose
markup the engine does not own, and paper needs every answer as text that wraps. Static
markup from pure drawers is the same on every binding, and the basic theme is a fallback that
always prints. A blank printout has to keep every field a rule could show, which only a
print setting per component can say, so a live print and a read-only print differ in what
they read and not in how they are drawn.

## Consequences

- The running header and footer are `@page` margin boxes written by `printPageCss`. Chromium
  renders them; Firefox and Safari do not, and their dialogs' own headers and footers remain
  the fallback there. Control over pagination beyond that stays the PDF pipeline's job.
- The model, the drawers and the document builder are DOM-free and exported from the render
  barrel, so Node tests cover them and a host can build the same document for a headless
  browser. `npm run test:print` in `engine/` prints fixture forms to PDF in Chromium and reads
  them back.
- The frame inherits the page's content security policy. Its sheets are applied as constructed
  sheets, so `style-src` needs no `'unsafe-inline'`. Under Trusted Types the parse goes through
  a policy named `datum-print`, which a host allows beside lit-html's
  (`trusted-types lit-html datum-print`).
- Paper never depends on a design system's script having run, and a third-party print theme
  cannot inject a person's answer into the print document as markup. A design system without a
  print theme prints in the basic theme.
- A blank or half-filled printout of a live form carries every field the author marked
  `always`, each saying when it applies. A read-only form's printout shows what was answered and
  shown. A component marked on screen only (`on: "screen"`, an office-use box) stays off paper,
  live or read-only, and one marked `answered` prints only once filled.
- Hosts translate the `printOnlyIf` text key. `print.*` is configuration the server-side
  programs ignore.
- The full account is in [`docs/print-support.md`](../print-support.md).
