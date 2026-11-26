# Builder example: story three

Forms are authored in this application. `datum-spring-boot-starter-ui` with `datum.builder.enabled: true` serves the
`<datum-form-builder>` bundle and the write endpoints; the application supplies where forms live, who may build,
and what happens after a save. There is no Datum controller in it.

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
./mvnw -q -B -pl examples/ui-builder-jpa -am package
java -jar examples/ui-builder-jpa/target/datum-example-ui-builder-jpa-0.1.0-SNAPSHOT-exec.jar
```

Open <http://localhost:8080/builder/> and sign in as `author` / `author` (a form admin). `viewer` / `viewer` may sign
in but not save: the builder shows the server's 403. Who may do what is Spring Security's alone (Datum has no access
policy): the rules are in `SecurityConfiguration`. <http://localhost:8080/> shows the form as visitors get it.

| What | Where |
| --- | --- |
| forms in the database | `JpaFormDefinitionRepository` over `FormEntity` (key, definition JSON, SHA-256, `@Version`) |
| every version, by hash | `JpaDefinitionSnapshotStore` over `SnapshotEntity` |
| who may build | `SecurityConfiguration`: `requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("FORM_ADMIN")` with `DatumRequestMatchers`, and `DatumSecurityResponses` answering the refusals in JSON on Datum's routes |
| sign-in and CSRF | `SecurityConfiguration`: form login, HTTP Basic, `CookieCsrfTokenRepository.withHttpOnlyFalse()` |
| after a save | `FormSavedAudit`, an `@EventListener` of `FormDefinitionSavedEvent` writing an audit row |
| the builder page | `static/builder/index.html`: `DatumHost.builder(el, {formKey: 'intake'})` |

## What a save goes through

`PUT /api/forms/intake` (the glue sends the definition, `If-Match` with the hash the page loaded and the CSRF header).
Nothing is stored on any refusal, and the answers come in this order:

| Status | Code | When |
| --- | --- | --- |
| 401 | `unauthorized` (Spring Security, with `DatumSecurityResponses`; `WWW-Authenticate: Basic`) | not signed in |
| 403 | `access.denied` (Spring Security, with `DatumSecurityResponses`) | no CSRF token, or signed in but not a form admin |
| 415 / 413 | `unsupported_media_type` / `bad_document` | not JSON, or over `datum.builder.max-definition-size` |
| 409 | `form.outdated` | someone saved since the page loaded (`ETag` and `currentSha256` name the current one) |
| 400 | `bad_document` | not strict JSON (an unpaired surrogate escape is not JSON either), or a bad `X-Datum-Locale-Changes` header |
| 422 | each finding's own, in `errors[].code` and `kernel[].code` (for example `pattern.risky`, `component.id.duplicate`, `definition.id.mismatch`) | the shape, an id that is not the form's, or the sandbox kernel's verdict (`kernel` lists code, where and limit); there is no top-level `code` |
| 422 | `definition.tooDeep` / `definition.tooCostly` (top-level `code`) | components nest too deep, or the kernel could not check it within its budget |
| 503 | `server.unavailable` (top-level `code`) | the kernel could not answer: the form is not saved unchecked |

A save answers `ETag` (the hash of what is stored, the one `GET .../definition?public=false` answers) and, when the
definition dropped languages, `X-Datum-Removed-Locales`; its locale leaves the translation catalog in the same save
(a renamed language keeps its texts under the new code). When the catalog could not be changed, the header is left out
and `warnings` says so: the definition is saved either way.
`PUT /api/forms/intake/translations` saves the host catalog (`{"catalog": {"<locale>": {"components": {"<id>": {…}}}}}`, ADR 0158) with `If-Match` on the catalog's own ETag;
`POST /api/forms` creates a form whose key is the definition's id.

## Several instances

The save re-checks `If-Match` under a per-form lock right before writing, which closes the race between two saves
inside one process. Behind a load balancer two processes can still both pass that check at once; `FormEntity`'s
`@Version` column does not see it (each save loads and writes the row in one short transaction), so a deployment of
several instances should serialise saves of a form in the database as well, for example with a row lock.
