# The definition

A form is one JSON document. The builder saves it, **Download** hands it to you, the element renders it, and a server host validates against the same file. It holds the components, the rules, the journeys, the PDF layouts, the translations and the tests, so there is nothing else to keep in step with it.

## The top-level keys

| Key | What it holds |
|---|---|
| `id` | The form's name, a non-empty string. A server host finds the form by it |
| `version` | The form's version, a non-empty string |
| `schemaVersion` | The version of the definition format, a non-empty string. The examples use `"1"` |
| `root` | The tree of components. Its `type` is `form` |
| `metadata` | `name`, `description` and `tags` |
| `accessibility` | `focusFirstError`, a boolean: `false` keeps focus on the error summary after a check that found errors, even under a binding that would send it to the first field in error. Left out, the binding decides. See [Accessibility](/accessibility#what-the-renderer-does-for-every-form) |
| `localization` | `defaultLocale` and `supportedLocales`, each `{ code, label? }` |
| `translations` | The form's texts in each other locale: locale, then kind of owner (`form`, `components`, `chrome`, `journeys`, `pdf`), then owner id, then the text's property path (see [Languages](/languages)) |
| `journey` | Multi-page flows: `journeys` (see [Journeys](/journeys)), `defaultJourneyId`, and `opensAs`, which is `"journey"` or `"form"` |
| `pdf` | `layouts` and `defaultLayoutId` (see [PDFs](/pdf)) |
| `tests` | `scenarios`, each `{ id, source }`, `source` being one `test "…"` block (see [The tests block](#the-tests-block)) |
| `kinds` | For a component type that is not Datum's own, which Datum type it is read as (see [The kinds map](#the-kinds-map)) |

- Only `id`, `version`, `schemaVersion` and `root` are required.
- A key the format does not know is reported as a warning (`definition.key.unknown`).
- Rules, on a component's `rules`, are tabled in [Rules and formulas](/formulas).
- The caps on a definition's size and shape are in [Limits](/limits).
- Every code `check` can answer is in [Codes and messages](/codes#definition-problem-codes).

## Form-wide settings

These live on the root component's `configuration`.

| Key | Values | Default | What it does |
|---|---|---|---|
| `title` | text | none | The form's title, drawn by the `form-title` chrome part |
| `description` | text | none | Drawn by the `form-description` chrome part |
| `chrome` | `{ header, footer, frame? }` | none | The parts drawn above and below the fields. See [Chrome parts](#chrome-parts) |
| `print` | an object | see [Print](/print) | The printed versions, header and footer lines, title, scale and page breaks |
| `validateOn` | `submit` or `commitAfterError` | `commitAfterError` | When a field is checked as the person leaves it. See [Validation](/validation#when-errors-appear). Any other word is read as the default and `check` warns with `validateOn.invalid` |
| `formulaErrors` | `fail` or `warn` | `fail` | What a rule whose formula cannot be read does: `fail` refuses the form, `warn` drops the rule and says so. A host may set it for a run too. See [Rules and formulas](/formulas#a-formula-that-cannot-be-read) |
| `agentTools` | `allowed` or `off` | not provided | Whether a browser assistant may use the form. See [Assistants](/assistants) |

## A small definition

One text field, one choice, one rule and a submit button. The phone number appears, and is required, only when the person chose phone.

```json
{
  "id": "contact-request",
  "version": "1.0.0",
  "schemaVersion": "1",
  "metadata": { "name": "Contact request" },
  "localization": { "defaultLocale": "en" },
  "root": {
    "id": "root",
    "type": "form",
    "configuration": { "title": "Contact request" },
    "children": {
      "content": [
        {
          "id": "fullName",
          "type": "text",
          "configuration": { "label": "Full name", "required": true }
        },
        {
          "id": "contactMethod",
          "type": "radio",
          "configuration": {
            "label": "How should we reach you?",
            "options": [
              { "value": "email", "label": "Email" },
              { "value": "phone", "label": "Phone" }
            ]
          }
        },
        {
          "id": "phone",
          "type": "text",
          "configuration": { "label": "Phone number" },
          "rules": {
            "visibleWhen": "contactMethod = \"phone\"",
            "requiredWhen": "contactMethod = \"phone\""
          }
        },
        {
          "id": "send",
          "type": "button",
          "configuration": { "label": "Send", "action": "submit" }
        }
      ]
    }
  }
}
```

Every component has an `id`, a `type`, a `configuration` and, when it needs them, `rules` and `children`. Children sit in named slots, and `content` is the form's main slot. A rule is a [formula](/formulas) over the answers.

## Ids and data keys

An `id` is unique across the whole form. It is what rules, errors and tests refer to.

- It starts with a letter, then uses letters, digits, `_` or `-`, and is at most 128 characters.
- Six words cannot be ids, because a rule reads them as scopes or the translations cannot key them: `component`, `host`, `row`, `ancestor`, `constructor` and `prototype`.
- A bad or repeated id is refused by `check`. The page still draws a form that repeats one, with a `datum-error`, and the components share one value.

A component stores its answer under its own segment, which is its `id` unless `configuration.dataKey` sets another, prefixed by the segment of each data-scoping container above it. The two let `shipping.street` and `billing.street` both exist.

- A data key uses letters, digits, `_` or `-`, at most 128 characters, and is not digits alone.
- Two components that would store an answer at one path are refused.

See [Data](/data) and [the grammar](/limits#ids-and-names).

## Chrome parts

`root.configuration.chrome` holds `header` and `footer`, each a list of parts. Every part written in a definition needs an `id`, unique across both lists, because its texts are translated under it. A part with no id, or a repeated one, is refused (`chrome.part.id.missing`, `chrome.part.id.duplicate`). A host's parts, given to the element, need no id.

```json
"chrome": {
  "header": [
    { "id": "logo", "type": "image", "src": "/logo.svg", "alt": "Example" },
    { "id": "title", "type": "form-title" }
  ],
  "footer": [
    { "id": "help", "type": "text", "text": "Questions? Call us." }
  ]
}
```

The part types and their settings are on [Look and chrome](/look#chrome).

## Versioning

`version` is the form's own version, a non-empty string of at most 64 characters. Change it when you change the form. A server host registers the definition under its `id` and `version`, and accepts a submission only for a version it has. A submission made for another version is refused as outdated.

`schemaVersion` names the version of the definition format. Keep it at `"1"`.

- Datum does not migrate a definition between schema versions.
- Nothing reads the value except the draft check: a saved draft is restored only when its `schemaVersion` equals the definition's, and is refused with `draft.incompatible` otherwise.
- A change of `version` alone does not stop a draft from restoring.
- A submission records both versions, beside the renderer's, in its `versionContext`.

## The kinds map

`kinds` says what a component type that is not Datum's own should be read as, so the sandbox and the PDF program can check its answer without any plugin or binding code. Each key is the type name, and each value is a Datum type it behaves as.

```json
"kinds": { "gcds-date": "date", "acme-notes": "textarea" }
```

The base must be a type that holds an answer (such as `text`, `textarea`, `number`, `date`, `select`, `radio`, `checkbox`, `checkboxes` or `file`) or a plain container (`fieldset`, `panel` or `tabs`). A key cannot be one of Datum's own types. A type missing from the map, and not Datum's own, is unknown: `check` warns with `component.type.unknown`. The map holds at most 4,096 entries.

## The tests block

`tests.scenarios` is a list of `{ id, source }`, `source` being the text of one `test "…"` block. An entry with no `id`, a repeated `id` or a `source` that is not text is skipped.

- The tests belong to the author: the public copy of a definition a host serves to a browser has them removed.
- They run in the builder, in the test command, and in the sandbox's `test` operation.
- The `test` operation is capped at 256 KiB of test text, 200 scenarios and 1,000 statements per scenario.

See [Testing](/testing) and [Limits](/limits#form-tests).

## Size

`<datum-form>` refuses to parse a definition fetched from `src` that is longer than 2 MiB. A definition past the limit is reported as `datum-error`, and `max-definition-bytes` changes the limit. The shape is bounded too: depth, components, options, journeys, pages, layouts and locales. [Limits](/limits) lists every cap and the code each one raises.

## A file for your repository

The definition is plain JSON with no binary parts and no generated state. Keep it in the repository next to the page that serves it, review a change to the form as a diff of the file, and let the builder be one editor among others. The tests that belong to the form travel inside it, or in a `.datum-test` file beside it (see [Testing](/testing)).
