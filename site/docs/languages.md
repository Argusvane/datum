# Languages

A form can be filled in, printed and turned into a PDF in more than one language. It is written once, in its default language. Translations are kept in the form's definition, edited in the builder's Languages workspace, and chosen by the page that shows the form. Switching language never resets an answer.

## Where translations live

Every text the form says is a plain string in the default language. Every translation of those texts sits in one `translations` section of the definition, by language, then kind, then the id of the thing that holds the text. Which languages the form offers is the `localization` block.

```json
{
  "localization": {
    "defaultLocale": "en",
    "supportedLocales": [
      { "code": "en", "label": "English" },
      { "code": "fr-CA", "label": "Français" }
    ]
  },
  "translations": {
    "fr-CA": {
      "components": {
        "fullName": { "label": { "text": "Nom complet", "source": "13z0t9r" } }
      }
    }
  }
}
```

`source` is a fingerprint of the default text the translation answered: a hash of it, written in base 36.

- When the default text changes, the builder flags the translation "Source changed" until it is confirmed or retyped.
- A stale translation still shows to the person, since staleness is the author's concern.
- An empty translation counts as none.
- A text with no translation shows in the default language, so nothing is ever blank.

### The localization block

| Key | Takes | What it does |
|---|---|---|
| `defaultLocale` | A language code | The language the form's own texts are written in, and the one a form falls back to |
| `supportedLocales` | A list of `{ code, label? }` | The languages a person may view the form in, in the order the switcher offers them. A `label` is shown as written; without one the switcher names the language in its own language, from the browser's locale data, and falls back to the code |

A form that declares no `supportedLocales` accepts any code.

### The translations map

The map is nested in this order:

1. The language code.
2. The kind, one of the six in the table.
3. The owner, for every kind but `form`. The `form` kind has no owner level: its paths start directly under `form`.
4. The path to the text.

The leaf is `{ text, source }`. The kind says what holds the text, and what its owner is:

| Kind | Owner | Holds |
|---|---|---|
| `form` | none | The form's own title and description, and messages the form words for every field |
| `components` | A component id | Labels, descriptions, placeholders, option labels, messages and the rest of a component's texts |
| `chrome` | A header or footer part's id | The text, link, image and label properties of a part |
| `journeys` | A journey id | The journey's name, its page titles and descriptions, and its wording keys |
| `pdf` | A PDF layout's id | A layout's name and texts |
| `texts` | `form` or `messages` | The renderer's own words in another language: `form` by form text key, `messages` by validation code |

The path under an owner is a text's address. Nothing in it is an index: an option is named by its value, a tab by its id, a part by its id.

| Text | Address under the language code |
|---|---|
| The form's title or description | `form › title`, `form › description` |
| A message worded for every field | `form › messages › <code>` |
| A component's label, description, placeholder or tooltip | `components › <id> › label` and so on |
| An option's label or description | `components › <id> › options › <value> › label` |
| A component's message | `components › <id> › messages › <code>` |
| A tab's caption | `components › <id> › tabs › <tab id> › label` |
| The note printed beside a hidden field | `components › <id> › print › note` |
| A header or footer part | `chrome › <part id> › <property>`, the property being `label`, `src`, `alt`, `href`, `text` or `html` |
| A journey's name | `journeys › <journey id> › name` |
| A journey page's title or description | `journeys › <journey id> › pages › <page id> › title` |
| A Check answers row's wording | `journeys › <journey id> › pages › <page id> › review › labels › <component id>` |
| A journey's or a page's wording | `journeys › <journey id> › texts › <key>`, `journeys › <journey id> › pages › <page id> › texts › <key>` |
| A PDF layout's name | `pdf › <layout id> › name` |
| A PDF layout's other texts | `pdf › <layout id> › accessibility › title`, `… › signature › reason`, `… › conformance › attachment › description`, `… › nodes › <node id> › <property>` for a drawn layout, `… › fields › <PDF field name> › text` and `… › areas › <area id> › text` for a template |
| A renderer text | `texts › form › <key>` |
| A validation message of the renderer | `texts › messages › <code>` |

