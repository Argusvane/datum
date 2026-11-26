# Components of your own

The standard types cover most forms. When one does not, a page adds a type of its own: a row of stars, a postcode lookup, a map pin. The form draws it, and the builder offers it on the palette and edits it like any standard type.

A type is one object, a component definition. The page's script holds all of it, so the example below is the whole page.

<LiveExample name="plugin" />

Try the form first. Press a star and the log shows the answer as a number. Then give the type to the builder: **Rating** sits on the palette under **Survey**, its inspector has a **Stars** field, and the canvas draws the stars with the same adapter.

## Adding a type

The way to add a type is `plugins.register`. A plugin carries the definition with its palette entry, and registering it once serves every `<datum-form>` and `<datum-form-builder>` on the page, including ones added later.

```js
import { plugins, standardFieldCapabilities } from "./datum-form.js";

plugins.register({
  id: "survey",
  version: "1.0.0",
  components: [{
    type: "star-rating",
    version: "1.0.0",
    base: "number",
    createDefault: () => ({ id: "rating", type: "star-rating", configuration: { label: "Rating", max: 5 } }),
    capabilities: standardFieldCapabilities({ placeholder: false }),
    palette: { label: "Rating", icon: "★", group: "Survey" },
    adapter: ({ html }) => ({ kind: "field", template: (state, on) => html`...` })
  }]
});
```

A plugin can bring more than types: hooks, validators, a submission handler, formula functions and data sources. See [Plugins](/plugins).

Two lower routes exist for a single element:

- `componentDefinitions` on one element adds definitions to that element alone: `form.componentDefinitions = [definition]`.
  - A builder lists a type from `componentDefinitions` only if a palette entry exists, which `componentTypes` gives: `builder.componentTypes = [{ type: "star-rating", label: "Rating", icon: "★", group: "Survey" }]`.
  - Without it the type draws but is not on the palette.
- `plugins` on one element takes a plugin for that element alone: `element.plugins = [plugin]`.

## What a definition holds

