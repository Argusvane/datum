# ADR 0158: Translations as a Section of the Definition, and the Languages Workspace

## Status

Accepted.

## Context

A multilingual form carries text in many places: every label, description, placeholder and
message, the form's title, a header or footer part, a journey's pages, a PDF layout. Authors
should translate them in one place, and the common way to translate a form (hand every text to a
translator or an AI assistant and bring the result back) needs a route out and a route in.

Every surface that touches a translation wants the same view: address, then locale, then text.
Storing translations inline on each property would make the builder rebuild that view from a
tree walk, make locale removal a deep walk over every node's configuration, and leave the
"source changed" flag no place to persist beyond one builder session.

## Decision

### 0. Locales are declared in `localization`

`FormDefinition.localization` holds `defaultLocale` and `supportedLocales`, a
`SupportedLocale[]`. A `SupportedLocale` is `{ code, label? }`: the `label` is the locale's name
as a switcher shows it, in that language ("Français (Canada)"), the way a person looking for
their language reads it.

- **The form owns the names.** The same definition names its locales the same way in the
  builder, in every host and in every binding's switcher. Hosts supply no locale list anywhere;
  `<datum-form-host>.languageSwitcher` (a boolean) says only whether a switcher shows (ADR 0066).
- **One helper decides a locale's label.** `core/localization/supported-locales.ts`
  (`supportedLocaleEntries`, `supportedLocaleCodes`, `supportedLocaleOptions`) is the only place
  the array is read: the runtime's `setLocale` allow-list, the rendered switcher, the canvas's
  switcher and the Languages workspace all read through it. `supportedLocaleOptions` resolves each
  locale to its authored label, else its own-language name through `Intl.DisplayNames`, else its
  code.
- **The builder authors the label** in the Languages workspace (section 5). Adding a language
  takes a code and, optionally, a name; with none typed, the language's own name is stored, so a
  builder-authored form is self-describing even where the rendering runtime lacks locale data.
  `normalizeLocalizationConfiguration` writes objects and drops blank labels and repeated codes.
- **Removing a locale deletes its translations.** It is one undoable step after a confirmation
  that says how many translations go; see the builder's rules in section 4.

### 1. Text properties are strings; translations are one map

Every text a definition authors is a **plain string in the form's default language**: a
component's label, description, placeholder and messages, an option's label, the form's title, a
header or footer part's text, a journey's names and page titles, a PDF layout's texts.

`FormDefinition.translations` holds every translation, addressed **locale first**, then **kind**,
then the owner's **key**, then a tree of **property segments** whose leaves are entries (`form` has
no owner: its tree holds the form's own properties directly). The map's shape is in
`docs/translation-support.md`, "The translations are one map", and every text's address is in
"Where each text lives".

- The six kinds are a fixed vocabulary: `form`, `components`, `chrome`, `journeys`, `pdf`, `texts`.
  `texts` holds the engine's own words, under two owners: `form` (the renderer's sentences, by
  form text key) and `messages` (the validation messages the engine words itself, by code). Their
  source is the engine's English, so every declared language that is not English takes a
  translation, the default language included.
- A user-chosen name (a component id, a part id, an option value, a message code) only ever
  appears one level below a kind, so none can collide with a reserved word, and nothing is ever
  split on a dot.
- An **entry** is `{ text, source }`: the translation, and `source`, the fingerprint of the
  default-language string it answered (FNV-1a 32-bit, base 36, over the exact string). An entry
  whose `source` differs from the hash of the current default is *stale*: the builder flags it
  "Source changed" until the author confirms or edits it. Nothing else is stored: no old wording,
  no timestamp. A `source` that is not a base-36 hash of at most 8 characters (a hand edit, another
  tool) is never refused: the writer keeps the entry and stores a marker that matches no hash, so it
  stays flagged. Writers and the reader trim a text only to decide whether it is blank (a blank text
  is no entry); the stored text keeps the author's whitespace.
- **Keys are the ids the tree already guarantees unique**: a component's `id` (not its data key:
  data keys repeat across data-scoping containers), a chrome part's `id` (required on authored
  parts, unique across header and footer), a journey's `id` and its pages' `id`s, a PDF layout's
  `id` and the ids its nodes and areas carry. An inline option is keyed by its `value`, a message
  by its `code`. **Never an index.**
