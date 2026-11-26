# Data model and data sources

A form's answers make a record, and a choice field can take its options from somewhere other than the form.

## What a record looks like

Every component that holds an answer stores it at a value path: its own segment, which is its data key if it has one and otherwise its id, prefixed by the segment of every data-scoping container above it.

| Form | Value path |
|---|---|
| A text field `email` at the top | `email` |
| `email` inside a container `applicant` | `applicant.email` |
| `billing_street` with data key `street`, inside a container with data key `billing` | `billing.street` |
| A field inside a fieldset, panel, grid, tabs, steps or button group | its own path, with nothing added |
| A field inside a data grid | `items[0].sku` while the form is open; submitted as one list under `items` |

The submission's `values` are a map keyed by path, and that is what a server receives.

- A plain answer sits under its whole path as one key.
- A data grid, or any container bound to a collection, is sent as one list with an object per row, an empty row included.

```json
{ "fullName": "Ada", "billing.street": "1 Main St", "items": [{ "sku": "A-1" }] }
```

The same answers read as a nested document, which is the shape the Data workspace's example document and JSON Schema show:

```json
{ "fullName": "Ada", "billing": { "street": "1 Main St" }, "items": [{ "sku": "A-1" }] }
```

## Ids and data keys

The id is what rules, errors and the builder's selection use, and it is unique across the whole form. The data key is only where the answer is stored. It lets `shipping.street` and `billing.street` exist side by side, held by components with the ids `street` and `billing_street`.

- A data key uses letters, digits, `_` and `-`, and cannot be digits alone.
- The inspector's Data section sets it, and a "Saved as" line shows the path whenever it is not simply the id.
- The builder refuses a key, a rename or a move that would put two answers in one place.
- A formula reads an answer by the path it is stored under.

## Containers as data scopes

- Only a `container` adds a level to the data, and its **Nest data under this id** switch turns that off.
- Fieldsets, panels, grids, tabs, steps and button groups only arrange the form.
- A data grid, or any container bound to a collection, stores its rows as one list at its path.
- A row the person left empty is kept as `{}`, so the server counts the rows the person saw.

## Answers of hidden fields

By default, the answer of a hidden field is not sent. This covers a field hidden by a rule and one set to `hidden`.

- The answer stays in the form while the field is hidden, so it shows again when the field does, and a saved draft keeps it.
- A PDF or a printed copy of the form does not show it either.

Each field holding an answer can choose differently. The setting is `hiddenValueBehavior` in the field's configuration, under **When hidden** in the inspector's Data section. A show or hide rule in the Logic workspace and the Data workspace change the same setting.

| `hiddenValueBehavior` | In the inspector | What is sent while the field is hidden |
|---|---|---|
| `exclude-from-submission` (the default) | Leave the answer out | Nothing: the answer is not in the submission. |
| `retain` | Keep and send the answer | The answer, as typed. |
| `clear` | Send it empty | No answer, as if the field had been left empty. |

The builder writes the key only for `retain` or `clear`. Two more settings decide what a hidden field is checked against:

- `hiddenValidationBehavior`: `skip` (the default) or `validate`.
- `hiddenRequiredBehavior`: `not-required` (the default) or `required`.

- A field that sets either of these to be checked while hidden has its answer kept and sent, unless it sets `hiddenValueBehavior` itself.
- An answer that is sent while hidden is still checked for its format, such as its length, its pattern, or a file's size and type.

On a journey, a field on a page the path skips is left out the same way, and the journey's `offPathValues` changes that for the whole journey. A field's own setting wins.

## Building the model from a sample

The **Data** workspace lists every answer the form stores, where, what kind and whether it is required. It shows the same model as a table, as a JSON Schema (draft 2020-12) or as an example document. **Import** reads a JSON sample or a JSON Schema, pasted or opened from a file.

Each place in the incoming model is marked new, already on the form, held as a different kind, approximate or not built.

- **Add missing fields** adds only the new places.
- **Replace form contents** rebuilds the form, after a confirmation.
- Each build is one undo step.

What the import reads:

- A sample must be an object. Every entry of a list is read and merged, and a format such as a date or an email address is kept only when every value agrees.
- A schema is read for `type`, `properties`, `required`, `items`, `enum`, `const`, `oneOf`, `anyOf`, `allOf`, `$ref`, `format`, titles and descriptions, `pattern` and the length and number bounds. A keyword a form cannot hold is named in one note; bookkeeping keywords such as `$schema` and `$defs` are passed over.
- A choice of up to five becomes a radio group and six or more a select. An object becomes a container, a list of objects a data grid, and a file a file upload.
- A key that cannot be stored (`first name`) is made usable (`first_name`) and kept as the data key.

## Options inline or from a source

A select, radio or checkboxes component gets its options one of two ways.

| Route | Where | Good for |
|---|---|---|
| Inline options | `configuration.options`, written in the builder's Options editor | Short, fixed lists: Yes and No, a few categories. |
| A data source | `configuration.data.sourceId` names it, and the page supplies it | Long, shared or live lists: countries, products, anything looked up. |

An option is `{ "value": "yes", "label": "Yes" }`. A component that names a source takes its options from it and ignores its inline list. A source that fails is reported, not replaced by the inline list.

## Supplying a source from the page

`data-sources` on `<datum-form>` takes JSON: each source id, then its list.

```html
<datum-form src="/forms/intake.json"
  data-sources='{ "provinces": [{ "value": "ON", "label": "Ontario" }, { "value": "QC", "label": "Québec" }] }'></datum-form>
```

The `dataSources` property takes the same object, and also functions and provider objects.

### The items

A source answers a list of items. An item has these keys:

| Key | Meaning |
|---|---|
| `value` | Required, a string. What is stored as the answer and what the server compares. It does not depend on the language. |
| `label` | Required. The text the person reads. Plain text, or `{ "default": "Email", "locales": { "fr": "Courriel" } }`, read in the person's locale. |
| `description` | Optional, the same kinds of text. A line of help under the option on a radio or checkboxes group. |
| `meta` | Optional, an object of your own. It travels with the item and the form does not draw it. |

An item with a missing or non-text `value` or `label` makes the whole answer malformed: the field offers no options and the failure is reported, as below.

### Three ways to write a source

| Written as | Use it for |
|---|---|
| A list of items | A fixed list. The form copies it on every load. |
| A function | A list the page works out: from the other answers, from a request to your API. It returns the list now or a promise of it, either as a bare list or as `{ items: [...] }`. |
| A provider object, `{ id, load(request, context) }` | The same as a function, with the declaration of where it may run. `environments` (`["client"]` or `["server"]`) limits it to one side, and `privileges` (`{ network, storage }`) is advisory text for the person who reads the declaration. The form runs in the browser, so a provider limited to `["server"]` is refused there. `load` answers `{ items: [...] }`. |

A function and a provider's `load` receive the same two arguments, `request` and `context`. The table lists the fields of each:

| Field | Holds |
|---|---|
| `request.sourceId` | The id the component names. One function can serve several ids. |
| `request.query` | An object that is always empty in `<datum-form>`: the element has no way to supply one. |
| `context.locale` | The language the form is in. |
| `context.values` | A copy of the form's current answers, one entry per value path (`billing.street`), the same keys as `detail.values` on `datum-change`. A journey page's own fields are not in it. |
| `context.environment` | `"client"` in `<datum-form>`. |

```js
form.dataSources = {
  cities: async (request, { values, locale }) => {
    const response = await fetch(`/api/cities?country=${encodeURIComponent(values.country ?? "")}&lang=${locale}`);
    return response.json(); // [{ "value": "tor", "label": "Toronto" }, ...]
  }
};
```

A function is asked again each time the form redraws, which includes when an answer changes or the language switches, with the answers as they then stand.

- That is how a list depends on another field.
- It also means a function can be asked many times in a minute: cache inside it when the request is expensive.

A source that reads from your API is a function that calls `fetch`, as above. The engine's own remote provider, which `datum-form.js` does not export, speaks one particular shape: a POST of `{ query, values, environment }` with `sourceId` and `locale` in the query string, answered with `{ "items": [{ "value": ..., "label": ... }] }`. A function in the page can speak the same shape to an endpoint that expects it:

```js
form.dataSources = {
  products: async (request, { values, locale }) => {
    const response = await fetch(`/api/options?sourceId=${request.sourceId}&locale=${locale}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: request.query ?? {}, values, environment: "client" })
    });
    if (!response.ok) throw new Error(`The options request failed: ${response.status}`);
    return (await response.json()).items;
  }
};
```

`defineDataSources` from `datum-form.js` builds the same set the property builds from an object, for a page that passes one set to a form and a builder; see [JavaScript exports](/exports).

| Attribute | Default | Meaning |
|---|---|---|
| `data-source-wait` | `none` | `none` paints the form first and fills each field when its list arrives. `all` shows "Loading form…" until every source has answered. |
| `data-source-timeout` | `15000` | Milliseconds a source may take before it counts as failed. `0` for no limit. |

- A field waiting on its list is marked `aria-busy` and says "Loading the choices…".
- A source that throws, answers nothing, answers something that is not a list of `{ value, label }` items, or times out raises `datum-error` with `detail.sourceId` and `detail.componentId`, and the field shows a short sentence in place of options.
- A list longer than 5,000 items is cut to that many.
- A label is plain text or text per language, as [The items](#the-items) describes.
- `features` can leave `data-sources` out, in which case a source the form names answers an empty list.

## In the builder

`<datum-form-builder>` takes the same `data-sources` attribute, so the canvas previews the lists and the Data source picker offers their ids.

- When the sources live elsewhere, `data-source-ids` takes a list of ids for the picker alone.
- With neither, the picker is a text box for the id.

A field set to **Answers may be free text** (`data.answersFree`) treats the list as suggestions only. The answer is not checked against it, though it still keeps the field's own limits.

## How the server checks an answer

The options of a source are not in the definition, so the sandbox cannot know them.

- The host resolves each source the form names and hands the lists to the run as an `optionSnapshot`: an object from source id to a list of items, as `{ value, label }` entries.
- The sandbox never fetches anything, so a server host supplies the snapshot with each run.
- Inline options are in the definition and need no snapshot.

Every answer to a choice backed by a source is then held to the snapshot's list for that source. The check runs on what will be stored, so a hidden answer the form still keeps is checked like any other.

| Code | When | `parameters` |
|---|---|---|
| `option.notAllowed` | The answer picks a value that is not in the source's list. An empty list allows nothing. | `keys`: the refused values, each once |
| `option.sourceUnavailable` | The snapshot has no list for the source the choice names: it was not supplied, or the source failed. The answer is refused, so a source that is down never lets an answer through. | `keys` and `sourceId` |

How an answer is read:

- A `select` or `radio` answer is one string, and an item allows it when the item's `value` is that string. A number in the item's `value` counts as its text form.
- A `checkboxes` answer is an object of booleans. Only the keys set to `true` are picked, and each must be an item's `value`. A key set to `false` picks nothing, so a list that changed since leaves no refusal behind.
- An answer that picks nothing (an empty string, nothing ticked) passes the check. It still meets `required`.
- Any other shape of answer is refused as `option.notAllowed`.
- A choice whose component sets **Answers may be free text** (`data.answersFree`) is not held to the list at all: no `option.notAllowed`, and no `option.sourceUnavailable` for a missing source. Its own limits still apply.
- Every row of a data grid is checked, with the path reported as `items.sku` without the row number.
- When several components store at one path, an answer is refused only when no choice stored there accepts it, and it is not checked at all when a plain text field stores there too.

In the page, a form with a sandbox wired (`wasm`, or a `wasmValidationHost`) builds the snapshot itself at submit.

- It asks each source named by a choice once more, with no query, under `data-source-timeout`, and puts the answers in the snapshot with their labels read in the submit language.
- A source that fails or times out is left out of the snapshot, which is how an unreachable source ends in `option.sourceUnavailable` instead of a pass.
- Without a sandbox the page does not compare an answer to the list; the server does.

For a server host, [Your own server](/server-programs) lists the run's keys, and [Validation and the sandbox](/validation#what-is-checked) says where this check sits among the others.