The host's `translations` catalogue has the same shape from the language down, with plain strings at the leaves and no `source`, so the address `components › country › label` is `{ "fr-CA": { components: { country: { label: "Pays" } } } }`.

Text a host hands in as data, such as a data source's labels, the renderer's `texts` and the parts it adds to the chrome, is written `{ default, locales }`, or as a plain string: a `default` and one entry per language.

Translatable texts:

- Labels, descriptions, placeholders, tooltips, prefixes and suffixes, and the captions of a data grid's buttons.
- Option labels and descriptions.
- Validation messages, for a component or for the whole form.
- The form's title and description, and the header and footer parts (the chrome).
- A journey's name, its page titles and descriptions, and its button wording.
- A PDF layout's name, headings and texts.
- The renderer's own sentences, such as the error summary heading, listed in the workspace under Built-in texts. Their keys are the form's text keys.

## The Languages workspace

The Languages button on the bar opens one workspace for everything about languages.

- **Language cards.** One per language, with its coverage and counts of missing texts and texts whose source changed. A card's menu has Make default, Rename code and Remove. Remove deletes that language's translations in one undo step. Type a code in the box and press Add to add a language.
- **The language switcher row.** Shows the switcher in the header, the footer, both or neither, and sets its label.
- **The grid.** Every text of the form in one table, grouped as Fields, Options, Messages, Header & footer, Print, Journeys, PDF and Built-in texts, with a search box and a filter for Missing, Source changed and Overridden by the page. Show one language per column or one language at a time.

- Typed cells collect in a bar with Apply and Discard, and Apply writes them as one undo step.
- While the form's settings hold changes not yet applied, the languages cannot be changed: apply or discard them first.

### Sending texts to a translator

Export takes the form's texts out for a translator, and Import reads the result back. Nothing changes in the form until you apply an import.

| Choice | Options |
|---|---|
| Format | JSON, CSV (a spreadsheet) or XLIFF 2.0. XLIFF writes one file per language |
| Which texts | All texts, Missing or source changed, or one group (Fields, Options, Messages, Header & footer, Print, Journeys, PDF, Built-in texts) |
| Languages | Any of the form's languages other than its default |
| Copy as a prompt | Puts the texts on the clipboard as CSV with instructions for an AI assistant. Import its answer as a CSV file |

Every exported text carries:

- its address
- a note of where it belongs
- the default text and its `source` fingerprint
- each language with a status of fresh, stale or missing

A CSV names its language columns `lang:` and the code, for example `lang:fr`. In the prompt a stale translation is written as an empty cell, so the assistant words it afresh.

On import the workspace reads a JSON, CSV or XLIFF file and shows a preview before it changes anything:

- a count of what is new, changed, unchanged, unknown and source changed
- a table of every row and what applying it does
- a list of problems

A language in the file that the form does not have is listed with an "Add" box to tick; one left unticked is skipped with its rows. Choose how existing translations are treated:

| Mode | An existing translation |
|---|---|
| Replace existing translations | The file's text replaces it |
| Fill blanks only | It is kept, and only empty cells are filled |

- A text in the file whose `source` no longer matches the form's default is imported and flagged "Source changed".
- A text the form does not have is skipped.
- An XML document type in an XLIFF file is refused.
- A file is read with limits:
  - 4 MiB
  - 20,000 texts
  - 16 KiB for one translation (a longer cell is skipped)
  - 100 new languages

## Choosing and switching the locale

| Attribute | Property | Takes | Notes |
|---|---|---|---|
| `locale` | `locale` | BCP 47 tag, or `auto` | The starting locale, matched against the form's supported locales as set out below. |
| `language-switcher` | `languageSwitcher` | boolean | Shows the locale switcher in the form's header. |

```html
<datum-form src="/forms/intake.json" locale="auto" language-switcher></datum-form>
```

### How the `locale` attribute matches

