# Journeys

A journey asks one form a few questions at a time. The questions, the data and the rules stay the form's own; the journey decides which questions share a step, where each step leads for the answers given, and when the answers are checked, by the browser and by your server.

A journey differs from a steps container. A steps container is a part of the form's tree: it sits inside one page and the form is still one form. A journey is written beside the form. It names components by id and lays them out as pages, so the same question can sit on two pages that exclude each other, and a form can have several journeys, or none.

Reach for a steps container when a short form goes straight through in one order.

Reach for a journey when:

- the path branches on the answers
- a page ends the form
- one form has a short version beside the full one
- a page needs a check by your server before the person goes on

## The model

A journey lives in the definition's `journey` key. These are every setting it takes.

| Key | Takes | Default | What it does |
|---|---|---|---|
| `journeys` | A list of journeys | none | The form's journeys. A journey whose shape is wrong is dropped, and a server refuses it as `journey.invalid` |
| `defaultJourneyId` | A journey id | The first journey | The journey the form opens as |
| `opensAs` | `journey` or `form` | `journey` whenever the form has a journey | Whether the form opens as its default journey or as the whole form on one page |

A journey:

| Key | Takes | Default | What it does |
|---|---|---|---|
| `id` | Text | required | Unique among the form's journeys. A letter, then letters, digits, `_` or `-` |
| `name` | Text | the id | The name a picker shows, in the form's default language |
| `pages` | A list of pages | required | The pages, in the order they come when no route says otherwise |
| `progress` | `none` or `count` | `count` | `count` captions each questions step and Check answers step "Step 2 of 5"; `none` draws no count |
| `heading` | `shown` or `hidden` | `shown` | `hidden` draws no page heading and no count: the form's title heads each page, as it heads the whole form |
| `offPathValues` | `exclude-from-submission`, `retain` or `clear` | `exclude-from-submission` | What happens to the answers on pages the path does not take: kept for the person but not submitted, kept and submitted, or submitted empty. A component's own hidden-answer setting wins over it |
| `texts` | An object of wording | none | The journey's own words for Back, Continue and the rest. See [Wording](#wording) |
| `validation` | An object | see below | How pages are checked, as the default for every page |

A page:

