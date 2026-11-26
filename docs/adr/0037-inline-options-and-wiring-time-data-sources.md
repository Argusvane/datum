# ADR 0037: Inline Options and Wiring-Time Data Sources

## Status
Accepted.

## Context

A `select`, `radio` or `checkboxes` component gets its choices from a data source named in
`configuration.data.sourceId`, which the runtime resolves through a `DataSourceRegistry`
(id → provider id) and a `DataSourceProviderRegistry` (ADR 0001). Two things are needed
beyond that route.

A short, fixed list — "Yes / No", four categories — should be typed into the form. Registering
every list, however small, as a source by whoever wires the runtime is too heavy, and the
builder has to be able to author one.

And a host that mounts the renderer needs a way to hand it data sources. Registering means
building three objects (a provider registry, a definition registry, a registered runtime) and
threading them into `FormRuntime`; a page that simply has the list in hand when it wires the
form needs a route of its own, the way ADR 0066 lets it hand over chrome.

## Decision

1. **Inline options are a configuration property.** `configuration.options` holds
   `{ value, label }` pairs (`core/schema/inline-options.ts`), `label` a `LocalizedText` like
   every other text — the same item shape a data source returns, so both routes meet in the
   render model's one `optionState` and the markup never knows which fed it. Reading is
   tolerant: an entry that is not an option is skipped, a missing label shows the value.

2. **A named data source wins over the inline list.** `resolveComponentOptionState` asks the
   resolver first; a component naming no source is answered `undefined`, and only then do
   its inline options apply. A configured source that fails stays an error rather than
   falling back to the inline list, so a broken integration is visible instead of silently
   showing whatever was typed months earlier.

   While a source is set the inspector offers no options editor: the inline list is dead data
   then, nothing renders it and nothing falls back to it. The saved list is never dropped, so
   switching to a source and back is lossless (`docs/data-sources.md`, section 1).

3. **Hosts define data sources at wiring time.** `defineDataSources({ id: input, … })`
   (`data/host/data-source-set.ts`) takes, per id, a fixed item list, a loader function, or a
   full `DataSourceProvider`, and returns a `DataSourceSet`: a `DataSourceRuntime` that also
   knows its ids. It is handed to `<datum-form-renderer>.dataSources` (forwarded by
   `<datum-form-host>`), to `<datum-builder>.dataSources`, and — because it is a runtime — may
   also be passed to `FormRuntime` as `dataSources` for validation and server-side use.

4. **The set is consulted before the runtime's registered sources.** The render bridge wraps
   the runtime's resolver (`createHostDataSourceResolver`): a component whose `data.sourceId`
   the set holds resolves there, with the form's locale and values as context; every other id
   falls through to `runtime.resolveDataSource`, and a component naming no source still
   reaches its inline options. The builder preview applies the same precedence over its own
   tree, so the canvas shows what the form will.

5. **The builder authors both routes in a Data section.** Capabilities contribute flat fields
   and the inspector groups `data-source-selector` and `options-editor` fields into a natural
   "Data" section after "Content"; the `dataSource` capability declares no section of its own,
   because a declared section list is exhaustive and would hide every other capability's fields.

   The Data source picker lists the wired set's ids plus any `dataSourceIds` the host
   names (sources registered on the runtime, which the builder cannot see), and is a text box
   for the id when the host wired nothing.

   The Options row opens a modal editor of the options (a key and a label each, in the form's
   default language, with Export / Import of the schema's own JSON). Apply writes the draft; the
   panel's Save writes the form. The editor is described in `docs/data-sources.md`, section 1.

## Consequences

- A form owner can author a list without asking anyone to register a source; a host can wire
  a list in one call; enterprise lookups keep the registered route, and the two mix.
- An inline option's label translates like any other form text, through the definition's
  `translations` section keyed by the option's value (ADR 0158).
- The browser renderer does not check a submitted value against its options. The sandbox kernel
  does: inline options everywhere, on every host, and source-backed options through the
  `optionSnapshot` the host passes with the options its data sources gave (ADR 0029). A
  source-backed choice whose source is missing from the snapshot is refused
  (`option.sourceUnavailable`), not left unchecked; `data.answersFree: true` is the author's
  opt-out for a source that only suggests (ADR 0142). The builder diagnostic
  `map.options-not-subset` says the server refuses such an answer.
