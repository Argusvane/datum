# The form element

`<datum-form>` renders a definition, validates the answers and raises the submission. Attributes carry the declarative part, JS properties take objects and functions, events report what happened, and methods let the page's own controls drive the form.

```html
<link rel="stylesheet" href="datum-form.css">
<script type="module" src="datum-form.js"></script>

<datum-form src="/forms/intake.json" locale="auto" draft="intake"></datum-form>
```

The tables on this page are written from the element's own code, so they list every attribute and event the element has. The same list ships as `attributes.json` in the repository's `docs/reference/` folder, for tools.

## Attributes

Almost every attribute has a property of the same meaning, named under it where the spelling differs. The two exceptions are `debug` and `allow-origins`, which are attribute only: set them with `setAttribute`. An attribute takes text, so objects are written as JSON; the property takes the object itself.

<!--@include: ./_generated/form-attributes.md-->

## Properties without an attribute

Functions, registries and custom objects are set from script.

<!--@include: ./_generated/form-properties.md-->

`printTheme` takes the theme a printed form is drawn with; Datum's basic print theme (`basicPrintTheme`, whose id is `basic`) applies when it is left out. See [Print](/print).

## Events

Every event bubbles and is composed, so one listener on the page hears every form, even from inside another element's shadow tree. Listen on the form or on `document`. The event's data is in `event.detail`.

<!--@include: ./_generated/form-events.md-->

### Event details

Every event is `bubbles` and `composed`. Only `datum-download`, `datum-pdf` and `datum-print` are cancelable.

#### `datum-submit`

