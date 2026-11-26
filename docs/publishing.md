# Publishing a form

From the builder's Download to a working page. Every attribute named here is read by
`<datum-form>` (packages/datum/src/form-element.ts); the full list is
[reference/attributes.md](reference/attributes.md).

## 1. Download, then load the JSON

File > Download saves the form definition as a JSON file. Put it where your page can fetch it
and point the element at it:

```html
<script type="module" src="/dist/datum-form.js"></script>
<datum-form src="/forms/intake.json"></datum-form>
```

- `src` is a URL or relative path. It is fetched with the page's own rules, so a cross-origin
  address needs CORS. A failed load shows the element's error card and fires `datum-error`.
- `definition` takes the JSON itself as the attribute value; the `definition` property takes
  the parsed object. Use it when the page already holds the JSON.
- Download warns when the form has no submitting button. Add one (a button with action
  `submit`) or the form cannot be sent.

The demo page `/demo/form.html?src=<relative path or http(s) URL>` loads any definition this
way; other schemes are ignored.

## 2. What the form opens as (journeys)

A form with journeys (multi-page flows, ADR 0112) opens either as the whole form on one page
or as a journey, a page at a time with Back and Continue.

- The definition's `journey.opensAs` decides: `"form"` is "The whole form", `"journey"` is a
  journey.
- The first journey a form gets becomes what it opens as (`opensAs: "journey"`, ADR 0115). Change
  it with the "Opens as" select on the journey or in Form settings. A definition that states
  `opensAs` keeps what it states.
- The `journey` attribute overrides the definition for this page: a journey's id, `form`
  for the whole form, or `journey` for the definition's default journey. Changing it restarts
  the journey over the answers already typed.
- `page` opens a page the person may already reach (a deep link or resume point).
  `datum-page-change` reports each move.

## 3. Handling a submit

The element validates and then fires `datum-submit` with `detail.accepted`, `detail.submission`
(the envelope) and `detail.errors`. It does not deliver anything itself. The page does:

```js
form.addEventListener("datum-submit", (event) => {
  const { accepted, submission } = event.detail;
  if (!accepted) return;
  event.detail.waitUntil(
    fetch("/api/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission) })
      .then(async (r) => { if (!r.ok) form.setErrors((await r.json()).errors); })
  );
});
```

- `waitUntil` keeps the form locked with a status line until the reply is in (ADR 0052).
- `setErrors([{ componentId, code, message }])` shows the server's verdict; `setNotice` shows a
  receipt.
- A button with action `download` saves the accepted envelope as JSON (`datum-download`,
  cancelable). Other actions arrive as `datum-form-action`.
- The `confirmation` attribute (boolean, off by default) makes the form show its own
  confirmation after an accepted submit, with the reference the reply carries when it has one.
  Without it the page owns what follows a submit. It never replaces a receipt the page set with
  `setNotice`. Wording: `texts` keys `confirmationTitle`, `confirmationMessage`,
  `confirmationReference`.
- The same rules run again on the server; see [integration-recipes.md](integration-recipes.md).

## 4. The PDF action

`pdf="auto"` loads the PDF module (`datum-pdf.js`, beside the bundle, or the URL given) on first
use. Then a button with action `pdf` produces the form as a PDF under the definition's layouts,
and `renderPdf()` / `downloadPdf()` do the same from script. See [pdf-rendering.md](pdf-rendering.md).
Without `pdf`, the action has nothing to run. In the PDF designer, the Add popover asks for a
layout name first (Enter creates, Escape cancels), and a PDF with no fillable fields hides
Suggest mappings and Create form fields.

## 5. Hosting

The form is static files: `datum-form.js` (plus `datum-form.css`, and `datum-pdf.js` and
`datum-wasm.js` when you enable them), and the definition JSON. Serve them from any static host
with correct MIME types, and keep the bundles beside each other so the `auto` loaders find them.
Data sources are assigned on the `dataSources` property before or with the definition.

A form is drawn with Datum's own look. To draw it with a design-system binding, also serve the
binding's bundle (`bindings/<id>/dist/<id>.js`) and the design system's own files (one release,
the one the binding names), register the binding, and set the element's `binding` property
([Integration recipes](integration-recipes.md#a-design-system-binding)). The files must be
same-origin or served with CORS, and the page over HTTP(S), never `file://`
([Host security](host-security.md)).
