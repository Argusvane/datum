# Live examples

Each example is a whole page a reader could copy, with choices that rewrite it and the page itself running under the code. They sit on the page that covers their subject.

## The form

| Example | Shows | On |
|---|---|---|
| A form on a page | Locale, mode, frame, drafts, data sources, messages, and the server's reply as a receipt or as errors | [The form on your page](/form-on-your-page) |
| A slow server | The form locked and saying it is submitting while a delivery runs, a timeout, then the receipt | [Submissions and replies](/submissions) |
| Header and footer | Parts the page adds, parts the form's author composed, or both: logo, title, instructions, language switcher | [Look and chrome](/look) |
| Parts left out | `features` on the form and on the builder | [Leaving parts out](/leaving-parts-out) |
| Rules of your own | Rules run at submit in the sandbox, the data the page hands them, their messages and the run log | [Validation and the sandbox](/validation) |
| A journey | One form with three journeys: a picker, page changes, a deep link, a draft resumed after a reload | [Journeys](/journeys) |
| A journey page the service checks | A page checked through `validate-url`, and the delivery judged the same way | [Journeys](/journeys) |
| Bootstrap with your own CSS | The Bootstrap binding over Bootstrap's stylesheet and a brand sheet of the site's own | [Bootstrap with your own CSS](/bootstrap) |
| A form in an iframe | A host page and the page it frames, sizing and reporting through `postMessage` | [In an iframe](/iframe) |
| Signing with a hardware token | The page wired to the local signing agent; it reports the agent as unreachable when none runs | [Signing](/signing) |

## Languages

| Example | Shows | On |
|---|---|---|
| A form in two languages | `locale` negotiated or `auto`, the form's own switcher, `setLocale` | [Languages](/languages) |
| Translations from the page | `translations`, `texts` with plural keys and `messages` meeting the form's own wording, and which wins | [Languages](/languages) |
| Choices in more than one language | A source told the locale, one that sends every language, and an endpoint read with `?locale=` | [Languages](/languages) |
| Language changes at Save | The languages removed or renamed since the last save, handed to the page's Save | [Languages](/languages) |
| The builder's own words | `textCatalog` and `textLocale` rewording the builder's interface | [Languages](/languages) |

## The builder

| Example | Shows | On |
|---|---|---|
| The builder in a box | Sizing, the file actions, the page's own Save on the bar, and every edit reported | [Embedding the builder](/embedding-the-builder) |
| Builder and form together | One listener hands each edit to a form beside the builder | [Embedding the builder](/embedding-the-builder) |
| Save with a revision check | `fileActions.save`, Ctrl/Cmd+S, the unsaved cue, and a stale save refused | [Embedding the builder](/embedding-the-builder) |
| A component type of your own | A star rating on the form or the palette, as `componentDefinitions` or as a plugin | [Components of your own](/custom-components) |
| Font Awesome icons | The builder's icons from the Font Awesome plugin, against its own | [Customising the builder](/customising-the-builder) |
| An icon set of your own | An icon set written in the page | [Customising the builder](/customising-the-builder) |
| Form tests | The builder opened on a form that carries its scenarios, the Tests panel running them | [Testing a form](/testing) |

## The server

Each of these shows the page running against a stand-in, and the endpoint in Python, Java, C# and Node.js.

| Example | Shows | On |
|---|---|---|
| Validate on the server | The endpoint reruns the sandbox program and answers with the same codes | [Example: validate](/server-example-validate) |
| Render a PDF on the server | The endpoint validates, renders the record and answers with the PDF | [Example: render a PDF](/server-example-pdf) |
| Fill a PDF on the server | The endpoint writes the answers into a template it keeps | [Example: fill a PDF](/server-example-fill) |
| Sign a PDF on the server | The endpoint seals the PDF with its own certificate, and a second one verifies it | [Example: sign a PDF](/server-example-sign) |

Components for React, Vue and Angular are on [React, Vue and Angular](/frameworks). Those are code to copy, not run here.

## How they run

The result is the code above it, loaded into a frame. Nothing else is wired to it. Two things stand in for a site of your own:

- The bundle folder, written as `/datum/` in the code, is this site's copy.
- Requests to `/forms/` and `/api/` are answered by the example in place of a server, and so are the example's own files, such as a stylesheet on a tab beside the page. Where an example has a Server reply choice, that choice is what the stand-in answers. The server examples' stand-in runs the same sandbox and PDF programs a server would.

The log under each result lists the events the element dispatched, what the page wrote to the console and each request it made to the stand-in. A long entry opens to show the whole of it.