See [Submissions and replies](/submissions#what-datum-submit-carries): `accepted`, `submission`, `errors`, `result`, `signed`, `submissionKey`, `trigger`, `agent` and `waitUntil`.

#### `datum-change`

| Key | Value |
|---|---|
| `path` | The value path that was written, such as `email` or `billing.street`. `undefined` when the event names none. |
| `value` | What the path now holds. |
| `values` | The form's answers as a whole, one entry per value path. Fields a journey page owns for itself are not in it. |

The event is not raised on every keystroke. See [When a change is reported](#when-a-change-is-reported).

#### `datum-validated`

| Key | Value |
|---|---|
| `errors` | The errors after `validate()` ran: a list of the entries below, empty when the form is valid. |

Each entry of `errors` is shaped like this. `submit` and `setErrors` return the same entries.

| Key | Value |
|---|---|
| `id` | An identifier of the entry, unique within the list. |
| `code` | The error code, such as `required`. |
| `message` | Text, when the stage that raised it supplied one. |
| `componentId` | The component the error is on, when it is on one. |
| `path` | Where the answer is stored, as `{ segments: [{ key, index? }] }`, when the error is on a row or a nested answer. |
| `stage` | The stage that raised it, such as `host` for an error the page set with `setErrors`. |
| `severity` | `error` (the default, blocks), `warning` or `info`. |
| `source` | `client`, `wasm`, `server` or `custom`. |
| `parameters` | Values the message names, such as `{ min: 3, count: 2 }`. |

#### `datum-ready`

| Key | Value |
|---|---|
| `runtime` | The engine's runtime object for the form just built. It is the engine's own surface and is not documented on this site: prefer the element's methods. |

#### `datum-error`

| Key | Value |
|---|---|
| `code` | A stable name for the cause, such as `definition.too-large` or `sandbox.unavailable`. Match on this. The [codes](/codes#datum-error-codes) page lists them. |
| `message` | What went wrong, in words, for showing. It may be reworded between releases. |
| `cause` | The thrown value, when there was one. |
| `sourceId` | Only for a data source that failed: its id. |
| `componentId` | Only for a data source that failed: the component that names it. |

#### `datum-warning`

| Key | Value |
|---|---|
| `message` | What was taken only in part. |
| `code` | `draft.dropped`: a restored draft held answers the form cannot hold, and the rest was restored. |
| `count` | How many answers were dropped. |
| `addresses` | The first few of them, as dotted paths. |

#### `datum-page-change`

| Key | Value |
|---|---|
| `journeyId`, `pageId` | The journey and the page the person is now on. |
| `fromPageId` | The page they left, or `null` when the journey has just started. |
| `direction` | Why: `forward` (Continue), `back`, `jump` (a page already reached), `change` (a Change link on a Check answers step), `error` (the page holding an error after a blocked submit), `start`, `resume` (a draft restored) or `redirect` (the page asked for with `page` cannot be reached with these answers; `pageId` is where the person is instead). |
| `index`, `total` | The page's place on the path as the answers draw it now, counting from 0, and how many pages are on it. Both count every page, exit pages included, so they differ from the "Step 2 of 4" count over the heading, which leaves exit pages out. |
| `title` | The page's heading in the form's language. |
| `kind` | `questions`, `exit` or `review` (a Check answers step). |
| `errorCount` | The blocking errors the page shows. |

#### `datum-locale-applied` and `datum-locale-rejected`

| Event | Key | Value |
|---|---|---|
| `datum-locale-applied` | `locale` | The language that took effect, whether the `locale` attribute negotiated it or the switcher picked it. |
| `datum-locale-rejected` | `locale` | The language the switcher offered that the form does not declare. The switcher has been put back to the form's current language. |
| `datum-locale-rejected` | `message` | The reason, for a page that wants to show it. |

#### `datum-download`

Cancelable. Fires before the browser is handed the file of an accepted submission. Cancelling takes the file over, for example to upload it, and nothing is downloaded.

| Key | Value |
|---|---|
| `submission` | The envelope, or the signed wrapper around it under the `wrapper` signing placement. |
| `fileName` | The name the file would be saved as. |
| `json` | The exact text the file would hold. |

#### `datum-pdf`

Cancelable. Fires before the browser is handed a PDF made by the PDF button, `downloadPdf()` or an assistant's tool. Cancelling takes the bytes over.

| Key | Value |
|---|---|
| `bytes` | The PDF, as a `Uint8Array`. |
| `fileName` | The name it would be saved as. |
| `layoutId` | The layout that drew it. |
| `layoutChoice` | `condition` when no layout was named and the first layout whose condition held was used. |
| `pageCount` | The number of pages. |
| `warnings` | What the PDF kernel had to say, a list. |
| `signature` | Present when the file was signed: what was signed. |
| `trigger`, `agent` | As on `datum-submit`. |

#### `datum-print`

Cancelable. Fires before the print dialog opens. Cancelling takes the document over, for example to send it to a PDF service, and nothing is printed.

| Key | Value |
|---|---|
| `html` | The complete document that would print. |
| `theme` | The id of the print theme it is drawn with. |
| `fellBack` | Present when the print theme asked for was set aside for the basic one: the reasons, a list of strings. |

#### `datum-wasm-ready` and `datum-wasm-validated`

| Event | Key | Value |
|---|---|---|
| `datum-wasm-ready` | `host` | The loaded sandbox host. |
| `datum-wasm-validated` | `blocked` | Whether the sandbox's verdict blocked the submit. |
| | `durationMs` | How long the run took. |
| | `unknownFields` | The setting the run used for keys the form does not define: `strip`, `keep` or `reject`. |
| | `logLevel` | The level the run log kept, when one was set. |
| | `values`, `externalData` | What the run was given. |
| | `outcome` | The sandbox's answer, when it gave one. See [Your own server](/server-programs). |
| | `executionError` | Why it gave none. |
| | `logs` | The run log entries, for the page to forward to a console or a logger. |

#### `datum-binding-error`

| Key | Value |
|---|---|
| `hook` | Where it failed: `assets` (a stylesheet or script of a design system did not load), `binding` (an id nobody registered), or one of the binding's own hooks such as `render`, `ready`, `focus` and `self-check`. |
| `message` | Why. |
| `id` | The field's instance key or component id, when one field's problem. |
| `url` | The file, for `assets`. |
| `problems` | A list of reasons, when the failure had several. |

#### `datum-form-action`

| Key | Value |
|---|---|
| `componentId` | The button's component id. |
| `action` | The button's configured action, as written. |
| `signature` | The button's `signature` option, when it has one. |

- A button with the action `submit` or `download`, and a journey's own Submit, is handled by the element, which raises `datum-submit` and `datum-download`, so the page does not hear it here.
- A `pdf` button reaches the page as `datum-form-action` only when the element has neither a `pdf` attribute nor a `pdfSupport` property to serve it.
- The event is not a way to attach a button action of your own: the actions a button can have are `submit`, `download` and `pdf`.

### When the form is ready

A form is built a moment after it gets its definition: a microtask after `definition` is assigned or `src` has loaded, and one chunk load later for the first journey form on a page, because journeys run from a file of their own. `datum-ready` is raised when the form is built and drawn, and `form.ready` is a promise for the same moment.

```js
const form = document.querySelector("datum-form");
form.definition = definition;
await form.ready;           // resolves once datum-ready has been raised
form.setLocale("fr");
```

How `ready` behaves:

- It resolves once `datum-ready` has been dispatched for the build, and at once when the form is ready already.
- It rejects with the reason when a build fails: the journeys file did not arrive, or the runtime refused the definition.
- A build that a newer assignment replaces rejects nothing, and `ready` follows the form becoming ready rather than one build.
- After a failure the next build, by Retry or a new definition, gives a fresh promise.
- With no definition it settles once one is set and built.
- An unawaited rejection is not reported as an unhandled one.
- Every change that rebuilds the form raises `datum-ready` again; read `ready` again for the next one.

The methods that return a promise (`validate`, `submit`, `submitAndDownload`, `renderPdf`, `downloadPdf`, `print`, the draft methods, `nextPage`, `previousPage` and `goToPage`) wait for a build under way and then run. Two methods answer at once and cannot wait, so they throw while the form is building:

| Method | Before the form is built |
|---|---|
| `setErrors` | Throws "the form is still building; call this after datum-ready". |
| `setLocale` | The same. The locale is kept, and the form is built in it. |

Both also throw `<datum-form> has no form yet` when there is no definition at all. `form.definition = d; form.setLocale("fr")` in one tick therefore throws: await `ready` between them. The `locale` attribute has no such limit; it applies when the form is built.

### What keeps the answers and what starts afresh

#### Settings that rebuild the form

Some settings are read when the form is built, so changing one builds the form again:

- `dataSources`, `translations`, `draft` and `draftStore`
- `plugins` (and a plugin registered on the page later)
- `componentDefinitions`, `features`, `formulaErrors` and `riskyPatterns`
- the signing properties
- `validateTimeout` and `dataSourceTimeout`
- `wasm` or `wasmValidationHost`, when the sandbox appears or goes

A rebuild:

- Keeps what the person typed and the language they chose, and the next submit sends those answers.
- Lets `values` assigned in the same change win over the typed answers.
- Clears errors already shown until the next check.
- Sends a journey back to the first page the person may open, with the answers kept.
- Raises `datum-ready` again.

#### Settings that apply in place

The other settings, such as `messages`, `texts`, `locale`, `frame`, `chrome`, `mode` and `binding`, take effect in place, without a rebuild. So does `hostContext`: the rules that read `host.` are worked out again over the answers typed so far, and no `datum-ready` is raised.

#### Starting afresh

Assigning `definition`, or a `src` that loads, starts the form afresh, even when it is the same object assigned again: the typed answers go, and `values` seeds the new form. Assigning is still a way to clear a form, but `reset()` is the plain one.

`reset()` takes the form back to how it first opened for its current definition.

- It clears what the person typed, the errors and notice on show, which fields were touched, and a journey's place.
- It applies the `values` the page assigned again.
- The language the person chose, the definition and every other setting stay.
- The form is built again, so `datum-ready` is raised again, and then one `datum-change` tells the page the answers are cleared: it has no `path`, and `values` holds the form's answers now.
- It resolves after that event, and does nothing on a form with no definition.

`reset()` does not touch a stored draft. It writes none and deletes none. The first change after it arms the autosave, which then saves the form as it stands, so the draft is replaced by the cleared form. To drop the draft too, call `clearDraft()` as well. See [Drafts](/drafts).

### Setting errors and notices

`setErrors(errors)` takes a list. Each entry:

| Key | Meaning |
|---|---|
| `code` | Required. The error code, such as `required` or a code of your own. |
| `message` | Text for the error. Its `{name}` slots are filled from `parameters`. |
| `componentId` | The component the error is on. Without it, and without a `path`, the error belongs to the form as a whole and is listed in the summary only. |
| `path` | A value path, such as `items[1].sku` for a field in the second row of a data grid, or `billing.street`. A path without an index names the answer's field, so the error is placed on the component stored there. A path with an index places it on that row. |
| `severity` | `error` (the default, blocks), `warning` or `info`. A warning or note is shown and does not block. |
| `source` | `client`, `wasm`, `server` or `custom`. Defaults to `server`. |
| `parameters` | Values for the message's `{name}` slots, such as `{ max: 3 }`. |

The errors:

- Replace those the form held.
- Are shown on their fields and in the summary, and move focus to the first.
- Are returned as the entries described under `datum-validated` (with `stage: "host"`).
- Stay until the next `validate()` or `submit()` replaces them; `setErrors([])` clears them.

In a journey, an error the server reported stands through the page's own checks until its answer changes, and the person is moved to the first page that holds one.

`setNotice(notice)` takes this object, or `undefined` to clear:

| Key | Meaning |
|---|---|
| `kind` | `success` (the default), `info`, `warning` or `error`. An `error` is announced at once; the others are announced politely. |
| `placement` | A list of `"top"` and `"bottom"`: the ends of the form it is drawn at. Absent or empty means `["top"]`. At both ends, the top copy is the one announced. |
| `title`, `message` | Plain text, or `{ "default": "...", "locales": { "fr": "..." } }` to follow the language. |
| `details` | A list of `{ label, value }`, such as `{ label: "Reference", value: "GC-48213" }`. `label` can be worded per language; `value` is a plain string. |
| `data` | The receipt as plain JSON, such as `{ "reference": "GC-48213" }`. It is never drawn by itself: a printed header or footer reads it as <code v-pre>{{receipt.reference}}</code> (see [Print](/print#a-receipt-in-the-header-or-footer)). A notice with only `data` draws nothing. |

The notice is drawn where the error summary goes, takes focus, and is printed with the form. The next submit clears it. The `notice` property reads what was last set.

### When a change is reported

`datum-change` reports a value once it has settled, not on every keystroke. Two attributes decide when:

| Attribute | Default | Meaning |
|---|---|---|
| `change-on` | `input` | `input`: a typed value is reported after `change-debounce` milliseconds without another keystroke, or when the field is left, whichever comes first. `commit`: a typed value is reported only when the field is left. |
| `change-debounce` | `300` | The quiet time for `change-on="input"`, in whole milliseconds. `0` reports every write. |

- A pick (a select, a checkbox, a radio) and a value the page writes are reported at once.
- A value still waiting is reported before `datum-submit`, so the answers a listener holds match what is submitted.
- Any other word for `change-on` is reported as `datum-error`.

### The confirmation

The `confirmation` attribute is a boolean. With it present, an accepted submit shows a notice with the form's own words: "Your form was submitted", a message, and a line with the reference when the delivery's reply carries one. The rule for the reference, and when the notice does not appear, is under [After acceptance](/submissions#after-acceptance). A notice the page set with `setNotice` is never replaced by it, and a download never shows it. The three sentences are `texts` keys, listed on [The form's own words](/form-texts).

### Origins and size

Four attributes name a URL the page would load code from or send answers to: `wasm`, `pdf`, `draft-store` and `validate-url`. In markup they reach places a script does not, so each is held to the page's own origin. An attribute that names another origin is reported as `datum-error` and ignored, unless `allow-origins` lists that origin.

`allow-origins` is a space-separated list of origins, each written as a URL: `allow-origins="https://cdn.example https://forms.example"`.

- A path after the origin is ignored.
- A word that names no origin, such as `*`, a bare host or a `data:` URL, is reported as `datum-error` and left out.
- It is read as an attribute only: set it with `setAttribute`.
- Changing it applies an attribute it now allows and drops one it no longer does, so it can be set after the others.

The rule has these edges:

- The properties are not held to it. A script that sets `pdfSupport`, `wasmValidationHost` or `draftStore` already runs on the page, and may name any origin.
- `src` is not covered. It is fetched with a plain `fetch`, so the browser's CORS rules, the page's `connect-src` and the server's headers decide whether another origin may serve a definition. The fetch carries no headers and no credentials. A definition behind a login is fetched by the page and assigned to `definition`.
- `src` and `definition` are used one at a time. While a `src` fetch is loading, an assigned `definition` is refused, and while a definition is assigned, `src` is refused. Both are reported as `datum-error`, and nothing changes. Clear one before setting the other.

`max-definition-bytes` caps the size of a definition read from `src`, in UTF-8 bytes.

- The default is 2097152 (2 MiB).
- A response that declares a longer length is refused unread.
- A body is read only as far as the cap, and a longer one is reported as `datum-error` and not parsed.
- The value must be a whole number above 0, or it is reported and the cap stays.
- A definition the page assigns is not held to it.

### Read-only properties

| Property | Holds |
|---|---|
| `ready` | The promise described under [When the form is ready](#when-the-form-is-ready). |
| `errors` | The errors the form holds now, as under `datum-validated`. Empty before the form is built. |
| `notice` | The notice last set with `setNotice`. |
| `submitting` | Whether a submit is in flight, from the submit until every `waitUntil` promise has settled. Also reflected as the `submitting` attribute, for a stylesheet to use. |
| `activeLocale` | The language the form is showing now: what `locale` negotiated to, or what the switcher picked. `undefined` before the form is built. |
| `renderer` | The inner `<datum-form-renderer>` element. |
| `runtime` | The engine's runtime object, the same one `datum-ready` hands out. It is the engine's own surface and is not documented on this site. |

## Methods

| Method | Does |
|---|---|
| `validate({ focus })` | Runs every check, reports the errors as `datum-validated` and resolves with them. Focus moves to the first error unless `focus` is `false`. |
| `submit({ signWith, signing })` | Validates, locks the form and raises `datum-submit`. Resolves with the same detail the event carries. A second call while one is in flight joins it; a call that asks for something different, or one made from inside a `datum-submit` listener, rejects. |
| `submitAndDownload()` | Submits and saves the submission as a JSON file in one step: the signed document when there is one, otherwise the submission. A rejected submit shows its errors and saves nothing. For a PDF, use `downloadPdf()`. |
| `setErrors(errors)` | Shows the server's errors (`code`, `message`, `componentId`, `path`, `severity`, `parameters`) on their fields and in the summary, and returns them as shown. `setErrors([])` clears them. Throws until the form is built: see [When the form is ready](#when-the-form-is-ready), and [Setting errors and notices](#setting-errors-and-notices). |
| `setNotice(notice)` | Shows a notice with a kind, a title, a message and details, such as a confirmation number. `setNotice(undefined)` clears it, and so does the next submit. |
| `reset()` | Clears the answers, errors, notice and journey position, and applies the `values` seed again. The language stays. Raises `datum-ready` and one `datum-change`, and resolves after them. A stored draft is left alone. See [What keeps the answers and what starts afresh](#what-keeps-the-answers-and-what-starts-afresh). |
| `setLocale(locale)` | Switches the form's language. Throws for a locale the form does not support, and until the form is built. See [Languages](/languages). |
| `nextPage()`, `previousPage()` | Continue and Back on a journey, from the page's own controls. Each resolves with where the form went or, with `ok: false`, the reason it stayed. |
| `goToPage(pageId)` | Opens a journey page the person has already reached, such as from a task list. Refused for a later page. |
| `journeys()` | The journeys the definition declares, for a page that offers a choice. See [Journeys](/journeys). |
| `presentationValues()` | The answers to fields a journey page owns for itself, which are kept in drafts and never sent in a submission. |
| `hasDraft()` | Whether a draft is stored under the `draft` key. |
| `saveDraft()` | Saves the answers under the `draft` key now, without waiting for the autosave. Resolves with the saved draft's summary. |
| `restoreDraft()` | Restores the stored draft after checking it against the form. Rejects with a coded error when there is none or it does not fit. |
| `clearDraft()` | Deletes the stored draft. See [Drafts](/drafts). |
| `pdfLayouts()` | The PDF layouts the definition declares, for a page that offers a choice. |
| `renderPdf(options)` | Draws the PDF from the current answers and resolves with its bytes. Loads the PDF kernel first when `pdf` names one. |
| `downloadPdf(options)` | Draws the PDF and hands it to the person. See [PDFs](/pdf). |
| `print(options)` | Opens the browser's print dialog with the form's print rendition. See [Print](/print). |
| `agentTools()`, `executeAgentTool(name, input)` | With the `agent` feature: the tools a browser assistant is offered, and one of them run from page script. See [Browser assistants](/assistants). |

The `ready` property is a promise that resolves once the current definition is built and drawn, and rejects with the reason when it could not be. See [When the form is ready](#when-the-form-is-ready).
