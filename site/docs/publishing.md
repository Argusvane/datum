# Publishing a form

This page follows a form from the builder to a page of yours: what Download gives you, how the form opens, and how to switch on the PDF action. It does not repeat the wiring of the submit, which is on [Getting started](/getting-started) and [Submissions and replies](/submissions), or where the files go, which is on [Files you host](/files).

## From Download to a page

**Download** in the builder's file menu saves the definition as a JSON file (see [The definition](/definition)). Put it where the page can fetch it and point `src` at it. This is the smallest page that shows it:

```html
<link rel="stylesheet" href="datum-form.css">
<script type="module" src="datum-form.js"></script>
<datum-form src="/forms/intake.json"></datum-form>
```

- A failed load shows the element's error card and raises `datum-error`.
- The `definition` attribute takes the JSON itself, and the `definition` property takes the parsed object, for a page that already holds it.
- A definition longer than 2 MiB is refused unless `max-definition-bytes` says otherwise, and one on another origin needs CORS.
- A new form starts with a Submit button. Download warns when a form has none, because without one the form cannot be sent.

## What the form opens as

A form with journeys opens either as the whole form on one page, or as a journey, one page at a time with Back and Continue. The definition decides through `journey.opensAs`, which is `"form"` or `"journey"`. A definition that does not say opens as a journey whenever it has one.

The `journey` attribute overrides that for one page. It takes a journey id, `form` for the whole form, or `journey` for the definition's default journey. Changing it restarts the journey over the answers already typed.

`page` opens a journey on a page the person may already reach, which suits a deep link or a resume point. See [Journeys](/journeys).

## Adding the PDF action

`pdf="auto"` fetches the PDF module on the first PDF. A button with the action `pdf` then produces the form as a PDF under the definition's layouts, and `renderPdf()` and `downloadPdf()` do the same from script.

```html
<datum-form src="/forms/permit.json" pdf="auto" pdf-theme="datum-plain"></datum-form>
```

- `pdf-theme` names the PDF theme: `datum-plain` is built in, beside Datum's own `datum-pdf`.
- Without `pdf`, the action has nothing to run.
- Keep `datum-pdf.js` and the `fonts/` folder beside `datum-form.js`; [Files you host](/files) lists them.

See [PDFs](/pdf).

## Choosing what loads

`features` says which parts of the form exist, and so which files a page ever asks for. It is described once, on [Leaving parts out](/leaving-parts-out#the-form), with the table of the form's features and what each loads.

## A page without modules

`datum-form.iife.js` is the same element as a classic script. See [Classic scripts](/files#classic-scripts).

## Short recipes

Delivering to your own endpoint is on [Getting started](/getting-started#send-it-to-a-server).

Form with options from the host:

```html
<datum-form id="f" src="/forms/intake.json"></datum-form>
<script type="module">
  document.getElementById("f").dataSources = {
    provinces: [{ value: "ON", label: "Ontario" }, { value: "QC", label: "Québec" }]
  };
</script>
```

A one-page form with nothing else loaded:

```html
<datum-form src="/forms/contact.json" features="minimal"></datum-form>
```

A builder with only the form workspace and no file actions:

```html
<script type="module" src="datum-builder.js"></script>
<datum-form-builder features="minimal" file-actions="none" style="height: 100vh"></datum-form-builder>
```

For every attribute, see [The form element](/form-element). Translations, signing and design-system bindings are on [Languages](/languages), [Signing](/signing) and [Design-system bindings](/bindings).