- `LocalizedText` the type survives only for text that is **host data, not form content**:
  data-source items, binding labels, the parts a host adds through `<datum-form-renderer>.chrome`,
  the renderer's `texts` property (`FormTextCatalog`) and a host's validation-message catalog
  (`ValidationMessageCatalog`). No definition type uses it. The same engine words can also be
  translated in the form's own map, as the `texts` kind: a word the host gives through `texts` or
  a `ValidationMessageCatalog` entry is read first, then the form's `texts` translation (the host's
  catalog over the definition's map), then the language pack, then the engine's English.

### 2. The host catalog has the same shape

`TranslationCatalog` is locale → kind → key → property tree, with **string** leaves (a host
has no fingerprints). An entry there overrides the form's own for the same address. A text carries
no separate key: the address *is* the key a host catalog is written against.

### 3. One resolver

`core/localization/translations.ts` is the one module that reads and writes the map: the entry
types, `TextAddress` (`kind`, `owner?`, `path`, never an index), the `addressOf` builders (one per
shape of text), `sourceHash`, `readTranslation`, `writeTranslation` (pure; an empty text deletes the
entry and drops empty parents), `reconcileTranslation`, `isStale`, `listTranslations`,
`pruneTranslations`, `copyTranslations`, `moveTranslations`, `removeLocale`, `renameLocale`,
`makeDefaultLocale`, `addressOfPropertyPath` and the tolerant readers `readFormTranslations` and
`readTranslationCatalog`, which drop unsafe segments (`__proto__`, `constructor`, `prototype` or an empty one),
malformed leaves and blank texts, and never throw. The PDF paths are built in
`render/pdf/pdf-text-addresses.ts`, shared by the render model, the designer and the Languages
workspace. A derived layout is worded at derive time from the form's own addresses; nothing lives
under `pdf` for it.

`resolveText(defaultText, address, locale, sources)` is the resolution order: catalog exact tag →
map exact tag → catalog primary subtag → map primary subtag → default text. Tags compare
case-insensitively with `_` read as `-`; an empty string is no text. `resolveLocalizedText` remains
for host data only, as do `isRtlLocale` and the tag helpers; a definition's own texts never go
through `LocalizedText`.

