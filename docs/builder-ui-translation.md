# Translating the Builder's Interface

The builder's own words (buttons, panel titles, confirms, announcements, problem messages)
are English by default. A host application can show them in another language. This is a
developer setting on the builder element; form authors do not see or manage it.

This guide is for developers integrating Datum into their own tools. Most integrations never
need it.

---

## Not the same as form translations

| | What it translates | Who manages it | Where it is set |
|---|---|---|---|
| **Builder interface** (this guide) | The builder's buttons, panels, confirms, announcements | The integrating developer | `textLocale` and `textCatalog` on the builder element |
| **Form translations** | The form's own labels, descriptions, messages, per language | The form author | Builder → **Languages** workspace (stored in the form definition) |
| **Host translation catalog** | Form text overrides keyed by stable IDs, kept outside the definition | The translation team | A catalog your application supplies to the form (see [translation-support.md](translation-support.md)) |

The three are independent. Changing the builder's interface language never changes the form,
and the form's languages never change the builder's words.

---

## Setting it

Two properties on the builder element:

```js
const builder = document.querySelector("datum-builder");

builder.textCatalog = {
  fr: {
    "logic.group.form": "Ce formulaire",
    "rule.show.when": "Afficher {target} lorsque {condition}"
  },
  "fr-CA": {
    "logic.group.form": "Ce formulaire-ci"
  }
};
builder.textLocale = "fr-CA";
```

- `textLocale` is a BCP 47 string (`string | undefined`). Absent means English.
- `textCatalog` is a `BuilderTextCatalog`: `{ [locale: string]: Partial<Record<key, string>> }`.
  Each locale holds only the keys you translate.
- Both can be set at any time, including after the builder is on the page; the builder reads
  them live.

### Fallback

Each key is looked up key by key down a chain: the exact locale (`fr-CA`), then its primary
language (`fr`), then English. A key you leave out falls to the next step, so a catalog can be
partial, and a `fr-CA` map can hold only the words that differ from `fr`.

### Overriding one key

Translation is not required to change one word. Supply a catalog with just that key under the
locale you set (use `"en"` to reword English):

```js
builder.textCatalog = { en: { "logic.group.form": "This intake form" } };
builder.textLocale = "en";
```

### Placeholders

Values are filled into named slots written with single braces: `{target}`, `{condition}`,
`{count}`. Keep the slot names from the English text. A slot with no value stays visible as
written, which makes a mistyped name easy to spot.

### Plurals

Counted texts have one key per plural category, as `<key>.one`, `<key>.other` (and `.zero`,
`.two`, `.few`, `.many` where the language needs them). The category comes from
`Intl.PluralRules` for the locale; when the chosen category has no key, `<key>.other` is used.
`{count}` is filled in. A language with more categories than English adds those keys:

```js
builder.textCatalog = {
  pl: {
    "problems.count.one": "{count} problem",
    "problems.count.few": "{count} problemy",
    "problems.count.many": "{count} problemów",
    "problems.count.other": "{count} problemu"
  }
};
```

### Lists

Where the builder joins items ("A, B or C"), it uses `Intl.ListFormat` for the locale, so the
separators and the word for "or" follow the language without a key. Where `Intl.ListFormat` is
missing, items are joined with commas and the `cond.join.and` / `cond.join.or` words.

### A sample: the Browser assistants setting in French

The Form settings panel has a "Browser assistants" setting (ADR 0155, the form author's switch for
assistants in the person's browser). Its nine words are in the core table under
`settings.agentTools.*`; the builder ships English only, so a host that wants them in French adds
them to its catalog. This is the sample catalog for them, with the English text each key replaces
in the comment:

```js
builder.textCatalog = {
  fr: {
    "settings.agentTools.title": "Assistants du navigateur",                  // Browser assistants
    "settings.agentTools.label": "Assistants dans le navigateur",             // Assistants in the browser
    "settings.agentTools.hint":
      "Indique si un assistant dans le navigateur de la personne peut remplir ce formulaire pour elle. Chaque site décide s'il offre des assistants.",
    "settings.agentTools.unset": "Non précisé",                               // Not set
    "settings.agentTools.unset.hint":
      "Les sites qui suivent le réglage du formulaire n'y admettent pas d'assistant; un site peut quand même les admettre sur tous ses formulaires.",
    "settings.agentTools.allowed": "Permis",                                  // Allowed
    "settings.agentTools.allowed.hint":
      "Les assistants peuvent remplir ce formulaire là où le site les offre.",
    "settings.agentTools.off": "Pas sur ce formulaire",                       // Not on this form
    "settings.agentTools.off.hint":
      "Pour les formulaires que la personne doit remplir elle-même, comme une déclaration. Les sites qui suivent le réglage du formulaire n'y admettent pas d'assistant; un site peut quand même les admettre sur tous ses formulaires."
  }
};
builder.textLocale = "fr";
```

The hints say that the author's "Not on this form" is honoured by sites that follow the form's
setting (`agent-access="definition"`, the default), not by every site: a site that sets
`agent-access="always"` on its form overrides it (see `docs/agent-tools.md`, "Turning assistants
off for a form").

---

## Where the keys live

- The core table, `engine/form-engine/builder/logic/builder-texts.ts`, holds the words the
  builder needs at once.
- Each lazily loaded area has its own English table beside its code, named
  `*-texts-en.ts` under `engine/form-engine/builder/` (Data, Languages, Print, Logic, Journeys,
  PDF designer, Overview, Palette, Formula, Try it). They load with the area, which keeps the
  main bundle small.

For a host, none of this matters: `textCatalog` is **one flat map per locale** covering every
key from every table.

---

## Getting a full template

To list every key with its English text, run from the `engine` directory:

```sh
npm run builder-texts:template -- fr            # JSON to stdout
npm run builder-texts:template -- fr texts.json  # or to a file
```

The locale is the first argument (default `xx`). The output is
`{ "<locale>": { "<key>": "English text" } }`, sorted by key. Give it to a translator, have them
replace the English, delete any keys they leave as is, and assign the `<locale>` object to
`textCatalog`.
