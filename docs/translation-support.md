# Translation Support

How multilingual forms work on this platform: where translated text lives, how the right
text is chosen for each person filling in the form, and where each kind of value is managed.
The design is [ADR 0158](adr/0158-translations-as-a-section-of-the-definition.md).

This guide is written for form owners, content managers, and translation coordinators. You
do not need to read any code — everything here is about the JSON documents you will see in
the schema view and the translation files you may hand to translators, plus the builder
screens that edit them.

---

## The big picture

A form is written in **one language**, its default. Every text it says — a label, a
description, a placeholder, a button's caption, an option, a message, a header line, a
journey's page title, a PDF layout's heading — is a **plain string** in that language.
Everything translated lives in **one section of the definition**, `translations`, and is
edited in **one place**, the builder's **Languages** workspace.

| Place | What it holds | Who manages it | Where |
|---|---|---|---|
| **Form localization settings** | Which locales the form supports and which one it starts in | The form owner | Builder → **Languages** → the language cards |
| **The form's texts** | The default-language string of every text, stored where it is used | The form author | Builder → select a field → its text properties |
| **The `translations` section** | Every translation of those texts, by language, then kind, then the id of the thing that holds the text | The translators, through Languages | Builder → **Languages** (type, or export and import a file) |
| **The host's catalog** | A document of translations your application supplies to the form; an entry there **overrides** the form's own for the same address | The application or the translation team | A document your application hands to the form when it prepares it |

