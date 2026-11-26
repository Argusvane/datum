# UI example: story two

The page asks the server for the form. `datum-spring-boot-starter-ui` serves the Datum elements and the glue script,
`src/main/resources/datum/forms/contact.json` (the file the builder's Download made) is the form, and
`UiExampleApplication` supplies the one thing the packages leave to you: a `SubmissionHandler` that stores what was
accepted. It answers `CONTACT-0001`, `CONTACT-0002`, ... and the form shows a notice with it.

## Before you build

The jars carry browser assets, programs and notices that the build generates from `packages/datum/dist`, so on a fresh clone
build those first. From the repository root, with Node 22 on the `PATH` (the Maven build runs `node`) and JDK 17 or newer:

```sh
npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel packages/datum
npm run datum:build
```

The first Maven build also compiles the pinned QuickJS runtime for six native targets, which takes 12 to 16 minutes. Add
`-Pdev-native` to the `./mvnw` command below to compile the host's target only, for a local run. A source build is version
`0.1.0-SNAPSHOT`, the version in the jar name below.

Then, from `integrations/jvm`:

```
./mvnw -q -B -pl examples/ui -am package
java -jar examples/ui/target/datum-example-ui-0.1.0-SNAPSHOT-exec.jar
```

Open <http://localhost:8080/>. There is no controller in this application: everything on the wire is the starter's. Every Datum route is off until switched on, so `application.yml` turns on exactly the ones this page uses (`definition`, `data-sources`, `submissions`, `validate` and `datum.web.assets.enabled`).

| What | Where |
| --- | --- |
| the page | `static/index.html` |
| the form definition | `GET /api/forms/contact/definition` (ETag = its SHA-256) |
| the elements | `/datum/assets/<build id>/datum-form.js` (immutable, cached for a year) |
| the glue | `/datum/assets/datum-host.js` (`DatumHost.load`, `DatumHost.submit`) |
| a submission | `POST /api/submissions` |
| the builder's files | 404 until `datum.builder.enabled=true` (story three, `examples/ui-builder-jpa`) |

## What the page does

```html
<datum-form id="f" locale="en" src="/api/forms/contact/definition"></datum-form>

<script type="module" src="/datum/assets/datum-host.js"></script>
<script type="module">
  await DatumHost.load({ bundle: 'form' });
  DatumHost.submit(document.getElementById('f'));
</script>
```

The page sets `locale` and `src` itself, as every attribute is the application's to set. `DatumHost.load`
reads `host.json` to find the versioned assets path, and `DatumHost.submit` posts each accepted submission to
`/api/submissions`, adds the CSRF header when the page has a token (Spring Security's
`CookieCsrfTokenRepository.withHttpOnlyFalse()` cookie, or a `<meta name="_csrf">`), and shows the receipt or the
refusals on the form.

## Story one and story three

Story one is the same application without the `-ui` starter: `datum-spring-boot-starter-submissions` alone, with the
page loading `datum-form.js` from wherever it likes. Story three adds the builder: `datum.builder.enabled=true`,
a Spring Security rule on `DatumRequestMatchers.builderWrites()` and `builderReads()` that checks a role (Datum has no
access policy; see examples/ui-builder-jpa), and `DatumHost.builder(el, {formKey})` on an author page.