The renderer's context carries `translations` (the definition's map) beside `translationCatalog`
(the host's). The WASM kernel mirrors `resolveText` over the map for its messages and form-test
ops and, when the run context carries it (decision 7), over the host catalog too, in the browser's
order; the `test` op stays map-only, so a form's own tests run without a host. The PDF kernel
resolves a layout's texts the same way.

### 4. The builder's rules

- **Delete prunes.** Deleting a component, an inline option, a message code, a chrome part, a
  journey page or a PDF layout prunes its addresses from every locale in the same undo step.
- **Duplicate and paste copy.** A duplicated or pasted component (and its subtree) carries its
  translations under the new ids. Pasting from another form carries what the clipboard holds.
- **Renames move.** Renaming a component id, an option value, a part id or a page id moves the
  entries. Renaming a locale code renames the map's key. Removing a locale deletes its
  entries from the map in every kind, after a confirmation that says how many go, in one undo step; Undo puts
  back what that step took (`docs/translation-support.md`, "Where to manage it").
- **Make default swaps** through `makeDefaultLocale`: one undo step that rewrites the
  configuration strings and the map together. Typed cells in the grid are applied first, so a
  Make default or Remove after typing is two history steps (the cells, then the swap or removal),
  and each can be undone on its own.
- **Locale codes are at most 35 characters** (the kernel's structure limit); a longer code is
  refused when a language is added or renamed.
- **A chrome part's `id` is required and unique** across header, footer and groups. The load check
  reports `chrome.part.id.missing` and `chrome.part.id.duplicate`, and the renderer draws such a
  part in the form's own language rather than in another part's translation.
- **The inspector field type `localized-text`** means "a translatable string": it draws a plain
  text box for the default and is what `translatableTexts()` lists.
- **Nothing but the Languages workspace edits the map.** The inspector, Edit options… and Edit
  messages… edit the default strings only. A component whose form has more than one language shows
  one line under its texts, its coverage per language and *Open in Languages*.
- **A host catalog is not edited by the builder.** The builder keeps the net change to the form's
  languages since a baseline (`LocaleChanges`: removed codes, renamed pairs) and hands it to the
  host on save (`fileActions.save`, `localeChangesSinceSave()`), so Undo never loses catalog
  wording the builder cannot bring back. The change event reports ids renamed (`renamedIds`) for
  the same reason (`docs/translation-support.md` carries the contract).

### 5. The Languages workspace

One workspace for everything about languages: the language cards (code, name, Default badge,
coverage, Make default, Rename code, Remove), the switcher row, and the table of every text with a
column per language or a one-language view. Its decisions:

- A cell the page's catalog words is read-only. A cell with no text of its own that the form already
  shows from a base language counts as translated and stays editable (`fallbackText`,
  `fallbackFrom: "form"`, the fourth rung of the resolver); the fallback is not the cell's wording,
  so Make default promotes only text the cell holds itself, and a text whose only wording comes
  through a fallback is not "worded": the table lists a text, and the coverage counts it, only when it
  has a default or a stored translation of its own; the rest are only counted, in a note under the
  table (`languages.unlisted`: "{count} texts have no wording yet and are not listed").
- Typed translations apply as one undo step, and a leave guard holds unapplied ones. The surface
  computes and draws only while its workspace is shown, so a hidden one costs nothing on every
  change of the form.
- **Export** (JSON, CSV, XLIFF 2.0, and a "copy as a prompt for an AI assistant" action) and
  **import** are the route out and in. A file is untrusted input: unsafe segments are refused, the
  size and row count are capped, and a file that is not valid UTF-8 is refused whole. A cell is
  read only where the form would show it, so a language a text has no cell for and a cell the
  page's catalog words are skipped, each with its own preview status. The preview shows what changes
  before anything does, and apply is one undo step. The formats, the `lang:` and `status:` columns
  and the preview are in `docs/translation-support.md`, "Export and import".

### 6. Plugin renderers read their texts through the state they are handed

A plugin's or binding's adapter reads its authored configuration texts with the state's
`text(property)` (`FieldState.text` for a field, `GroupState.text` for a container,
`render/live/contract.ts`), not `resolveLocalizedText(config.x, locale)`: a text is a string and its
translations live in the definition's `translations` map. `text(property)` resolves the property for
the component being drawn, in the order the built-in renderers use, so a worked-out copy of the
component is read at the target's id. A plugin definition declares those configuration fields as
`localized-text` so the Languages workspace lists them at `components › <id> › <property>`; a plugin
that calls `resolveLocalizedText` on its configuration renders the default language under every
locale, because its translations are never read.

### 7. The host catalog crosses into a run

A server-side validation run words a message the way the browser does, so it needs the host's
catalog as well as the definition's `translations` map. A `run` context may carry the host catalog
as the optional key `catalog`, in section 2's shape, beside `translations`; the JVM host, the
FastAPI host and the in-page `@argusvane/datum-submissions` server pass it, each only when the
catalog holds something. Wherever a message is worded the order is `resolveText`'s, and a blank or
non-string catalog leaf, an unsafe segment or a catalog that is not a record is no text: the next
rung, never a throw. The browser stage reads `FieldConstraintsContext.catalog` (set by `FormRuntime`
from its `translationCatalog`) beside `translations`, so both sides word a pattern's message alike;
a journey page's own fields read the catalog through the same context.

### 8. Exchange files and load-time reading

- **A CSV language column is `lang:<code>`.** Only a prefixed header is a language on import, so an
  unprefixed header (a Notes or Status column) is never one; JSON keeps a not-a-language guard for
  keys such as `id` or `url`. Status columns are informational and ignored on import.
- **A CSV cell that looks like a formula** (it begins with `=`, `+`, `-`, `@`, tab, CR or LF, after any
  leading apostrophes) is written with one more leading apostrophe, and the importer takes one off any cell that matches.
- **Locale keys are normalised at load.** A loaded map's keys that differ from a declared code only
  in case or in `_` against `-` are renamed to the declared spelling once at load, not as an undo
  step; the builder writes only the declared spelling.
- **Dropped entries are reported.** The tolerant reader returns the count of entries it could not
  keep and the first addresses; the builder raises one `datum-warning` with the code
  `translations.dropped`, the form still loads, and Save writes the kept entries.

## Consequences

- One schema decision touches every reader of a text: the renderer, the runtime's locale switch
  and re-validation, both kernels, the PDF designer, the journey designer, the agent tools, the
  data model, the hosts' catalog classes (JVM and FastAPI) and the conformance suite.
- Addresses by id mean a host catalog follows id renames only if the host renames too; the
  builder reports `renamedIds` on the change event for that.
- Locale removal is a single map delete, not a walk over every node's configuration, and the
  "source changed" flag persists with the definition.
- `docs/translation-support.md` is the guide for authors and hosts; this ADR holds the decisions.
