# The form on your page

`<datum-form>` takes a definition and draws the form. The page around it supplies what the definition cannot know: the data behind the selects, the wording for this site, where the answers go and what the server said back. This page walks through those, with the whole thing running at the end of each part.

## The whole page

The example is a complete page. The choices above the code rewrite it, and the result under it is that page, running.

<LiveExample name="form" />

The definition it loads is a file of this site's: [customer-intake.json](/forms/customer-intake.json){target="_blank"}.

## What the page sets

**Where the form comes from.**

- `src` names a definition to fetch. A page that already holds the object assigns it to the `definition` property instead.
- Use one at a time: while one is in place the other is refused with a `datum-error`, so clear it first.
- `src` is a plain `fetch` with no headers and no credentials; for a definition behind a login, fetch it yourself and assign `definition`.

**How it opens.**

- `locale` picks the starting language from the ones the form supports, and `auto` takes the visitor's browser languages.
- `language-switcher` adds the form's own switcher to its header.
- `mode="readonly"` shows the answers without letting them change.
- `frame` sets the box around the form: `seamless`, `outlined` or `paper`. The author's own pick beats it unless `frame-fixed` is set.

**Data sources.** A select or radio group can name a source instead of listing its options. The page supplies each source under that id, as a list or as a function that returns one. See [Data model and data sources](/data).

**Messages.** The form's author words the validation errors in the builder. The page's `messages` word them too, per language. An entry beats the author's message for the same code; a code the page leaves out keeps the author's words. In the example, submit with the name empty: the page's "This field is required." shows in place of the field's own "Enter your full name."

**Drafts.** With a `draft` key every change is saved, in the browser unless `draft-store` names a server. Nothing restores by itself: the page calls `restoreDraft()` once the form is ready, as the example does. Turn on Draft autosave in the example, type a name and press Reload. See [Drafts](/drafts).

## Taking the submission

A button with the action `submit` validates the form. If the answers pass, the form locks and raises `datum-submit` with `detail.accepted` set and the envelope, which holds the answers, in `detail.submission`. If they fail, the form shows its own errors and the event carries `accepted: false`, so a listener returns early.

The page delivers `detail.signed ?? detail.submission` wherever it likes. `detail.submissionKey` is the same for every retry of one attempt, so the server can keep one record for it. The shape of the envelope and everything else the event carries is on [Submissions and replies](/submissions#what-datum-submit-carries).

## Answering it

What the server said goes back into the form through two methods: `setNotice` for a receipt and `setErrors` for a refusal or a failed delivery. Which call fits which reply, the shape each takes, timeouts, retries and what to do after acceptance are on [Submissions and replies](/submissions#the-reply-back-into-the-form). `setErrors` throws until the form is built; see [When the form is ready](/form-element#when-the-form-is-ready).

Change Server reply in the example and submit again to see each one. Every text in a notice can be a plain string or one worded per language, as the example's receipt is.

## From script

Everything an attribute sets, a property sets too, and objects and functions are properties only. An application built with a bundler, or with plain ES modules, can make the element and wire it from code. Importing the module defines `<datum-form>` and exports the API behind it, whose types `@argusvane/datum/form` declares (see [TypeScript](/frameworks#typescript)).

```html
<div id="intake-slot"></div>
<button id="send" type="button">Send from the page</button>

<script type="module">
  import "/datum/datum-form.js";                 // defines <datum-form>

  const form = document.createElement("datum-form");
  form.definition = await (await fetch("/forms/customer-intake.json")).json();
  form.locale = "fr-CA";                         // one of the form's own languages
  form.colorScheme = "dark";
  form.dataSources = {
    countries: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }]
  };

  // The organisation's chrome, once, for every form this application serves.
  form.chrome = {
    header: [{ type: "heading", text: "Example Org" }, { type: "form-title" }, { type: "language-switcher" }],
    footer: [{ type: "text", text: {
      default: "Privacy · Accessibility",
      locales: { "fr-CA": "Confidentialité · Accessibilité" } } }],
    frame: { id: "paper", fixed: true }          // fixed: this frame wins over the author's pick
  };

  form.addEventListener("datum-change", ({ detail }) => {
    console.log("settled values", detail.values); // not every keystroke
  });

  // A control of the page's own can ask for the submit, beside the form's own button.
  document.getElementById("send").addEventListener("click", async () => {
    const { accepted, submission } = await form.submit();
    if (accepted) console.log("deliver", submission);   // otherwise the form shows its own errors
  });

  document.getElementById("intake-slot").append(form);
</script>
```

The application's own controls drive the element:

- It hears settled values through `datum-change`.
- It asks for `validate()` or `submit()` from any button.
- It reads the verdict from what they return.

[React, Vue and Angular](/frameworks) has a component for each framework.

## Next

- Every attribute, property, event and method: [The form element](/form-element).
- The header, the footer and the look: [Look and chrome](/look).
- Checking the same answers on your server: [Validation and the sandbox](/validation).
