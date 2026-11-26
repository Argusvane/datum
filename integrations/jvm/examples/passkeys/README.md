# Passkeys example: signed submissions

A form that must be signed with a passkey. A signed-in person makes a passkey (the browser's WebAuthn prompt), signs
the petition with it, and the server verifies the signature before the `SubmissionHandler` sees the submission. The
same signed document is never accepted twice, and a passkey that was removed signs nothing more.

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
./mvnw -q -B -pl examples/passkeys -am package    # from integrations/jvm
java -jar examples/passkeys/target/datum-example-passkeys-0.1.0-SNAPSHOT-exec.jar
```

Open <http://localhost:8080/>, sign in as `ada` / `ada` (or `grace` / `grace`), and fill the form in. The first time
the browser has no passkey for the site, the page offers to make one. `http://localhost:8080/account.html` lists
your passkeys, adds one ahead of time, tests one and removes one. Passkeys need a secure context: `localhost` is one;
anywhere else, use https and set `datum.webauthn.rp-id` and `origins` to match.

## What the application supplies

| What | Where |
| --- | --- |
| who the person is | `SecurityConfiguration` (Spring Security form login; the cookie CSRF recipe the glue reads). The principal's name owns the passkeys (`SecurityPrincipalSubjectResolver`). |
| the form | `datum/forms/petition.json` on the class path |
| which forms sign, and how | `application.yml`: `datum.webauthn.forms.petition.mode: required` and the statement signed with the answers |
| where passkeys live | H2 here. `spring.flyway.locations: classpath:META-INF/datum/db/migration/{vendor}` runs Datum's `V400__datum_webauthn.sql` for the database in use (h2, postgresql, mysql), and `datum.jdbc.initialize-schema: never` says Flyway owns the schema |
| who may do what | `SecurityConfiguration`, Spring Security with `DatumRequestMatchers`: anyone reads, submits and reaches the passkey endpoints; `builderWrites()`, `builderReads()`, `dryRun()` and `inspect()` are `denyAll()`; nobody uses a form's Test context (`datum.webauthn.test-roles` names no role); `DatumSecurityResponses` answers the refusals in JSON |
| what to do with a signed submission | `PasskeysExampleApplication.petitionHandler()`; it runs only after the signature verified and its digest was claimed |

Everything on the wire is the starters': `/api/forms/petition/definition`, `/api/submissions`, and the passkey endpoints
below. There is no controller in this application.

## The passkey endpoints (`datum.webauthn.path`, default `/api/webauthn`)

| Endpoint | What it does |
| --- | --- |
| `POST /challenge` `{form?, context?, label?}` | a single-use registration challenge; with `form`, for a passkey made at that form; without, one the person adds to their account ahead of time |
| `POST /register` `{token, form?, context?, label?, credential}` | verifies what `registerCredential()` returned and stores the passkey (201) |
| `GET /passkeys[?form=key]` | the caller's passkeys; with `form`, the passkeys the page offers and a `signing` block of what it needs |
| `DELETE /passkeys/{credentialId}` | the owner removes a passkey (revoked first; kept, nameless, when a stored submission names it) |
| `POST /passkeys/{credentialId}/check-challenge`, `/check` | "Test this passkey": a `get()` ceremony against a server challenge |

Codes and words are the endpoint catalog's (`signing.off`, `signing.not_set_up`, `signing.sign_in`, `passkey.challenge`,
`passkey.invalid`, `passkey.exists`, `signature.required`, `signature.unknown`, `signature.unusable`, ...). Challenges
and registrations count against the submissions throttle (kind `REGISTER`), and with a passkey's test challenge against its
address limit (`datum.web.throttle.address-limit`), which counts a request before its body is read.

## The page

```html
<datum-form id="f" locale="en" src="/api/forms/petition/definition"></datum-form>

<script type="module" src="/datum/assets/datum-host.js"></script>
<script type="module">
  await DatumHost.load({ bundle: 'form' });
  const form = document.getElementById('f');
  const passkeys = await DatumHost.passkeys(form, { formKey: 'petition' });
  DatumHost.submit(form, { headers: passkeys.headers });
</script>
```

`DatumHost.passkeys()` reads what the form signs, gives the element a signing provider over the form bundle's
`createWebAuthnSigningProvider`, and offers a new passkey when none signs or the server refuses the one that did.
`headers` lets a browser without passkeys say so (`X-Datum-Signing: unavailable`) to a form that accepts that
(`unavailable: accept`). If you move the endpoints (`datum.webauthn.path`), pass `{endpoint: '/your/path'}`.

## Production notes

- `datum.webauthn.secret` signs the registration challenges: 32 bytes or more, the same on every instance (here it
  comes from `PASSKEY_SECRET` or an example value).
- The replay guard and the challenge claims must be shared by every instance, so the application refuses to start on
  in-memory stores unless `datum.webauthn.allow-memory-stores=true` acknowledges a single instance.
- Passkeys are bound to `rp-id`: change it and every passkey stops working. The origins are exactly what a browser
  writes (`https://forms.example.org`), with no path.
- `datum.webauthn.keep-years` is for your retention job (the packages store no submissions); `label-path` names the
  answer that labels a visitor's passkey.

`PasskeysExampleIT` runs the story on the real sandbox runtime with a software authenticator: challenge, register,
unsigned refused, signed accepted, the same document answered with its first receipt, a changed document refused,
and a removed passkey refused.
