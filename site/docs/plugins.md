# Plugins

A plugin is one object that adds to Datum. It can carry:

- component types
- hooks around validation and submission
- a handler that runs after a submission is accepted
- formula functions
- data sources
- PDF renditions
- themes

A page registers it once and every form and builder on the page takes it up.

```js
import { plugins } from "./datum-form.js";

plugins.register({
  id: "acme-audit",
  version: "1.0.0",
  hooks: { afterSubmit: [({ submissionId }) => console.log("accepted", submissionId)] }
});
```

- `plugins` is exported by `datum-form.js` and by `datum-builder.js`. The two bundles share one registry through a global, so a page registers once whichever bundle it loads.
- A plugin registered twice with the same `id` and `version` is skipped, never an error.
- A plugin whose shape is wrong (a list that is not a list, a component with no `type`, a theme with the wrong `target`) is refused by name with a console error, and the other plugins are still served.

Registering reaches every `<datum-form>` and `<datum-form-builder>` on the page, including ones added later. An element can also take a plugin of its own, on its `plugins` property, for that one element alone.

## What a plugin holds

| Member | What it is |
|---|---|
| `id`, `version` | Required. A plugin is known by both. |
| `engineRange` | The engine versions the plugin supports. Outside it the plugin is not installed and a warning names the reason. |
| `environments` | `"browser"`, `"server"`, `"wasm"`: where the plugin may install. In a page the environment is `browser`. |
| `dependencies` | `[{ id, versionRange? }]`: plugins that install first. |
| `components` | Component definitions: new types. See [Components of your own](/custom-components). |
| `validators` | Validation stages that run after the field constraints. See [Validators](#validators). |
| `wasmPlugin` | A portable module for the sandbox: `{ id, version, source }`. It carries the same validators, and the formula functions, for the server. See [Validation and the sandbox](/validation). |
| `formulaFunctions` | Functions a rule's formula may call. See [Formula functions](#formula-functions). |
| `pdfRenditions` | More ways for a component type to appear in a PDF. See [PDF renditions](#pdf-renditions). |
| `builderThemes`, `pdfThemes` | Themes for the builder's shell and for the PDF. See [Themes](#themes). |
| `dataSources`, `dataSourceProviders` | Option lists a choice field can name. See [Data sources](#data-sources). |
| `hooks` | Functions that run around validation, submission, navigation and drafts. See [Hooks](#hooks). |
| `submissionHandlers` | Work done after a submission is accepted. See [Submission handlers](#submission-handlers). |
| `initialize` | `initialize({ environment })`, called once when the plugin is installed. |

## Hooks

A hook is a function in a list under its name. Hooks from the host's own code run first, then those of plugins, in registration order. Each receives a context and may return a promise, which the form waits for.

| Hook | Runs | Receives | A throw |
|---|---|---|---|
| `beforeValidation` | Before every validation run: one field's check or the whole form's. | `{ values, validationContext }` | Propagates to the caller. |
| `afterValidation` | After a validation run. | `{ values, validationContext, result }` | Propagates. It cannot change the result. |
| `beforeSubmit` | When a submission starts, before the values are transformed or sent. | `{ values, modeId, agent? }` | Stops the submission. The form returns to idle and can be sent again. |
| `transformValues` | After `beforeSubmit`, in order. | The values; returns the values to submit. | Stops the submission, as above. |
| `afterSubmit` | After the submission is accepted and the submission handlers have run. | `{ values, modeId, submissionId, agent? }` | Propagates to the caller. |
| `beforeNavigation` | Before a `steps` container moves to another step. | `{ fromStepId?, toStepId, mode }` | Blocks the move. |
| `beforePageChange` | Before a journey changes page on the person's Continue, Back or jump. | `{ journeyId, fromPageId, toPageId, direction, values }` | Vetoes the move. The message of the thrown error is shown as the reason. |
| `beforeDraftSave` | Before a draft is saved. | `{ draftId, values }` | Propagates to the caller. |
| `afterDraftLoad` | After a draft is restored. | `{ draftId, values }` | Propagates to the caller. |

`agent` is present when the page's assistant tools were live; see [Browser assistants](/assistants). A transform replaces the values, so return a changed copy:

```js
plugins.register({
  id: "acme-trim",
  version: "1.0.0",
  hooks: {
    transformValues: [(values) => ({ ...values, email: String(values.email ?? "").trim() })],
    beforePageChange: [({ toPageId, values }) => {
      if (toPageId === "payment" && !values.consent) throw new Error("Agree to the terms first.");
    }]
  }
});
```

## Validators

A validator is a stage `{ id, version, validate(context) }`.

- `validate` receives `{ values, formId, locale, externalData }` and returns `{ errors: [...] }`.
- Each error has a `code`, a `componentId`, a `stage`, a `source` (`"custom"`) and optional `path`, `severity` (`error`, `warning`, `info`) and `parameters`. Only `error` blocks.
- An `async` stage (`kind: "async"`) may do I/O and runs after every deterministic one.
- A validator that has to run on a server too is written for the sandbox instead; see [Validation and the sandbox](/validation).

```js
plugins.register({
  id: "acme-rules",
  version: "1.0.0",
  validators: [{
    id: "no-test-emails",
    version: "1.0.0",
    validate: ({ values }) => ({
      errors: String(values.email ?? "").endsWith("@example.test")
        ? [{ code: "email.test", componentId: "email", path: "email", stage: "custom", source: "custom" }]
        : []
    })
  }]
});
```

## Submission handlers

A handler is `{ id, version, handle(submission, context) }`.

- It runs after the submission is accepted and receives the canonical submission and `{ modeId, formId, submissionKey, signed? }`.
- `submissionKey` identifies the attempt: send it with the delivery, and send the same one again on a retry.
- A handler that throws is isolated: the others still run, the submission stays accepted, and the failure is listed in the submission result's `handlerErrors`.

```js
plugins.register({
  id: "acme-receipt",
  version: "1.0.0",
  submissionHandlers: [{
    id: "store-receipt",
    version: "1.0.0",
    handle: async (submission, { submissionKey }) => {
      await fetch("/api/receipts", { method: "POST", headers: { "Idempotency-Key": submissionKey }, body: JSON.stringify(submission) });
    }
  }]
});
```

## Formula functions

A function a rule's formula calls by name. It takes the evaluated arguments and returns a plain value; `undefined` is no answer.

```js
plugins.register({
  id: "acme-tax",
  version: "1.0.0",
  formulaFunctions: [{
    name: "taxFor",
    params: ["amount", "province"],
    returns: "number",
    summary: "The sales tax on an amount in a province.",
    example: "taxFor(subtotal, province)",
    evaluate: ([amount, province]) => (typeof amount === "number" ? amount * (province === "ON" ? 0.13 : 0.05) : undefined)
  }]
});
```

Details, the rules a function follows and the server side are on [Rules and formulas](/formulas#your-own-functions).

## PDF renditions

A rendition is one way a component type appears on paper.

- `pdfRenditions` adds one to a type the plugin does not own: `{ componentType, rendition: { id, label?, render(node, context) } }`. `render` returns the blocks the PDF layer lays out.
- A component type of the plugin's own lists its renditions in its definition's `pdf` member: `{ renditions: [...], defaultRendition: "id" }`.
- An author picks a rendition on the component, under PDF.

## Data sources

A source is a name a choice field can use in `data.sourceId`, backed by a provider that loads the options.

```js
plugins.register({
  id: "acme-lists",
  version: "1.0.0",
  dataSourceProviders: [{
    id: "acme-api",
    load: async ({ sourceId, query }, { locale }) => {
      const response = await fetch(`/api/lists/${sourceId}?locale=${locale ?? "en"}`);
      return { items: await response.json() };   // [{ value, label, description? }]
    }
  }],
  dataSources: [{ id: "provinces", providerId: "acme-api", version: "1.0.0" }]
});
```

- A plugin's sources resolve behind the page's own, on the form and in the builder's picker.
- A provider may name `environments` and an advisory `privileges: { network, storage }`.

More on options and sources: [Data model and data sources](/data).

## Themes

`builderThemes` and `pdfThemes` reach the page's theme registries, so `<datum-form-builder theme="acme">` and `pdf-theme="acme"` find them. Two options of `plugins.register` say how:

```js
plugins.register(acmeThemesPlugin, {
  assetsBase: "/assets/acme-themes/",
  aliases: { dark: "acme-dark" }
});
```

| Option | Meaning |
|---|---|
| `assetsBase` | The URL of the directory where the page serves the themes' files: the relative stylesheets and fonts a theme names in its `assets`. |
| `aliases` | Further ids that name a theme the plugin carries: `{ dark: "acme-dark" }` makes `theme="dark"` mean `acme-dark`. |

A builder theme needs `target: "builder"` and `tokens`; a PDF theme `target: "pdf"`. How a builder theme is written is on [Customising the builder](/customising-the-builder).

## Inspecting the registry

| Call | Gives |
|---|---|
| `plugins.has(id, version?)` | Whether a plugin is registered. |
| `plugins.plugins()` | Every registered plugin, in order. |
| `plugins.registrations()` | Each plugin with the options it came with. |
| `plugins.components()` | The component definitions they contribute. |
| `plugins.paletteEntries()` | The builder palette entries those definitions declare. |
| `plugins.subscribe(listener)` | Calls the listener after each registration that added a plugin; returns the way to stop. |
