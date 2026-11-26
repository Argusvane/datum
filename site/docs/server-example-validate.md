# Example: validate on the server

The browser is not the last word on a submission. In this example the page delivers the envelope that `datum-submit` carries to an endpoint of its own server, and the endpoint judges it again with the same sandbox program the browser runs, over the server's own copy of the form and the rules. The verdict comes back as codes and fields, never text, so the page words a 422 with the same messages it uses for its own errors, through `setErrors`. Nothing is written again in the server's language, and nothing the page did is trusted.

The endpoint is given in four stacks: Python with FastAPI, Java with Spring Boot, C# with ASP.NET Core and Node.js with Express.

## The page

There is no server behind these docs. The result under the code is answered by a stand-in in the browser that runs the same program, from the same built files, over the same form and rules. The endpoint files further down are what a real server runs.

<LiveExample name="server-validate" />

Try it in this order:

1. Type a first name alone, such as "Ada", and submit. The form lets it through, the server answers 422 with `custom.fullNameIncomplete` on `fullName`, and the page's message appears on the field.
2. Choose Mexico and Phone for the second rule, `custom.phoneNotOffered`.
3. Turn on **Run the same rules in the browser too**: the page loads the same rules file into its own sandbox with `wasm="auto"`, and the same answers are refused before they leave the page.

The log shows each delivery and the run log the endpoint forwards to its own logger: the program's steps and what the rules wrote with `context.log`.

## The rules both sides read

The rules are one file, `rules/intake-rules.js`, a plain module whose validators return codes. The server reads its copy from disk; with the browser option on, the page fetches the same file. It is on the `rules/intake-rules.js` tab of the example above.

## The endpoint

Each file is complete. Its first lines say what to install and how to fetch the engine, a WASM build of a JavaScript engine (`qjs-wasi.wasm`), from its release page. Beside it the server keeps:

- The sandbox program `datum-sandbox-program.js` from the built folder, which [Files you host](/files#getting-the-files) says how to build (the Java and Node.js files also copy `datum-pdf-program.js` at startup, which this endpoint does not use).
- Its copy of the form at `forms/customer-intake.json`.
- The rules at `rules/intake-rules.js`.

### Python (FastAPI)

::: code-group

<<< @/snippets/server/validate/main.py{python} [main.py]

:::

### Java (Spring Boot)

::: code-group

<<< @/snippets/server/validate/Application.java{java} [Application.java]

<<< @/snippets/server/shared/pom.xml{xml} [pom.xml]

:::

### C# (ASP.NET Core)

::: code-group

<<< @/snippets/server/validate/Program.cs{csharp} [Program.cs]

<<< @/snippets/server/shared/intake.csproj{xml} [intake.csproj]

:::

### Node.js (Express)

::: code-group

<<< @/snippets/server/validate/main.mjs{js} [main.mjs]

<<< @/snippets/server/shared/qjs.mjs{js} [qjs.mjs]

:::

## What to notice

- **One program, one verdict.** The endpoint does not port the rules. It hands the program the form's root, the submitted values, the locale and what only the server knows, and reads back the outcome. The same input gives the same codes in the browser and on every host.
- **The server's copies decide.** The form, the rules, the list of countries behind the select and the countries phone contact is offered in are the server's own. The page sends its copy of the phone countries to its own sandbox, but the server has the say.
- **Codes, not text.** A 422 carries `{ errors: [{ field, code }] }`. The page's `messages` word each code per language, so the server never sends wording.
- **One record per attempt.** The page posts `{ document, submissionKey }`. The endpoint refuses a delivery without a key with 400 `bad_document`, and stores one record per key, so a retry of the same attempt is the same record.
- **The sanitised values.** On success the endpoint stores `values` from the outcome, not what was posted: keys the form does not define are gone.
- **Only the release it names.** The endpoint checks the engine file's SHA-256 before compiling it, and refuses any other file. The Java build makes the same check in `pom.xml`.
- **A run reaches one folder.** At start the endpoint copies the program into a folder of its own and mounts that, so a run cannot read the form, the rules or anything else beside the server.
- **Fail closed.** A rule that throws blocks the submission with `validator.failed`. A run that ends without an outcome, because its time or memory limit stopped it or a rule module would not load, gives no verdict: the endpoint answers 503 `wasm.execution_error` and stores nothing.
- **The run log stays on the server.** It comes back inside the outcome at the level the request asks for (`debug` here), and the endpoint writes it to its own log. It never goes to the browser.

## Simple on purpose

These endpoints are short so that the part that is Datum's stays in view: hand the program the form and the answers, read the outcome, answer with its codes. Each is one file you can run in a few minutes. They are not a pattern for a production server.

What they skip, so that you know it is there:

- They answer 422 for any entry in the outcome. A warning alone need not block a submission.
- They take the program's whole output as the answer. A production host frames the answer.
- When a run fails they answer 503 with the code `wasm.execution_error` and log the reason. The message never goes to the client, and a production host keeps it in its log the same way.
- They keep nothing: no store, no record of a submission key already seen, no limit on runs in flight.

The [Spring Boot](/spring-boot) and [FastAPI](/fastapi) hosts are packages that do all of that for you. For a host of your own, [Running the programs on your own server](/server-programs) has the full protocol, [Hardening on a server](/wasm-hardening) lists what a production host does around every run, and the [conformance suite](/conformance) checks it.

## Next

- The same delivery, answered with a PDF: [Example: render a PDF on the server](/server-example-pdf).
- What the sandbox checks and how a rule is written: [Validation and the sandbox](/validation).
- The request, the outcome and the limits a host sets: [Running the programs on your own server](/server-programs).
- Hosts that do all of this for you: [Server hosts](/server-hosts).
