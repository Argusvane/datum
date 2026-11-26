# datum-host-tck: the Datum host test kit

The wire contract of every Datum endpoint as JUnit 5 test interfaces over a base URL, so every JVM host binding is held to the
same statuses, codes, bodies and headers. The kit speaks HTTP only and depends on no Datum library and no framework:
a binding is judged by its answers, never by code it shares with the kit.

## The contracts

| Interface | Capability | What it holds the host to |
|---|---|---|
| `SubmissionsContract` | `submissions` | story one over the kit's fixture form: the golden control documents (CTL-01 accepted with a digest, CTL-02 to CTL-04 refused with the kernel's errors), the journey check, 409 `form.outdated`, 415 `unsupported_media_type`, 413 and 400 `bad_document`, 404 `form.notFound`, the submission key: a retry of one attempt answered with the first receipt (`handled: true`), another attempt with the same answers a second record, a known key with another document 409 `submission.keyConflict` (an invalid one too: the key is answered before the document is judged), a delivery without a key 400 `bad_document` |
| `SubmissionsDryRunContract` | `submissions-test` | `POST /submissions/test` reports the golden values, as one flat report of exactly 14 members, accepted or refused |
| `FormsContract` | `forms` | the public copy (never the server-secret rule) under the key and the catalog key `id@version`, its `ETag` and the 304, 404 `form.notFound`; with the builder off (`HostTarget.builderEnabled()` false), the author's copy `?public=false` is a 404 with no `ETag` and never the server-secret rule, for a form that exists and one that does not (FRM-04 in the Node suite) |
| `AssetsContract` | `assets` | `host.json`, the immutable bundles under the build id, the glue, the builder's files following `datum.builder.enabled`, no path out of the assets |
| `PdfContract` | `pdf` | posted answers print (sealed with a test certificate when the host holds a key), refused answers do not, sign, the server's chain, verify, 404 `layout.notFound`, 415, 400 `pdf.notAPdf` |
| `TsaContract` | `tsa` | a granted RFC 3161 token over the digest and nonce, a rejection for unreadable bytes, 403 for any cookie (the default rule, a plain `a=b` included) then 415, the certificates in PEM and DER |
| `PasskeysContract` | `passkeys` | the signing block, who may ask for a challenge, the challenge's shape, the register refusals in order, a person's list, 404 for another person's passkey |
| `BuilderContract` | `builder` | only someone who may build saves (the application's security refuses 401 or 403, body unchecked), `If-Match` and 409, the kernel's 422s, id rules, 409 `form.exists` |
| `HardeningContract` | `hardening` | with the kit's hostile rule module registered for the fixture form (`TckFixtures.HARDENING_RULES`): a looping validator is cut within the budget, memory without bound and a 40 MiB answer are refused, bytes written after the answer frame refuse the run, and the next submission answers as before. A run that gave no verdict is 503 with its code (`wasm.execution_error`, `outcome_too_large`) and no `Retry-After`, on a delivery and on a journey check alike; only a verdict the kernel reached (`validator.failed`) is 422; never 200 or 500 |
| `RuntimeDownContract` | `runtime-down` | a runtime that could not prove its program (an unreadable one, or the kit's `TckFixtures.STALE_PROGRAM` below the ABI floor) answers 503 to every submission |
| `HostContextContract` | `host-context` | the host judges `host.` rules with a context it works out itself (ADR 0142), over the kit's fixture `datum-host-context` (`name` required; `admin_note` required and shown only when `host.role = "admin"`): HCX-01 header `X-Datum-Test-Role: admin` refuses `{name}` with `{field: "admin_note", code: "required"}` on the check (journey and page scope) and 422 on a delivery; HCX-02 `user` accepts; HCX-03 no header (no context) accepts, the dry run naming `admin_note` in `visibilitySkipped`; HCX-04 `user` with a document that forges `hostContext` (on the envelope and its submission), a `host` answer and an `admin_note` answer is still accepted, and the dry run's `values` hold no `admin_note` |
| `FloodContract` | `flood` | 429 `flood` with `Retry-After`, from the per-form limit (FLD-01, the refused CTL-02 document at most 120 times) and from the address limit (FLD-02, a body that does not parse at most 400 times: the address limit counts a request before its body is read); numbered last because it spends the request budget |

The hardening subset needs two test deployments: one that registers the kit's
hostile rule module for the fixture form (a `SandboxRulesProvider` answering `TckFixtures.hardeningRules()` on Spring
Boot) for `hardening`, and one started with `datum.runtime.programs.sandbox` set to the kit's stale program and
`datum.runtime.fail-fast=false` for `runtime-down`. Never register the hostile module in a deployment people use.

The `host-context` subset needs a test deployment that serves the kit's host context fixture
(`TckFixtures.HOST_CONTEXT_FORM_RESOURCE`, `META-INF/datum-tck/host-context-form.json`; on Spring Boot add
`DatumTck.HOST_CONTEXT_FORM_LOCATION` to `datum.forms.locations`), switches the dry run on, and wires a TEST-ONLY host
context provider: for `datum-host-context` only, `{"role": <value>}` when the request carries `X-Datum-Test-Role`, and no
context when it does not (on Spring Boot a `HostContextProvider` bean, as `SubmissionsHostContextIT` in the submissions
example declares it). The fixture is written by hand, not generated; the Node kit is to ship the same bytes. A client
chooses that header, so never wire such a provider where real submissions are taken.

The fixture form is the security suite's endpoint fixture (`datum-security-suite`, version 1) and the expected
verdicts are its golden file; the asset generation writes both to `target/datum-assets/datum-host-tck/` and the build puts them in the jar under `META-INF/datum-tck/`. A host under
test serves that form: on Spring Boot add `DatumTck.FIXTURE_FORM_LOCATION` to `datum.forms.locations`.

## The routes under test must be switched on

Every Datum route is off until the host enables it. A contract against a route the host never mapped
fails with the host's own 404, so the deployment under test sets the switches for the capabilities it names. On
Spring Boot (the Node kit's preflight, `datum-host-check`, names the same property when it finds a route off):

| Capability | Switches |
|---|---|
| `submissions` | `datum.web.api.endpoints.submissions=true`, `datum.web.api.endpoints.validate=true` |
| `submissions-test` | `datum.web.api.endpoints.test=true` |
| `forms` | `datum.web.api.endpoints.definition=true` (and `data-sources` for a data source) |
| `assets` | `datum.web.assets.enabled=true` (and `datum.builder.enabled=true` for the builder's files) |
| `builder` | `datum.builder.enabled=true` and `datum.web.api.endpoints.definition=true` |
| `pdf` | `datum.web.api.endpoints.pdf`, `fill`, `sign`, `verify`, `certificate` set to `true` |
| `tsa` | `datum.tsa.enabled=true` |
| `passkeys` | `datum.webauthn.enabled=true` |

The `flood` capability also needs throttle settings it can reach from one address: a per-form limit FLD-01 reaches within 120
posts and an address limit above the rest of a whole kit run that FLD-02 reaches within 400 bodies that do not parse. On
Spring Boot: `datum.web.throttle.limit=30` and `datum.web.throttle.address-limit=200` (a full kit run sends about 60 counted
requests before FLD-02). Boot a fresh deployment for it: the flood cases spend the address's budget.

The Spring examples under `integrations/jvm/examples` carry the switches they use in their `application.yml`; the CI job
boots the ui example with them passed explicitly.

## In a host's own tests

A test class implements the contracts of the capabilities it has and answers `target()`. The methods run by
`@Order`: `HostContract` declares `@TestMethodOrder(MethodOrderer.OrderAnnotation.class)`, which JUnit reads for
every implementing class, and a class that names another orderer is refused before its first test. The contracts
number theirs from 1100; a host's own tests use numbers below 1000. An own test without `@Order` runs after the
contracts and before the flood contract (`Order.DEFAULT + 9000` and `+ 9001`), so it is never throttled by it:

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
class MyFormsIT implements SubmissionsContract, FormsContract, AssetsContract {
    @LocalServerPort int port;
    @Override public HostTarget target() { return DatumTck.local(port); }
}
```

`DatumTck` comes with `datum-spring-boot-starter-test`; the Spring examples under `integrations/jvm/examples` run every
contract this way. `HostTarget` carries the paths a host changed, whether the builder is on and the server signs PDFs,
the forms the passkeys and builder contracts use, and a `RequestDecorator` that makes a request a signed-in person's
(a session cookie, a CSRF token, credentials).

## Against a deployed application

```sh
java -cp "datum-host-tck.jar:<junit-jupiter, junit-platform-launcher, assertj, jackson-databind>" \
  com.argusvane.datum.tck.HostTck \
  datum.tck.base-url=https://forms.example datum.tck.capabilities=submissions,forms,assets \
  datum.tck.person.header.Authorization="Bearer ..."
```

Keys: `datum.tck.base-url`, `capabilities`, `api-path`, `assets-path`, `tsa-path`, `webauthn-path`,
`builder-enabled`, `pdf-signing`, `pdf-bindings`, `signing-form`, `build-form`, `header.<Name>`, `person.header.<Name>`,
`other-person.header.<Name>`, `csrf`, or `--config tck.properties`. Each capability runs as its own launcher execution in a
fixed order (flood last), without reading `junit-platform.properties` or `junit.*` system properties, so a CI
setting such as a random order cannot reorder the contracts. Exit 0 when every selected contract passed and each
named capability had at least one test succeed; 1 when a test failed; 2 for a usage error, including a capability
whose every test was skipped for a missing key (`builder` without `build-form`, `passkeys` without `signing-form`).
The PDF signing tests are skipped, not passed, unless `pdf-signing=true`. The per-route test (`twoRoutesOnOneHostGetEachRoutesCatalogPdfTheme`) is skipped unless `pdf-bindings=true`: the host serves the fixture form and its copy `datum-security-suite-b` (`DatumTck.FIXTURE_FORM_B_LOCATION`), `datum.bindings.*` routes the copy to a binding whose catalog PDF theme is the kit's `datum-host-check-pdf` (`DatumTck.FIXTURE_PDF_THEME_LOCATION` as `datum.bindings.pdf-themes.datum-host-check-pdf`) and the fixture form to one with another, and each PDF names its route's theme in `X-Datum-Pdf-Theme` and is drawn under it: the theme's text colour `#123456` is in the copy's content streams and not in the fixture form's.
`datum.tck.csrf=cookie:<cookie>:<header>` (for example `cookie:XSRF-TOKEN:X-XSRF-TOKEN`, Spring Security's cookie token) is the Node
kit's `--csrf` recipe: the token cookie any earlier reply set (else the cookie of a `GET <base-url>/`) is echoed as the header on every
write and as the cookie on every request, one token per person (visitor, person, other person), so a host that guards its writes can be
judged by the kit; a host that hands out no token fails the first write by name, and a value that is not `cookie:<name>:<header>`
is a usage error (exit 2).
The submissions, builder and passkeys contracts write (a redelivered document, a saved version, a refused passkey);
run them against a test deployment.

## And the security suite

The kit proves the positive wire contract a host promises. The security suite's endpoint mode
(`packages/conformance-suite`, `datum-security-check --endpoint <url> --form datum-security-suite --profile submissions`)
complements it from the other side: it sends attack vectors (forged outcomes, smuggled journey members, oversized and
malformed bodies, replays) at the same receiving routes and reports PASS or FAIL per vector. A release runs both
against the same packaged example: the kit for "answers as specified", the suite for "refuses what it must".
