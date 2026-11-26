# Data Sources

Where a `select`, `radio` or `checkboxes` gets its choices, and how to supply them: options
typed into the form, data sources a host defines when it wires a form, and data sources
registered on the runtime through providers. The design decisions behind it are recorded in
[ADR 0001](adr/0001-architecture-constraints.md) (data sources resolve through providers) and
[ADR 0037](adr/0037-inline-options-and-wiring-time-data-sources.md).

This guide is written for form owners (section 1), host developers (sections 2 to 5) and
anyone writing a provider (section 4). Section 6 applies to everyone.

---

## The big picture

A choice-bearing component gets its list of `{ value, label }` items from one of two routes:

| Route | Where it lives | Who owns it | Good for |
|---|---|---|---|
| **Inline options** | The component's own `configuration.options` | The form author, in the builder's Options editor | Short, fixed lists: Yes / No, a few categories |
| **A data source** | `configuration.data.sourceId` names it; the host supplies it | The host application | Long, shared or live lists: countries, products, anything looked up |

A data source is supplied one of two ways:

- **Defined at wiring time** with `defineDataSources(...)` and handed to the renderer (and the
  builder) — the shortest route when the page has the list in hand.
- **Registered on the runtime** through a provider registry and a source registry — the
  route for sources shared across forms and environments, and the only one validation sees
  unless the wiring-time set is also given to the runtime.

The two mix freely. A form may take one field's options inline, another's from a
wiring-time source, and a third's from a registered one.

**Precedence:** a component that names a data source takes its options from that source; the
inline list applies only when no source is named. A source that fails is reported as an
error (a `datum-error` and a notice under the field), not papered over with the inline list.

---

## 1. Inline options (form owners)

Select a `select`, `radio` or `checkboxes` on the canvas. Its properties panel has a **Data**
section with two entries:

- **Data source** — the source the field takes its options from (leave it at *none* to use
  the inline list).
- **Options** — how many options are typed in, and an **Edit options…** button. While a data
  source is set the row instead names the source and offers no editor: the source wins
  outright, so the inline list would be dead data (nothing renders it, and a failing source
  never falls back to it). The list is kept — the row says how many options are saved — and
  the editor returns the moment the source is cleared.

**Edit options…** opens the options editor: a table with one row per option.

| Column | Meaning |
|---|---|
| **Key** | What the form stores when this option is picked. Required, unique within the list. |
| **Label** | What the person filling the form reads. Blank means the key is shown. |

Type a key and label at the bottom and press **Add option** (or Enter). Rows can be moved up
and down and removed. **Export** downloads the list as a JSON file; **Import** replaces the
list with one. **Apply** puts the list into the panel's pending edits; the panel's **Save**
is what writes it to the form, like any other property. The editor can be dragged by its
title bar, resized from its corner, and maximized.

In the schema the list looks like this — the same shape a data source returns:

```json
{
  "id": "answer",
  "type": "radio",
  "configuration": {
    "label": "Do you agree?",
    "options": [
      { "value": "yes", "label": "Yes" },
      { "value": "no", "label": "No" }
    ]
  }
}
```

An inline option's label and description are plain strings in the form's language. Their
translations are in the form's `translations` section, keyed by the option's `value` — for these
two, `components › answer › options › yes › label` — and are typed in the Languages workspace
(see [translation-support.md](translation-support.md)); the editor has a column for the default
language only.

If the field also names a data source, the editor says so at the top: the inline list is kept
but not shown until the source is cleared.

---

## 2. Data sources defined at wiring time (host developers)

The shortest route from a list to a rendered `select`:

```ts
import { defineDataSources, RemoteDataSourceProvider } from "@argusvane/datum-engine";

const dataSources = defineDataSources({
  // A fixed list.
  countries: [
    { value: "CA", label: "Canada" },
    { value: "US", label: "United States" }
  ],
  // A loader: the request (id and query) and the context (locale, the form's current
  // values, the environment). Return items, or a { items } result, now or later.
  cities: async ({ query }, { values, locale }) =>
    fetchCities({ country: values.country, locale, ...query }),
  // A full provider (see section 4).
  products: new RemoteDataSourceProvider("products", "https://api.example.com/options")
});

host.dataSources = dataSources;      // <datum-form-host>, forwarded to <datum-form-renderer>
builder.dataSources = dataSources;   // <datum-builder>: the canvas previews them, the picker lists them
```

A component whose `data.sourceId` is one of these ids resolves here. Any other id falls
through to the runtime's registered sources (section 3), and a component naming no source
still reaches its inline options.

What a loader receives:

| Argument | Field | Meaning |
|---|---|---|
| request | `sourceId` | The id the component named. |
| | `query` | The request's query (from the render options, per component), merged over nothing — a wiring-time set has no `defaultQuery`. |
| context | `locale` | The form's current locale. |
| | `values` | A snapshot of the form's current values, so a source can depend on another field. |
| | `environment` | `"client"` unless the set was defined with `{ environment: "server" }`. |

The result is a `DataSourceSet`: a `DataSourceRuntime` that also knows its ids
(`has(id)`, `ids()`). Because it is a runtime, it can also be passed to `FormRuntime`:

```ts
new FormRuntime(form, { dataSources, submissionModes, validationPipeline });
```

Do that when validation or server code needs the same sources — the renderer's copy is
presentation only.

### The builder's picker

`<datum-builder>.dataSources` makes the picker list the set's ids. Sources registered on the
runtime are invisible to the builder, so name them too:

```ts
builder.options = { dataSources, dataSourceIds: registry.ids() };
```

With neither, the picker is a plain text box for the id.

### Trying it in the demo web host

The builder page's bar has a **Data sources** button (the database icon) that opens an
editor for exactly this set: add a source by id, give it `{ value, label }` items, and
**Save** — the picker lists it, the canvas previews it and the renderer offers it, with no
rebuild of the form. It stands in for the lists a real host wires in code, and is saved in the
browser's storage; **Export** / **Import** move the same JSON document `defineDataSources`
takes for fixed lists (`{ "departments": [{ "value": "eng", "label": "Engineering" }] }`). The
sources registered on the demo's runtime (`countries`, `contact-methods`) sit in the same list
and open read-only, showing their items and which fields name them; their ids cannot be
redefined, since a set defined at wiring time is asked first and would shadow them.

---

## 3. Data sources registered on the runtime (host developers)

The registered route, for sources shared across forms and used by validation:

```ts
const providers = new DataSourceProviderRegistry();
providers.register(new StaticDataSourceProvider("static-countries", [{ value: "CA", label: "Canada" }]));

const definitions = new DataSourceRegistry();
definitions.register({
  id: "countries",              // what a component names in data.sourceId
  providerId: "static-countries",
  version: "1.0.0",
  defaultQuery: { region: "americas" }   // optional; a request's query is merged over it
});

const dataSources = new RegisteredClientDataSourceRuntime(definitions, providers);
new FormRuntime(form, { dataSources, submissionModes, validationPipeline });
```

Resolution, per component, on every render (ADR 0001):

1. The runtime reads the component's `data.sourceId` (or the path a request names instead).
   No id → `undefined` → the component's inline options, if any.
2. The registry resolves the id to a definition (latest version unless one is asked for),
   then the definition's `providerId` to a provider — rejecting a provider whose declared
   `environments` exclude the runtime's own (`client` in the browser, `server` on a server).
3. The provider's `load()` receives `{ sourceId, query }` (the definition's `defaultQuery`
   under the request's query) and `{ locale, values, environment }`.