| Field | What it is |
|---|---|
| `type` | The name a definition uses for it, such as `"star-rating"`. A name that matches a standard type replaces that type. |
| `version` | The version of the type. |
| `base` | The standard type it reads as, an answer type or `fieldset`, `panel` or `tabs`. See [Base and the kinds map](#base-and-the-kinds-map). |
| `createDefault` | A function returning the component the builder adds when the type is picked from the palette. |
| `capabilities` | The inspector fields the type shares with others. See [Capabilities](#capabilities). |
| `propertyEditor` | The inspector fields of the type's own. See [The inspector](#the-inspector). |
| `children` | For a container: `{ slots: [...] }`, the named places children go. A slot has an `id`, `multiple`, and optionally `min`, `max`, `allowedTypes`, `allowReorder`, `allowNested` and `emptyHint` (the words on the canvas while the slot is empty). |
| `adapter` | How the type draws, on the form and on the builder's canvas. See [The adapter](#the-adapter). |
| `css` | A list of CSS rules for what the adapter draws, adopted into the form after the design system's, so the type looks the same under every design system. |
| `palette` | How the builder lists it: `{ label, group?, icon?, binding? }`. `group` defaults from the type's name (Fields, Choices, Layout, Content, Actions, else Other). `icon` is a short text glyph. `binding` offers the type only while that design-system binding draws the canvas. |
| `pdf` | `{ renditions, defaultRendition }`: the ways the type appears in a PDF. See [Plugins](/plugins#pdf-renditions). |
| `validators` | Validation stages that belong to the type. |
| `fixed` | Marks a component that stands for something outside the author's hands, such as a field of a PDF template: its properties edit, but there is no Delete and it is never on the palette. |

### Capabilities

A capability is a set of inspector fields with the code that writes them into `configuration`. `standardFieldCapabilities(options)` returns the usual set for a value-bearing field, in the order the inspector shows them. Label, tooltip, hide label and disabled are always in it. The options turn the rest on or off:

| Option | Default | Adds |
|---|---|---|
| `description` | on | Description. |
| `placeholder` | on | Placeholder. Off for a control with no text box. |
| `required` | on | Required. Off for a component that holds no value. |
| `dataKey` | follows `required` | The data key: the name the answer is stored under. |
| `messages` | on | Validation messages per code. |
| `cssClass` | on | CSS classes. |
| `pdf` | on | PDF rendition and leave out of PDFs. |
| `print` | on | How it prints from the live form. |
| `pattern` | off | Pattern and its message, for free text. |
| `length` | off | Minimum and maximum length and the character count. |
| `rows` | off | Visible rows, for a multi-line control. |
| `autocomplete` | off | The autocomplete token. |
| `inputMode` | off | The keyboard and spell-check settings. |
| `affix` | off | Prefix and suffix. |
| `attachFiles` | off | Attach uploaded files to a PDF, for a file type. |

`cssClassCapability` is exported too, for a container that lists its fields itself.

### The inspector

`propertyEditor` is `{ mode, fields?, sections?, features? }`.

| `mode` | Meaning |
|---|---|
| `default` | The capabilities' fields only. |
| `extend` | The capabilities' fields, then these. |
| `replace` | These fields instead of the capabilities'. A container does this and lists the fields it wants. |
| `none` | No fields. |

A field is `{ id, type, propertyPath, label?, description?, ... }`. `propertyPath` is a path inside the component's `configuration` (`"max"`, `"tabs.0.label"`). The field types:

| `type` | Edits |
|---|---|
| `text`, `number`, `boolean` | A string, a number (with `min`, `max`, `step`), a switch. |
| `select` | One of `choices: [{ value, label }]`. |
| `localized-text` | A text the form translates. |
| `color` | A colour. |
| `expression`, `formula` | A formula, in the Logic workspace's formula editor. |
| `component-selector` | A component of the form. |
| `data-source-selector` | One of the data sources. |
| `options-editor` | Inline `{ value, label }` options. |
| `messages-editor` | Validation text per error code. |
| `chrome-editor` | A region's header or footer parts. |
| `file` | A file kept in the configuration (`accept`, and `assetChoices` for ready-made values). |
| `path` | A value path, with the form's saved paths offered. |
| `value-map` | A table that translates one set of values to another. |
| `custom` | Drawn by the definition's own `render`. |

Any field takes `defaultValue` (what the editor shows while the property is unset; nothing is written until the author changes it), `visibleWhen` and `disabledWhen` (`{ propertyPath, equals }`, reading another property of the same component). `sections` group fields: `{ id, title?, fieldIds, hideWhenEmpty? }`.

### The adapter

`adapter` is one of:

- an adapter object,
- a list of them told apart by `when`, or
- a function `(lit, datum) => entry`. It receives the renderer's own lit namespace (`{ html, ... }`), so the page loads no template library, and Datum's own binding.

A type that nothing draws shows the renderer's unknown-component note. An adapter is laid over whichever binding draws the form, so the type draws under every binding.

The `kind` says what it draws:

| `kind` | Draws | `template` receives |
|---|---|---|
| `field` | A leaf: input, choice, date, file, button, static content. | `(state, on)` |
| `group` | A container around its children. | `(state, children)` |
| `tabs` | A tabs container. | `(state)` |
| `grid` | A data grid or repeating section. | `(state)` |
| `steps` | A steps container. | `(state)` |

For a field, the renderer builds `state` and the adapter returns a template. The members a custom control uses:

| `state` | Holds |
|---|---|
| `answer`, `value` | The stored answer as it is, and as text. |
| `label`, `labelId`, `hideLabel` | The label and an id for it, so a group can name itself with `aria-labelledby`. |
| `hint`, `hintId` | The description and the id it must carry. |
| `id`, `name`, `valuePath` | The control's id, a name for grouped controls, and where the answer is stored. |
| `required`, `readOnly`, `disabled`, `invalid`, `pending`, `busy` | The field's states. Set `aria-invalid="true"` only while `invalid`. |
| `errors`, `errorId`, `notices`, `noticeId` | The worded blocking errors and warnings, and the ids their elements carry. |
| `describedBy` | The ids that describe the control, in order. Write them as `aria-describedby`. |
| `locale`, `dir`, `mode`, `classNames` | Language, direction, `interactive`, `readonly` or `disabled`, and the author's classes. |
| `words` | The form's words for the locale, for any text the adapter draws. |
| `text(property)` | One of the component's own configuration texts, in the locale. |
| `model` | The engine's model: `model.node.configuration` holds the properties the inspector wrote. |

`on` reports what the person did. The renderer ignores writes while the form is read-only or disabled.

| `on` | Reports |
|---|---|
| `input(value, { interim?, badInput?, typed? })` | A new answer. `interim: true` while typing. |
| `commit()` | The field was left or its value settled. It runs the leave-field check. |
| `parts({ day, month, year })` | A date typed in parts. |
| `files(list)`, `remove(id)`, `download(id)` | A file field's picks, removals and downloads. |

The adapter's `capabilities` answer, per drawing capability, whether it draws it: `drawn`, `degraded` or `none`. The members and answers are the same as a design-system binding's; [Writing a binding](/writing-a-binding#the-adapter-contract) has the full contract, including `after`, `ready`, `connect`, `focusTarget` and `idsWrittenBy`.

## Base and the kinds map

The engine knows what a `number` is, how to validate it, how to print it and how a sandbox reads it. It knows nothing of `star-rating`. A definition's `base` says the standard type a type reads as, here `"number"`.

- Types that hold an answer can have an answer type as a base.
- Containers can have `fieldset`, `panel` or `tabs`.

The builder copies the base into the form's `kinds` map, which is part of the saved definition:

```json
{
  "id": "customer-survey",
  "kinds": { "star-rating": "number" },
  "root": { "id": "root", "type": "form", "children": { "content": [] } }
}
```

With the map in the definition, validation, the sandbox and the PDF treat a `star-rating` as a number without any of the type's code. The form can be checked on a server that has never heard of it.

The definition below is the one the example loads:

<<< @/public/forms/customer-survey.json

## Next

- Where components are placed and how the palette is limited: [Components](/components).
- The look of a type under a design system, and writing a binding of your own: [Writing a binding](/writing-a-binding).
- The inspector and palette on the builder: [Customising the builder](/customising-the-builder).