| Key | Takes | Default | What it does |
|---|---|---|---|
| `id` | Text | required | Unique in the journey, and never the id of a component of the form |
| `kind` | `questions`, `exit` or `review` | `questions` | An `exit` page is content only: no Continue and no Submit. A `review` page lists the answers and sends them: see [Check answers](#check-answers) |
| `title` | Text | the label of the page's first component that shows | The page's heading, in the form's default language |
| `description` | Text | none | Text under the heading. With `heading: "hidden"` it opens the page's fields instead |
| `components` | A list | none | What the page draws, in order. A string is a form component's id, which brings everything under it. An object is a field of the page's own: see [Fields of a page's own](#fields-of-a-page-s-own) |
| `routes` | A list of `{ when?, to }` | none | Tried in order when the person leaves the page. `to` is a later page's id or `"$end"` |
| `texts` | An object of wording | none | Wording for this page, over the journey's |
| `validation` | An object | the journey's | Settings for this page, key by key over the journey's |
| `review` | An object | none | How a `review` page lists the answers: `labels`, `emptyOptional`, `change`. See [Check answers](#check-answers) |

A page or journey `validation`:

| Key | Takes | Default | What it does |
|---|---|---|---|
| `continue` | `page` or `defer` | `defer` | `defer` moves on unchecked, and Submit checks every page on the path, taking the person to the earliest one with an error. `page` checks the page's answers when Continue is pressed and stays while an error blocks. A deferred page that already holds a blocking error is checked on Continue, so the fix can be confirmed. Restoring a draft never checks a deferred page |
| `server` | `true` or `false` | `false` | Continue also asks your server to check the page, once the page's own checks pass. Ignored on a deferred page, so set `continue` to `page` on a page that asks your server |
| `onUnavailable` | `block` or `continue` | `block` | What a check that gets no verdict does: keep the person on the page with a message, or let them on |
| `end` | `client` or `server` | `client` | On the journey only. What Submit does on the last page: `server` asks your server to check the whole journey before the answers are signed or delivered |

A condition is a [formula](/formulas), or the expression tree the builder writes. A route with no `when` always matches.

## Pages and the routes between them

A journey is a list of pages. Each page names the components it asks.

```json
"journey": {
  "journeys": [{
    "id": "eligibility",
    "name": "Check and apply",
    "validation": { "end": "server" },
    "pages": [
      { "id": "home", "title": "Your home", "components": ["mainHome"],
        "routes": [{ "when": { "kind": "binary", "operator": "eq", "left": { "kind": "path", "path": "mainHome" }, "right": { "kind": "literal", "value": "no" } }, "to": "ineligible" }] },
      { "id": "work", "title": "The work", "components": ["upgrade", "cost"], "validation": { "server": true } },
      { "id": "contact", "title": "How to reach you", "components": ["fullName", "email"], "routes": [{ "to": "$end" }] },
      { "id": "ineligible", "kind": "exit", "title": "You cannot apply", "components": ["notEligibleNote"] }
    ]
  }],
  "defaultJourneyId": "eligibility"
}
```

- **A page has no condition of its own.** The path reaches a page by falling through to it or by a route, and shows every page it reaches, even one on which nothing shows. To pass a page by, give the page before it a route.
- **`routes`** are tried in order when the person leaves a page. The first that matches wins and names a later page or `"$end"`. With none matching, the path goes on to the next page. Routes only go forward, so every path ends.
- **An `exit` page** ends the journey with no Submit. A submission whose path ends at one is refused.
- **A question off the path** is hidden, never validated and never required. Its answer is kept, so going back to that branch restores it. Whether it is submitted is the journey's `offPathValues`, unless the component's own hidden-answer setting says otherwise.
- **The count** "Step 2 of 4" shows over each heading unless `progress` is `none`. It counts the questions pages and the Check answers page on the path, so an exit page is not counted. The `index` and `total` of [`datum-page-change`](#the-page-change-event) are a different count: they include exit pages.
- **Checking is on Submit.** With `continue` left alone, Continue moves on and Submit checks the whole path, so nobody is held on a page by an error whose cause is on a page they have not reached yet.
- **A one-page journey** has one page and `heading: "hidden"`. It draws no page heading and no count, so it reads as the form itself: a short public version of a long form, say.

A condition reads only the answers of pages already on the path, so an answer left on an abandoned branch cannot steer.

### Fields of a page's own

A page's `components` can hold objects as well as ids; the builder calls them journey-only fields. Their answers stay in the browser: they are kept in drafts, and never sent, printed or exported. Read them with the element's `presentationValues()`. There are three kinds.

- **An alias** is a field with `configuration.fills` set to a form field's id. Its answer is that form field's answer, stored where the form field stores it. It can have its own label, help and Required marker, so a page can ask the same question in different words. It shows the form field's visible, disabled and read-only state.
- **A worked-out value** has `type: "journey-value"` and `configuration: { to, value, label? }`. The browser works out `value`, a formula over the own fields on the same page, and writes it into the form field `to`, drawn read-only with the line "Worked out from your answers". The server keeps the value and holds it to the form field's own rules.
- **Any other own field** keeps its answer in the browser alone, and is checked there by its own rules.

```json
{ "id": "home", "title": "Your home", "components": [
  "fullName",
  { "id": "contactEmail", "type": "text",
    "configuration": { "label": "Email we can reach you at", "fills": "email", "required": true } },
  { "id": "monthlyPay", "type": "number", "configuration": { "label": "Pay each month" } },
  { "id": "monthlyOther", "type": "number", "configuration": { "label": "Other income each month" } },
  { "id": "yearlyIncome", "type": "journey-value",
    "configuration": { "to": "annualIncome", "value": "(monthlyPay + monthlyOther) * 12" } }
] }
```

An own field's `id` is never a form component's id. A layout of the page's own, such as a fieldset, can hold form components by reference: an object with `type: "journey-field"` and `configuration: { componentId }`. At the top of a page the id as a string does the same. The rules of an own field run in the browser only, and the server never reads them or a worked-out value's formula, so a route should not turn on a value worked out in the browser.

## Check answers

A page of kind `review` lists the answers the person has given, step by step, with a Change link beside each, and sends them. It is the last page of the journey, there is one per journey, and it holds no form field of its own. It can hold text of its own, such as a declaration.

```json
{ "id": "check", "kind": "review", "title": "Check your answers",
  "components": [{ "id": "declaration", "type": "html", "configuration": { "content": "By sending this you agree." } }],
  "review": { "labels": { "fullName": "Your name" }, "emptyOptional": "notProvided", "change": true } }
```

| Key of `review` | Takes | Default | What it does |
|---|---|---|---|
| `labels` | An object of text by component id | none | The wording of a row, in place of the question's label. Translated with the journey's other texts |
| `emptyOptional` | `notProvided` or `omit` | `notProvided` | What an optional question left blank reads: "Not provided", or no row |
| `change` | `true` or `false` | `true` | `false` draws no Change links |

- **What is listed.** The answers of the questions pages on the path, in path order, under each page's title.
  - A hidden question, a question off the path and a field of a page's own are not listed.
  - A row shows the label, the answer in words, and a Change link named "Change {label}".
  - A required question with no answer reads "Enter {label}" and links to its page.
  - A data grid or repeating section is one card per row, with one Change link.
- **Change and return.** Change opens the page that asked.
  - Continue from there goes on to the first page not yet completed, which may be a new one the changed answer put on the path, and then back to the Check answers page.
  - Any other move, such as a jump, gives up the return.
  - `datum-page-change` reports `change`.
- **A blocked send stays.** When Submit is refused the person stays on the Check answers page. It lists each error on its row and in an error summary that links to the row, and Change opens the page.
- **Always last.** A journey with a second Check answers page, or a page after it other than an ending, is reported as an error in the builder. A route from an earlier page straight to the end that skips it is reported as a warning.
- **Wording** is the `change`, `changeHidden`, `notProvided` and `enterAnswer` texts. See [Form texts](/form-texts).

The GOV.UK binding draws it with the design system's summary list and cards, and the other bindings with Datum's own drawing.

## In the builder

The Journeys workspace lists each journey as a document in the bar's dropdown, after the form and its PDF layouts. A new journey is one empty step, with nothing on it. In the builder a page is called a step.

- **Map | Step.** The bar switches between two views.
  - **Map** draws the journey as a flow: Start, a card per step, every route as a labelled line from its step, endings dashed, and End. Nothing is passed over, so a step with nothing on it is drawn like any other. Add step and New rule are on its bar, and a selected step has Open, Move up, Move down, Duplicate and Delete.
  - **Step** shows one step as a person sees it, with Back, the count, the fields and Continue, on the form's canvas.
- **Filling a step.**
  - The components palette adds fields of the step's own, which are never sent.
  - The **Form fields** panel on the activity strip, offered in the Step view, lists the form's fields, those not on a step first, and a click or a drag puts one on the step.
  - A form field on a step has "Take it off this step" in its inspector.
- **Going from step to step.** Falling through to the next step needs nothing. A route is a **Go to** rule, written in the Logic workspace: from a step, to a later step or the end, with a condition. A step's inspector has **Step** and **Logic** tabs, and Logic lists its rules in the order they are tried.
- **Problems** are listed at the top of the Journey panel, errors then warnings, each with its fix: a route that goes backward, a step no path reaches, a question on no step. They never stop Save. A required question on no step still blocks every submission through the journey, so the builder marks it as an error and offers "Ask it here".
- **Try it** runs the journey with the edits as they stand. The Journey card shows the map with the current step and the way taken, Restart starts over, and Open this step returns to the Step view on that step. Server checks are off, and Submit sends nothing.

The Journey panel also holds:

- Progress
- Step heading
- Answers off the path
- the check on Continue ("Move on, check at the end" is the default)
- the check when the person submits
- Wording

A step's inspector holds its Kind (Questions, Exit or Check answers), its checks and its wording. Undo and Redo in the Step view step through the form and the journey in the order the edits were made.

The first journey sets the form to open as that journey. Two rows pick the whole form or any journey by name: the Journey panel's "The form opens as" row, and the Form panel's "Opens as" row.

## Which journey opens

Three places say which journey a form opens as, and they are read in this order.

| Where | Says | Takes |
|---|---|---|
| `journey` attribute or property on the element | The page's choice, which wins | A journey id, `form` or `journey` |
| `opensAs` in the definition | Whether the form opens as its journey or as one page | `journey` (the default whenever the form has a journey) or `form` |
| `defaultJourneyId` in the definition | Which journey that is | A journey id. Absent, or naming none, the first journey |

The `journey` attribute takes these values:

- **An id** opens that journey.
- **`form`** opens the whole form on one page.
- **`journey`** opens the definition's default journey even when `opensAs` says `form`.
- **Left out**, the definition decides.
- **An id the form does not have** is reported with one console warning and the definition decides.

Changing `journey` later restarts the journey over the answers already typed, and nothing is rebuilt. With `journey="form"` on a form that has journeys, the journeys runtime is still loaded, so the journey can be switched on later.

| Attribute | Property | Takes | Notes |
|---|---|---|---|
| `journey` | `journey` | a journey id, `form`, `journey` | See above |
| `page` | `page` | a page id | Opens on that page when the person may reach it, for a deep link or a resume point. Read, it gives the page shown now |

```html
<datum-form src="/forms/rebate.json" journey="eligibility" page="work"></datum-form>
```

At the start only the first page can be reached, so a `page` further on waits.

- Restoring a draft whose completed pages reach it opens there, and the person's first move forgets it.
- Until then the form shows the first page, with a quiet line saying the page asked for is not available yet, and `datum-page-change` reports `redirect`.

## The element's journey calls

```js
const form = document.querySelector("datum-form");
form.addEventListener("datum-page-change", ({ detail }) => {
  history.pushState({ page: detail.pageId }, "", `?page=${detail.pageId}`);
});
const result = await form.goToPage("contact");
if (!result.ok) console.log(result.reason);
```

| Call | Does | Resolves to |
|---|---|---|
| `journeys()` | Lists the form's journeys for a picker | `[{ id, label }]`, the label being the journey's name in the form's language, else its id. An empty list before the form is built, or when `journeys` is left out of `features` |
| `nextPage()` | Continue, from your own control: checks the page as its journey says, asks your server when the page asks, and moves to the next page on the path | `{ ok, pageId, reason?, message? }`. `pageId` is the page shown after the call. When it is refused, focus goes to the first error. On the last page it is refused with `at-end`: the last page submits instead |
| `previousPage()` | Back: the page before this one on the path as the answers stand now. Nothing is checked | The same shape. On the first page, refused with `at-start` |
| `goToPage(id)` | A jump to a page already reached: on the path, and at or before the first page not yet completed | The same shape. Any other page is refused with `unreachable`. Asking for the page already shown answers `{ ok: true }` |
| `presentationValues()` | The answers the journey's own fields hold, by field id | An object. Aliases are not listed, since their answer is the form field's |

A refusal is a resolved value with `ok: false` and a `reason`, never a rejection. `message` carries the server's text or a hook's, when there is one. The call settles on the other cases the same way:

- With no journey running (the form was asked to open as `form`, or has none) the reason is `no-journey`.
- A call made while a check or another move is out is refused with `pending`.
- The element's calls reject, instead of resolving, when `journeys` is left out of `features` or when the journeys runtime did not arrive, as [the journeys runtime](#the-journeys-feature-and-the-journeys-runtime) says.
- A call made before the form is built waits for the build.

The names of every reason are tabled with the other codes the product answers with.

`beforePageChange` is a runtime hook that can refuse a move with `vetoed`. The element sets none, so it applies only to a runtime you build yourself.

### The page-change event

`datum-page-change` fires when a journey moves to another page. Its detail has nine fields:

| Field | What it holds |
|---|---|
| `journeyId` | The journey running |
| `pageId` | The page the person is on now |
| `fromPageId` | The page they came from, or `null` when the journey has just started |
| `direction` | How it was reached: `start`, `resume`, `forward`, `back`, `jump`, `change`, `error` or `redirect` |
| `index` | The page's place on the path the answers draw now, counted from 0. Exit pages are on the path and are counted |
| `total` | How many pages are on that path, exit pages included. It is not the total in "Step 2 of 4", which leaves exit pages out |
| `title` | The page's heading in the form's language |
| `kind` | `questions`, `exit` or `review` |
| `errorCount` | A number: the errors that block the page, on its fields and in its summary |

The directions:

- **`forward`** is Continue.
- **`back`** is Back.
- **`jump`** is a jump to a page already reached.
- **`change`** is a Change link on a Check answers step (the review step is where Continue then comes back to).
- **`error`** is the move to the earliest page holding an error after a blocked submit or `setErrors()`.
- **`resume`** is a draft restored.
- **`start`** is a journey started over a form already running (by changing `journey`).
- **`redirect`** is a `page` the answers cannot reach, with `pageId` the page the person is on instead.

Notes on when it fires:

- The page the form first opens on is not reported: nothing is listening yet, so read it from the element's `page`.
- A draft is saved on every move except `resume`.
- Read-only mode, print and PDF render the whole form.

A page that keeps the address bar in step, or prefixes the document title with "Error: " while the page has errors, listens to this event:

```js
form.addEventListener("datum-page-change", ({ detail }) => {
  document.title = (detail.errorCount > 0 ? "Error: " : "") + detail.title;
});
```

### What a journey does not draw

A journey draws its pages, Back, Continue or Submit, the page count, the server check line and, for a Check answers page, the list of answers. It draws no task list: that is written on the page around the form, from the calls above.

A task list reads the page ids and titles from the definition and goes to a page on click:

```js
const journey = form.definition.journey.journeys.find((entry) => entry.id === "eligibility");
const list = document.querySelector("#tasks");
for (const page of journey.pages) {
  const link = Object.assign(document.createElement("button"), { textContent: page.title ?? page.id });
  link.addEventListener("click", async () => {
    const result = await form.goToPage(page.id);
    if (!result.ok && result.reason === "unreachable") alert("Answer the earlier pages first.");
  });
  list.append(link);
}
```

A page's title in the definition is in the form's default language.

## Multi-page form with save and resume

A form that branches over several pages and can be left and picked up again, on this device or from another, takes a journey, a draft key and a store.

1. In the definition, write the journey as above.
2. On the page, set a `draft` key, name a store, and list both `journeys` and `drafts` if you set `features`.
3. Restore on load, and clear once the delivery is accepted.

```html
<datum-form id="apply" src="/forms/rebate.json"
  draft="rebate-ada" draft-store="server:/api/drafts" features="journeys drafts"></datum-form>
<script type="module">
  const form = document.getElementById("apply");
  await form.ready;
  if (await form.hasDraft()) await form.restoreDraft();

  // deliver() is your own function that posts the answers, as in Getting started.
  form.addEventListener("datum-submit", ({ detail }) => {
    if (!detail.accepted) return;
    detail.waitUntil(deliver(detail).then(() => form.clearDraft()));
  });
</script>
```

How saving and restoring behave:

- Every change autosaves after a short pause, and every move to another page saves at once, so a reload or a visit from another device finds the person's place.
- Restoring puts them back on the page they reached, reports `resume`, and checks again only the pages they had already continued from.
- The `draft` key names the draft and sits in the page, so a server that keeps drafts must authenticate each request itself and give each person their own key.
- The built-in hosts do not store drafts: [Drafts](/drafts) gives the four requests your service answers.
- A submission does not clear the draft by itself, which is why the example does.

## A live example

The form below has three journeys. Apply asks over three pages, with an email field of its own that fills the form's email and a yearly income worked out from two monthly amounts. Renew asks the form's own questions over two pages, and One page asks them all on one page with its heading hidden. The page fills its picker from `journeys()`, its buttons call `goToPage()`, and `draft` keeps the answers, the journey and the page reached in the browser.

<LiveExample name="journey" />

Fill About you and press Continue: `datum-page-change` appears in the log with `forward`. Press Reload and the draft resumes on the page you reached, reported as `resume`. A button for a page you have not reached yet answers `{ ok: false }` and the journey stays where it is. Open on page sets `page` for a deep link: until a draft reaches that page, the form opens on the first page instead and reports `redirect`.

## Checking between pages on the server

There are two server checks:

- **Between pages.** Set `validation.server: true` on a page, or on the journey for every page, and Continue asks the service once the page's own checks pass.
- **At the end.** Set `validation.end: "server"` and Submit asks the service to check the whole journey before the answers are signed or delivered. A download skips that check.

On the last page, which submits and does not continue, a page's `server: true` makes the check the submit's last stage instead.

| Attribute | Property | Takes | Notes |
|---|---|---|---|
| `validate-url` | `validateUrl` | URL | The element posts each check there, in the body a Datum host's `POST /api/submissions/validate` takes. On the page's origin unless `allow-origins` lists another. |
| `validate-timeout` | `validateTimeout` | milliseconds | 10000 by default; `0` for no limit. Changing it rebuilds the form; the answers typed so far carry over. |

Instead of a URL, the `serverValidator` property takes a function that resolves with `{ errors }`.

- It is called with `{ formId, formVersion, journeyId, scope, pageId, values, locale }`, and a second argument with `signal` and `document`, the submission envelope over those answers.
- For a token in a header, or cookies to another origin, the bundle exports `createFetchJourneyValidator(url, { headers, credentials })`, which returns such a function to assign.
- The builder's Preview never asks the server.

A check posts the delivery a Datum host takes, as `application/json`:

```json
{
  "document": {
    "versionContext": { "form": { "id": "household-support-checked", "version": "1.0.0" }, "client": { } },
    "submission": {
      "locale": "en",
      "values": { "fullName": "Ada Lovelace", "email": "ada@example.com" },
      "journey": { "id": "apply" }
    }
  },
  "scope": "page",
  "pageId": "you"
}
```

- **`document`** is built the way Submit builds `detail.submission`, from the answers so far. It names the form and its version, lists the form's own versions under `client` (shortened above), and carries every submittable answer keyed by path, the locale and the journey. The locale travels in the document too, as `submission.locale`.
- **`scope`** is `page` or `journey`.
- **`pageId`** names the page, and is left out for `journey`.

The service answers with a 200 or a 422 and a JSON body with an `errors` list:

```json
{ "accepted": false, "errors": [{ "field": "email", "code": "taken" }] }
```

Anything else, a 4xx included, is no verdict.

| Entry key | Meaning |
|---|---|
| `code` | Required, and not empty. One entry without it voids the whole reply, which then counts as no verdict |
| `field`, or `componentId` | The field the error belongs to. Neither, or `null`: an error of the form's own |
| `path` | A value path, for an entry with no field |
| `message` | The text to show |
| `severity` | `error` (the default), `warning` or `info` |
| `parameters` | Values for the message |

What the reply may hold and how it is read:

- A `notes` list beside `errors` holds entries in the same shape that never block, shown as warnings.
- When the reply has an `accepted` flag it must agree with the errors: `true` with no blocking error, `false` with one. A reply where it does not counts as no verdict.
- A page's reply is kept to the fields on that page and to entries that name none.
- A reply holding only warnings stops Continue once; pressing it again with the same answers goes on.
- A check still out when an answer changes is dropped, and a page the service passed is not asked about again until its answers change.

A server that cannot be reached, answers with a status that is no verdict, or answers a body that is not usable, is handled by `validation.onUnavailable`:

- `"block"` (the default) keeps the person on the page with a message.
- `"continue"` lets them on.
- The journey's own `onUnavailable` governs the end check.

A server that runs the sandbox program over its own copy of the form answers the check from the request's `journey` and `page`. It works the path out from the values, and it:

- refuses a path that ends at an exit page (`journey.exit`)
- refuses a journey it does not have (`journey.unknown`)
- refuses a malformed one (`journey.invalid`)
- refuses a path that turns on the clock without a `today` (`journey.clockDependent`)
- refuses a fold that does not settle (`fold.unsettled`)
- lists `pageComponentIds`, the fields the program placed on that page, in the outcome

A check that goes wrong on the person's side shows the form's own "We could not check your answers" line.

<LiveExample name="journey-server-check" />

Here About you asks the service on Continue. The example answers `validate-url` in the docs page by running the same sandbox program a server runs, and its log shows the request, the fields placed on the page and the verdict.

- Choose "Also refuses the email" and Continue stays on the page with the service's message under the email.
- Choose "Cannot be reached" and the journey blocks with its own message.
- A page the service passed is not asked about again until its answers change, so change the email after switching.

The server code is in [Your own server](/server-programs) and [Validation and the sandbox](/validation).

## What the server verifies at submit

The submission names the journey (`journey: { id }`) and never the path. A host that re-validates the answers works out the path again from them, with the same fold the browser uses, and reaches the same pages and the same verdict. A submission whose path ends at an exit page is refused (`journey.exit`), and a question off the path is not required. See [Validation and the sandbox](/validation).

## Wording

A journey's name, page titles and descriptions, and its wording are plain strings in the form's default language. Their translations are kept in the definition's `translations` map under `journeys`, at `<journey id> › name`, `<journey id> › pages › <page id> › title` and so on, and are edited in the [Languages](/languages) workspace.

The `texts` of a journey, and of a page over it, replace the words a journey page draws. The values are plain strings in the default language.

| Key | English | What it words |
|---|---|---|
| `back` | Back | The Back button |
| `continue` | Continue | The Continue button |
| `submit` | Submit | The button on the last page |
| `pageOf` | `Step {{n}} of {{total}}` | The count over a page heading, unless `progress` is `none`. Its `n` and `total` leave exit pages out |
| `checking` | Checking your answers… | The line shown while your server checks a page |
| `serverUnavailable` | We could not check your answers. Try again. | The error when a check gets no verdict and `onUnavailable` is `block` |
| `pageRedirected` | The page you asked for is not available yet. This is the nearest page you can open. | The line shown after a `redirect` |
| `workedOut` | Worked out from your answers | The line under a worked-out value |

```json
{ "id": "work", "title": "The work", "components": ["upgrade", "cost"],
  "texts": { "continue": "Accept and send" } }
```

A slot is written with double braces. A page's `texts` win over the journey's for the same key.

## The `journeys` feature and the journeys runtime

`journeys` is a feature name for the `features` attribute of `<datum-form>`. When `features` is set, only the parts it lists exist, so list `journeys` for a form that has journeys, as in `features="journeys print"`. On `<datum-form-builder>`, `journeys="off"` removes the Journeys workspace and leaves the definition's journeys untouched.

The journeys runtime is a separate file beside the bundle, `datum-form-journey-engine-chunk-<hash>.js`, fetched only when a form has journeys and the feature is on. Preload it with `loadJourneyEngine()`, which the bundle exports.

A journey with a Check answers step also fetches `datum-form-journey-review-chunk-<hash>.js` once the journeys runtime has arrived, and the form is drawn once both have. A journey without such a step never fetches it.

- **The feature is left out.** The form is built as the whole form on one page. The definition's journeys and the `journey` and `page` settings are ignored with one console warning, and `nextPage()`, `previousPage()` and `goToPage()` reject.
- **The file does not arrive.** This applies to either file. The form is never drawn as one page instead. It shows an alert card worded by the `journeysUnavailable` text with a Retry button worded by `retry`, raises `datum-error`, and `ready` rejects. Calls made meanwhile reject with the same error. Retry asks for the file again.

`datum-engine.js`, the runtime with no element, carries the journeys runtime inside it, so a script, a worker or a server walks a journey with nothing to fetch: see [Walking a journey](/engine#walking-a-journey).

## Checking a hand-written journey

The builder lists problems at the top of the Journey panel and on the step they concern. For a definition written by hand, add the `debug` attribute to `<datum-form>`: it logs what is wrong with the journeys once per definition, errors with `console.error` and warnings with `console.warn`, each line naming the journey, the page and the code. A page can run the same check itself with `loadJourneyDiagnostics()`, which the bundle exports and which answers a function to call with a definition.

A journey with errors still runs: the path passes over what it cannot follow. The main codes:

| Code | Level | Means |
|---|---|---|
| `journey.duplicate-id` | error | Two journeys share an id; only the first opens |
| `journey.no-end` | error | Every path ends at an exit page, so the journey can never be submitted |
| `page.duplicate-id` | error | Two pages share an id |
| `page.id-is-component-id` | error | A page has the id of a form component |
| `page.unknown-component` | error | A page lists an id the form does not have |
| `page.root-component` | error | A page lists the form itself |
| `page.review-repeated` | error | More than one Check answers page in a journey |
| `page.review-not-last` | error | A page other than an exit comes after the Check answers page, or a route leaves it for anywhere but the end |
| `page.review-form-field` | error | A Check answers page lists a form field |
| `route.unknown-target` | error | A route goes to a page the journey does not have; it is ignored |
| `route.backward` | error | A route goes to its own page or an earlier one; it is ignored |
| `condition.scope` | error | A condition reads `row.`, `ancestor.`, `host.` or a component path, which a journey condition cannot |
| `condition.invalid` | error | A condition cannot be evaluated, or a formula does not parse |
| `condition.reads-presentation-field`, `rule.reads-presentation-field` | error | A condition or a rule reads a field a page owns |
| `component.hidden-required` | error | A field required while hidden that no page can ask |
| `component.unassigned` | warning (error when required) | A form component on no page |
| `component.multiple-pages` | warning | A component on several pages, which a path may take together |
| `component.placed-twice` | warning | A page shows a form field twice |
| `page.unreachable` | warning | No path reaches the page |
| `page.no-title` | warning | A page with no title and no label to borrow |
| `page.entry-field` | warning | A page lists one field of a repeating section; list the section instead |
| `page.validation-server-deferred` | warning | `server` on a page that defers, where it is ignored |
| `page.validation-on-exit` | warning | Validation settings on an exit page, which never uses them |
| `page.review-bypassed` | warning | A route to the end on an earlier page, which sends the answers without the Check answers page |
| `route.shadowed` | warning | A route that an earlier one that always matches makes unreachable |
| `condition.unknown-field` | warning | A condition reads a field the form does not have |
| `condition.reads-later-page` | warning | A condition reads a question asked only on a later page |
| `condition.reads-clock`, `rule.reads-clock` | warning | A condition or rule reads `today()` or `age()`, which a server judges by its own clock |
| `calc.reads-branch`, `calc.input-left-out` | warning | A calculation reads an answer some paths never ask |
| `rule.reads-host`, `rule.server-cannot-run`, `rule.browser-only-required` | warning or error | A rule a server cannot run or does not enforce as the browser does |

Codes for a page's own fields start with `field.`, `map.` or `own.`, and `presentation.entry-unusable` names an own entry that was ignored: an alias of a field of another kind, a worked-out value reading another page, a field kept in the browser that fills nothing, an id that clashes.
