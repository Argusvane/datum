# Drafts

A draft saves a half-filled form so the person can leave and come back to it. The answers, the language, the page they were on and, in a journey, their place in it are stored under a key you choose. When the person returns, the page asks the form to restore them.

## Switching it on

Give the form a `draft` key. Then:

- Every change saves to the browser's own storage after a short pause (300 ms).
- `restoreDraft()` brings the draft back.
- Nothing restores by itself: the page calls `hasDraft()` and `restoreDraft()` when it wants the person's work back.

```html
<datum-form src="/forms/intake.json" draft="intake-2026"></datum-form>
```

About the key:

- It names the draft, so use one per person or per case if the page serves more than one.
- Keys that start with `__` belong to the browser store: saving, loading or deleting one is refused with the error code `draft.reservedKey`.
- It sits in the page, so it is a name and not a secret.

The `drafts` feature must be on. It is by default.

## Switching it off

Without a `draft` key nothing is saved. To rule drafts out whatever key the page or a script sets, take the feature out of the [`features`](/leaving-parts-out) list:

```html
<datum-form src="/forms/intake.json" features="-drafts"></datum-form>
```

Every other feature stays. The key and the store are then ignored with one console warning, and the draft methods reject.

## Where a draft is kept

| `draft-store` | Where |
|---|---|
| left out, or `local` | The browser's storage, on this device |
| `server:<url>` | Your server, over four requests |
| the `draftStore` property | Any store you write |

The browser's storage:

- It is `localStorage`, as plain JSON, under the name `datum-form:` followed by the key.
- It holds every answer the form holds, hidden ones that were kept included, so on a shared computer clear the draft when the person is done.
- Where the browser refuses `localStorage` (a private window, a sandboxed frame), drafts are held in memory and are gone when the page closes.

A `server:` store:

- The URL may be relative to the page.
- A server on another origin is refused with a `datum-error`, and the draft stays in the browser, unless that origin is listed in `allow-origins`.
- A value that is neither `local` nor `server:` is reported as `datum-error`.

```html
<datum-form src="/forms/intake.json" draft="intake-2026" draft-store="server:/api/drafts"></datum-form>
```

## The server's side

With `draft-store="server:/api/drafts"`, the form sends four requests, where `<id>` is the draft key, percent-encoded and added to the URL's path (a query on the URL is kept after it).

| Request | Meaning | Body sent | Answer |
|---|---|---|---|
| `PUT /api/drafts/<id>` | Save | The draft as JSON, with `content-type: application/json` | Any 2xx |
| `GET /api/drafts/<id>` | Load | none | The draft as JSON, or 404 when there is none |
| `DELETE /api/drafts/<id>` | Remove | none | Any 2xx, or 404, which counts as removed |
| `GET /api/drafts` | List | none | A JSON array of summaries, in any order: the form sorts them newest first |

- A 404 on a load is `draft.notFound`.
- Any other status counts as the request failing, and the draft call rejects with a plain error that names the status.
- A key that is empty, `.` or `..` cannot name a draft under the URL, and the call is refused before a request goes out.
- Requests carry the page's own cookies, as `fetch` does for the same origin, and no other credential or header. For a token, a CSRF header or another origin, write a store.

The draft body is:

| Key | What it holds |
|---|---|
| `id` | The draft key |
| `formId`, `formVersion` | The form's id and version |
| `runtime` | `{ schemaVersion, rendererVersion }`: the definition's `schemaVersion`, and the renderer's version |
| `locale` | The language the form was in |
| `values` | Every answer, keyed by value path. In a journey, a page's own fields keep their answers here too, under names that start with `@` |
| `state` | `{ mode, currentStep?, touched, dirty, visitedSteps, completedSteps, journey? }` |
| `updatedAt` | When it was saved, in milliseconds since 1970 |

`state.journey` is `{ id, page, completed, written? }`: the journey, the page shown, the pages continued from, and the form's own record of what its worked-out values last wrote. A summary, which a list answers with, is `{ id, formId, formVersion, locale, updatedAt }`.

Treat the body as the person's answers: store it where you would store a submission, and authenticate the requests yourself. The built-in hosts do not serve this route; it is your own service.

## A store of your own

For headers, credentials, another origin or another protocol, assign a store from script. It wins over the attribute. A store is an object with four methods:

```js
form.draftStore = {
  save: async (draft) => { /* keep draft, filed under draft.id */ },
  load: async (id) => { /* return the draft, or throw if there is none */ },
  list: async () => { /* [{ id, formId, formVersion, locale, updatedAt }] */ },
  delete: async (id) => { /* remove it */ }
};
```

`load` should throw an error whose `code` is `draft.notFound` when nothing is stored, so a page branching on `error.code` treats yours like the built-in stores. The store does nothing without a `draft` key.

A store also makes a draft file, one the person keeps and brings back from any machine, with no more than the page's own code:

```js
let kept; // the latest draft the form saved
form.draftStore = {
  save: async (draft) => { kept = draft; },
  load: async () => {
    if (!kept) throw Object.assign(new Error("Draft not found"), { code: "draft.notFound" });
    return kept;
  },
  list: async () => [],
  delete: async () => { kept = undefined; }
};

// Download: hand the person the draft as a file.
function downloadDraft() {
  const file = new Blob([JSON.stringify(kept)], { type: "application/json" });
  Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: "draft.json" }).click();
}

// Upload: read the file, then restore it. The usual checks apply.
async function uploadDraft(file) {
  kept = JSON.parse(await file.text());
  await form.restoreDraft();
}
```

### Helpers for the file

`datum-form.js` exports two helpers for the file, so the page does not write its own.

```js
import { serializeDraftFile, parseDraftFile } from "./datum-form.js";

// Download: the draft as JSON, keys in a stable order.
const text = serializeDraftFile(kept);

// Upload: check the file and get the draft back.
kept = parseDraftFile(await file.text());
```

- `serializeDraftFile(draft)` gives the same bytes for the same draft.
- `parseDraftFile(text)` checks that the identifiers, runtime versions, locale, values and state are present, and throws a plain error when they are not. The usual checks on `restoreDraft()` still apply to what it returns.

Two more draft helpers stay in the engine package, which is not published on its own, and `datum-form.js` does not export them:

- `IndexedDbDraftStore` is a store you hand a small repository (`put`, `get`, `list`, `delete`) backed by your own database. No attribute selects it.
- `DraftError` is the error the built-in stores and a restore throw.

A page that loads the bundle files uses a store like the one above and branches on `error.code`, never on `instanceof DraftError`.

## Methods

| Method | Does |
|---|---|
| `hasDraft()` | Resolves `true` when a draft is stored under the key, and `false` when there is none or the store could not be read, a network failure included |
| `saveDraft()` | Saves now, replacing the pending autosave, and resolves with the draft's summary |
| `restoreDraft()` | Loads the draft into the form and resolves with `updatedAt`, `locale` and any `dropped` paths |
| `clearDraft()` | Deletes the draft, and cancels an autosave that was about to put it back |

```js
const form = document.querySelector("datum-form");
if (await form.hasDraft()) {
  await form.restoreDraft();
}
```

All four reject when the form has no `draft` key. A call made before the form is built waits for the build.

## What a draft holds

- Every answer, hidden ones the form kept included, and what is still being typed, which is reported before the draft is saved.
- The language the form was in.
- Which fields were touched and which changed, and the progress through a steps container.
- In a journey, the journey's id, the page shown and the pages continued from, and the answers to a page's own fields.
- The form's id and version, and the definition's `schemaVersion`.

It never holds what your server said about the answers in a journey check, so a restored journey asks the server again.

## What restoring does

`restoreDraft()` reads the whole draft before anything changes, so a draft that cannot be restored leaves the form as it was. It then, in order:

1. Replaces the answers, the touched and changed flags and the step progress.
2. Switches to the draft's language when the form declares it.
3. Works the rules out again.
4. Checks the answers: the whole form, or in a journey only the pages already continued from, so the page the person comes back to shows no errors before they act.

A journey is put back on its page, and reports `datum-page-change` with `resume`.

Reading is forgiving of what can be repaired:

- A language the form does not declare is read as the closest it does, or left as it is now. A form that declares no languages takes any.
- A `touched`, `dirty` or steps list that is not a list of text is dropped.
- A journey block that is damaged costs the person their place in the journey, never their answers, which then resume at the start.
- An answer the form cannot hold, such as an object in a single-valued field, is left out and the rest is restored. The element reports the left-out paths on `datum-warning` with the code `draft.dropped`, and in `dropped`.

## Checks before a draft is restored

A draft comes back only into the form it was saved from, and only at a schema version the form can read. `restoreDraft()` rejects with an error whose `code` says why.

| Code | Meaning |
|---|---|
| `draft.notFound` | Nothing is stored under the key |
| `draft.formMismatch` | The draft belongs to another form |
| `draft.incompatible` | The draft's `schemaVersion` is not the definition's |
| `draft.malformed` | The draft is not a record, its `values` are not a record, it has no `state`, or its `state` lacks `mode` (`normal` or `wizard`), `visitedSteps` or `completedSteps` |
| `draft.reservedKey` | The key starts with `__`, which the browser store keeps for itself. Only the browser store raises it |

The form's own version is not part of the check. A draft saved under an older version of the form restores anyway: `formVersion` is kept in the draft and listed in `list()`, and a host that wants to refuse older drafts reads it there, in its own store, or in a `load` of its own that throws `draft.incompatible`.

## What is stored, and when it goes

- A draft lives until it is cleared.
- Accepting a submission does not clear it: call `clearDraft()` when the delivery succeeds, or the person's old answers come back on the next visit.
- A failure to save, a full browser storage or a 4xx or 5xx from your server, is reported as `datum-error` with the message "Autosave failed", and the form carries on.
- Where you keep drafts on a server, delete them on your own schedule: nothing expires one.

For the settings in one place, see [The form element](/form-element). A multi-page recipe with a server store is on [Journeys](/journeys#multi-page-form-with-save-and-resume).