Each tag asked for is tried in order, and the first that matches wins. Case is ignored and `_` reads as `-`, so `fr_CA` is `fr-CA`.

1. A declared code that is the same tag.
2. Its language alone, against a declared code that is just a language: `fr-CA` meets `fr`.
3. Any declared code with the same language: `fr` meets `fr-CA`, and `fr-CA` meets `fr-FR`. The first declared wins. A match never crosses scripts, so `zh-TW` does not meet `zh-CN`, nor `sr-Latn` `sr-Cyrl`.

- The result is always the code as the form declared it.
- A tag nothing matches gives the form's `defaultLocale`, or its first supported locale when none is declared.
- A form that declares no supported locales takes the attribute as written (for `auto`, the visitor's first language).
- `locale="auto"` asks for the visitor's browser languages, in the browser's order, and takes the first that matches.
- Without the attribute the form opens in its default.

### `setLocale` and the switcher

`form.setLocale("fr-CA")` switches from the page, and it is strict where the attribute is not.

- It takes a declared code exactly, and throws for any other (a form that declares none takes any), so `form.setLocale(navigator.language)` throws for `fr-CA` when only `fr` is declared. Use the `locale` attribute for a best match.
- It also throws while the form is still being built (call it after `ready`) and when `translations` is left out of `features`.
- `activeLocale` reads the locale the form settled on.

A person changes language with the switcher. It offers each declared language under its label, or named in its own language. It can come from four places:

- the `language-switcher` attribute
- a `language-switcher` part in the header or footer chrome
- the Languages workspace's switcher row
- `formLanguageSwitcher: false` in the host's chrome, to drop one the form's author placed

See [Look and chrome](/look#chrome).

| Event | Fires | Detail |
|---|---|---|
| `datum-locale-applied` | When the `locale` attribute or the switcher puts a locale in effect. Not on a `setLocale()` call, since the page that made the call already knows | `{ locale }` |
| `datum-locale-rejected` | When the switcher picks a locale the form refuses, one outside its supported locales. The switcher is put back to the locale the form is still in | `{ locale, message }` |

- A `locale` attribute that cannot be applied is reported as `datum-error`.
- Switching also re-words the messages of fields already showing an error.

<LiveExample name="languages-form" />

- Pick `FR_ca` or `de` in the locale list to see the negotiation: `FR_ca` meets the declared `fr`, and `de` matches nothing, so the form stays in English.
- Use the form's own switcher, which fires `datum-locale-applied` (the page's listener logs "locale applied"), or the page's two buttons, which call `setLocale` and log `activeLocale`.
- Type an answer first: switching language keeps it.

## Supplying translations from the host

A host can keep translations outside the definition, so a wording fix needs no new form version.

| Attribute | Property | Takes |
|---|---|---|
| `translations` | `translations` | JSON catalogue: locale, kind, owner id, then the property, with plain strings at the leaves |
| `messages` | `messages` | JSON of validation message templates by code |
| `texts` | `texts` | JSON of the renderer's own strings (buttons, status lines) |

```js
form.translations = {
  "fr-CA": { components: { country: { label: "Pays" } } }
};
```

A catalogue entry overrides the form's own translation at the same locale. For one text the order is:

1. the catalogue's exact locale
2. the form's exact locale
3. the catalogue's language alone
4. the form's language alone
5. the default string

Entries for ids the form does not have are ignored. Give `<datum-form-builder>` the same `translations` and the Languages workspace shows the texts it overrides as read-only.

- **`texts`** words what the form draws itself, such as the error summary heading and the characters left. A counted text has one key per plural category (`countLeft.one`, `countLeft.other`), picked by the locale's plural rules.
- **`messages`** words each validation code. An entry wins over any message the form's author wrote for that code, the way `translations` win over the form's own translations. A code `messages` leaves out keeps the author's words.

<LiveExample name="languages-catalog" />

The form's own French for the email label is "Adresse courriel", and the page's catalogue says "Courriel", so the catalogue's wording shows.

- Press Send on the empty form: the summary heading comes from `texts`, and both fields' "required" from `messages`, which beats the name field's own "Enter your full name.".
- Turn `messages` off and the name field's own message comes back.
- Turn `translations` off and the email label returns to the form's own French.

## Where a word comes from

The author writes words into the definition and the page can hand words to the element. When both word the same text, the page wins, except for a journey's own wording. The page sets only what it wants to change: anything it leaves out keeps the author's words.

| Kind of word | The author sets it in the definition | The page sets it with | Who wins, first to last |
|---|---|---|---|
| Labels, descriptions, placeholders, options, the title, header and footer parts, journey names and page titles, PDF texts | The text itself, in the default language, and its translations | `translations` | The page's `translations`, then the form's translations, then the author's text in the default language |
| Validation messages | `messages` on a field, on a container or on the form, and their translations | `messages` | The page's `messages` for the code, then the field's own message, then its containers', then the form's, each in the page's or the form's translation where one exists. Then the form's own words for the error (`error.<code>` in `texts`), then the message the error came with, then the built-in sentence, translated under `texts` |
| The form's own words: the Submitting line, the error summary heading, Back and Continue, the character count, the confirmation | Its translations under `texts`, in the Languages workspace's Built-in texts | `texts`, and `translations` under `texts` | The page's `texts`, then the page's `translations`, then the form's translations, then the design system's words, then the built-in English |
| A journey's own wording of those words | `texts` on a journey or on one of its pages, and their translations | `translations` under `journeys` | The journey page's words, then the journey's, each in the page's translation or the form's. They are written for that journey alone, so they beat the page's `texts`, as a button's own label does |
| The builder's own buttons and panels | Nothing | `textCatalog` and `textLocale` on `<datum-form-builder>` | The page's catalogue, then English |

The language is matched the same way everywhere: the exact locale first, then the language alone.

- For `translations` each step is tried in the page's catalogue and then in the form's before the next step, so the form's exact `fr-CA` beats a page entry for `fr`.
- `messages` and `texts` entries are written `{ default, locales }`, or as a plain string that serves every language. An entry with no word for the language falls back to its own `default`, and that still beats the form.
- Name a code in `messages` only if you want your wording in every language you serve.

Which message comes first, the built-in sentence or the error's own:

- **The built-in sentence first.** For most codes the form raises itself (a number that is not a number, a date out of range, a journey's server out of reach) the built-in sentence comes before a message the error carries, since that message may be in another language.
- **The error's own message first.** A field's limits (`required`, `minLength`, `maxLength`, `pattern`, `fileType`, `maxFileSize`) and any code the form does not raise, such as one a server sends through `setErrors`, take the error's own message first.

## Choices in more than one language

A choice field's list can come from a source, and the source can speak the form's language in two ways:

- **One language at a time.** A function is told the language in `context.locale` and answers in plain text, with whatever fallback it wants. A remote endpoint can do this by reading a `locale` parameter from its URL.
- **Every language at once.** A source sends every language together, each label written as `{ default, locales }`, and the form picks the wording for its locale and falls back to the default.

Either way a language switch asks for the lists again, and the stored value never changes. More on sources in [Data model and data sources](/data).

<LiveExample name="languages-data-sources" />

Pick a kind in both fields, then switch to English with the form's switcher. The labels change and the chosen value stays, as the log's `datum-change` lines show. Choose the endpoint to see the request carry the form's locale.

If you keep a catalogue, the builder tells you what changed since the last save:

- `localeChangesSinceSave()` and the `localeChanges` on `datum-builder-save` list the languages removed or renamed.
- A component's id rename is reported as `renamed: { from, to }` on `datum-builder-change`.

```json
{ "removed": ["es"], "renamed": [{ "from": "fr", "to": "fr-CA" }] }
```

Apply it to your catalogue in this order:

1. Drop everything you hold under each code in `removed`.
2. Apply `renamed` as one simultaneous mapping, so two codes can swap. What you moved to `to` replaces whatever you held under it.
3. Call `markLocalesSaved()` afterwards, to make the languages as they stand the new baseline. `markSaved()` does it too.

- A chain of renames is one move from the code the form had at the baseline to the code it has now.
- A language removed and brought back is no change, and an Undo takes its part back.

<LiveExample name="languages-save" />

1. Press the builder's **Full window** button (the arrows on its bar).
2. Open **Languages**, and remove Español or rename `fr` to `fr-CA`.
3. Choose Save from the ⋮ menu.

The log shows the `localeChanges` the page was handed and the languages its catalogue holds afterwards. Undo before Save and the count returns to nothing.

## Right-to-left, print and PDF

When the active locale is a right-to-left language, the form flips direction by itself. Nothing is configured. The PDF follows the same rule. The languages read as right-to-left, judged by the language of the tag so `ar-EG` flips too, are:

- Arabic (`ar`)
- Hebrew (`he`)
- Persian (`fa`)
- Urdu (`ur`)
- Pashto (`ps`)
- Sindhi (`sd`)
- Uyghur (`ug`)
- Yiddish (`yi`)
- Divehi (`dv`)
- Kurdish (`ku`, `ckb`)

Print and PDF follow the form's current locale:

- Choice labels and dates are put into words in that language, and the printed header and page numbers use the translated texts.
- `renderPdf({ locale })` and the PDF button draw the PDF in the locale asked for, using the same translations as the form, and the PDF's document language follows it.

See [PDFs](/pdf).

## Translating the builder's own interface

The builder's buttons, panel titles and messages are English. A host can show them in another language. This is separate from the form's translations: it never changes the form, and the form's languages never change the builder.

```js
builder.textCatalog = {
  fr: { "logic.group.form": "Ce formulaire" },
  "fr-CA": { "logic.group.form": "Ce formulaire-ci" }
};
builder.textLocale = "fr-CA";
```

- `textLocale` is a BCP 47 tag; unset means English.
- `textCatalog` holds one flat map of keys per locale, and may be partial. A key is looked up in the exact locale, then its language, then English.
- Both can be set at any time.
- Values take named slots in single braces, such as `{count}`, where the form's own texts use double braces (`{{n}}`).
- Counted texts have one key per plural category (`<key>.one`, `<key>.other`).

<LiveExample name="languages-builder-words" />

Press the builder's **Full window** button (the arrows on its bar) so the builder has its full width. Undo, Redo and the Logic and Languages workspace names change language when you pick another `textLocale`; the catalogue is partial, so every other word stays English.

- With `fr-CA`, one key reads "Refaire" and the rest comes from `fr`.
- With `en`, or with `textLocale` unset, the interface is English and only the Languages workspace is reworded, to "Translations".

- A slot with no value stays visible as written, which makes a mistyped name easy to spot.
- The category for a counted text comes from the browser's plural rules for the locale (`zero`, `one`, `two`, `few`, `many` or `other`). When the chosen category has no key, `<key>.other` is used, so a language with more categories than English adds those keys.
- Where the builder joins items ("A, B or C"), it uses the browser's list formatting for the locale, so the separators and the word for "or" follow the language without a key.

To change one word without translating, give the catalogue only that key under the locale in use, with `en` to reword English:

```js
builder.textCatalog = { en: { "logic.group.form": "This intake form" } };
builder.textLocale = "en";
```

### Getting a template for a translator

The builder has well over a thousand keys, kept in tables that load with the area they belong to, but `textCatalog` is one flat map per locale over all of them. To list every key with its English text, run this from the `engine` folder of a checkout of the repository:

```sh
npm run builder-texts:template -- fr            # JSON to stdout
npm run builder-texts:template -- fr texts.json  # or to a file
```

The first argument is the locale (`xx` when left out). The output is `{ "<locale>": { "<key>": "English text" } }`, sorted by key. Then:

1. Give it to a translator to replace the English.
2. Delete the keys they leave as they are.
3. Assign the `<locale>` object to `textCatalog`.
