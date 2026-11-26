# Example: render a PDF on the server

A record as a PDF, made without a browser in the loop. In this example:

1. The page delivers the envelope to an endpoint.
2. The endpoint first validates it with the sandbox program, as in [Example: validate on the server](/server-example-validate) but with the form's own checks only: it registers no custom rules and sends no external data.
3. It then renders the sanitised values with the PDF program, `datum-pdf-program.js`.
4. The endpoint answers `application/pdf` with the bytes, and the page shows them in place and offers them as a file.

The PDF program is the same kernel the browser's PDF button runs, so the server's PDF has the same layout, page for page.

## The page

There is no server behind these docs. The result under the code is answered by a stand-in in the browser that runs the same programs, from the same built files, over the same form. The endpoint files further down are what a real server runs.

<LiveExample name="server-pdf" />

Enter a full name and submit. The form stays locked while the server renders, then the PDF appears under the form with a link to save it.

- The PDF is in English whatever language the form is switched to: the endpoint sends the form's root and the answers but no form translations, so the program has no other language's text to print.
- Submit with the name empty and nothing is sent, because the form refuses the submit and shows its own error on the field.
- A 422 comes only from a delivery that reaches the endpoint and fails its checks, which the page hands to `setErrors`.

The form here declares no PDF layout, so the kernel derives one from the form's components. A form designed in the builder's PDF workspace carries its layouts under `pdf`, and the endpoint passes them on unchanged.

## The endpoint

Each file is complete. Its first lines say what to install and how to fetch the engine, a WASM build of a JavaScript engine (`qjs-wasi.wasm`), from its release page. Beside it the server keeps:

- Both programs from the bundle folder, `datum-sandbox-program.js` and `datum-pdf-program.js`.
- Its copy of the form at `forms/customer-intake.json`.
- The two fonts it embeds at `fonts/DejaVuSans.ttf` and `fonts/DejaVuSans-Bold.ttf`.

### Python (FastAPI)

::: code-group

<<< @/snippets/server/pdf/main.py{python} [main.py]

:::

### Java (Spring Boot)

::: code-group

<<< @/snippets/server/pdf/Application.java{java} [Application.java]

<<< @/snippets/server/shared/pom.xml{xml} [pom.xml]

:::

### C# (ASP.NET Core)

::: code-group

<<< @/snippets/server/pdf/Program.cs{csharp} [Program.cs]

<<< @/snippets/server/shared/intake.csproj{xml} [intake.csproj]

:::

### Node.js (Express)

::: code-group

<<< @/snippets/server/pdf/main.mjs{js} [main.mjs]

<<< @/snippets/server/shared/qjs.mjs{js} [qjs.mjs]

:::

## What to notice

- **Validation first.** The PDF prints the values the sandbox returned, not what was posted, so it never shows a key the form does not define.
- **The program has no file system.** The endpoint reads the fonts and hands them over as base64, and resolves the Country select's options itself. With no fonts, the standard PDF fonts stand in.
- **The only time and identity.** The request's `env` carries the creation time and a document id. The program reads no clock and makes no random numbers, so the same request gives the same bytes on every host.
- **The server's say.** The language and the compactness of the file are constants of the endpoint (`LOCALE`, `COMPACT`). `LAYOUT_ID` names one of the form's layouts by id; left empty, the form chooses, by the first layout whose condition holds on the answers, else its default.
- **Two budgets.** In these example files a validation run gets 32 MiB and a PDF run 256 MiB and 15 s. The validation time budget is 250 ms in the Python and C# files and 5 s in the Java and Node.js files. These are the examples' own numbers, not the built hosts' defaults, which are tabled in [Your own server](/server-programs#limits-a-host-sets).
- **Errors keep their shape.** A 422 is the same error contract as validation. A failed render answers 500 with the kernel's code, such as `font`, `layout` or `template`.

## Next

- Why these endpoints are short, and what they skip: [Example: validate on the server](/server-example-validate#simple-on-purpose).
- An existing PDF form filled with the answers: [Example: fill a PDF on the server](/server-example-fill).
- The record sealed with the server's certificate: [Example: sign a PDF on the server](/server-example-sign).
- Layouts, themes and PDF/A: [PDFs](/pdf).
- The PDF request and its operations: [Running the programs on your own server](/server-programs).
