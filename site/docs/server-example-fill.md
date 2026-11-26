# Example: fill a PDF on the server

Sometimes the PDF already exists: a fillable form, an AcroForm with fields of its own, that the answers have to go into. In this example the server keeps that PDF, and its copy of the form definition carries a template layout for it: which of the PDF's fields takes which answer. The page delivers the envelope, and the endpoint validates it with the sandbox program, fills the PDF with the PDF program and answers with the filled file.

## The page

There is no server behind these docs. The result under the code is answered by a stand-in in the browser that runs the same programs, from the same built files, over the same form and the same PDF. The endpoint files further down are what a real server runs.

<LiveExample name="server-fill" />

Try it in this order:

1. Fill in a name, pick a country and a contact method, and submit. The filled PDF appears under the form with a link to save it.
2. Tick the newsletter box and enter an address, then submit again: the email field in the PDF is filled.
3. Untick it and the field is cleared, because a rule hides the address and a hidden answer is not printed.

The log lists the fill report, one line per mapped field.

## What the server keeps

The PDF is the server's, at `templates/customer-intake.pdf`: open the [blank form](/templates/customer-intake.pdf){target="_blank"} to see its seven fields. The page loads the plain form, and the server's copy of the definition is the same form with the template layout added: [customer-intake-template.json](/forms/customer-intake-template.json){target="_blank"}. Its layout `intake-template` maps the fields this way:

| PDF field | Takes |
|---|---|
| `applicant_name` | The answer to `fullName`, as typed |
| `country` | <code v-pre>{{country}}</code>, template text that writes the option's label, since the PDF's list holds country names |
| `contact_method` | The answer to `contactMethod`, whose values match the radio group's export values |
| `newsletter_optin` | The checkbox `subscribe` |
| `newsletter_email`, `notes` | The answers to `newsletterEmail` and `notes` |
| `submitted_via` | The literal "Web form" |

A layout like this is made in the builder's PDF workspace: add the PDF as a template layout and map its fields. See [PDFs](/pdf).

## The endpoint

Each file is complete. Its first lines say what to install and how to fetch the engine, a WASM build of a JavaScript engine (`qjs-wasi.wasm`), from its release page. Beside it the server keeps:

- Both programs from the bundle folder.
- Its copy of the form at `forms/customer-intake.json` (the one with the template layout).
- The PDF at `templates/customer-intake.pdf`.
- The two fonts at `fonts/`.

### Python (FastAPI)

::: code-group

<<< @/snippets/server/fill/main.py{python} [main.py]

:::

### Java (Spring Boot)

::: code-group

<<< @/snippets/server/fill/Application.java{java} [Application.java]

<<< @/snippets/server/shared/pom.xml{xml} [pom.xml]

:::

### C# (ASP.NET Core)

::: code-group

<<< @/snippets/server/fill/Program.cs{csharp} [Program.cs]

<<< @/snippets/server/shared/intake.csproj{xml} [intake.csproj]

:::

### Node.js (Express)

::: code-group

<<< @/snippets/server/fill/main.mjs{js} [main.mjs]

<<< @/snippets/server/shared/qjs.mjs{js} [qjs.mjs]

:::

## What to notice

- **The PDF never sits in the definition.** The layout's template source names a file the server resolves. The endpoint reads the bytes from its own disk and sends them with each request, base64.
- **The server picks the layout.** The request carries the template layout inline, so no layout's condition is tried and the bytes are that layout's. Sending only `"layoutId": "intake-template"` would not select it: an id picks from the definition's `pdf` block, and this request carries none, so the layout has to be sent inline as here.
- **What becomes of the fields.** `FIELDS` is the endpoint's constant. This example leaves them editable. The values are:
  - `editable` leaves fields a reader may still change.
  - `readonly` locks each one the fill touched.
  - `flatten` draws the values into the page and drops the fields, for an archive copy.
- **The fill report.** The answer lists every mapped field with its status, and the endpoint writes it to its log. The statuses are:
  - `filled`.
  - `cleared` when there is no answer or a rule hid it.
  - `missing` when the PDF has no field of that name.
  - `unsupported` for a kind the kernel cannot fill.
- **The options are the server's.** <code v-pre>{{country}}</code> writes the label from the list the endpoint resolved itself ("Canada"), not the code the form stores ("CA").

## Next

- Why these endpoints are short, and what they skip: [Example: validate on the server](/server-example-validate#simple-on-purpose).
- The record drawn from the form's own layout instead: [Example: render a PDF on the server](/server-example-pdf).
- The record sealed with the server's certificate: [Example: sign a PDF on the server](/server-example-sign).
- Template layouts, value maps and creating form fields from a PDF: [PDFs](/pdf).
