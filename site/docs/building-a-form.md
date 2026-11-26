# Building a form

This is a tour of the builder in the order an author works. It edits one form definition at a time. A page that hosts the builder is described in [The builder element](/builder-element) and [Embedding the builder](/embedding-the-builder); nothing here needs that.

## The bar

One bar runs across the top. From the start:

- **Undo and Redo.** Each acts on the side you are working on, the form, a PDF layout or a journey.
- **Search commands.** Opens the command palette (see below).
- **The workspaces**, as tabs on a wide bar and as a menu on a narrow one.
- **The document**, in the middle, when you are in Journeys or PDF: the journey or layout you are editing, with a dropdown to switch, rename, duplicate, reorder, set the default or delete.
- **Full window**, which makes the builder cover the page it sits in.
- **Changes not saved**, a cue that shows while the form differs from the saved one.
- **The menu (⋮).** New form, Open form file…, Download form, Dark mode, and a Save when the page that hosts the builder provides one.
  - New and Open ask before they replace the form.
  - A new form starts with a Submit button. Download warns when a form has none, because nobody could send it.

## The workspaces

A workspace is what you are doing. Each has its own tab on the bar and its own page below it.

| Workspace | What you do there |
|---|---|
| **Form** | The canvas. Add components, arrange them in containers, tabs and steps, and set each one's label, help, validation and look in the inspector. [Components](/components) lists them. |
| **Logic** | Rules written as formulas: show, hide, require, calculate, set options. See [Rules and formulas](/formulas). Each rule names the fields it reads and the tests that pin it. |
| **Data** | The data model and the data sources: the keys a record carries, built from a JSON sample or schema, and the option lists the form loads from outside itself. See [Data model and data sources](/data). |
| **Languages** | The form's languages and every text in each of them, in one grid. See [Languages](/languages). |
| **Journeys** | Multi-step flows over the same form: steps, the rules that go from one to the next, a flow map, a Check answers step and a Try it that walks the path. See [Journeys](/journeys). |
| **PDF** | Layouts: pages drawn from the form's components, or an existing fillable PDF with its fields mapped to the answers. See [PDFs](/pdf). |
| **Print** | What the browser's printed copy carries: which versions are offered, the header and footer lines, page breaks and what shows on paper only, beside a preview sheet. See [Print](/print). |

Journeys and PDF open on a list of cards, one per journey or layout. Opening a card puts that document's designer on the page, with a back link on the canvas (‹ Journeys, ‹ Layouts). A page can hide any workspace; see [Leaving parts out](/leaving-parts-out).

Switching workspace never loses an edit: if a panel holds one that is not applied, the builder asks first.

## The strip and its panels

A strip of buttons down the side opens the panels that apply to the whole form. One panel is open at a time, and the button opens and closes it. Which buttons show depends on the workspace.

| Panel | What it holds | Where it shows |
|---|---|---|
| **Form settings** | The form's own settings, which are the inspector for the form as a whole: its identity (id, version), the Header & footer choices, PDF choices, the journey it opens as. | Form, Journeys, PDF |
| **Header & footer** | What the form shows above and below its fields, one part to a row: form title, form description, heading, text, HTML, image, language switcher, and groups that put parts side by side. It has a Parts view and a read-only JSON view, and Apply and Discard. | Form |
| **Components** | The palette: every component type, in groups, with a filter. Click one to add it after the selection, or drag it onto the form. On the Form workspace a rail of the most used types sits beside the strip, with All components to open this panel. | Journeys, PDF (the Form workspace reaches it from the rail) |
| **Outline** | The form as a tree, in reading order. Click a row to select it. Components that a rule is hiding right now are marked. | Form, Logic, Journeys, PDF |
| **Variables** | What a rule or a PDF text may name: fields by id, scopes such as `row.` and `host.`, the functions of the formula language, and the placeholders a text may hold. Click one to copy it. | Logic, Data, Journeys, PDF, Print |
| **Tests** | The form's scenarios, run as you edit. See [Testing a form](/testing). | every workspace but Languages |
| **View** | How the canvas looks, not the form: see below. | Form |
| **Settings** | What Try it uses, and the language the canvas shows: see below. | every workspace |

## The canvas

The canvas is the form as it will be drawn, with editing around it.

**Selecting.** Click a component to select it. A bar appears beside it with its name and these buttons: Edit, Move up, Move down, Move to…, Duplicate, Add logic and Delete. The same actions are in the command palette.

**Adding.** Click a type in the rail or the Components panel to add it after the selection, drag it onto the canvas where you want it, or search the palette for "Add …". Containers, tabs and steps take components dropped inside them.

**Moving.** Drag a component by its grip. For a place a drag cannot reach, press M, or Move to…: the arrow keys walk through every place the component may go and Enter moves it there (Move mode), or a dialog names the container and position. A component can only go where it is allowed.

**Duplicating.** Duplicate copies the component, with what is inside it, next to the original under new ids.

**Deleting.** Delete, or the Delete key, asks first. If rules, journey pages or PDF layouts read the component, the question lists them and offers to remove those references too; without that they stay, and are flagged as missing.

**Zoom and pan.** The width and zoom buttons on the canvas bar show the form at desktop (1280), tablet (768) or phone (390) width, and zoom in steps from 25% to 200%. Fit shows the whole form. Drag the sheet's edges for a width of your own, and drag empty canvas or hold Shift with the arrow keys to pan. Every key is in [Keyboard shortcuts](/shortcuts).

**Steps and tabs.** On a form with steps, the canvas bar has Previous step and Next step buttons to bring each into view.

## The inspector

The inspector follows the selection. At the top are the component's name and type, and a row of tabs:

| Tab | Holds |
|---|---|
| **Field** | The component's settings in sections, such as Content (label, help, placeholder), Data (where options come from, the data key), Validation, Behavior and Presentation. The ID and the path its answer is **saved to** are here. With the form itself selected, this tab is called Settings. |
| **Style** | The look options of the component's design system, when it has any. |
| **Logic** | The component's rules, with a count. Shown for components that can have rules. Each rule is a formula with a plain-words reading beneath it; Open in Logic goes to the workspace. |
| ⋯ **Edit JSON** | The component's JSON, to read and edit. |

A filter box narrows the settings by name. Settings the host page manages show "Managed by the site." instead of a box.

### Apply and Discard

The inspector edits a draft.

- Nothing reaches the form until Apply (or Enter), so a session of typing is one Undo step.
- A "Not applied" mark shows while there is a draft.
- Discard throws the draft away.
- Moving to another component, another panel or workspace asks first.

### Problems

A problem is shown under the box it concerns, and the footer summarises them: one problem is its message, several are a count that opens a list, and either leads to the box.

- Apply is never greyed out for a problem, because a disabled button says nothing. Press it and the builder takes you to the first problem instead of applying, saying "Not applied".
- The one exception is a value Apply cannot take at all, such as a pattern that is not a regular expression or a minimum above its maximum. Apply is disabled and the message under the box says why.

## Undo and redo

Undo and Redo step back and forward through every applied change on the side you are on. The form, each PDF layout and each journey keep a history of their own, and a rename that carried references with it (rules, journeys, layouts, tests) is undone as one step. Ctrl+Z and Ctrl+Shift+Z do the same on the canvas.

## Try it

**Try it** on the canvas bar fills the form as a person would, with the real runtime: rules fire, validation runs, journeys move. The button reads Preview in a designer that has nothing to fill, and Back to editing returns to the canvas. A panel beside the form shows:

- **Last submit**: whether the form was accepted, refused or could not be sent, and when. A form with no Submit button says so, with a button that adds one.
- **Typed answers** and **Clear answers**.
- **Show the form** as Fill in or Read only, and Print.
- **Checks**: Check now or as answers change, in the browser and, with the sandbox, on the server.
- **Submission data**: the answers as a submission carries them, with a Copy button.
- **WebAssembly validation**: run the sandbox's checks, the ones a server runs, in the browser.
- **PDF**: Preview PDF, which prints the layout the answers choose.

Record, in the Tests panel, turns what you do in Try it into a test.

A rule that reads a `host.` value has nothing to read in Try it until you give it some: set **Host values** in the Settings panel.

## The View panel

The View panel changes how the canvas looks. None of it is written into the form.

| Setting | Does |
|---|---|
| **Preview width** | Fit page, or a width from a list of devices (360 to 1024). |
| **Design system** | Draws the canvas with another design system, when the page offers several. See [Design-system bindings](/bindings). |
| **Show components a rule hides** | On by default: components hidden by a rule are drawn faded so you can reach and edit them. Try it shows the form as a person sees it. |
| **Form chrome** | The page's frame, whether the page fixes it, and whether the header, footer and language switcher show, for the preview only. |

## The Settings panel

The Settings panel is the builder's own, never the form's.

- **Language.** The language the canvas shows the form in. A form in one language has only a note pointing at Languages.
- **Submitting in Try it.** A stand-in for your server, so you can try how the form behaves before there is one. These values are used by Try it in Form, Logic, Journeys and PDF. The settings are:
  - What the server does: accepts, refuses, or cannot be reached.
  - How long it takes, 0 to 10,000 milliseconds.
  - Where "Submitting…" shows (top, bottom) and its text.
  - For an accepted form, the receipt's kind, title, message and reference (`{n}` becomes six random digits), and where it shows, plus whether the answers stay editable or turn read only.
  - For a refused form, the refusal message.
- **Host values.** A JSON object, such as `{ "role": "admin" }`, that the rules read under `host.` while you try the form.
  - It applies when you leave the box.
  - Text that is not a JSON object is reported under the box, and the last good values stay in use.
  - Clear the box for none.
  - The form keeps none of it, and the checks that run on the server's side in Try it are given the same values.
- **Data sources.** Each source the form names, shown as Simulated, From the page or Not provided. Give one a list of your own, one `value | label` a line, to try the form with it.

## Edit JSON

The ⋯ menu on the inspector opens the selected component's JSON. Edit it, and it applies like any other draft: text that does not parse, or that breaks a limit, is reported with its line and column and is not applied. The Form settings panel shows the form's own JSON the same way, and the Header & footer panel shows its parts as read-only JSON.

## The command palette

Ctrl+K (Cmd+K on a Mac), or the search button on the bar, opens a box that filters every command as you type and runs one with Enter. A command that cannot run is greyed. The groups are:

- **Workspaces.**
- **Add.** Every component the form accepts.
- **Go to.** Every component.
- **Edit.** Undo, redo, duplicate, move, delete, add logic.
- **Documents.** Open or make a journey or layout.
- **View.** Panels, full window, Try it, widths, show hidden components.
- Any commands the page added.

## Where to go next

- [Components](/components) lists every component and its settings.
- [Rules and formulas](/formulas) and [Testing a form](/testing) cover the Logic workspace and the Tests panel.
- [Data model and data sources](/data), [Languages](/languages), [Journeys](/journeys) and [PDFs](/pdf) and [Print](/print) cover the other workspaces.
- [Keyboard shortcuts](/shortcuts) lists every key.

## Saving

The definition is one JSON document. **Download form** saves it as a file, so it goes through the review and approval you already use for code:

- keep it in your repository
- see every change as a diff
- publish the version you approved

A server host registers each form by id and version, accepts a submission only for a version it has, and keeps each record under the version it answers.
