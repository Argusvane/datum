# Getting started

This page takes you from nothing to a form on a page of your own, then to a form you designed yourself, then to its answers in your hands. Follow it from top to bottom. No server of your own is needed until the last step.

You need Node 22 or newer, npm and Python 3 (only to serve a folder; any static file server does the same).

## Get the files

Datum is a folder of files you host. Make a folder for your site, install the package into it, and copy the files in as `datum/`, with a place for forms:

```sh
mkdir -p my-site/forms
cd my-site
npm install @argusvane/datum
cp -R node_modules/@argusvane/datum/dist datum
```

The folder `datum/` now holds everything the form and the builder load. [Files you host](/files) says what each file is, how to build the same folder from the repository, and how to load it from a CDN instead.

Save the sample form as `forms/contact.json`: [contact.json](/forms/contact.json){target="_blank"}. A form is one JSON file, the definition. This one has four fields and a Send button.

::: details The sample form
<<< @/public/forms/contact.json
:::

## Put the form on a page

Save this as `index.html` in the site folder:

```html
<!doctype html>
<meta charset="utf-8">
<title>Contact</title>
<link rel="stylesheet" href="/datum/datum-form.css">
<script type="module" src="/datum/datum-form.js"></script>

<datum-form src="/forms/contact.json"></datum-form>
```

Serve the folder and open `localhost:8080` in a browser:

```sh
python3 -m http.server 8080
```

You should see a form titled "Contact us" with a name, an email, three choices, a message box and a Send button. Press Send with nothing filled in: the form lists two errors and marks the two required fields.

If it does not work:

- **A blank page.** The page was opened from disk. A browser loads a module only over HTTP, so open the address above, not the file.
- **"This form could not be loaded."** The element could not fetch the definition. Check that `forms/contact.json` is in the site folder. The browser's console names the address and the reason.
- **Nothing where the form should be.** `datum/datum-form.js` was not found. Check that the built folder was copied in as `datum/`.

## Take the submission

When the person presses Send and the answers pass, the form raises `datum-submit`. Add this under the form, and reload:

```html
<pre id="answers"></pre>

<script type="module">
  const form = document.querySelector("datum-form");
  form.addEventListener("datum-submit", ({ detail }) => {
    if (!detail.accepted) return;        // the form shows its own errors
    document.getElementById("answers").textContent =
      JSON.stringify(detail.submission, null, 2);
  });
</script>
```

Fill in a name and an email and press Send. The page prints what the form hands over:

```json
{
  "submission": {
    "locale": "en",
    "values": { "email": "ada@example.org", "fullName": "Ada Lovelace" }
  },
  "versionContext": {
    "client": { "…": "what the browser ran" },
    "form": { "id": "contact", "version": "1.0.0" }
  }
}
```

That object is the envelope: the answers under `submission.values`, and the form's `id` and `version`, which say which definition they were given against. Its keys are always in the same order, so the same answers always make the same text. [Submissions and replies](/submissions#what-datum-submit-carries) describes all of it.

## Design a form of your own

The builder is one more element from the same folder. Save this as `builder.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Builder</title>
<link rel="stylesheet" href="/datum/datum-builder.css">
<script type="module" src="/datum/datum-builder.js"></script>

<datum-form-builder></datum-form-builder>
```

Open `localhost:8080/builder.html`. It opens on a new form that holds a Submit button and nothing else.

1. Click a component in the panel on the left, or drag it onto the form. Click it on the form to edit its label and its settings on the right.
2. Press **Try it** to fill the form in as a person would.
3. Open the menu (⋮) at the right end of the bar and choose **Download form**. The browser saves the definition as a JSON file.
4. Move that file into `forms/`, point `src` in `index.html` at it, and reload the page.

**Open form file…** in the same menu loads a definition back in, so `forms/contact.json` can be the starting point instead. [Building a form](/building-a-form) walks the whole builder.

## Send it to a server

Until now nothing has left the browser. To keep the answers, the page delivers the envelope to an endpoint of yours. Replace the script from [Take the submission](#take-the-submission) with this one, and add the `confirmation` attribute to the form:

```html
<datum-form src="/forms/contact.json" confirmation></datum-form>

<script type="module">
  const form = document.querySelector("datum-form");
  form.addEventListener("datum-submit", ({ detail }) => {
    if (!detail.accepted) return;
    detail.waitUntil(deliver(detail));   // the form stays locked until this settles
  });

  async function deliver(detail) {
    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: detail.signed ?? detail.submission,
                               submissionKey: detail.submissionKey })
      });
      const reply = await response.json();
      if (response.status === 422) {     // { errors: [{ field, code, message }] }
        form.setErrors(reply.errors.map((error) => ({
          componentId: error.field, code: error.code, message: error.message })));
      } else if (!response.ok) {
        throw new Error("The server answered " + response.status);
      }
      return reply;                      // `confirmation` reads its reference
    } catch {
      form.setErrors([{ code: "delivery", message: "Your answers could not be sent. Try again." }]);
    }
  }
</script>
```

`/api/submissions` is not part of the folder: it is the endpoint your server provides. With the static server from this page there is none, so pressing Send now shows "Your answers could not be sent." in the form. That is the failure path working.

What the script does:

- **`waitUntil`** keeps the form locked, with a "Submitting…" line, until the delivery settles.
- **The body** is the envelope as `document` and `submissionKey`, a key that stays the same for every retry of one attempt, so the server can keep one record for it.
- **A 422** carries the server's own errors, which `setErrors` puts on the fields.
- **An accepted reply** with a `reference` is shown by the form's own confirmation, because of the `confirmation` attribute.

The route, the body and both replies are the defaults of Datum's server hosts, so this page works against one unchanged. A server host finds the same definition by its `id` and `version` and checks the answers again in the sandbox: it never takes the browser's word.

- [Spring Boot: first run](/spring-boot#first-run)
- [FastAPI: first run](/fastapi#first-run)
- Any other server: [Your own server](/server-programs), with the endpoint in Python, Java, C# and Node.js

## Where next

- **The form on the page.** Data for the selects, wording, languages, drafts, the header and footer: [The form on your page](/form-on-your-page), and [Ways to configure](/configuring) for the map of every setting.
- **Building forms.** [Building a form](/building-a-form), [Components](/components), [Rules and formulas](/formulas).
- **A framework.** React, Vue and Angular use the elements as they use any custom element: [React, Vue and Angular](/frameworks).
- **The builder inside your application.** [Embedding the builder](/embedding-the-builder) and [Saving forms](/saving-forms).
- **Outputs.** [PDFs](/pdf), [Print](/print), [Signing](/signing).
- **Going live.** [Publishing a form](/publishing), [Files you host](/files), [Security headers](/security-headers).
