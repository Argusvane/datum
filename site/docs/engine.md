# The engine on its own

`<datum-form>` is the engine with a face on it. Underneath is a runtime that holds the answers, works the rules out, validates and builds the submission envelope, and none of that needs an element. A test, a script, a shell of your own or a server that wants Datum's rules can use the runtime from JavaScript.

Prefer the element when a person fills the form in. It draws the form and a journey's pages, moves focus to the first error, keeps drafts and loads the optional files on demand. The runtime does none of that: it gives you the answers, the errors, the page a journey is on and the envelope, and drawing and delivering are yours.

The runtime has a file of its own, `datum-engine.js`:

- It defines no element and needs no DOM.
- It loads the same way in a page, a web worker and Node.
- `datum-form.js` exports the same runtime beside the element.
- The names are in [JavaScript exports](/exports#the-engine-file), which this page does not repeat.

`datum-engine.js` is in the npm package `@argusvane/datum`. In Node, install the package and import `@argusvane/datum/engine`; the samples below import `./datum-engine.js`, the same file by its path in the folder you host. Datum is pre-release: [Release status](/introduction#release-status) says what that means for the contracts.

## A runtime in a few lines

Import `createFormRuntime` from `datum-engine.js` and go. Nothing else has to be in place first, so the samples below run as they are in Node. `datum-form.js` needs a DOM when it loads, because it defines the element.

The runtime takes the definition, answers are set by value path, and `validate` resolves with the errors.

```js [a-runtime.mjs]
import { createFormRuntime, versionContextFor, EMBED_SUBMISSION_MODE } from "./datum-engine.js";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
    { id: "reason", type: "textarea", configuration: { label: "Reason for the visit" } }
  ] } }
};

const runtime = createFormRuntime(definition);

const before = await runtime.validate();
console.log(before.map((error) => `${error.componentId}: ${error.code}`));   // fullName: required

runtime.setValue("fullName", "Ada Lovelace");
console.log((await runtime.validate()).length);                               // 0

const result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));
console.log(result.accepted, result.canonicalSubmission.submission, result.submissionKey);
```

```
[ 'fullName: required' ]
0
true { locale: 'en', values: { fullName: 'Ada Lovelace' } } 7eff686c-d7cb-43aa-9c85-500e025e8a77
```

`submit` takes a submission mode and a version context. The element's own pair is `EMBED_SUBMISSION_MODE`, which validates and does not sign, and `versionContextFor(definition)`.

- An accepted result carries `canonicalSubmission`, the [envelope](/submissions#the-envelope), and `submissionKey`, the attempt's key. Deliver them as `{ document, submissionKey }`, as [Submissions and replies](/submissions) shows.
- A refused one has `accepted: false` and the errors, and neither of those two.

## Values from the host, the language and events

- Rules that read `host.` names get them from `hostContext`, set when the runtime is built or later with `setHostContext`, which works the form out again over the answers held.
- `setLocale` throws for a language the form does not declare.
- `events().subscribe` hears the runtime's own events. `FormEventType` holds their names; the same names as plain strings work too.

```js [b-host.mjs]
import { createFormRuntime, FormEventType } from "./datum-engine.js";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] },
  root: { id: "root", type: "form", configuration: {}, children: { content: [
    { id: "fullName", type: "text", configuration: { required: true } },
    { id: "badge", type: "text", configuration: { required: true }, rules: { visibleWhen: 'host.role = "staff"' } }
  ] } }
};

const runtime = createFormRuntime(definition, { hostContext: { role: "visitor" } });
runtime.events().subscribe(FormEventType.COMPONENT_CHANGED, (event) => console.log(event.type, event.data.value));

console.log(runtime.effectiveState("badge").visible);   // false
runtime.setHostContext({ role: "staff" });
console.log(runtime.effectiveState("badge").visible);   // true

runtime.setValue("fullName", "Ada");
runtime.setLocale("fr");
console.log(runtime.state().locale, runtime.submittableValues());
try { runtime.setLocale("de"); } catch (error) { console.log(error.message); }
```

```
false
true
COMPONENT_CHANGED Ada
fr { fullName: 'Ada' }
Locale "de" is not supported
```

`submittableValues()` is what a submission would carry: the answers of fields that are shown, without the ones a rule has hidden. See [Rules and formulas](/formulas#values-from-the-host) for `host.` and [Languages](/languages) for what a locale changes.

## Walking a journey

A form with journeys opens as its journey here too, and the runtime walks it page by page as the element does.

- `journeyView()` says which page is shown and where it sits on the path.
- `nextPage()` is Continue, `previousPage()` is Back and `goToPage(id)` jumps to a page already reached.
- Each resolves to `{ ok, pageId, reason? }`: a refusal is a value, never a rejection.
- The routes pick the next page from the answers, so a page the path does not take is passed over.

`journeyServerValidator` is your way to your server. Continue calls it for a page that asks for a server check, with the page's request and the envelope over the same answers. Submit on the last page checks every page on the path first.

```js [k-journey.mjs]
import { createFormRuntime, versionContextFor, EMBED_SUBMISSION_MODE, FormEventType } from "./datum-engine.js";

const definition = {
  id: "benefit-check", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: {}, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
    { id: "children", type: "number", configuration: { label: "Children at home", required: true, min: 0 } },
    { id: "childNames", type: "text", configuration: { label: "Their names" } },
    { id: "email", type: "text", configuration: { label: "Email", required: true } }
  ] } },
  journey: { journeys: [{
    id: "apply",
    validation: { continue: "page" },
    pages: [
      { id: "you", components: ["fullName", "children"], validation: { server: true },
        routes: [{ when: "children > 0", to: "kids" }, { to: "contact" }] },
      { id: "kids", components: ["childNames"] },
      { id: "contact", components: ["email"] }
    ]
  }] }
};

// Your way to your server: here it accepts every page.
const journeyServerValidator = async (request, { document }) => {
  console.log("check", request.scope, request.pageId, document.submission.values);
  return { errors: [] };
};

const runtime = createFormRuntime(definition, { journeyServerValidator });
runtime.events().subscribe(FormEventType.PAGE_CHANGED, ({ data }) => console.log("moved", data.direction, data.toPageId));

console.log(runtime.journeyView().pageId);   // you
console.log(await runtime.nextPage());       // refused: the page has errors

runtime.setValue("fullName", "Ada Lovelace");
runtime.setValue("children", 0);
await runtime.nextPage();                    // no children: past their page
await runtime.previousPage();

runtime.setValue("children", 2);
await runtime.nextPage();                    // kids
await runtime.nextPage();                    // contact

runtime.setValue("email", "ada@example.org");
const result = await runtime.submit(EMBED_SUBMISSION_MODE, versionContextFor(definition));
console.log(result.accepted, result.canonicalSubmission.submission);
```

```
you
{ ok: false, reason: 'validation', pageId: 'you' }
check page you { children: 0, fullName: 'Ada Lovelace' }
moved forward contact
moved back you
check page you { children: 2, fullName: 'Ada Lovelace' }
moved forward kids
moved forward contact
true {
  journey: { id: 'apply' },
  locale: 'en',
  values: { children: 2, email: 'ada@example.org', fullName: 'Ada Lovelace' }
}
```

The page ids are the journey's own. `PAGE_CHANGED` reports each move, and `journeyTrace()` gives the path the answers draw now. Nothing here draws a page or follows the address bar: read the view and draw it, as below. To post each check to a Datum host, pass `createFetchJourneyValidator(url)` as `journeyServerValidator`: see [Checking between pages on the server](/journeys#checking-between-pages-on-the-server). The settings a page takes are under [Journeys](/journeys#the-model).

## Drawing it yourself

The runtime is a model. A shell of your own reads it and draws what it likes: the tree from `formRoot()`, each component's state from `effectiveState(id)` and `isRequired(id)`, the answers from `state().values`, the problems from `errors()`. This one prints the form as text.

```js [c-draw.mjs]
import { createFormRuntime } from "./datum-engine.js";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: { title: "Visit request" }, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
    { id: "reason", type: "textarea", configuration: { label: "Reason" } }
  ] } }
};
const runtime = createFormRuntime(definition);
await runtime.validate();

function lines(node, depth = 0) {
  if (runtime.effectiveState(node.id)?.visible === false) return [];
  const problems = runtime.errors().filter((error) => error.componentId === node.id).map((error) => error.code);
  const answer = JSON.stringify(runtime.state().values[node.id] ?? "");
  const row = `${"  ".repeat(depth)}${node.configuration.label ?? node.id}${runtime.isRequired(node.id) ? " *" : ""} = ${answer} ${problems.join()}`;
  return [row, ...Object.values(node.children ?? {}).flat().flatMap((child) => lines(child, depth + 1))];
}
console.log(lines(runtime.formRoot()).join("\n"));
```

```
root = "" 
  Full name * = "" required
  Reason = ""
```

The engine has a renderer of its own that draws a runtime through a [binding](/bindings), but no file you host exports it. It needs a shadow root and the pieces the element wires, so drawing with Datum's components without the element is not something you can do from the page's side today. Use `<datum-form>`, and reach its runtime with `form.runtime` or `datum-ready`'s `detail.runtime` when you want both.

## Validating a submission on a server

The server checks again what the page checked. The `@argusvane/datum-submissions` package is a service for that: register a definition, hand it the envelope and the key, and it answers with a verdict and keeps the record. It judges in the sandbox, the same program the page can run, so the verdicts match.

- The two functions the HTTP routes need are `receive` and `validate`.
- `parseValidateRequest` and the response helpers turn a body into a call and a result into a status and body.

<<< @/snippets/server/engine/submissions.mjs{js} [submissions.mjs]

```
{"status":200,"body":{"accepted":false,"errors":[{"field":"fullName","code":"required"}]}}
{"status":422,"body":{"errors":[{"field":"fullName","code":"required"}]}}
200 [ 'id', 'status', 'digest', 'receipt' ]
```

A check is a `200` whatever the verdict, and a refused delivery is a `422`. The envelope the runtime above made is accepted here as it is.

- `@argusvane/datum-submissions` is not published, and its entry points are TypeScript source, so run the file through a TypeScript-aware runner from a checkout.
- There is a second validator, `createKernelValidator()`, that runs the rules in the calling process with no sandbox. It is for development and tests, and the service logs a warning when it is given one.

The page can run the sandbox too, with `wasmValidationHost` on the runtime's config or the `wasm` attribute on the element: [Validation and the sandbox](/validation#loading-the-sandbox-yourself). A server in another language, or one that runs the programs itself, reads [Running the programs on your own server](/server-programs). The built-in hosts are in [Server hosts](/server-hosts).

## A PDF from a runtime

`datum-pdf.js` holds the PDF kernel and its fonts. Its `renderPdf(runtime, options)` draws a runtime's form as the element's `renderPdf()` does: the same bytes for the same answers, language, layout and theme. It runs in Node as well as a page.

```js [f-pdf.mjs]
import { writeFile } from "node:fs/promises";
import { createFormRuntime } from "./datum-engine.js";
import { renderPdf } from "./datum-pdf.js";

const definition = {
  id: "visit-request", version: "1.0.0", schemaVersion: "1",
  root: { id: "root", type: "form", configuration: { title: "Visit request" }, children: { content: [
    { id: "fullName", type: "text", configuration: { label: "Full name", required: true } }
  ] } }
};
const runtime = createFormRuntime(definition);
runtime.setValue("fullName", "Ada Lovelace");

const pdf = await renderPdf(runtime);
await writeFile(pdf.fileName, pdf.bytes);
console.log(pdf.fileName, pdf.layoutId, pdf.pageCount, pdf.warnings);
```

```
visit-request-default-20261116-014838.pdf default 1 []
```

The options are the element's, listed under [PDFs](/pdf#from-script), and the result is the same. Four more stand in for the element's properties:

- `support`: what `createPdfSupport()` makes, which the function makes for itself when it is left out.
- `theme`: a registered PDF theme's id or a theme, as the `pdf-theme` attribute.
- `templates`: as `pdfTemplates`.
- `binding`: the PDF theme a binding suggests.

The runtime's host context is not handed to the PDF: name `hostContext` in the options when a layout reads `host.` values.

The fonts are read from `fonts/` beside `datum-pdf.js`, so keep the folder with it. In a page, `datum-form.js` exports a `renderPdf(runtime, options)` of its own that loads `datum-pdf.js` on its first call, from beside the bundle or from the address in its `pdf` option, and shares the load with the element.

On a server the PDF program draws the same document, and the submissions service renders and signs one with a record when the form is registered with PDF settings (see the package's README): [The PDF program](/pdf-program) and [Example: render a PDF on the server](/server-example-pdf).

## What is not stable

Only the names in [JavaScript exports](/exports) are meant to be imported, and even they are pre-release.

- `FormRuntime` has many more methods than this page shows. Those that are not on this page are not described anywhere on the site and may change.
- The engine package, `@argusvane/datum-engine`, is private and ships TypeScript source. Names that the files do not re-export, such as `mountLive` and the telemetry helpers, cannot be imported from the files you host.
- `@argusvane/datum-submissions` and `@argusvane/datum-pdf-kernel` are private too. Their entry points and the service's options may change before a release.
- `datum-engine.js` and `datum-form.js` each carry their own copy of the runtime. A runtime made by one is not an `instanceof` the other's `FormRuntime`. `renderPdf` takes a runtime from either, and the two share the page's plugin and theme registries.