`resolveDataSource` throws for a component id the form does not have (`Component not found`; a
node a running journey presentation owns answers `undefined`, as does the presentation's own
container, except a worked-out value, which resolves the source of the form field it copies) and for a component that names a source when the runtime has no data-source runtime
(`Data source runtime is not configured`). Neither is published as `DATA_SOURCE_RESOLVE_FAILED`.
A definition that names a provider the registry does not hold (`Data source provider not found`)
fails inside the load, so it is published like any other failed source.

A source that throws publishes `DATA_SOURCE_RESOLVE_FAILED` on the runtime's event bus with
the component id, source id and message, and the component renders with an empty list. The
renderer also draws the reason under the field and dispatches `datum-error` (see "Paint first,
time out, surface" below). A source that never answers fails after `dataSourceTimeoutMs`
(15 seconds unless set, `0` for none), and a provider that answers nothing is a failure too.

`RegisteredServerDataSourceRuntime` is the same runtime pinned to `"server"`, for server-side
rendering and validation.

---

## 4. Writing a provider

A provider is anything with an `id` and a `load(request, context)` returning `{ items }`:

```ts
import type { DataSourceProvider, DataSourceRequest, DataSourceContext, DataSourceResult } from "@argusvane/datum-engine";

class LookupProvider implements DataSourceProvider {
  readonly id = "lookup";
  readonly environments = ["server"] as const;     // omit to allow both
  readonly privileges = { network: true };          // advisory, for host policy review

  async load(request: DataSourceRequest, context: DataSourceContext): Promise<DataSourceResult> {
    const rows = await lookup(request.sourceId, request.query, context.locale);
    return { items: rows.map((row) => ({ value: row.code, label: row.name, meta: row })) };
  }
}
```

| Field | Meaning |
|---|---|
| `id` | What a definition's `providerId` names. |
| `environments` | Where it may run: `["client"]`, `["server"]`, or both (omitted). A runtime refuses a provider that excludes its own. |
| `privileges` | Declared, not enforced: a `client` provider that needs `network` says so, for review. |
| `load` | Returns `{ items: [{ value, label, meta? }] }`. `meta` is carried but not rendered. |

Two ship with the engine:

- `StaticDataSourceProvider(id, items)` — a fixed list, copied on every load.
- `RemoteDataSourceProvider(id, baseUrl, fetcher?)` — POSTs `{ query, values, environment }` to
  `baseUrl?sourceId=…&locale=…` and expects `{ items }` back. Network-backed by construction;
  typically pinned to `["server"]`.

A provider is used either registered (section 3) or handed straight to `defineDataSources`
(section 2), where the set checks its `environments` the way a registry does.

---

## 5. What the renderer does with the items

Every render rebuilds the option states for the whole tree, all components in parallel,
through `resolveOptionStatesForTree`. Each component ends up with an `optionState`:

| `status` | Meaning |
|---|---|
| `ready` | `items` hold the options (from a source or the inline list). |
| `loading` | The component names a source that has not answered yet; `items` is empty. Only a paint that did not wait for sources draws this (see "Paint first" below). |
| `not-applicable` | The component names no source and has no inline options — a text field, or an empty select. |
| `error` | The named source failed; `items` is empty and `error` carries the message, `sourceId` the source. |

### Paint first, time out, surface

*This is the paint contract (ADR 0142): a sandbox that validates a source-backed choice must be given the resolved sources as `optionSnapshot`, or it refuses every answer to the choice (`option.sourceUnavailable`).*

The form is drawn without waiting for its data sources. A field whose source has not answered
is drawn as loading: the control carries `aria-busy="true"` and a status line under it says
"Loading the choices…" (the form text `optionsLoading`). When the source answers, the field is
repainted with its options. A source that answers inside the same turn of the event loop never
shows the loading state. Later edits are drawn at once as well, from the answers already known,
while a new request is outstanding.

A source that fails is not papered over. It fails when its loader throws or rejects, when it
answers nothing (`null`, `undefined`), when its answer is not a list of `{ value, label }` text
items (a remote endpoint that sends HTML or the wrong JSON), or when it runs out of time. The
element then dispatches `datum-error` once per component and message, with `detail.message`,
`detail.sourceId` and `detail.componentId`, and draws a short translated sentence under the
field (`optionsFailed`, "The choices could not be loaded.", tied to the control by
`aria-describedby`, marked `data-source-error`). The raw reason is the host's, on `datum-error`;
it is never put into the text a person filling the form reads.
The field offers no options. **The author's inline options are not a fallback** for a source
that was named and failed: they stand only for a component that names no source (or one the
resolver is not asked about, as a journey page's own field). Remove `data.sourceId` to use the
inline list.

Host options:

| Attribute | Property | Default | Meaning |
|---|---|---|---|
| `data-source-wait` | `dataSourceWait` | `none` | `none` paints first. `all` shows only "Loading form…" until every source has answered or timed out. The timeout bounds the wait. |
| `data-source-timeout` | `dataSourceTimeout` | `15000` | Milliseconds a data source may take before it counts as failed; `0` for no limit. Applies to the sources the host defined (`dataSources`) and, through `FormRuntime`'s `dataSourceTimeoutMs`, to the runtime's registered ones. Changing it rebuilds the runtime, like `validate-timeout`. |
| `wasm-timeout` | `wasmTimeout` | `15000` | Milliseconds the sandbox module (`wasm`) may take to load; `0` for no limit. A submit waiting on it, and any after, is refused as validator unavailable (`datum-error`); the next submit tries the load again. |

`<datum-form-renderer>` takes `dataSourceWait` and `dataSourceTimeout` as properties.

A list longer than `MAX_DATA_SOURCE_ITEMS` (5000) is cut to that many, a warning is logged, and
a line under the field says "Showing the first 5000 of N choices." (`optionsTruncated`). A list
that long is a search box's job. The cap is the engine's; the browser draws every item it is given.

The markup reads the same `items` for all three types: a `select` draws one `<option>` per
item after its placeholder, a `radio` one radio per item under a shared name, and
`checkboxes` one checkbox per item, composed into one object of booleans. A component whose
list is empty renders a select with only its placeholder, or an empty group.

The builder canvas renders through the same code, over its own preview runtime, with the same
precedence: wiring-time set, then the resolver the host gave the builder
(`dataSourceResolver`), then inline options. Hand the builder the same set as the renderer and
the canvas shows what the form will.

### Translatable labels

An option's `label` and `description` are host data, not form content (ADR 0158): a plain
string, or `{ default, locales }`. The form's own `translations` section and the host's catalog
do not reach them, since a source's items are the host's to word; an inline option, which is
form content, is translated in the Languages workspace instead. The renderer reads an item's
text in the filler's locale: the exact locale, then its primary language, then `default`. Plain
strings keep working and are shown as given.

- **Static sources** (`defineDataSources({ contactMethods: [{ value: "email", label: { default: "Email", locales: { fr: "Courriel" } } }] })`,
  `StaticDataSourceProvider`) carry the translations in the items.
- **Remote sources and loaders** may answer either way: the text already in the `locale` the
  request carried (`?locale=` on the remote provider, `context.locale` in a loader), or
  localized items holding every language at once. The renderer asks again on a language switch
  and never draws the previous language's answer.
- **Values are language-independent.** `value` is what is stored and what the option snapshot
  compares, so a switch of language never changes an answer. Everything that leaves the
  renderer or crosses the sandbox (typed answers, the review, the printed copy, the PDF, the
  error summary, the snapshot) receives plain strings resolved in the filler's, or the
  submission's, locale. A server that builds an `optionSnapshot` may send plain strings, or
  localized labels, which `@argusvane/datum-submissions` resolves in the submit locale before the
  sandbox sees them. The sandbox reads values only, so its interface is unchanged.

### Validating the answers: the option snapshot

The kernel holds every answer to a source-backed choice (`select`,
`radio`, `checkboxes` with `data.sourceId`) to the list that source holds, and fails closed when
it has no list: an answer that picks a value of such a choice is refused with
`option.sourceUnavailable` (`parameters.sourceId` names the source). The lists reach the kernel
as `context.optionSnapshot`, `{ [sourceId]: [{ value, label? }] }`; a source missing from it, or
whose entry is not a list, is unavailable. An answer that picks nothing passes, and an inline
option list needs no snapshot.

**In the browser** `FormRuntime` builds the snapshot itself whenever a sandbox is attached
(`<datum-form wasm="...">`, `wasmValidationHost`): at submit it loads each source the form names
through the runtime's data sources (the set the page defined with `dataSources`, plus the
registered ones) with no query, so the whole list, under the same `data-source-timeout`. A source
that throws, times out, answers nothing or answers something that is not a list is left out of
the snapshot on purpose, and the sandbox refuses answers to its choice: a source that is down
does not let any answer through. `<datum-form>` needs no attribute for this; it is the same
`dataSources` that fill the field. That is one more request per source at submit.

**On a server** the sandbox is handed the context by the host, so the host sends the lists. The
server examples in the docs' [live examples](../site/docs/examples.md) do (`"optionSnapshot": {"countries": COUNTRIES}`, the lists
the endpoint resolves itself; the program never fetches). With `@argusvane/datum-submissions` there are two
seams:

- `settings.validation.optionSnapshot`, plain data registered beside the form (it persists with
  the catalog entry, and is left out of `listCatalog`), for lists that do not change;
- `createSubmissionService({ optionSnapshot })`, a provider
  `(definition, values, locale) => snapshot | undefined`, called for every judgement
  (`receive` and `validate`), for lists that depend on the answers, the locale or the day. Where
  both name a source the provider's list wins. A provider that throws refuses the call
  (`validator_unavailable`, a 503, nothing kept); to treat one source as down, leave it out of
  the result.

**A typeahead whose suggestions are not the only answers** says so in the definition:
`"data": { "sourceId": "cities", "answersFree": true }` (the **Answers may be free text** switch
in the inspector's Data section). The kernel then does not hold that choice to the snapshot, so a
host need not send the source (a free source is left out of what `FormRuntime` loads at submit,
and out of the refusal); the answer still has the shape of its kind and passes the field's own
limits (`maxLength`, `pattern`, `required`). Only the boolean `true` counts; absent, the answer is
validated and the check fails closed as above. The `inspect` op lists each source on its path as
`source: { id, free }`. A source shared with a choice that is not free is still loaded and still
binds that choice. Hosts with their own "does not validate answers" setting (for their data
sources) write this flag into the definition rather than leaving the source out of the
snapshot.

A server that sends neither refuses every answer to a source-backed choice. A server host that
is not `@argusvane/datum-submissions` (Java, .NET, Python) puts `optionSnapshot` in the context it
hands the program, as the samples do.

---

## 6. Choosing a route

| Situation | Use |
|---|---|
| A handful of fixed choices the author owns | Inline options |
| The page already has the list, or can fetch it | `defineDataSources` at wiring time |
| The list is shared across forms, or validation must see it | Registered on the runtime (or pass the wiring-time set to `FormRuntime` too) |
| The list depends on another field's value | A loader or provider reading `context.values` |
| The list must not be fetched from the browser | A provider with `environments: ["server"]` |

Things to know:

- **Translation.** A source's labels and descriptions are translatable text; see
  [Translatable labels](#translatable-labels).
- **Value membership is checked in the sandbox, not by the markup.** The
  kernel holds an answer to a source-backed choice to the list the host sends as
  `optionSnapshot`, and refuses one outside it, or every one when the source is missing from
  the snapshot (see [Validating the answers](#validating-the-answers-the-option-snapshot)). A
  choice marked `answersFree` is the exception. Without a sandbox nothing checks membership:
  add a validation stage if you need it there.
- **Options are read at render time.** A source is asked again on every render; cache in the
  provider if the lookup is expensive.
