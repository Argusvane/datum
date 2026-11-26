# Concepts

This page says how a form travels from the builder to the page, to your server and into a record, and then defines each word the rest of the site uses. Each definition links to the page that covers it.

## How a form flows

1. **Design.** An author builds the form in the builder, one workspace at a time, and ends with one JSON file, the [definition](/definition). It holds the components, the rules, the journeys, the PDF layouts, the translations and the tests. Download it, or let your host save it by id and version.
2. **Publish.** A page loads the form element and points it at the definition. The page chooses what the form is drawn with (a [binding](/bindings)), which language it opens in, and which [features](/leaving-parts-out) exist. Nothing is sent anywhere yet.
3. **Fill.** The person answers. The [rules](/formulas) show, hide, require and calculate as they type, a [journey](/journeys) walks them through pages, and a [draft](/drafts) can keep their place. Everything here runs in the browser.
4. **Submit.** The element checks the answers, locks the form, and raises `datum-submit` carrying an [envelope](/submissions#what-datum-submit-carries): the answers with their context, in a canonical form, so the same answers always make the same bytes. Your page delivers the envelope to your server.
5. **Check on the server.** The server finds the same definition by id and version, and runs the same checks again in the [sandbox](/validation#on-the-server). It does not trust what the browser decided. The answer is an [outcome](/server-programs#the-sandbox-run): the errors, or the cleaned answers.
6. **Keep.** The server stores the answers as a [record](/data#what-a-record-looks-like) under the form's id and version, and answers with a [receipt](/submissions#the-reply-back-into-the-form), which the page shows to the person. A PDF can be drawn from a [layout](/pdf#layouts) or filled into a [template](/pdf#filling-an-existing-pdf), and a [signature](/signing) can cover the PDF or the answers.

A team can do the first three steps and never run a server: the person can print the form, or download a PDF. A server host takes over from step 4 without changing the form.

## Words, by where you meet them

### The form

**Definition.** The one JSON document a form is: its components, rules, journeys, layouts, translations and tests. Two definitions of the same form differ by `version`. See [The definition](/definition).

**Component.** One piece of a form: a field, a container, a display or an action. It has an `id`, a `type`, a `configuration` and, when it needs them, `rules` and `children`. See [Components](/components).

**Rule.** A formula attached to a component that decides one thing about it: whether it shows (`visibleWhen`), is required (`requiredWhen`), is valid (`validWhen`), or what it holds (`value`). See [Rules and formulas](/formulas).

**Formula.** A line of FEEL, the expression language of DMN, over the form's answers: `age >= 18`. Rules, journey conditions and PDF layout choices are all formulas. See [Writing a formula](/formulas#writing-a-formula).

**Data key.** The name an answer is stored under when it should differ from the component's `id`. The `id` is what rules and errors use, and the data key is only where the answer goes. See [Ids and data keys](/data#ids-and-data-keys).

**Data source.** A list of options a choice field loads from outside the form, instead of listing them inline. The page supplies it, or it is fetched from a URL. See [Options inline or from a source](/data#options-inline-or-from-a-source).

**Record.** What a form's answers make once they are kept: a flat map from each answer's value path to the answer, kept under the form's id and version. See [What a record looks like](/data#what-a-record-looks-like).

**Journey.** A multi-page flow over one form, written beside it. It lays components out as pages and branches between them with rules. The builder calls a page a step. A form can have several journeys, or none. See [Journeys](/journeys).

**Page.** One step of a journey: the components it asks and the routes that lead out of it. Every page the path reaches is shown. Not the web page that holds the form, which this site calls the page or the host page.

**Presentation field.** A field that belongs to one journey page and not to the form: an alias that asks a form field in other words, a worked-out value, or an answer kept in the browser alone. Its answer is never sent. See [Fields of a page's own](/journeys#fields-of-a-page-s-own).

**Layout.** A PDF layout: a named document drawn from the same answers, either generated from components or an existing PDF to fill. A form can have several, and one can be chosen by the answers. Not the builder's `layout` attribute, which sizes the builder on the page. See [PDFs](/pdf#layouts).

**Template.** An existing fillable PDF used as a layout: its fields are mapped to the form's answers and filled from them. See [Filling an existing PDF](/pdf#filling-an-existing-pdf).

**Features.** The list on the `features` attribute that says which optional parts of an element exist. With it, only the listed parts do, and the files of a part left out are never fetched. See [Leaving parts out](/leaving-parts-out).

### The page

**Look.** How Datum draws a form unless told otherwise: tokens for colour, type, spacing and geometry, a stylesheet scoped to the form, a light set and a dark set. A host restyles it with `createDatumBinding`. See [Look and chrome](/look).

**Binding.** What draws a form. Datum's own binding is the default. A binding for another design system draws the same components in that system's own markup, and the reference bindings are demonstrations of that. The word means the one that draws, and the look is what Datum's own draws. See [Look and chrome](/look) and [Design-system bindings](/bindings).

**Chrome.** The header and footer around a form, made of parts: a logo, the form's title, text, a language switcher. The page sets chrome once for every form it serves, the form's definition can carry its own, and the two are merged. See [Chrome](/look#chrome).

**Frame.** The shape drawn around the form: `seamless` in the page, `outlined` as a panel, or `paper` lifted over the page. See [Frames](/look#who-decides-the-frame).

**Draft.** A half-filled form saved under a key so the person can leave and return: the answers, the language and, in a journey, the page. See [Drafts](/drafts).

**Submission.** What the form sends when a person submits: the answers, in a canonical record. The word names the whole envelope and also the `submission` block inside it, which holds the locale, the `values` and the journey's id. See [Submissions and replies](/submissions).

**Envelope.** The canonical record `datum-submit` carries: `versionContext` (the form's id and version, and the versions the browser ran), `submission` (the locale, the `values` and the journey's id) and, when signed, `signatures`. See [What `datum-submit` carries](/submissions#what-datum-submit-carries).

**Receipt.** The server's answer to an accepted submission, usually an id and a reference, which the page shows to the person with `setNotice` or the form's own confirmation. See [The reply, back into the form](/submissions#the-reply-back-into-the-form).

**Signature.** Datum signs two things. A PDF signature (PAdES) proves a document has not changed since it was signed. A submission signature, made with a passkey, proves who sent exactly these answers. See [Signing](/signing).

**Host.** Two things, told apart by context. The *host page* is the page that holds the elements and delivers the submission. A *server host* is the Spring Boot or FastAPI package, or your own server, that serves definitions and receives submissions. See [Server hosts](/server-hosts).

### The server

**Sandbox.** The WebAssembly runtime in which the programs run: no network, no clock, no randomness, and no files beyond the read-only programs. The sandbox module is the runtime itself, a WebAssembly build of a JavaScript engine. See [Validation and the sandbox](/validation), and [How Datum uses WebAssembly](/wasm) for the parts and how to run them.

**Program.** A plain JavaScript file the sandbox runs. The sandbox program judges a submission against a definition, and the PDF program draws or fills a PDF. Each states an interface version, and a host refuses one it was not built for. See [Running the programs on your own server](/server-programs).

**Outcome.** A program's answer to one run: errors as codes with the component they belong to, never wording, and the cleaned answers when nothing blocks. See [The sandbox run](/server-programs#the-sandbox-run).

### The builder

**Workspace.** One side of the builder with its own work: Form, Logic, Data, Journeys, PDF, Languages and Print. The builder's methods call a workspace a mode. See [Building a form](/building-a-form#the-workspaces).

**Strip.** The row of buttons down the side of the builder that opens panels.

**Panel.** A docked editor opened from the strip: form settings, the header and footer, components, the outline, variables, tests, view and settings. Which show depends on the workspace. See [The shell](/building-a-form#the-strip-and-its-panels).

**Inspector.** The panel that edits whatever is selected: a component's label, help, validation and look, or a journey's page. It follows the selection.
