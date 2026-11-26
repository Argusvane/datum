# Ways to configure

This page is a map. Use it when you know what you want to change and not which setting does it: it says what the seven ways of configuring the form and the builder are, and lists each task with the page that covers it.

A page that hosts a form or the builder decides a good deal about it: what it loads, how it looks, what it says, where the answers go and which parts exist at all. None of that needs a build of Datum. It is all set from the page, through seven mechanisms.

## The seven mechanisms

| Mechanism | What it carries | Example |
|---|---|---|
| Attributes | The declarative part: text, numbers, on/off, and objects written as JSON | `locale="fr-CA"`, `draft="intake"`, `features="minimal"` |
| Properties | Objects and functions, set from script | `form.dataSources = {…}`, `builder.fileActions = {…}` |
| Events | What happened, for the page to act on | `datum-submit`, `datum-builder-change` |
| Methods | The page's own controls driving the element | `form.setErrors(…)`, `builder.setWorkspace("logic")` |
| Slots | The page's own controls inside the builder's bar | `<button slot="toolbar">Save</button>` |
| Registries | Additions every element on the page takes up | `plugins.register(…)`, `bindings.register(…)` |
| The definition | Choices the form's author made in the builder, saved with the form | Messages, chrome, frame, translations |

Almost every attribute has a property of the same meaning, so most of what is written in HTML can be set from script instead. The exceptions are attribute only, and a script-driven host sets them with `setAttribute`:

- **Builder.** `debug`, `leave-guard`, `allow-origins`, `no-full-window` and `no-scheme-toggle`.
- **Form.** `debug` and `allow-origins`.

The reverse does not hold: a function has no attribute. The full lists are in the reference: [the form element](/form-element) and [the builder element](/builder-element).

```html
<datum-form id="intake" src="/forms/intake.json" locale="auto" draft="intake"></datum-form>

<script type="module">
  const form = document.getElementById("intake");
  form.dataSources = { countries: () => fetch("/api/countries").then((r) => r.json()) };
  form.addEventListener("datum-submit", ({ detail }) => { /* deliver detail.submission */ });
</script>
```

## The page or the author

Several settings can be made twice: once by the author in the builder, saved in the definition, and once by the page that hosts the form. Each has a rule for which one wins.

| Setting | Who wins | To change that |
|---|---|---|
| Validation messages | The page's. An entry in `messages` beats the form's own message for that code; the codes it leaves out keep the author's words. | Leave a code out of `messages` to keep the author's. See [Languages](/languages#where-a-word-comes-from). |
| Frame | The author's pick. The page's `frame` is the default. | `frame-fixed` makes the page's win. |
| Header and footer | Both. The page's `chrome` parts are merged over the form's own. | See [Look and chrome](/look). |
| Translations | The page's. An entry in `translations` overrides the form's own for the same text. | See [Languages](/languages). |
| Features | The page's list is the limit. The form can only use what the list allows. | See [Leaving parts out](/leaving-parts-out). |

In the builder, `managed-settings` takes a setting out of the author's hands altogether: the inspector shows "Managed by the site." in its place. See [Customising the builder](/customising-the-builder).

## Find the page for a task

### The form

| To | Use | Covered in |
|---|---|---|
| Put a form on a page and take its submission | `src`, `datum-submit`, `setErrors`, `setNotice` | [The form on your page](/form-on-your-page) |
| Deliver to a slow server, time out and retry | `waitUntil`, `texts`, `submissionKey` | [Submissions and replies](/submissions) |
| Set the language, or let the person switch | `locale`, `language-switcher` | [Languages](/languages) |
| Fill a select from your own data | `dataSources` | [Data model and data sources](/data) |
| Word the validation messages and the form's own text | `messages`, `texts`, `translations` | [Languages](/languages) |
| Add a logo, a title and a footer | `chrome`, `frame` | [Look and chrome](/look) |
| Draw the form with your design system | `binding`, `assets` | [Design-system bindings](/bindings) |
| Draw it with Bootstrap and your own CSS | `binding`, `assets.stylesheets` | [Bootstrap with your own CSS](/bootstrap) |
| Use it in a React, Vue or Angular application | Properties, events | [React, Vue and Angular](/frameworks) |
| Show it on another site | An `<iframe>` and `postMessage` | [In an iframe](/iframe) |
| Keep a half-filled form | `draft`, `draft-store` | [Drafts](/drafts) |
| Run a form as several pages | `journey`, `page` | [Journeys](/journeys) |
| Check an answer in a way the form's settings cannot | `validWhen`, `wasm`, `wasmPlugins` | [Validation and the sandbox](/validation#choosing-a-route) |
| Offer the answers as a PDF | `pdf`, `pdf-theme` | [PDFs](/pdf) |
| Sign the submission or the PDF | `sign-with`, `pdfSigner` | [Signing](/signing) |
| Ship less | `features` | [Leaving parts out](/leaving-parts-out) |

### The builder

| To | Use | Covered in |
|---|---|---|
| Put the builder in your application | `layout`, `src`, the `toolbar` slot | [Embedding the builder](/embedding-the-builder) |
| Save the form to your server | `save`, `fileActions` | [Saving forms](/saving-forms) |
| Take parts, workspaces, panels or component types away | `features`, `hidden-panels`, `component-types` | [Leaving parts out](/leaving-parts-out#the-builder) |
| Choose where it opens, add a panel, a command or a slot | `workspace`, `strip`, `registerCommands()` | [Customising the builder](/customising-the-builder) |
| Give it your colours, or a dark scheme | `theme`, `scheme` | [Customising the builder](/customising-the-builder) |
| Add a component type of your own | `plugins.register`, `componentDefinitions` | [Components of your own](/custom-components) |
| Change its icons | `icons`, `setDefaultIconSet` | [Customising the builder](/customising-the-builder) |
| Translate its interface | `textLocale`, `textCatalog` | [Languages](/languages) |

### The server

What the server accepts, how it validates and what it renders are set on the server host, not on the page: see [Server hosts](/server-hosts). For a server of your own, [Your own server](/server-programs) has the protocol and four worked examples with the endpoint in Python, Java, C# and Node.js.

## Live examples

The pages in this section carry live examples: the whole page a reader would write, with choices that rewrite it, and that page running under the code. [Live examples](/examples) lists them all.