Choices that come from a data source are translated too: a source's items carry the same
localized text (static lists) or answer per `locale` (remote ones); see
[data-sources.md](data-sources.md#translatable-labels). Those items are host data, not form
content, so they keep the `{ "default": …, "locales": { … } }` shape.

A form can use any mix of these. A single-language form uses none of them — its labels are
plain text and nothing else is required.

The builder's own interface words are a separate, developer-only setting: see [builder-ui-translation.md](builder-ui-translation.md).

---

## 1. Form localization settings

The form definition carries one `localization` block:

```json
{
  "id": "customer-intake",
  "version": "1.0.0",
  "localization": {
    "defaultLocale": "en",
    "supportedLocales": [
      { "code": "en", "label": "English" },
      { "code": "fr-CA", "label": "Français" },
      { "code": "ar-EG", "label": "العربية (مصر)" }
    ]
  },
  "root": { "...": "the form's fields" },
  "translations": { "...": "section 2" }
}
```

| Field | Meaning | If left out |
|---|---|---|
| `supportedLocales` | The locales a person is **allowed** to view the form in, in the order the switcher offers them. The runtime refuses to switch to anything else. | Any locale is accepted (no restriction). |
| `supportedLocales[].code` | The locale's code. | — (required) |
| `supportedLocales[].label` | What the language switcher calls this locale: its name **in that language** ("Français", not "French"), since a person looking for their language reads it. The form owns this name, so it is the same under every application that shows the form. | The browser names the language in itself (`Intl.DisplayNames`), falling back to the code. |
| `defaultLocale` | The locale the form **starts** in, and the language its strings are written in. Should be one of the supported locales. | The form starts in `"en"`. |

Locale codes follow the common web convention: a two- or three-letter language code,
optionally followed by a region — `"en"`, `"fr-CA"`, `"ar-EG"`, `"es"`, `"pt-BR"`.

### Asking for a locale from the host page

The `locale` attribute of `<datum-form>` negotiates rather than demanding an exact code: case
is ignored and `_` reads as `-`, a regional request falls back to its language (`fr-CA` meets a
declared `fr`; a bare `fr` meets a declared `fr-CA` when no plain `fr` is declared), and a
request nothing matches leaves the form in its `defaultLocale`. The form always ends up in the
code it declared. `locale="auto"` negotiates the visitor's `navigator.languages` the same way
(it is opt-in; without it the form opens in its default). A form that declares no
`supportedLocales` accepts the value as written. The language switcher and `setLocale()` stay
strict and refuse a code the form does not declare. `form.locale` keeps the value the page asked
for; the read-only `form.activeLocale` is the code the form negotiated to, and `datum-locale-applied` fires with it for this path as for the switcher.

Switching locale also re-runs validation for fields already showing an error, so messages from
custom or plugin validators are worded again in the new language. For the engine's own codes,
an authored `messages` entry wins, then the form's `texts` translation of the code (see "The
engine's own words" below), then a binding's language pack, then the engine's English, then any
baked `message`.

### Where the language switcher appears

The switcher a person uses to change language is drawn by the form itself, in its header (or,
if you or the hosting application prefer, its footer). The form supplies what it offers — the
supported locales, in their order, each under the label authored for it. Under the default
look it is a labelled drop-down; a design-system binding can present it its own way (the GC
Design System binding shows the Government of Canada language toggle). Picking a locale the form does not
support is refused by the form, and the control goes back to the language the form is still
in.

Who places it: the application that shows the form decides *whether* a switcher shows. You
decide *where*, and what it is called, in the **Language switcher** row of the Languages
workspace (below): header, footer, both, or not shown, and its label. That row writes the
switcher part of the form's header and footer. The **Header & footer** panel on the builder's
activity strip edits the rest of those regions — an image (a logo), a heading, text, HTML
instructions, the form's title or description, or a group that puts several parts side by
side. Every part has an `id`, unique across the header and the footer (the builder gives the
parts it creates one, `part_1` and so on), because the part's translations are stored under
it. A part with no usable `id`, or an `id` another part holds, is reported when the definition is
checked (`chrome.part.id.missing`, `chrome.part.id.duplicate`), and the renderer draws such a part in
the form's own language rather than in another part's translation. When the application adds a switcher of its own, it fills the slot you placed rather than
adding a second one; when you placed none, the application's goes where the application put
it. The application's other parts, if any, are drawn after yours.

### Where to manage it

Everything about languages is in the **Languages** workspace (the bar's **Languages** button).

- **Language cards** — one card per language: its code and name, a **Default** badge on the
  language the form starts in, how much of the form is translated into it, and counts of its
  missing texts and its texts whose source changed. A card's menu has **Make default**,
  **Rename code** and **Remove**. To add a language, type its code (and, if you like, its own
  name) in the box and press **Add**. Leave the name blank and the language takes its own name
  from the browser (`Intl.DisplayNames`), stored with
  the form (where the browser has no name, none is stored and the code is shown), so a form authored here names its languages even where the page that shows it lacks
  locale data. The first language you add becomes the default. A code is two or three letters
  with optional subtags (`fr`, `pt-BR`) and at most 35 characters, and one already in the list
  (in any case) is refused, when adding and when renaming. The name is the language's own ("Français
  (Canada)"), the same in the builder, every host and every binding's switcher: the host supplies no
  list of languages and only decides whether a switcher shows.
- **The preview language** — the language the canvas shows while you build. The Settings panel
  has the same control.

There is nothing about languages in the Form panel, the field inspector or the Edit options…
and Edit messages… dialogs any more. A component whose form has more than one language shows
one line under its texts instead — how many of its texts are translated into each language —
and **Open in Languages**, which opens the workspace filtered to that component.

**Removing a language deletes its translations.** The card's **Remove** asks first and says
how many translations go with the language. The removal is one undo step: Undo brings the
language and all its texts back, the journeys' and the PDF layouts' included. Undo puts back
only what that step took: a language added since stays, and so does a journey or a layout made
since. Removing the default language hands the place to the next one; that language's wording
becomes the default text first, as in *Changing the default language* below.

**Renaming a language code.** **Rename code** on the card renames a code (`fr` to `fr-CA`).
One step renames the language's key in the `translations` map, in every kind, and is undone in
one step; the label stays. A code already in the list is refused. A PDF layout's own document
language (`accessibility.lang`) follows the rename too.

**Changing the default language.** **Make default** asks first. The wording in the new default
language then becomes the string stored on each text, and the old default string moves into the
old language's translations, all in one undo step. Where the new language has no wording for a
text, that text keeps its string: nothing is invented.

#### Language changes and the host's catalog

The builder does not ask the host to prune or move catalog entries while the author works:
Undo would then lose catalog wording the builder can no longer bring back. It keeps count
instead of the **net** change to the form's languages since a baseline — the form as loaded,
or as the host last saved it:

```ts
interface LocaleChanges {
  removed: string[];                              // baseline codes the form no longer has
  renamed: Array<{ from: string; to: string }>;   // baseline codes now under another code
}
```

A rename chain (`fr` to `fr-CA` to `fr-QC`) is one move, `fr` to `fr-QC`; a rename back, or a
language removed and then restored by Undo, is no change at all; Undo and Redo move the count
along with the form. A host that keeps a catalog reads it when it saves, from either:

- `fileActions.save` is called with `{ localeChanges }` (the builder's File menu Save);
- `datum-builder-save` carries `detail.localeChanges`, for a Save the `save` attribute turned
  on;
- `builder.localeChangesSinceSave()` on `<datum-form-builder>` / `<datum-builder>`, for a host
  with a Save of its own.

It applies the change to its catalog: first drop each `removed` code's entries, then move each
`renamed` pair's wording from `from` to `to` (read every source before writing any, so two
codes can swap). When the save has succeeded the baseline is reset — `fileActions.save`
resolving does it, as does a save by the `save` attribute (bare or with an address); otherwise call `markSaved()` (which also resets the dirty flag) or
`markLocalesSaved()`. A failed save leaves the count as it was. Loading another form resets it
as well. The change event carries no `removedLocales` and no `renamedLocales`: the form's own
translations are pruned and moved inside the definition, so there is nothing for a host to
act on there.

A form that never enables localization carries no `localization` block at all — that is
normal, not an omission.

---

## 2. The texts and the `translations` section

### The texts are plain strings

```json
"label": "Full name"
```

Just a string, in the form's default language. It is shown to everyone who has no
translation. It is the safety net: it always exists, so no viewer ever sees a blank label.
Every text a definition authors is one: a component's label, description, placeholder,
tooltip, prefix, suffix and pattern message; an inline option's label and description; a
validation message; the form's title and description; a header or footer part's text,
heading, HTML, image description and switcher label; a journey's name and its pages' titles
and descriptions; a PDF layout's name, title, headings, texts and captions.

### The translations are one map

`FormDefinition.translations` holds every translation, **language first**, then the **kind**
of thing, then the **id** of the thing that holds the text, then the text's property:

```json
"translations": {
  "fr-CA": {
    "form": { "title": { "text": "Accueil des clients", "source": "18gf023" } },
    "components": {
      "fullName": {
        "label": { "text": "Nom complet", "source": "13z0t9r" },
        "messages": { "required": { "text": "Entrez votre nom complet.", "source": "8bi3le" } }
      },
      "contact": {
        "options": { "email": { "label": { "text": "Courriel", "source": "inbfc7" } } }
      }
    },
    "chrome": { "welcome": { "text": { "text": "Demander une prestation", "source": "k25i2c" } } },
    "journeys": { "apply": { "name": { "text": "Faire une demande", "source": "1k6e5zv" } } },
    "pdf": { "record": { "name": { "text": "Dossier d'admission", "source": "11rlmyu" } } }
  }
}
```

The six **kinds** are a fixed vocabulary:

| Kind | Holds | Keyed by |
|---|---|---|
| `form` | The form's own title and description, the form's validation messages (`messages › <code>`), and the printed form's header and footer lines (`print › header › start`, and the same for `end` and `footer`) | nothing: the form's properties sit directly under `form` |
| `components` | A component's texts, an inline option's texts (`options › <value> › label`), its validation messages (`messages › <code>`), a tab's caption (`tabs › <tab id> › label`) | the component's `id` |
| `chrome` | A header or footer part's texts: `text`, `html`, `label`, `alt`, and a picture's `src` or a link's `href` | the part's `id` |
| `journeys` | A journey's `name`, its wording (`texts › <key>`), its pages' `title` and `description` (`pages › <page id> › title`) | the journey's `id` |
| `pdf` | A layout's `name`, its document title, its headings and texts (`nodes › <node id> › label`), a template's field and area fill texts | the layout's `id` |
| `texts` | The engine's own words: its form texts (`form › <key>`) and the validation messages it words itself (`messages › <code>`) | `form` or `messages` |

### Where each text lives

A text's address is its kind, the owner's key (none for `form`) and a path of property segments.
The path never holds an index: an option is named by its `value`, a message by its `code`, a part,
page, node or tab by its `id`. A code that contains dots (`date.min`) stays one segment, and
nothing is ever split on a dot.

| Text | Kind | Owner | Path |
|---|---|---|---|
| Form title, description | `form` | none | `title`, `description` |
| The form's own validation message | `form` | none | `messages › <code>` |
| A printed form's header or footer line | `form` | none | `print › header › start` (and `end`, `footer`) |
| A component's label, description, placeholder, tooltip, prefix, suffix, pattern message, HTML content, image alt, a step's label | `components` | component id | `<property>` |
| An inline option's label or description | `components` | component id | `options › <value> › label` or `description` |
| A component's validation message | `components` | component id | `messages › <code>` |
| A tab's caption (`tabs` container) | `components` | container id | `tabs › <tab id> › label` |
| A data grid's label, description, `addLabel`, `removeLabel`, `rowLabel`, `emptyText` | `components` | grid id | `<property>` |
| A print note | `components` | component id | `print › note` |
| A journey's own node text | `components` | the node's own id | as any component |
| A plugin component's own configuration texts (a `localized-text` field of its definition) | `components` | component id | `<property>` |
| A header or footer part's text, html, label, alt, src, href | `chrome` | part id (unique across header and footer) | `<property>` |
| A journey's name | `journeys` | journey id | `name` |
| A journey's wording (back, continue, submit, pageOf, checking, serverUnavailable) | `journeys` | journey id | `texts › <key>` |
| A page's title, description | `journeys` | journey id | `pages › <page id> › title` or `description` |
| A page's wording | `journeys` | journey id | `pages › <page id> › texts › <key>` |
| A PDF layout's name | `pdf` | layout id | `name` |
| A layout's document title | `pdf` | layout id | `accessibility › title` |
| An attachment's description | `pdf` | layout id | `conformance › attachment › description` |
| A signature's reason | `pdf` | layout id | `signature › reason` |
| A generated layout node's label (a section heading, a field label override, a signature caption), text, emptyText, alt | `pdf` | layout id | `nodes › <node id> › <property>` |
| A template field's fill text | `pdf` | layout id | `fields › <AcroForm field name> › text` |
| A template area's fill text | `pdf` | layout id | `areas › <area id> › text` |
| An engine form text | `texts` | `form` | `<form text key>`, or `<key>.<plural category>` |
| An engine validation message | `texts` | `messages` | `<code>` |

A layout the form derives (a form with no declared layout) is worded when it is derived, from the
form's own addresses; nothing lives under `pdf` for it. These texts stay plain `LocalizedText`, since
they are host data and not form content: data-source items, binding and frame labels, host chrome
parts (`host: true`), the renderer's `texts` property, a host's validation-message catalog, the
submission notice, PDF theme texts and an answer object `{ default, locales }`.

### The engine's own words

English is the only language the engine words itself in, and it is the source a `texts` translation
is fingerprinted against. The renderer's own sentences (the error summary's heading, a data grid's
Add button, the steps' Back and Continue, "Loading the choices…") are **form texts**, each under a key
(`summaryHeading`, `dataGridAdd`), and the validation messages the engine words itself (`required`,
`date.min`, `rows.min`) are keyed by code. Their translations sit in the map under `texts`:

```json
"fr-CA": {
  "texts": {
    "form": { "dataGridAdd": { "text": "Ajouter une ligne", "source": "1d3k9q" } },
    "messages": { "required": { "text": "Ce champ est requis", "source": "0x2f8a" } }
  }
}
```

A form text is worded by the first layer that has it: the page's own `texts` (`<datum-form texts>`), the
form's `texts` translation for the locale (the host catalog's over the definition's map), a binding's
language pack, then the engine's English. A binding may ship words of its own in any languages (the GC
Design System and Québec bindings ship French); a language nobody words falls back to English. The
Languages workspace lists every engine word under **Built-in texts**, so they are translated like
any other text.

A word that takes plural forms has one entry per category (`summaryHeading.few`), kept only for the
languages whose plural rules use the category. The source of these words is the engine's English, so
every declared language that is not English takes a translation, the default language included: a
form whose default language is not English has a column for it in the Languages workspace and in an
export, holding the engine's own words and nothing else.

A few rules make the map safe to edit by hand, by tool, or by a translator's file:

- **Keys are ids, never positions.** A component is keyed by its `id` (not its data key, which
  may repeat in different containers), an option by its `value`, a message by its `code`, a
  part by its `id`. Reordering the options or the header does not disturb a single
  translation.
- **An entry is `{ "text": "…", "source": "…" }`.** `text` is the translation. `source` is a
  short fingerprint (FNV-1a, base 36) of the default string the translation answered. If the
  default string is edited afterwards, the fingerprint no longer matches and the builder
  flags the translation **Source changed** until you confirm it or retype it. Nothing else is
  stored: no old wording, no timestamp.
- **The default language has no entry.** Its wording is the string itself. The builder never
  writes a map entry for `defaultLocale`, except for the engine's own words (`texts`) when the
  default language is not English.
- **An empty translation is no translation.** Clearing a cell deletes the entry (and any
  parent left empty), and the text falls back to the default.
- **A language key is read as the form spells the language.** A map key that differs from a
  language the form declares only in case or in `_` against `-` (`fr_ca` for `fr-CA`) is read
  under the declared spelling when the builder loads the form, as no undo step; two keys for
  one language merge, the declared spelling's own entries winning, and its kinds stay in the
  order of the table below.
- **What cannot be used is left out, and the builder says so.** An entry whose text is not
  text or that has no `source`, a kind the table does not list, and a key that cannot be a
  property name (`__proto__`, `constructor`, `prototype` or an empty one) are not kept. The form still loads, the
  builder raises one `datum-warning` with the code `translations.dropped` (the count and the
  first addresses, each as a path such as `fr-CA.components.fullName.hint`; a text that lost
  its place in a merge is named by the key it sat under), and saving writes the rest.

### What happens when you edit the form

The builder keeps the map in step with the form, one undo step each time:

| You… | The map… |
|---|---|
| Delete a component, an option, a message, a header part, a journey page or a PDF layout | loses its entries in every language |
| Duplicate or paste a component (or a subtree) | copies the entries to the new ids; pasting from another form carries what the clipboard holds |
| Rename a component id, an option value, a part id or a page id | moves the entries to the new key |
| Rename or remove a language, or make another the default | follows (section 1) |

When a component's id is renamed, the builder's change event reports `renamedIds`
(`[{ kind: "components", from, to }]`), so a host that keeps a catalog under the same
addresses can rename its entries too.

### Where to translate

Only the **Languages** workspace edits the map. See *The Languages workspace* below. Each text
property in the inspector is one plain text box: the default string. A **data grid**
(ADR 0153) has three captions of its own, each a text like a label: **Add button label**
(`addLabel`), **Remove button label** (`removeLabel`) and **Empty text** (`emptyText`). They
sit in the grid's Rows section and are translated in Languages. Left empty, each falls back to
the form's own wording ([Data grids](#data-grids)). The grid's column headings are not
captions: a column heading is the label of the field in that column, translated as that
field's label is.

---

## 3. The host's catalog

A host can supply a translation catalog of its own. It has **the same shape as the form's
map** — language, then kind, then id, then property — with **plain strings** at the leaves
(a host keeps no fingerprints):

```json
{
  "fr-CA": {
    "components": {
      "country": { "label": "Pays" }
    },
    "chrome": {
      "help": { "text": "Besoin d'aide? Appelez-nous." }
    }
  }
}
```

An entry in the catalog **overrides** the form's own translation of the same address, and
the Languages workspace shows such a cell read-only, marked "Set by the page".

### How it reaches the form

The catalog is **supplied by the application that hosts the form**, as configuration, at the
moment it prepares the form for display: the `translations` property (or attribute, as JSON)
of `<datum-form>` and `<datum-form-builder>`, or `translationCatalog`
when you build a `FormRuntime` yourself. The form platform never fetches translations itself
— your technical team decides where the catalog lives (a database, a translation service, a
bundled file) and hands the finished JSON object to the form.

A server-side run words its messages the way the browser does, so a run's context may carry the
catalog too, as the optional key `catalog` beside `translations`, in the same shape. The JVM host,
the FastAPI host and the in-page `@argusvane/datum-submissions` server pass it, each only when the
catalog holds something. A message is resolved in the order of "How the displayed text is chosen": a
blank or non-string leaf, an unsafe segment (`__proto__`, `constructor`, `prototype` or an empty one) or a catalog that is not a record is no text and falls
to the next source, never an error.

This means the catalog is available from the very first moment the form renders — there is
no loading delay and no "failed to load" state. If the application supplies no catalog, the
form shows its own translations and its default strings.

### Why use it

The catalog separates the **translation workflow** from **form authoring**:

- Translations can be corrected or re-issued **without changing the form definition** — no
  new form version for a wording fix; your application just supplies the updated catalog.
- Different environments or audiences can be served different catalogs from the same form
  definition.

### Practical notes

- A catalog entry is addressed by the **ids** of the form. Rename a component's id in the
  builder and the catalog must follow, or its entries silently stop applying. The builder
  reports `renamedIds` on its change event for exactly this.
- Extra entries in the catalog that no text of the form has are harmless and ignored.
- The catalog document itself is never edited in the form builder — it is owned by whoever
  manages translations, and delivered by the hosting application.
- To let
  the Languages workspace mark the texts your catalog overrides, give `<datum-form-builder>`
  the same document: `builder.translations = catalog`. (On the engine's own `<datum-builder>`
  the property is `translationsSource`, a function answering `{ catalog }`.)

---

## How the displayed text is chosen

When the form renders a piece of text for the viewer's current locale, it checks the
sources **in this order** and uses the first hit:

1. **The host's catalog, exact locale** (`fr-CA`).
2. **The form's `translations`, exact locale.**
3. **The host's catalog, the language on its own** (`fr`).
4. **The form's `translations`, the language on its own.**
5. **The string** stored on the text — always present, always last.

Tags compare case-insensitively with `_` read as `-`, and an empty string is no text, so it
falls through to the next source.

Two rules worth internalizing:

- **The catalog outranks the form's translations at the same precision.** An exact match in
  the form's own map still beats a catalog entry for just the language.
- **Regional fallback is automatic.** A viewer in `fr-CA` will happily receive a plain
  `fr` translation if no `fr-CA` one exists. This means a catalog (or a map) can be written
  once per language and still serve every region of it.

### Worked example

The form has `"label": "Country"` on the component `country` and, in its `translations`,
`"fr-CA"` → `components` → `country` → `label` → "Pays (dans le formulaire)". The application's
catalog has `"fr"` → `components` → `country` → `label` → "Pays (catalogue)".

| Viewer's locale | Shown | Why |
|---|---|---|
| `fr-CA` | Pays (dans le formulaire) | The form's `fr-CA` is an exact match; the catalog has only `fr`, which is less specific. |
| `fr` | Pays (catalogue) | Exact match in the catalog. |
| `fr-CH` | Pays (catalogue) | No exact match anywhere; the catalog's `fr` is tried before the map's language entry. |
| `ar-EG` | Country | No entry for Arabic anywhere → the string. |
| `en` | Country | Same — the string. |

---

## When things don't match

There is deliberately **no error state** for translation gaps. Every mismatch resolves to
*something readable*, text by text:

| Situation | Result |
|---|---|
| The catalog and the form's map disagree for the same locale | The catalog text is shown. |
| A supported locale has no translation anywhere | The stored string is shown. |
| A translation's `source` no longer matches the string | The translation is still shown; the builder flags it **Source changed**. |
| The map or the catalog holds locales the form doesn't support | Unreachable — viewers can't switch to an unsupported locale, so those entries are never used. |
| The catalog holds entries for ids the form doesn't have | Ignored. |
| The application supplies no catalog | The whole form runs on its own translations and strings. |

The Languages workspace shows coverage: each card counts the texts missing in its language
and the texts whose source changed, and the Texts table filters to them. Before publishing a
new locale, filter to **Missing** and walk the form in that locale.

---

## The Languages workspace

The bar's **Languages** button opens one workspace for everything about languages, in three
parts:

1. **Language cards** (section 1): the languages, their coverage, **Make default**, **Rename
   code**, **Remove**, and the box that adds one.
2. **The language switcher row**: where the form shows the switcher (header, footer, both,
   or not shown) and the switcher's label — written to the form's switcher part — and the
   preview language.
3. **Texts**: every text of the form, in a table.

The **Texts** table has a group rail (**All texts**, **Fields**, **Options**, **Messages**,
**Header & footer**, **Journeys**, **PDF**, **Built-in texts** (the engine's own words, below), and **Page catalog** for texts only the host's
catalog words), a search box, and a status filter (**All**, **Missing**, **Source changed**,
**Overridden by the page**). **All languages** shows one column per language; **One language**
shows one language at a time, where **Enter** moves to the next text that needs you. A cell
the page's catalog words is read-only and says so. A cell with no text of its own that the form
already shows from a base language counts as translated and stays editable: the page's catalog under
the language alone (`fr` for `fr-CA`) is shown as the page's, and the form's own `fr` text, when the
catalog has none, as served by `fr`. That fallback is not the cell's wording: **Make default**
promotes only text the cell holds itself, and a text whose only wording comes through a
fallback is not listed (or counted) as worded: the table lists a text when it has a default or a
stored translation of its own, and a note under the table counts the ones it leaves out ("N texts
have no wording yet and are not listed: word them in Form first."). A cell whose source changed offers
**Confirm** to say the translation still reads right.

Typing in a cell writes nothing yet: the changes collect in a bar that says how many are
waiting, with **Apply** and **Discard**. **Apply** writes them all as one undo step. Leaving
the workspace (or switching documents) with typed cells asks you to apply or discard them
first.

The row **Show it in Form** takes you to the component the text belongs to. Journey and PDF
texts are rows of the same table: the journeys' names, page titles and wording, and the PDF
layouts' names, headings and texts are translated here, and counted in each language's
coverage.

### Export and import

Translators and AI assistants work on files, not on the builder, so the workspace exports
its texts and imports the result. Both live in the Texts header.

**Export** takes the texts out as one of three formats, for all texts, for the texts that are
missing or whose source changed, or for one group:

- **JSON** — a header and one object per text.
- **CSV** — the spreadsheet format (RFC 4180 quoting). The file starts with a UTF-8 byte-order
  mark so Excel opens its accents correctly (the pasted prompt has none), and a byte-order mark is
  tolerated when a file is read back.
- **XLIFF 2.0** — for translation tools; one file per language, the address as the unit id
  and the default as the source; the file of a non-English form's default language names English
  as its source language, since only the engine's own words are in it. A browser lets one download follow a click, so with several
  languages the dialog lists a link for each file instead of starting them all at once.

The same three texts of the example form (its title, the full-name label and the email option's
label) in each, as the Export dialog writes them. `exportedAt` is the time of the export;
`where` is the owner's label and the text's name, so a translator can find it.

JSON:

```json
{
  "form": "customer-intake",
  "exportedAt": "2026-10-28T14:30:00.000Z",
  "defaultLocale": "en",
  "locales": [
    "fr-CA",
    "es"
  ],
  "texts": [
    {
      "kind": "form",
      "key": "",
      "path": "title",
      "where": "Form · Title",
      "default": "Customer Intake",
      "source": "18gf023",
      "status": { "fr-CA": "fresh", "es": "missing" },
      "fr-CA": "Accueil des clients",
      "es": ""
    },
    {
      "kind": "components",
      "key": "fullName",
      "path": "label",
      "where": "Full name · Label",
      "default": "Full name",
      "source": "13z0t9r",
      "status": { "fr-CA": "fresh", "es": "fresh" },
      "fr-CA": "Nom complet",
      "es": "Nombre completo"
    },
    {
      "kind": "components",
      "key": "contact",
      "path": "options/email/label",
      "where": "Preferred contact method · Option “email”",
      "default": "Email",
      "source": "inbfc7",
      "status": { "fr-CA": "fresh", "es": "fresh" },
      "fr-CA": "Courriel",
      "es": "Correo electrónico"
    }
  ]
}
```

CSV (the columns `kind, key, path, where, default, source` come first, then, for each
language, a `lang:<code>` column and the `status:<code>` column beside it):

```csv
kind,key,path,where,default,source,lang:fr-CA,status:fr-CA,lang:es,status:es
form,,title,Form · Title,Customer Intake,18gf023,Accueil des clients,fresh,,missing
components,fullName,label,Full name · Label,Full name,13z0t9r,Nom complet,fresh,Nombre completo,fresh
components,contact,options/email/label,Preferred contact method · Option “email”,Email,inbfc7,Courriel,fresh,Correo electrónico,fresh
```

The **status** of a text in a language is `fresh` (translated, and the default has not changed
since), `stale` (translated, but the default has changed since) or `missing` (no translation).
It is there for the person reading the file: CSV carries it in the `status:<code>` column after
each language, JSON in a `status` object keyed by language (`{ "fr-CA": "stale" }`), and XLIFF
in the segment's `state`. An import ignores it; what it compares is the text and the `source`
fingerprint.

A spreadsheet runs a cell that begins with `=`, `+`, `-`, `@`, a tab or a line break as a
formula. The CSV export therefore writes one extra apostrophe in front of such a cell, counting
any apostrophes it already leads with (a text `=SUM(1)` is written `'=SUM(1)`, a text `'=x` is
written `''=x`), and the import removes one apostrophe from any cell that
matches, so every text comes back as it went out. JSON and XLIFF are not guarded.

XLIFF (`fr-CA`; a file per language). The segment's `state` is `translated` for a fresh
translation and `initial` for a text with no translation yet, written with an empty target. A
stale translation is `translated` with `subState="datum:stale"`; these are the states XLIFF 2.0
allows, and the import reads them only to ignore them:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="en" trgLang="fr-CA">
  <file id="f1" original="customer-intake" xml:space="preserve">
    <unit id="form/title">
      <notes>
        <note category="location">Form · Title</note>
      </notes>
      <segment state="translated">
        <source>Customer Intake</source>
        <target>Accueil des clients</target>
      </segment>
    </unit>
    <unit id="components/fullName/label">
      <notes>
        <note category="location">Full name · Label</note>
      </notes>
      <segment state="translated">
        <source>Full name</source>
        <target>Nom complet</target>
      </segment>
    </unit>
    <unit id="components/contact/options/email/label">
      <notes>
        <note category="location">Preferred contact method · Option “email”</note>
      </notes>
      <segment state="translated">
        <source>Email</source>
        <target>Courriel</target>
      </segment>
    </unit>
  </file>
</xliff>
```

A text's address is the pair `kind` and `key` (the owner's id) plus `path`. A segment that
holds a slash or a percent sign is written with `%2F` and `%25`, so the path is never
ambiguous. In XLIFF the address is the unit id (`components/fullName/label`).

**Copy as a prompt** puts a short instruction and the CSV on the clipboard, for an AI
assistant: it asks for the empty cells of the language columns to be filled (a translation
whose source text has changed since is written as an empty cell, so it is refreshed), the other
columns (and the `lang:` heading row) to stay as they are, placeholders such as `{{name}}` to be
kept, and the complete CSV back; the prompt's CSV carries no `status:` columns.
Import what it answers as a CSV file.

On import, a CSV column is a language only when its heading starts with `lang:` followed by a
language code (`lang:de`, `lang:pt-BR`; the prefix may be in any case, and a space after the
colon is fine). A column without the prefix is never a language, so a Notes, Status or ID column
needs no care, and a prefixed heading that is no language code (`lang:Notes`, or a bare `lang:`, which the
list names as written) is listed as a problem and skipped. A CSV with records and no `lang:` column is listed as having no language
column (`noLanguageColumns`), with nothing to import. In JSON the keys carry no prefix, so a key that is a language
code is a language, except the names a row commonly carries beside its texts (`id`, `ref`,
`tag`, `uid`, `url`, `row`, `num`, `nr`, `no`): those are listed as a problem and skipped
unless the form already declares that code as a language. `kind`, `key`, `path`, `where`, `note`,
`default`, `source` and `status` are never languages.

**Import** reads a JSON, CSV or XLIFF file made by Export. **Nothing changes until you
apply.** The dialog first shows a preview:

- The counts of what the file holds: **New**, **Changed**, **Unchanged**, **Unknown** (an
  address the form does not have, skipped) and **Source changed** (the file's `source` no
  longer matches the form's current default — the translation is imported and flagged).
- The **languages the form does not have**, each with an **Add** checkbox; a language left
  unchecked is skipped with its rows.
- **Replace existing translations**, or **Fill blanks only**.
- A row-by-row table of the text, the language, what it says now, what the file says and what
  applying does with it.

**Apply** adds the checked languages and writes every accepted translation as **one undo
step**. A file is untrusted input: an address with an unsafe segment (`__proto__`,
`constructor`, `prototype` or an empty one) is refused, a file over 4 MiB or with more than 20,000 rows is
refused, a document type declaration in an XLIFF file is refused, a file that is not valid UTF-8
(a spreadsheet's ANSI "CSV") is refused whole, since reading it lossily would write replacement
characters over good translations, and problems are listed (at most 200) without stopping the rest.

A cell is read only where the form would show it. A language a text has no cell for (an engine
word has none in English; a counted text's plural form exists only where the language's plural
rules use the category, judged by address, from the engine's own list of plural forms, for a language the import adds) is never asked for in an
export and is skipped on import, as is a cell the page's catalog words under the exact tag; each
skip has its own status in the preview (`noCell`, `pageWorded`), apart from **Unknown**. A column
for the default language is read for the engine's own words only: the default-language wording of
any other text is the form's own and is refused, and the prompt for an AI assistant says which
cells of the default and English columns stay empty. A CSV row that does not line up with its header
(a comma that lost its quotes shifts every later cell, so the row is wider than the header or its
`source` is no fingerprint) is reported and left out.

### Host wiring

| You want to… | Do this |
|---|---|
| Give a page its own wording for some texts | Set `translations` on `<datum-form>` (and on `<datum-form-builder>`) to a catalog in the shape above |
| Keep the form's translations | Persist `definition.translations` with the rest of the definition; `<datum-form-builder>.definition` returns it |
| Know a language was removed or renamed (for a catalog you keep) | `localeChangesSinceSave()`, or the `localeChanges` handed to `fileActions.save` and carried by `datum-builder-save` |
| Know a component id was renamed (for a catalog you keep) | `renamedIds` on the `builder-change` event detail |
| Hide the workspace | `hidden-workspaces="languages"` (the `languages` feature turns it off with the others) |

---

## Common patterns

**Single-language form.** Do nothing: plain-text labels, no `localization` block. Add
localization later without restructuring — adding a language turns the existing strings into
the default.

**Small multilingual form, translations managed by the form author.** Add the languages in the
Languages workspace and type each translation in its cell. Everything lives in one document;
no catalog needed.

**Translator-managed workflow.** Add the languages, then **Export** the texts (CSV for a
spreadsheet, XLIFF for a translation tool, or **Copy as a prompt** for an AI assistant) and
**Import** the returned file. The preview tells you what changes before it does, and a text
whose source changed since the export comes back flagged for review.

**Wording fixes without a new form version.** Put the corrected wording in the host's catalog:
it outranks the form's own translations, and the Languages workspace shows those cells as set
by the page.

---

## Validation messages

The text shown for a validation failure (for example a "required" message) is a small map
from **error code** to a string — the form's default-language wording — and it lives in the
form itself. Its translations are in the `translations` section, under the form (for the
form's messages) or under the component (for a field's), at `messages › <code>`:

```json
{
  "root": {
    "type": "form",
    "configuration": {
      "title": "Customer intake",
      "messages": {
        "required": "This field is required.",
        "maxLength": "Keep it under {maxLength} characters."
      }
    },
    "children": { "content": [
      {
        "id": "email", "type": "text",
        "configuration": {
          "label": "Email",
          "required": true,
          "messages": { "required": "Enter your email so we can reply." }
        }
      }
    ] }
  },
  "translations": {
    "fr-CA": {
      "form": { "messages": { "required": { "text": "Ce champ est requis.", "source": "7dfi7a" } } },
      "components": { "email": { "messages": { "required": { "text": "Entrez votre courriel pour que nous puissions répondre.", "source": "1nfqm7i" } } } }
    },
    "ar-EG": {
      "form": { "messages": { "required": { "text": "هذا الحقل مطلوب.", "source": "7dfi7a" } } }
    }
  }
}
```

**Where each message applies.** Messages on the form (Builder → **Form** → **Validation**
→ **Edit messages…**) are the form's wording for every field. Messages on a field (select
the field → **Validation** → **Edit messages…**) apply to that field alone and win over the
form's. A section's messages, if a form carries any, cover the fields inside it. The nearest
one to the field decides. The dialog edits the default-language wording only; the other
languages' wording is typed in Languages, in the **Messages** group.

**The application's wording comes first.** The application hosting the form may supply a catalog
of its own (`messages` on `<datum-form>`): a map from code to text in the
`{ "default": …, "locales": { … } }` shape, since it is host data. For one error the catalogs
layer in this order and the first to name the code wins: the application's, then the field's own,
then each section's up to the form's. A code the application names is therefore worded its way
on every form it embeds, replacing each field's own message for that code. A code it leaves out keeps the form's words, so
an application that only wants to fill gaps names just the codes its forms leave unworded. Where
no catalog names a code, the form's texts word it (`error.<code>`, by the field's label), then the
error's own message and the engine's sentence, and the bare code last.

**Codes and details.** Every code the field's own checks can raise (on the form, every code
its fields can raise) is already a row when the editor opens — its code, what it means, and
an empty message cell. A blank row keeps the application's or the engine's wording; where the
application words the code, that wording shows greyed in the cell, and **Use default** copies
it in so you can edit from it rather than retype it. Such a row cannot
be removed, only **Clear**ed, since the check still raises the code. (The application hands
the builder its wording along with its codes — `validationCodes: [{ code, label, message }]`.) Under the table sit the other codes as buttons: on the form, **Other engine codes**
and, if the application named any, **Named by the page**; on a field, all of them behind
**Other codes**. Hover a button for what the code means and the details its message may
quote; click it to put the code in the code box, then add the message. Any other code can
still be typed — a code your application's server or rules return is whatever it chose. A
message may quote the error's details in braces, as the table below lists. A field's older
**Pattern message** box still works and counts as that field's `pattern` message.

| Code | Raised when | Details a message may quote |
|---|---|---|
| `required` | A required field is left empty | — |
| `minLength` | Text is shorter than the field's minimum | `{minLength}` the minimum, `{length}` the current count |
| `maxLength` | Text is longer than the field's maximum | `{maxLength}` the maximum, `{length}` the current count |
| `pattern` | Text does not match the field's pattern | `{pattern}` the expression |
| `fileType` | An attached file's type is not among the accepted ones | `{file}` its name, `{type}` its type, `{accept}` the accepted types |
| `maxFileSize` | An attached file is larger than the field's limit | `{file}` its name, `{sizeLabel}` and `{maxFileSizeLabel}` readable sizes (`{size}`, `{maxFileSize}` in bytes) |
| `number` | A number field holds an answer that is not a number | — (a box the browser could not read adds `badInput: true`) |
| `date` | A date field holds an answer that is not a real date | — |
| `dateIncomplete` | A date was typed in part (browser only) | `{missing}` the parts left ("month and year"), `{missingKey}` (one of `day`, `month`, `year`, `day-month`, `day-year`, `month-year`, so each case can be worded), `{missingParts}` |
| `rule` | A field's Validate rule (`rules.validWhen`) does not hold | — |

Codes beyond these come from the application: what its server answers for a field
(`taken`, say), what a sandboxed rule returns, or a form-level failure such as
`delivery.failed`. The application can name them to the builder so they appear under
**Named by the page**, with its own wording as the hint.

If nothing anywhere words a code, the raw error message (or the code itself) is shown.

**Numbers and dates** (ADR 0122). A non-empty answer on a number field raises `number` unless it is
a finite number or a text that is a plain decimal numeral once trimmed (`12`, `-3.5`, `1e3`, `.5`);
"1,000", "0x10", "Infinity", "12 kg", a boolean, a list and an object do not pass. The text is
judged by its spelling alone, never by the number an engine reads it as, so every host agrees: a
numeral too large for a double ("1e999") passes. A date must be exactly `YYYY-MM-DD`, years 0001 to
9999, a month 01 to 12 and a day the month has (Gregorian leap years); a datetime text, "2026-2-3"
and a number raise `date`. An empty answer raises neither code, since Required judges it, and
nothing is rewritten. Both checks apply to the built-in number and date types only (a plugin's
number or date input is not checked), come after Required and before bounds, length and pattern,
and hold for a hidden answer that is still submitted, a field a presentation fills, and a field of
a repeating section at each entry.

Two things a control knows are not in the answer, which is empty, so they stay in the browser.
A date drawn as parts that is typed in part raises `dateIncomplete` in place of `required`, with or
without Required; its details name the parts left in day-month-year order, and no part missing, or
all three, is not incomplete. A number box holding text the browser cannot read raises `number` with
`badInput: true`. A server holds only the empty answer, so for the same submission it says
`required` or nothing; this is the one case where the browser is stricter than the server. The
states are forgotten when anything else writes the answer, when a draft loads, and while the
component is not visible, and a browser's own date box typed in part reports nothing more.

A number text box and a date's month typed as a name are read in the form's language where the box
is read, and only the canonical value is stored (a number, or a `YYYY-MM-DD` date), so the checks
above stay strict. A number reads digits grouped in threes by spaces or the locale's grouping mark
and a fraction after the locale's decimal mark, or "." where "." is not the locale's grouping
mark ("1,250,000" and "1 000" in English, "1 000,5" and "2,5" in French); digits grouped in other
sizes ("1,5" in English), or under a first group led by a zero ("0,500" in English, "0.500" in
German), are not a number, and a plain numeral reads as itself, so a text box
drawn for a number stores what `Number()` parses ("0x10" is stored as 16, "0b11" as 3, "0o17" as
15). A month reads as its name, the locale's short form or three or more letters only one month
starts with, in the form's language or English (the Gregorian calendar's names, whatever calendar
the locale uses by default, so Persian reads "مارس" and not "اسفند"), ignoring case, accents and a closing full stop
("Feb", "Sept.", "fevrier"), and is stored as the month's number; a select month is unchanged, and
a typed name redraws as its digits ("02") on the next draw. Text neither reading can read is kept as typed, so "12 kg"
is `number` and "Fbz" is `date`. A value a host, a draft or a server writes is never read this way.

**Right-to-left display.** Handled automatically. When the active locale is a
right-to-left language (Arabic, Hebrew, Persian, Urdu, and others), the rendered form
flips direction on its own — nothing to configure.

---

## Journeys

A form can also be asked as a **journey**: a step at a time, with routes between steps for some
answers, a step that stops the journey and a Check answers step (ADR 0112, ADR 0172). The questions are the form's own, so
their labels, options and messages are translated exactly as above. A journey adds text of its
own, and every piece of it is a plain string in the form's default language with its translations
in the same `translations` map, under `journeys › <journey id>`. Nothing about a journey needs
translating twice, and it is translated in the same Languages workspace (the **Journeys**
group).

| Text | Address | Where it shows |
|---|---|---|
| The journey's `name` | `journeys › <journey id> › name` | What an application offers when it lets a person choose between journeys. |
| A page's `title` | `journeys › <journey id> › pages › <page id> › title` | The page's heading. A page without one is headed by its first question's label, in the viewer's language like any label. |
| A page's `description` | `journeys › <journey id> › pages › <page id> › description` | A line under the heading. |
| The journey's `texts`, and a page's `texts` | `journeys › <journey id> › texts › <key>` and `journeys › <journey id> › pages › <page id> › texts › <key>` | The journey's own buttons and lines, below. A page's wording wins over its journey's on that page, and both win over the application's and the binding's. |
| A Check answers page's row wording (`review.labels`) | `journeys › <journey id> › pages › <page id> › review › labels › <component id>` | The row's key on the Check answers page, in place of the question's label. A row with no wording of its own shows the label, translated like any label. |

```json
"journey": {
  "journeys": [{
    "id": "eligibility",
    "name": "Check and apply",
    "texts": { "pageOf": "Step {{n}} of {{total}}" },
    "pages": [
      {
        "id": "landlord",
        "title": "Your landlord",
        "description": "Renters need their landlord's agreement.",
        "components": ["landlordName", "landlordConsent"]
      }
    ]
  }]
},
"translations": {
  "fr-CA": {
    "journeys": {
      "eligibility": {
        "name": { "text": "Vérifier et demander", "source": "1rb5hru" },
        "texts": { "pageOf": { "text": "Étape {{n}} de {{total}}", "source": "on1ejs" } },
        "pages": {
          "landlord": { "title": { "text": "Votre propriétaire", "source": "rmg7ho" } }
        }
      }
    }
  }
}
```

The wording a journey's `texts` (or a page's) may set, by key:

| Key | Shown | Engine's English | Placeholders |
|---|---|---|---|
| `back` | The link above every page but the first; shared with the steps container | Back | — |
| `continue` | The button under every page but the last; shared with the steps container | Continue | — |
| `submit` | The last page's button, unless the page holds a submit button of the form's own (that button's caption is its label, translated like any label) | Submit | — |
| `pageOf` | The caption in a step's heading, unless the journey's `progress` is `none` | Step {{n}} of {{total}} | `{{n}}` the page's number, `{{total}}` the questions and Check answers steps on the person's path |
| `checking` | The line under the button while the application's server checks the answers | Checking your answers… | — |
| `serverUnavailable` | The error shown when that server cannot be reached | We could not check your answers. Try again. | — |
| `change` | The link beside each answer on a Check answers page, which opens the step the answer was given on | Change | — |
| `changeHidden` | That link's whole name for assistive technology: the words after `change` are drawn visually hidden. A wording that does not start with `change` is read whole, `change` hidden from assistive technology | Change {{label}} | `{{label}}` the row's wording |
| `notProvided` | A Check answers page's value for an optional question left blank (unless the page leaves such answers out) | Not provided | — |
| `enterAnswer` | The link in place of a required answer not given, on a Check answers page; it opens the question's step | Enter {{label}} | `{{label}}` the row's wording |
| `pageRedirected` | The muted status line under a page's heading when the page asked for (`page`) was not open to the answers and the person was put on the nearest page they can reach; the next move clears it, and `datum-page-change` reports it with direction `"redirect"` | The page you asked for is not available yet. This is the nearest page you can open. | — |

The same keys can be worded by the application for every form it shows (the texts it hands
the form), and the engine words them in English alone. Another language comes from the form's
`texts` translations (the **Built-in texts** group of the Languages workspace) or from the language
pack of the binding drawing the form, so a journey only needs `texts` where it wants its own words. The error behind `serverUnavailable`
has the code `journey.server-unavailable`: a validation message for that code, on the form or from the application, wins over the text.

Two more keys word the card `<datum-form>` shows when a journey form's runtime file did not
arrive (a deployment that left it out, a blocked or failed request; ADR 0144). They are the
page's `texts` (not a journey's, since the journey has not loaded) and sit under the same
precedence as the other keys:

| Key | Shown | Engine's English |
|---|---|---|
| `journeysUnavailable` | The alert in place of the form | This form could not be loaded because part of it did not arrive. Check the connection and try again. |
| `retry` | The button on that alert, which asks for the file again | Try again |

A one-page journey (ADR 0121, ADR 0112) is translated the same way: the builder seeds its page
`title` from the form's title, and that title is a text of its own at
`journeys › <journey id> › pages › <page id> › title`, even while the journey hides its page
heading.

The builder's "Journeys" mode authors journeys (ADR 0115, ADR 0121, ADR 0112): their default
strings are edited there, and their translations are rows of the Languages table, in the
**Journeys** group. A journey-only field a journey owns (ADR 0121) is a component of its own and
is translated at `components › <field id>` like any field.

---

## Data grids

A data grid (ADR 0153) draws seven pieces of text of the engine's own. They are form texts, like
the steps container's Back and Continue: the engine words them in English, a binding may ship
them in other languages, and the form's `texts` translations or the application can word them for
every form it shows or for one page through the catalog.

| Key | Shown | Engine's English | Placeholders |
|---|---|---|---|
| `dataGridAdd` | The button after the rows; a grid's **Add button label** replaces it | Add row | — |
| `dataGridRemove` | The button that removes a row; a grid's **Remove button label** replaces it | Remove | — |
| `dataGridMoveUp` | The button that moves a row up | Move up | — |
| `dataGridMoveDown` | The button that moves a row down | Move down | — |
| `dataGridEmpty` | In place of the rows when there are none; a grid's **Empty text** replaces it | No rows yet. | — |
| `dataGridRow` | A row's heading (and its number in the error summary: "Row 2: Name") | Row {{n}} | `{{n}}` the row's number, from 1 |
| `dataGridActions` | The heading of the column holding the row buttons | Actions | — |

Each row's buttons are described by that row's heading, so a screen reader hears which row a
Remove belongs to.

---

## Quick reference: where do I change…

| I want to… | Go to |
|---|---|
| Add or remove a language the form offers | Builder → **Languages** → the box that adds one; a card's menu → **Remove** |
| Change the language the form opens in | Builder → **Languages** → a card's menu → **Make default** |
| Translate one field's label myself | Builder → **Languages** → find the text (search, or the field's **Open in Languages** line) → type in the language's cell → **Apply** |
| Translate the choices of a select, radio or checkboxes | Builder → **Languages** → the **Options** group → type in each option's cell → **Apply**. Choices that come from a data source are translated by the source (see [data-sources.md](data-sources.md)). |
| Change what every field says when a check fails (e.g. "required") | Builder → **Form** → **Validation** → **Edit messages…** for the default wording; the **Messages** group in **Languages** for the other languages |
| Change what one field says when a check fails | Builder → select the field → **Validation** → **Edit messages…**. It wins over the form's message for that code. |
| Reword a data grid's Add row, Remove or empty-state text | Builder → select the grid → **Rows** → the caption boxes (and **Languages** for the other languages); the grid's other wording is the form's, see [Data grids](#data-grids) |
| Translate a journey's page headings, its buttons or its "Page n of N" | Builder → **Languages** → the **Journeys** group; the default strings are the journey's own `name`, `title`, `description` and `texts` — see [Journeys](#journeys) |
| Translate a PDF layout's names and texts | Builder → **Languages** → the **PDF** group |
| Send the texts to a translator or an AI assistant, and bring the result back | Builder → **Languages** → **Export** (or **Copy as a prompt**), then **Import** |
| Rename a language code, or change the default language | Builder → **Languages** → the language's card menu (see section 1) |
| Fix a translation managed by translators | Edit the catalog document your application supplies — no form change needed |
| Change the fallback text everyone sees when a translation is missing | The text's own string, in the builder |
