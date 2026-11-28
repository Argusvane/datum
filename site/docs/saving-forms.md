# Saving forms

The builder has no Save until the page asks for one, because it has nowhere of its own to keep a form. There are four ways to ask. Pick the first row that describes your server.

| Your server | Use | Covered in |
|---|---|---|
| Takes the whole form at one address, by a plain `PUT` or `POST` | `save="/api/forms/intake"` | [An address](#an-address) |
| Needs headers, a CSRF token or a request of your own | A bare `save`, and a `datum-builder-save` listener that hands its work to `waitUntil` | [A request of your own](#a-request-of-your-own) |
| Checks a revision, or you decide what counts as saved | `fileActions.save`, and `savedDefinition` | [A function](#a-function) |
| Is a Datum host (Spring Boot or FastAPI) | The host's page glue, `DatumHost.builder` | [A Datum host](#a-datum-host) |

Every route puts Save in the builder's ⋮ menu and on Ctrl/Cmd+S inside the builder. In each:

- The builder first asks about an edit still open in the inspector, so what is saved is what the author sees.
- It shows "Saving…" while the save is pending and shows the reason beside the menu if it fails.
- `save-label` names the item ("Save draft", "Publish") and a `fileActions.saveLabel` wins over it.

## An address

```html
<datum-form-builder src="/forms/intake.json" save="/api/forms/intake"></datum-form-builder>
```

`save` with an address has the builder send the definition itself, as JSON with `content-type: application/json`, by `PUT`.

- `save-method="POST"` sends a `POST` instead.
- Any 2xx answer counts as saved.
- Any other answer, a server out of reach, or 30 seconds without an answer shows beside the menu as the reason the form was not saved, and the form stays unsaved.

About the address:

- A relative address reads against the page.
- The address in the attribute is held to the page's own origin: one on another origin is reported as `datum-error` and the attribute is treated as absent, unless `allow-origins` lists that origin.
- The `save` property is a script's own choice and may name any address.
- The `save` property takes the same three states as the attribute: `false` for no Save, `true` for a bare `save`, or an address.

The first example on [Embedding the builder](/embedding-the-builder#saving) saves this way: edit, choose **Save**, and the log shows the `PUT`. A page that needs more than this plain request does not use an address. It uses one of the routes below.

## A request of your own

A bare `save` adds the menu item and sends nothing. Choosing it fires `datum-builder-save`, and the page stores the form in a listener. Hand the work to `waitUntil` so the builder shows "Saving…" until it settles and shows the reason if it rejects:

```html
<datum-form-builder id="builder" save save-label="Save draft"></datum-form-builder>

<script type="module">
  document.getElementById("builder").addEventListener("datum-builder-save", (event) => {
    event.detail.waitUntil(
      fetch("/api/forms/intake", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(event.detail.definition)
      }).then((response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
      })
    );
  });
</script>
```

The event is cancelable and its `detail` carries:

| Field | Meaning |
|---|---|
| `definition` | The form as authored: what this save stores, and the saved baseline once it succeeds. |
| `localeChanges` | The net change to the form's languages since it was loaded or last saved. See [Language changes](#language-changes). |
| `trigger` | `"agent"` when a browser assistant asked for the save, absent when the person did. |
| `waitUntil(work)` | Has the save wait for a promise. Call it while the event is being dispatched; any number of listeners may each hand one in. A rejection is the save failing. |

Once every promise has settled and none rejected, the builder takes the form as sent for the saved one, so `dirty` clears, and it stays set for an edit made while the save ran.

The event also fires with `save="/url"`, before the request. A listener there can do its own work first with `waitUntil`, or call `preventDefault()` to leave the request out and do the storing itself.

## A function

`builder.fileActions = { save, saveLabel }` takes a function, which wins over the attribute in either form. Use it when the page keeps its own idea of what is saved, such as a revision the server checks:

```js
builder.fileActions = {
  async save({ localeChanges }) {
    const definition = builder.definition;
    const response = await fetch("/api/forms/intake", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": revision },
      body: JSON.stringify(definition)
    });
    if (response.status === 409) throw new Error("someone else saved this form first");
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    revision = (await response.json()).revision;
    // The form as sent is the saved one. An edit made meanwhile stays unsaved.
    builder.savedDefinition = definition;
  },
  saveLabel: "Save"
};
```

About the function:

- It is called after the builder's own question about an open edit.
- A thrown error or a rejected promise is the reason the builder shows beside the menu.
- It fires no `datum-builder-save`.
- It leaves the saved baseline to you: set `savedDefinition` to the form you sent, not to whatever the builder holds when the answer arrives, or an edit made during the save would be counted saved.

The second live example on [Embedding the builder](/embedding-the-builder#a-server-that-checks-the-revision) does this against a server that refuses a stale revision.

## A Datum host

A page served by a Spring Boot or FastAPI host (see [Server hosts](/server-hosts#the-page-glue)) does not write any of this. `DatumHost.builder(element, { formKey, status, seed, dataSources })` in the host's `datum-host.js` wires the builder to the host's form routes:

- It loads the author's copy of the form from `{apiBase}/forms/{formKey}/definition?public=false` and remembers the hash of the version it loaded, taken from the `ETag`.
- Its Save sends the definition by `PUT` to `{apiBase}/forms/{formKey}` with `If-Match` set to that hash, the host's CSRF token, and an `X-Datum-Locale-Changes` header when languages changed. Requests go one at a time. A form that does not exist yet starts from `seed`, and its first save is a `POST` to `{apiBase}/forms`.
- On success it takes the new hash from the answer, says "Saved." on the `status` element if you gave one, and fires `datum-host-saved` on the builder with `{ sha256 }`.
- On a 409 (`form.outdated`) somebody else saved first: nothing is overwritten, the message shows on the bar and in `status`, and `datum-host-outdated` fires so the page can offer a reload. A 422 lists the server's reasons, and 413, 503 and other answers are worded by status.
- It refuses to save a form whose id is not `formKey`, and it turns saving off when the builder refused the definition it was given, so a blank form never replaces the stored one.
- It sets `fileActions` for Save, Download, and, with a `seed`, New and Open, all keyed to this form's id, and has the browser ask before the page is left with unsaved work.

It resolves with `{ save, sha256, dispose }`: `save()` saves as the menu does, `sha256()` is the hash the page builds on, and `dispose()` removes the listeners. A host needs `datum.builder.enabled` for the routes to exist.

## Knowing what is unsaved

`<datum-form-builder>` treats the definition it loads as saved. Four members tell a page where it stands:

| Member | What it is |
|---|---|
| `dirty` | Whether the form differs from the saved one, drafts held in a panel included. It is also a `dirty` attribute, so a Save button can be styled from CSS, and `datum-builder-dirty-change` fires when it flips. |
| `savedDefinition` | The baseline `dirty` compares with. Setting it makes the form saved at that definition. |
| `markSaved()` | Tells the builder the page has saved: the definition and its languages as they stand become the baseline, and `dirty` clears. Use it after a save of your own, such as a button on the bar. |
| `hasUnsavedChanges()` | Whether an edit is still open in a panel that a leave would lose. It is not "the form differs from the saved one": that is `dirty`. |

A page that saves from a control of its own, in the `toolbar` slot say, calls `builder.requestLeave(run)` first, so an edit still open in the inspector is settled, and then `markSaved()` once the server has the form.

## Leaving the page

A reload, a followed link or a closed tab would take unsaved work with it. While the form is `dirty`, or an edit is still open in a panel, the builder has the browser ask before the page goes.

- The question is the browser's own and its words cannot be changed.
- `leave-guard="off"` turns it off for a page that keeps the work some other way, such as autosave.
- It is read when the page is about to go, so it can change at any time.

A page that swaps the builder out without leaving, as a single-page app does on a route change, is not a page the browser is leaving. Call `builder.requestLeave(run)` there. It runs `run` at once when nothing is open, and otherwise after the person answers the builder's Save or Discard question.

## Language changes

A form's languages are part of its definition, so a save that sends the definition sends them. A page that also keeps a catalogue of translations of its own needs to know which languages were removed or renamed since the last save. The builder reports them as `localeChanges`, `{ removed, renamed }`, to `fileActions.save`, in `detail.localeChanges` of `datum-builder-save`, and from `builder.localeChangesSinceSave()` for a host that saves some other way. [Languages](/languages#choices-in-more-than-one-language) describes what each means.

The count is reset in these cases:

- A save succeeds: the function resolving does it, as does a save by the `save` attribute.
- Another form is loaded.

After a save of your own, call `markSaved()` or `markLocalesSaved()`. A failed save leaves the count as it was, so a retry sends the same changes again.

The count starts again from the languages the save was handed, not from the languages when it finished. A language renamed or removed while the save is still running is sent with the next save. If the save fails, the next save sends both: what this one was handed and what changed while it ran.
