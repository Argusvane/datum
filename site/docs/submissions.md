# Submissions and replies

[The form on your page](/form-on-your-page) shows the basic round trip: the form raises `datum-submit`, the page delivers the answers and the server's reply goes back in. This page goes deeper into the parts of it that matter when the server is slow, unreachable or strict.

## What `datum-submit` carries

The event fires after the form has validated and locked itself. It fires for a refused submit too, so a listener checks `accepted` first. Its `detail` holds:

| Property | What it is |
|---|---|
| `accepted` | Whether the answers passed validation. A listener returns early when it is `false`: the form shows its own errors. |
| `submission` | The envelope, present when accepted. See [The envelope](#the-envelope). |
| `errors` | The errors that refused the submit, as the form holds them (see the shape under [`datum-validated`](/form-element#event-details)). An accepted submit has none. |
| `result` | The runtime's whole answer: `accepted`, `errors`, `canonicalSubmission` (the same object as `submission`), `signatures`, `signed`, `submissionKey`, and `handlerErrors` when a submission handler registered by a plugin threw. A page that wants the signatures reads them here. |
| `submissionKey` | On an accepted submit, a key minted when the attempt started: a version 4 UUID. It is the same for every retry of that attempt, and new for the next one. |
| `waitUntil(promise)` | Keeps the form locked until the promise settles. |
| `signed` | Only when the form is signed with `signing-placement="wrapper"`: the document to deliver, the envelope as its `payload` with the signatures beside it. See [Signing](/signing). |
| `trigger` | `"agent"` when an assistant started the submit; absent otherwise. See [Assistants](/assistants). |
| `agent` | When an assistant's tools were ever live on the form: which answers they wrote last. Advisory, kept on the page, and never part of the envelope. |

Deliver `detail.signed ?? detail.submission`. For an unsigned form, and for a form signed with the default `embedded` placement, that is the envelope; under the `wrapper` placement it is the wrapper, and the envelope alone would drop the signatures.

### The envelope

The envelope is the object the form calls the canonical submission. It has three keys, and the middle one is itself named `submission`, so the answers are at `detail.submission.submission.values`. In this page the whole object is the envelope and its inner `submission` key is the submission block.

```json
{
  "versionContext": {
    "form": { "id": "customer-intake", "version": "1.0.0" },
    "client": {
      "runtimeVersion": "1.0.0",
      "rendererVersion": "1.0.0",
      "schemaVersion": "1",
      "components": { "text": "1.0.0", "select": "1.0.0" },
      "plugins": {}
    }
  },
  "submission": {
    "locale": "en",
    "values": {
      "fullName": "Ada Lovelace",
      "billing.street": "1 Main St",
      "items": [{ "sku": "A-1" }, {}]
    },
    "journey": { "id": "apply" }
  },
  "signatures": [
    { "signature": "MEUCIQ...", "algorithm": "ES256", "signedAt": 1767225600000, "participantId": "applicant" }
  ]
}
```

| Key | What it holds |
|---|---|
| `versionContext.form` | The `id` and `version` of the definition the answers were given against. A server uses the pair to pick the definition to check them with. |
| `versionContext.client` | What the browser ran: `runtimeVersion`, `rendererVersion` and the definition's `schemaVersion`, then `components` (each component type the form uses, with its version) and `plugins` (each installed plugin, with its version). |
| `versionContext.server` | Absent from what a page sends. It appears only where a server stage is part of the submission mode. |
| `submission.locale` | The language the form was in when it was submitted. |
| `submission.values` | The answers, one entry per value path. A nested container's answer is under a dotted path (`billing.street`). A data grid, or any other collection, is one entry holding a list of row objects, a row the person left empty kept as `{}`, so the server counts the rows the person saw. A key never appears with an `undefined` value. |
| `submission.journey` | Only for a form filled through a journey: `{ "id": ... }`. It is the only journey data in the envelope. The pages the person visited are not sent, and a server works the path out again from the answers. |
| `signatures` | Only for an `embedded` signed submit. Each entry holds `signature`, `algorithm`, `signedAt` (milliseconds since 1970) and `participantId`, with `format`, `statement` and `webauthn` when the provider sets them. See [Signing](/signing). |

What a hidden field's answer does in `values` is described with the field, not here. Presentation-only answers of a journey (the page's own fields) never reach `values`; `presentationValues()` returns them on the page.

### The canonical form and the digest

Before the envelope is signed, delivered or stored, every object in it has its keys sorted by UTF-16 code unit, at every depth. Lists keep their order. Two envelopes with the same answers therefore serialise to the same text, whatever order the keys were written in.

The sandbox returns that text as `canonical`, with `digest`: the lowercase hex SHA-256 of the text's UTF-8 bytes. A host:

- passes the delivered document to the sandbox as `document`,
- stores both values, and
- never serialises the document itself, so the browser and every host name one record by one digest.

See [Your own server](/server-programs).

A signature covers a different text:

- It is the envelope, its submission block or its `values` alone (the `signing-scope`), written in the form RFC 8785 defines (JSON Canonicalization Scheme).
- `signatures` never enters the signed text, so a verifier gets the same bytes from an embedded or a wrapped document.
- `canonicalizeJcs` and `signedCanonicalOf` are exported from `datum-form.js` for a page that verifies in the browser; see [JavaScript exports](/exports).

## Holding the form while the server answers

A delivery that takes a moment must not leave the form open to a second press or to edits. Hand the delivery to `detail.waitUntil(promise)`. The form stays locked, every field, button and the language switcher inert, and a status line reads "Submitting…" with a spinner beside it, until the promise settles. The element reflects the lock as its `submitting` attribute, so a stylesheet or an observer can see it too.

Two attributes shape the line:

- `texts` carries the page's own wording, per language: `{ submitting: { default: "Sending your answers…", locales: { "fr-CA": "Envoi de vos réponses…" } } }`.
- `submitting-placement` says where the line goes: `top` (the default, where the error summary sits), `bottom` beside the button, or both.

Rules for `waitUntil`:

- Call it while the listener is still running, before any `await`. A listener written `async (event) => { await something(); event.detail.waitUntil(...) }` calls it too late and it throws.
- It can be called again while an earlier promise is still pending, but not with the promise `submit()` itself returned.

When the promise fails:

- A promise that rejects lifts the lock and is reported as `datum-error`. What the person sees for the failure is the page's `catch`.
- A promise that resolves with a `Response` whose `ok` is `false`, which is what `fetch` gives for a 500, counts as a failed delivery too: the form unlocks and shows no confirmation.

Calling `form.submit()` while a submit is in flight joins it and resolves with the same detail. A call that asks for something different (a download after a plain submit), or one made from inside a `datum-submit` listener, rejects with a busy error.

## Timeouts and retries

The form has no timeout of its own. The page sets one on the request, and a signal does it in one line: `AbortSignal.timeout(5000)` makes the `fetch` throw when the server has not answered in five seconds. The `catch` then calls `setErrors` with an error of the form's own, and the form unlocks so the person can press Submit again.

That second press starts a new attempt, with a new `submissionKey`. When the page retries the same delivery itself, it sends the key it already has, unchanged. A server that keeps one record per key then keeps one record however many times the request arrived, which matters when the first request did reach it and only the reply was lost.

## The reply, back into the form

| The server | The page calls | The form shows |
|---|---|---|
| Accepted | `setNotice({ kind, title, message, details, placement })` | A receipt |
| Rejected a field | `setErrors([{ componentId, code, message }])` | The message on that field and in the error summary |
| Rejected a row of a data grid | `setErrors([{ path: "items[1].sku", code }])` | The message on that row's field |
| Did not answer in time, or could not be reached | `setErrors([{ code, message }])` | An error of the form's own, in the summary |

The full shape of an error and of a notice is on [The form element](/form-element#setting-errors-and-notices). In brief:

- `placement` on a notice lists the ends of the form it is shown at, `["top"]`, `["bottom"]` beside the button, or both.
- A notice is printed with the form and takes focus.
- A notice's title, message and detail labels can be a plain string or one worded per language. An error's `message` and a notice's detail values are plain strings.
- The next submit clears a notice, and `setNotice(undefined)` and `setErrors([])` clear them by hand.

A server that reports a warning sends `severity: "warning"` (or `"info"`) and the error is shown without being treated as blocking. In a journey, the person is moved to the first page holding an error the server reported.

## After acceptance

Three things a page commonly does once the server has accepted:

- **Show the receipt and leave the answers editable.** The notice is all it takes.
- **Show the receipt and lock the answers.** Set `form.mode = "readonly"` after `setNotice`. The answers stay as sent and the Submit button is disabled. Setting `form.mode = "interactive"` and clearing the notice starts over.
- **Move on.** The page navigates, for instance `location.assign("/thanks?ref=" + reply.reference)`, and the form is not seen again.

A form that needs only a plain confirmation can use the `confirmation` attribute instead: an accepted delivery shows the form's own notice. It reads the reference from `reference` (or `confirmationNumber`, a string or a number) on the value the `waitUntil` promise resolves with, or on that value's `receipt`. A `fetch` resolves with a `Response`, which carries no reference, so hand `waitUntil` a promise that resolves with the parsed reply:

```js
form.addEventListener("datum-submit", (event) => {
  if (!event.detail.accepted) return;
  const delivery = fetch("/api/submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: event.detail.signed ?? event.detail.submission, submissionKey: event.detail.submissionKey })
  }).then((response) => response.json()); // { "reference": "GC-48213" }
  event.detail.waitUntil(delivery);
});
```

The confirmation also keeps the reply's data for print. When the reply is a plain object (or has a `receipt` object), the confirmation's notice carries it as `data`, so a printed header or footer can say <code v-pre>Reference {{receipt.reference}}</code> (see [Print](/print#a-receipt-in-the-header-or-footer)).

The confirmation appears only when the submit was accepted and the delivery did not fail (no promise rejected, no reply with `ok: false`). It does not appear when the page has set a notice of its own, when an error is standing, or for a download.

- **Wording.** The title, message and the label of the reference line are the `texts` keys `confirmationTitle`, `confirmationMessage` and `confirmationReference`, listed on [The form's own words](/form-texts).
- **Server replies.** Datum's server hosts answer an accepted submission with `{ id, reference, status, digest, handled }` and a rejected one with a 422 and `{ errors: [{ field, code, message }] }`, which the page maps into `setErrors` as `componentId`.
- **Your own receipt.** A page that wants its own receipt calls `setNotice` instead, and the built-in confirmation never replaces it.

## A live example

Submit the form with a name. With the 2 second delay, the form locks and shows the page's own submitting line, then the receipt follows. Choose Never answers and submit again: the page gives up after five seconds, the form unlocks and shows the page's error. Move the submitting line to the bottom, or lock the answers after acceptance, and the code under the example changes with you.

<LiveExample name="slow-submit" />

## Next

- The basics of the same round trip: [The form on your page](/form-on-your-page).
- Checking the answers on your server: [Validation and the sandbox](/validation).
- Every attribute and method: [The form element](/form-element).
