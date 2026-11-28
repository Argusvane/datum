# Datum for Spring Boot

Maven starters that add Datum's server side to a Spring Boot 4 application: the same validation program the page runs,
in a sandbox on your JVM; the form definition, the browser assets and the thin page glue; PDF rendering and signing; an
RFC 3161 timestamp server; passkey-signed submissions. Group id `com.argusvane`, Java 17 or newer, servlet
(Spring MVC) or reactive (WebFlux), found by auto-configuration. Build the reactor under [`integrations/jvm`](../integrations/jvm/README.md) and install
it locally (the build generates the browser assets and programs itself from `packages/datum/dist`; see "Building
from source" below). The design record is [ADR 0152](adr/0152-a-spring-boot-host-as-capability-modules-on-shared-jvm-libraries.md).

The packages store no submissions. The wire shapes, error codes and statuses are the endpoint catalog's
([integrations/shared/endpoint-catalog.json](../integrations/shared/endpoint-catalog.json)), and the conformance suite
([ADR 0151](adr/0151-a-security-suite-for-the-validation-gate.md)) holds the receiving routes to them.

## Two stories, three starters

Every route is off until the application switches it on: see "Switches per story" under Install for the set each
story needs; the examples carry theirs in `application.yml`.

1. **My form is on a page, and the server validates what it submits.** Add `datum-spring-boot-starter-submissions`.
   You get `POST /api/submissions/validate` (page checks of a journey or a form), `POST /api/submissions` (the full
   receive pipeline), the `SubmissionHandler` hook where your code stores the accepted submission, events, the
   throttle and the runtime. No browser assets: the page loads `datum-form.js` from wherever it likes.
2. **The renderer is on my page; load the schema from my server, submit back.** Add `datum-spring-boot-starter-ui`.
   It brings the first story and serves the form assets under a versioned path, `GET /api/forms/{key}/definition`,
   data sources and the page glue `datum-host.js`.
3. **This application is where forms are authored** (story two plus the builder): the same starter with
   `datum.builder.enabled=true`, which serves the builder bundle and the write endpoints, and a Spring Security rule
   on `DatumRequestMatchers.builderWrites()` that decides who may use them (see "Security notes").

Add `-pdf`, `-timestamp` or `-webauthn` for the other capabilities.

## Install

Import the BOM once, then add the starter you need and a web starter of your own (`spring-boot-starter-webmvc` or
`spring-boot-starter-webflux`; the Datum starters bring no web stack and map their routes on whichever one is there).

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.argusvane</groupId>
      <artifactId>datum-bom</artifactId>
      <version>0.1.0</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-spring-boot-starter-ui</artifactId>
  </dependency>
</dependencies>
```

| Starter | Adds | Story |
|---|---|---|
| `datum-spring-boot-starter-submissions` | the sandbox runtime (Endive, both runners), the programs, forms, the receiver | one |
| `datum-spring-boot-starter-ui` | submissions, the form and builder assets, the glue, the builder write endpoints (off) | two and three |
| `datum-spring-boot-starter-pdf` | PDF render, fill, sign and verify; the PDF browser assets; the timestamp client | any, plus PDF |
| `datum-spring-boot-starter-timestamp` | an RFC 3161 server and client, standalone | a timestamp server |
| `datum-spring-boot-starter-webauthn` | the passkey ceremony; signed-submission verification (brings submissions) | signed submissions |
| `datum-spring-boot-starter-test` | `@AutoConfigureDatum`, `FakeGuestRuntime`, fixture forms, MockMvc and WebTestClient helpers, `DatumTck` | tests (test scope) |

The BOM also pins the third-party libraries (Endive 1.2.0 exactly, because the compiled `Qjs` class is bound to it,
jimfs, jffi, Bouncy Castle, webauthn4j, springdoc). The submissions starter pulls both Endive runners and the runtime
picks Panama on JDK 25 and newer, JFFI below that, so there is nothing to add for the fast path; exclude the Panama
runner below JDK 25 and the JFFI runner only on JDK 25 and newer, to slim the application (Panama cannot load before
JDK 25, and with no usable native runner the start is refused unless `datum.runtime.allow-bytecode=true`). On JDK 24 and newer the JVM wants native access: an executable Spring Boot jar carries
`Enable-Native-Access: ALL-UNNAMED` in its manifest, anything else (including `spring-boot:run`) needs
`--enable-native-access=ALL-UNNAMED` in `jvmArguments` or `JAVA_TOOL_OPTIONS`, and the runtime logs one WARN when it
is missing. That WARN is best effort: it reads whether the class path's unnamed module had native access before Endive's
first runner probe, so an earlier restricted call by another library on the class path (a native transport loading its
library, say) enables access first and the WARN stays silent; the JVM's own "restricted method" warning is the
authoritative signal. Module-level detail is in [integrations/jvm/README.md](../integrations/jvm/README.md).

Every Datum **route** is off until the application switches it on: a starter on the class path registers
no route by itself, so adding a dependency never opens a door. The beans and the runtime exist (`datum.enabled=false`
removes them too); `datum.web.api.endpoints.*`, `datum.web.assets.enabled`, `datum.builder.enabled`,
`datum.tsa.enabled` and `datum.webauthn.enabled` decide which routes are mapped, and a route that is off answers the
framework's own 404 and stays free for your own controller. At start the log lists what is on (INFO, logger
`datum.web`):

```
Datum routes enabled (4):
  POST /api/submissions (datum.web.api.endpoints.submissions)
  POST /api/submissions/validate (datum.web.api.endpoints.validate)
  GET /api/forms/{key}/definition (datum.web.api.endpoints.definition)
  GET /datum/assets/** (datum.web.assets.enabled)
```

and, when nothing is on, says so and names the properties: `Datum: no Datum route is enabled; set
datum.web.api.endpoints.*, datum.web.assets.enabled, datum.builder.enabled, datum.tsa.enabled or datum.webauthn.enabled
to serve one`. A switch whose module is not on the class path lists nothing. The OpenAPI documents follow the switches:
a bare application documents no Datum route.

### Switches per story

| Story | Properties set to `true` | Routes |
|---|---|---|
| One: the form is on my page, the server validates | `datum.web.api.endpoints.submissions`, `.validate`, `.definition` | `POST /api/submissions`, `POST /api/submissions/validate`, `GET /api/forms/{key}/definition` and `/translations` |
| Two: the server also serves the form | story one plus `datum.web.assets.enabled`, `datum.web.api.endpoints.data-sources` | the bundles and `datum-host.js` under `/datum/assets`, `GET /api/data-sources/{id}` |
| Three: this application authors forms | story two plus `datum.builder.enabled` (and secure `DatumRequestMatchers.builderReads()` and `builderWrites()`) | `POST /api/forms`, `PUT /api/forms/{key}`, `PUT /api/forms/{key}/translations`, the author's copy `GET /api/forms/{key}/definition?public=false`, the builder files |
| PDF | `datum.web.api.endpoints.pdf`, `.fill`, `.sign`, `.verify`, `.certificate` (any subset) | `POST /api/pdf`, `/api/pdf/fill`, `/api/pdf/sign`, `/api/pdf/verify`, `GET /api/server/certificate` |
| Operators | `datum.web.api.endpoints.test`, `.inspect` | the dry run `POST /api/submissions/test`, the kernel's `POST /api/inspect` |
| Timestamp server | `datum.tsa.enabled` | `POST /tsa`, `GET /tsa/certificate`, `/tsa/certificates` |
| Passkeys | `datum.webauthn.enabled` (with its relying party) | `/api/webauthn/*` |

For example, story two in `application.yml`:

```yaml
datum:
  web:
    assets:
      enabled: true
    api:
      endpoints:
        submissions: true
        validate: true
        definition: true
        data-sources: true
```

## Configuration

Every property is in the starters' configuration metadata, so an IDE completes it. The defaults below are read from the
`*Properties` classes.

Datum's auto-configurations are `public final` classes with package-private nested and imported configurations, as Boot's are:
they are not API to extend or `@Import`. A test or an application that lists auto-configurations by hand lists the ones it
means; the builder's routes are built over the `BuilderService` bean, so a list with `DatumBuilderAutoConfiguration` also
lists `DatumBuilderServiceAutoConfiguration` (the start stops at the missing bean otherwise).

**A value that cannot work stops the start**, naming the property, as every Spring Boot setting does, and prints as a Description and an Action
(Boot's `FailureAnalyzer`s: the general one for Datum's refusals in `datum-spring-web`, the engine-selection one in `datum-sandbox-spring`) instead of a nested stack trace. Datum's refusals are
`DatumConfigurationException`s (an `IllegalArgumentException` from `datum-core`: `property()`, `problem()`, `action()`), and
a misnamed engine is the `EngineSelectionException` with its own analyzer:

```
Description:

datum.runtime.engine is "endvie", and no engine can be used for it: No engine has the id "endvie"; engines found: endive (available).

Action:

Set datum.runtime.engine to the id of one of the engines found, add the jar of the engine you want (datum-sandbox-endive is the
default, and the submissions starter brings it), or define a GuestRuntime bean of your own.
```

A refusal never carries a secret (a short key is reported by its length). The same words are checked wherever the value is
built, not only on the property path: `HostOptions`, the PDF `fonts` and `certify` words and the passkey signing words
(`FormSigning`) refuse an unknown word instead of reading it as the default, so an application's own bean with a typo stops
too. Boot's relaxed enum binding does the same for the enum properties: a word that is no
member of an enum (`datum.host.*`, `datum.pdf.fonts`, `datum.pdf.seal.certify`, `datum.webauthn.mode` and its siblings,
`datum.web.throttle.by`), a time zone that is no zone id, a size or duration Boot cannot read, a bound that is not met (a
throttle `limit` below 1, a `max-body-size` or `max-definition-size` below one byte, a `datum.webauthn.window` under a
second, a `datum.forms.*` count below 1). Nothing falls back to a default silently. The exceptions are the run budgets,
documented safety clamps (see "Runtime and host options"): they keep their bounds and the WARN.

### Web (`datum.web.*`, root `datum.enabled`)

| Property | Default | |
|---|---|---|
| `datum.enabled` | `true` | master switch |
| `datum.web.api.path` | `/api` | where the JSON endpoints live |
| `datum.web.api.max-body-size` | `1MB` | counted on the raw stream before parsing (413 over it); at least `1B` |
| `datum.web.api.problem-details` | `false` | answer errors as RFC 9457 `application/problem+json` with the same codes |
| `datum.web.api.busy-retry-after` | `5s` | the `Retry-After` of a 503 `server.busy`; whole seconds, `1s` to `1h` (anything else stops the start) |
| `datum.web.api.endpoints.<name>` | `false` | per-endpoint switch, every one off until set: `submissions`, `validate`, `test`, `inspect`, `definition`, `data-sources`, `pdf`, `fill`, `sign`, `verify`, `certificate` |
| `datum.web.assets.enabled` | `false` | serve the bundles from the class path (the asset routes are endpoints too) |
| `datum.web.assets.path` | `/datum/assets` | files are at `{path}/{buildId}/...`; `host.json` and `datum-host.js` sit at `{path}/` |
| `datum.web.assets.cache-period` | `365d` | `max-age` of the immutable asset responses; not negative |
| `datum.web.assets.omit-features` | none | feature tokens whose files answer 404 (ADR 0143) |
| `datum.web.csrf.header-name` / `cookie-name` / `meta-name` | `X-XSRF-TOKEN` / `XSRF-TOKEN` / `_csrf` | the names the glue reads |
| `datum.web.throttle.enabled` / `limit` / `window` / `by` | `true` / `60` / `1m` / `ip, form` | the default throttle; `limit` is at least 1, `window` longer than zero, `by` takes `ip`, `form`, `principal` (anything else stops the start); `ip` counts an IPv6 client by its /64 and an IPv4-mapped address as its IPv4 address |
| `datum.web.throttle.address-limit` | `600` | requests per window for one address on every throttled route, counted after the `Content-Type` check and before the body is read (so a body that does not parse still counts), in its own key space with the same window, storage and `max-keys`; `0` turns it off, a negative value stops the start. Binding-level: your own `SubmissionThrottle` bean counts no address unless it implements `checkAddress` and `recordAddress` |
| `datum.web.throttle.limits.<kind>` | none | the development throttle's own limit for a route kind (`submit`, `validate`, `test`, `pdf`, `register`), at least 1; a kind not listed uses `limit`. Binding-level: your own `SubmissionThrottle` bean ignores it |
| `datum.web.throttle.max-keys` | `10000` | the most windows the development throttle holds (16 to 10,000,000); when full the expired ones go first, then a sixteenth of the live windows, one at a time from the caller (address and principal) holding the most: its window with the fewest attempts first, the newest among equals |
| `datum.web.openapi.enabled` / `group-prefix` | `true` / `datum-` | springdoc groups |

### Forms and builder

| Property | Default | |
|---|---|---|
| `datum.forms.locations` | `classpath:/datum/forms/*.json` | where the default repository reads definitions (see "The forms files") |
| `datum.forms.snapshots.max-entries` | `500` | the in-memory snapshot store's bound |
| `datum.forms.snapshots.public-copy-cache-size` | `256` | public copies kept, by definition hash |
| `datum.forms.data-sources.timeout` / `max-threads` | `15s` / `16` | one provider call, and calls in flight (the pool is the bean `datumDataSourceExecutor`, see "Beans the binding takes from you") |
| `datum.forms.too-costly-memory` | `300s` | how long a definition the kernel could not check in time is refused without another run; `1s` to `1h` |
| `datum.forms.cache.definition` | `no-store` | the `Cache-Control` of a definition answer (the current definition, and a full copy asked with `public=false`, even by hash) |
| `datum.forms.cache.snapshot` | the `definition` value (`no-store`) | the `Cache-Control` of the **public copy** of a version asked by hash (`?sha256=`). Opt in to a cacheable value (for example `public, max-age=3600`) only when the read routes are unauthenticated: a shared cache may then keep the answer, and the kernel can change a public copy's bytes under the same hash after an upgrade, so do not use `immutable`. A blank value or one with a line break stops the start |
| `datum.builder.enabled` | `false` | serve the builder bundle, register `POST /api/forms`, `PUT /api/forms/{key}`, `PUT /api/forms/{key}/translations`, and serve the author's copy (`GET /api/forms/{key}/definition?public=false`; off, it is a 404) |
| `datum.builder.max-definition-size` | `1MB` | the largest definition a save reads (413 over it); `1B` to `64MB` |

### Runtime and host options

| Property | Default | |
|---|---|---|
| `datum.runtime.engine` | `endive` | the engine that runs QuickJS, by its provider's id (see [Engines](#engines)); an id no engine on the class path has, or one unavailable here, stops the start |
| `datum.runtime.fail-fast` | `true` | a runtime that cannot prove its programs stops the context; with `false` health is DOWN and every run answers 503 until a recheck passes |
| `datum.runtime.allow-bytecode` | `false` | whether the context may start when the engine runs the programs as JVM bytecode (no native code for the platform, or no native runner it can use). `false` stops the start with `EngineBytecodeException`, whatever `fail-fast` says; `true` starts as before: a WARN, validation several times slower, the PDF routes 503, `engineMode: bytecode` on health. See [Engines](#engines) |
| `datum.runtime.warm-up-runs` | `3` | smoke runs at start (a negative value stops the start) |
| `datum.runtime.shutdown-grace` | `10s` | how long a shutdown waits for runs in flight (negative stops the start). The runtime stops after the web server's drain (its lifecycle phase is below `WebServerGracefulShutdownLifecycle`'s), and `stop()` is synchronous and bounded by this value, not by `spring.lifecycle.timeout-per-shutdown-phase` |
| `datum.runtime.startup-budget` | `30s` | wall time of the proof runs at start and recheck |
| `datum.runtime.stop-grace` / `max-strays` | `5s` / `0` | the engine's own settings (an `EngineSettings` bean of yours replaces both): how long a stopped run's thread is given to end and close its instance, and how many stopped runs may outlive that before new runs are refused; `0` strays is one per CPU, at least two. Raise the grace on a slow host or an engine with slow set-up; a negative value stops the start |
| `datum.runtime.validation.time-limit` / `memory` / `concurrency` / `wait` | `5s` / `32MB` / `0` / `2s` | one validation run; `0` slots is one per CPU, up to 64; `wait` is the wait for a free slot before 503 `server.busy`. The same slots cover the kernel's inspect and check runs and the public copy of a definition, so a builder save, an inspection and a public definition read wait for one too |
| `datum.runtime.pdf.time-limit` / `memory` / `concurrency` / `wait` | `15s` / `256MB` / `0` / `2s` | one PDF run; `0` slots is the smaller of 2 and the CPUs |
| `datum.runtime.verify-max-bytes` | `20MB` | the largest PDF the verify route reads (413 over it); clamped to `1MB` to `100MB` with the WARN of the other budgets |
| `datum.runtime.programs.sandbox` / `pdf` | the packaged programs | a `file:` or `classpath:` program used instead; still proved by the ABI probe |
| `datum.runtime.diagnostics.*` | trace `off`, report `true`, capture `false` | the run trace, the settings report and the failed-run capture: seven keys, in [Diagnostics](#diagnostics). A capture writes personal data to disk |
| `datum.host.formula-errors` | `fail` | what a formula that cannot be evaluated does (`fail` or `warn`, ADR 0142) |
| `datum.host.risky-patterns` | `refuse` | a regular expression that repeats a repeat: `refuse` or `allow` |
| `datum.host.time-zone` | the JVM's | the zone `today()` and date rules read in, a zone id such as `America/Toronto` |
| `datum.host.unknown-fields` | `strip` | an answer with no component: `strip`, `keep` or `reject` |
| `datum.host.log-level` | `warn` | how much of a run's log the program keeps (`off` to `debug`, ADR 0050) |
| `datum.submissions.idempotency.memory-size` | `10000` | the receipts the in-memory idempotency store (no `DataSource`) remembers; 16 to 10,000,000 |

The `datum.host.*` words are enums, bound the relaxed way (`Reject`, `REJECT` and `reject` are one word); a word outside
the set stops the start. The zone is read as a zone id by the library: a bad id stops the start, and an empty value is the
JVM's zone. The budgets, slots and the wait are the one place a value is clamped
instead: they are clamped to `ProgramLimits`' documented bounds (a time limit of 1 to 60 s for validation, 1 to 300 s
for PDF, memory within its range, at most 64 slots, a wait of 0 to 10 s, a start-up budget of 1 s to 5 min, whole
seconds), and a value used other than as set is logged once at WARN naming the property. The runtime's output caps (32 MiB
stdout, 64 KiB stderr, 8 MiB outcome) are not configurable.

### PDF, timestamp, passkeys

| Property | Default | |
|---|---|---|
| `datum.pdf.enabled` / `fonts` | `true` / `default` | `default` (Sans and Sans Bold), `standard` (five faces), `all` (seven) |
| `datum.pdf.signing.ssl-bundle` | none | the server's signing key, as a Spring Boot SSL bundle (`spring.ssl.bundle.jks.<name>` or `.pem.<name>`); see "Signing keys" |
| `datum.pdf.signing.retired-certificates` / `trust-anchors` | none | PEM resources: earlier server certificates; anchors that make a signer or timestamp authority "trusted" |
| `datum.pdf.signing.tsa.url` / `timeout` / `bearer-token` / `basic-user` / `basic-password` | none / `10s` | a named timestamp server for seals (the timeout is at least `1s`); empty uses the in-process authority when it is on |
| `datum.pdf.signing.tsa.policy` | none | the `reqPolicy` object identifier every request to that server asks for (for a server that issues under several policies); unset asks for none. A value that is no object identifier stops the start |
| `datum.pdf.signing.tsa.ssl-bundle` | none | the SSL bundle for the TLS connection to that server (its trust store checks the server, its key store presents a client certificate); see "Outbound HTTP" |
| `datum.pdf.seal.enabled` / `layouts` / `certify` / `timestamp` / `reason` / `location` / `visible` | `false` / all / `noChanges` / `true` | the seal on PDFs the application issues; `certify` is `noChanges`, `formFill`, `annotate` or `none` |
| `datum.pdf.seal.posted-answers` | `false` | seal PDFs of posted, unstored answers with the server's key too (off: a throwaway certificate seals them) |
| `datum.bindings.default` | `datum` | the design-system binding a form route without an override is drawn by: an id of the catalog (the bundles' `datum` and the `catalog` entries below). An id the catalog does not list stops the start. A dark Datum form is the element's `scheme` attribute, not a binding |
| `datum.bindings.routes.<form-key>` | none | a per-route override: the form key and the binding it is drawn by. The host knows it from here, never from the definition; `host.json`'s `bindings` publishes the table to the page glue |
| `datum.bindings.catalog.<id>.label` / `pdf-theme` | none | adds a binding the application registers on its pages, with the PDF theme a PDF of its routes prints under. The bundles' `datum` suggests `datum-pdf`, the engine's own |
| `datum.bindings.pdf-themes.<pdf-theme-id>` | none | the JSON object (`target: "pdf"`, the same `id`) of every suggested PDF theme but `datum-pdf`, as a Spring resource. A PDF of a route carries its binding's theme object as the request's host theme, below the render call's and the layout's own; nothing is written into a layout. The reply names it in `X-Datum-Pdf-Theme`: the theme the route's binding suggests, which a render call's or a layout's own theme still outranks in the drawing. A suggested theme nobody supplies stops the start |
| `datum.tsa.enabled` | `false` | the RFC 3161 server |
| `datum.tsa.path` | `/tsa` | `/certificate` and `/certificates` hang below it |
| `datum.tsa.access` | `clients` | `clients` (a key listed under `clients` or in the table) or `open` |
| `datum.tsa.client-store` / `clients` | `properties` / none | `properties` (SHA-256 hashes in configuration) or `jdbc` (the `datum_tsa_client` table) |
| `datum.tsa.policy` / `accuracy` / `max-request-size` | Datum default / `1s` / `16KB` | policy OID, stated accuracy, the largest request |
| `datum.tsa.accepted-policies` | the issuing policy | further policy OIDs a request may ask for with `reqPolicy`; the token then names the policy asked for, and the issuing policy is always accepted. Any other is an `unacceptedPolicy` rejection that lists the accepted ones |
| `datum.tsa.flood.limit` / `window` | `1000` / `1h` | tokens per window per client or address (an IPv6 client counted by its /64); `0` turns it off, a negative limit or a window under `1s` stops the start |
| `datum.tsa.flood.failed-keys` | `10` | wrong client keys one address (an IPv6 client by its /64) may present per hour before it is answered 429 with `Retry-After: 3600`; 1 to 10,000 |
| `datum.tsa.signer.ssl-bundle` | none | the signing key, as a Spring Boot SSL bundle; see "Signing keys" |
| `datum.tsa.signer.self-signed` | `false` | a throwaway certificate made at start: development only; not together with `ssl-bundle` |
| `datum.tsa.retired-certificates` / `session-cookies` | none / `*` | earlier certificates for `/certificates` (a location each; a bare path, a Windows drive path included, is a file, for the PDF verifier too); cookie names that make a request a browser's (refused 403; the default `*` refuses any cookie, a list of names only those, case-insensitively; a name in `server.servlet.session.cookie.name` or `server.reactive.session.cookie.name` is added to a list, and is redundant beside `*`) |
| `datum.tsa.allow-memory-stores` | `false` | see "Memory-store policy" |
| `datum.webauthn.enabled` | `false` | passkeys |
| `datum.webauthn.rp-id` / `rp-name` / `origins` | empty | the relying party and the exact origins a client may write; nothing is derived from the Host header |
| `datum.webauthn.path` | `/api/webauthn` | the ceremony endpoints |
| `datum.webauthn.anonymous` / `register-at-submit` | `false` / `true` | who may make passkeys |
| `datum.webauthn.test-roles` | empty (nobody) | the Spring Security roles that may make a passkey in a form's Test context (see "Security notes") |
| `datum.webauthn.window` / `challenge-ttl` | `600s` / `300s` | how long a signature may take to arrive; a registration challenge's life (10 s to 1 h) |
| `datum.webauthn.resident-key` | `required` | the `residentKey` requirement a registration asks the authenticator for: `required`, `preferred` or `discouraged` |
| `datum.webauthn.challenge-skew` | `60s` | how far ahead of this server's clock a challenge's issue time may be (a challenge made on another server); `0` to `5m` |
| `datum.webauthn.signed-at-skew` | `60s` | how far apart the two signing times a signature carries may be; `0` to `10m` |
| `datum.webauthn.anonymous-grace` | `24h` | how long an anonymous passkey that signed nothing is kept before the purge removes it; `1h` to `30d` |
| `datum.webauthn.passkeys` | `site` | passkeys sign for every form (`site`) or only the one they were made on (`form`) |
| `datum.webauthn.secret` | made at start | HMAC key of challenges, at least 32 bytes, the same on every instance |
| `datum.webauthn.mode` / `scope` / `placement` / `user-verification` / `statement` / `verify` / `unavailable` | `off` / `envelope` / `embedded` / `preferred` / empty / `true` / `refuse` | form defaults; `forms.<key>.*` overrides them per form (a key with a dot is written `forms[my.form].mode`) |
| `datum.webauthn.label-path` / `keep-years` | empty / `0` | the answer that names a passkey; years signed submissions are kept at least (0 to 100; outside stops the start) |
| `datum.webauthn.allow-memory-stores` | `false` | see "Memory-store policy" |

Unknown members under `datum.webauthn` are refused at start, so a typo cannot leave a form unsigned.

Anonymous passkeys that signed nothing are deleted after `datum.webauthn.anonymous-grace` (a day by default). When the application has exactly one Spring `TaskScheduler` (it
enables scheduling with `@EnableScheduling`, or defines the bean; two with none primary count as none), the binding purges them hourly in bounded batches;
without one, each anonymous registration purges a batch, so the rows still go.

### Beans the binding takes from you

Where Spring already does a job, Datum takes its tool and does not build a private one. Each of these is optional.

| You define | Datum uses it for |
|---|---|
| a `Clock` bean | every time the binding reads: the definition service's too-costly memory, the JDBC snapshot, idempotency, serial and client stores, the builder's saves, the timestamp server's default time source, the passkey ceremony, the PDF service and the ABI gate's memory of a failed PDF program. Without one, the system clock |
| a bean named `datumDataSourceExecutor` (any `Executor`, such as a `TaskExecutor`) | the data-source calls. Datum's own pool is kept in a holder that is not an `Executor` bean, so adding the forms starter leaves Boot's `applicationTaskExecutor` and your `@Async` default alone. The default is built from Boot's `ThreadPoolTaskExecutorBuilder`, so your `spring.task.execution.*` settings, `TaskDecorator` and `ThreadPoolTaskExecutorCustomizer` beans apply; Datum's shaping runs after them and holds whatever they set: a pool of at most `datum.forms.data-sources.max-threads` daemon platform threads, no queue, that refuses past it (a hung provider can hold that many and no more). Boot's virtual-thread switch does not reach it. A pool you name is yours to size and to stop, and `max-threads` is then not read |
| exactly one `reactor.core.scheduler.Scheduler` bean (WebFlux) | where the blocking calls of every Datum handler run (the public copy's kernel run, a data source, a submission, a PDF render, the builder's saves, the timestamp server, passkeys, the asset class path lookup). Without one, `Schedulers.boundedElastic()`. With two and none primary, the elastic scheduler |
| a `PdfFonts` bean | the font faces a PDF request carries; `datum.pdf.fonts` still picks the pack (`default`, `standard`, `all`). The default is DejaVu from `datum-programs` |
| a `GrantedAuthorityDefaults` bean | the role prefix `datum.webauthn.test-roles` is matched under (`FORM_ADMIN` is `ROLE_FORM_ADMIN` by default, `APP_FORM_ADMIN` under `new GrantedAuthorityDefaults("APP_")`, and `FORM_ADMIN` under `""`; the bare name is always accepted as an authority) |
| a `TsaTransport` bean, `RestClient.Builder` customisers | the timestamp client's HTTP, see "Outbound HTTP" |
| an `EngineSettings` bean | what the engine is created with besides the limits (stop grace, stray bound); the binding builds one from `datum.runtime.stop-grace` and `max-strays`. An application that builds the `GuestRuntime` itself passes its own to the provider |
| a `DataSource` marked `@DatumDataSource` | the database of every Datum JDBC store, see "Storage" |
| a `JdbcSchemaInitializer` bean | replaces the one that makes the modules' tables (`datum.jdbc.initialize-schema`), see "Storage" |

**Every bean is replaceable.** The settings records (`WebSettings`, `FormsSettings`, `SandboxSettings`,
`UiSettings`, `PdfSettings`, `TsaSettings`, `PasskeySettings`, `WebAuthnSettings`), the services under the routes
(`SubmissionService`, `BuilderService`; the receiver and `BuilderApi` are built over yours, see "Using the engine without
HTTP") and the facades (`FormsApi`, `SubmissionsApi`, `BuilderApi`, `PdfApi`, `PasskeysApi`, `TsaEndpoint`) are
`@ConditionalOnMissingBean`: a bean of yours
of the same type is used and the properties that would have built it are not read (the one exception is the endpoint
switches, `datum.web.api.endpoints.*` and the `enabled` switches, which are conditions on the property itself and so are
always the property's; the other is the PDF binding's network side: the TSA transport is built from `datum.pdf.signing.tsa.url`, `ssl-bundle` and `timeout`, and the signing key's `datum.pdf.signing.ssl-bundle` is read from the properties, so a `PdfSettings` bean of yours carries the rest of the signing and seal settings but those two are replaced by your own `TsaTransport` and `PdfSigner` beans). The plumbing that makes the wire the
same on both stacks is deliberately not replaceable, because replacing it would change the wire contract: the JSON mapper,
the error mapper, the asset service and the asset routes, the capability list, the health contributors, the OpenAPI and
route registries, the method rules, the exception handlers, the meters, the info contributor and the builder's file gate.
Reach those through their hooks instead: `ErrorTranslator`, `WithheldAssets`, `MeterFilter`, and the properties above. The
capability list and the health contributors collect beans (`DatumCapability`, `DatumHealthCheck`) each module declares on its
own, so replacing a facade or the runtime keeps the start-up notice, `info.datum` and health true; the TSA and passkey
health states (`TsaHealth`, `WebAuthnHealth`) and the `datumEventPublisher` are replaceable.

### Signing keys

The PDF signer and the timestamp server read their private key from a Spring Boot **SSL bundle**, the framework's own way to
locate, type and unlock key material. Define the bundle, name it:

```yaml
spring:
  ssl:
    bundle:
      jks:
        pdf-signer:
          keystore: { location: "file:/etc/datum/pdf-signer.p12", password: "${PDF_KEYSTORE_PASSWORD}", type: PKCS12 }
          key: { alias: server }          # optional when the store holds one key; key.password when it differs
      pem:
        tsa:
          keystore: { certificate: "file:/etc/datum/tsa.crt", private-key: "file:/etc/datum/tsa.key" }
datum:
  pdf.signing.ssl-bundle: pdf-signer
  tsa.signer.ssl-bundle: tsa
```

The key is the bundle's `key.alias` entry (the only key entry when none is named), unlocked with `key.password`, else the key
store's password. A bundle that does not exist, holds no key store, or holds no private key stops the start with a message
naming `datum.pdf.signing.ssl-bundle` or `datum.tsa.signer.ssl-bundle`, never a password.

The key is read once, at start. Datum registers no bundle update handler, so Boot's `reload-on-update` does not swap a
renewed key into a running server: replacing the files takes a restart. List the certificate you replaced in
`datum.pdf.signing.retired-certificates` or `datum.tsa.retired-certificates`, so the seals and tokens it made still verify
as the server's own.

The bundle is the only way Datum reads a signing key from configuration; an application that keeps its key elsewhere (a
vault, an HSM) supplies its own `PdfSigner` or `TsaKeyMaterial` bean. The PEM resources (`retired-certificates`,
`trust-anchors`) are certificates, not keys, so they stay plain resource properties.

### Outbound HTTP

The only outbound HTTP call in the JVM code is the PDF module's request to a named timestamp server
(`datum.pdf.signing.tsa.url`). It goes through a `TsaTransport` (`libs/datum-timestamp`): one POST answered with the status,
the content type and the bytes. The binding supplies one, `@ConditionalOnMissingBean`:

- When the application has a `RestClient.Builder` bean the request rides **`RestClient.Builder`**. In a servlet application
  Boot auto-configures it with `spring-boot-starter-restclient` (the pdf starter brings it): every `RestClientCustomizer` you
  declare applies (headers, interceptors, observation and metrics), and so do the request factory's choices from
  `spring.http.client.*` (client library, proxy, connect and read timeouts; set a read timeout, it ends a stuck call). In a
  **reactive** application Boot configures no `RestClient.Builder`; declare a prototype `RestClient.Builder` bean to opt in
  (what it sets reaches the server; the factory is the one `ClientHttpRequestFactoryBuilder.detect()` picks, with default
  settings). Two things are Datum's either way: the factory never follows a redirect, whatever `spring.http.client.redirects`
  says (a bearer token or Basic credential goes only to the URL named), and `datum.pdf.signing.tsa.ssl-bundle` is the TLS bundle
  for this connection. The call runs on a thread of its own, one per call, from Boot's `SimpleAsyncTaskExecutorBuilder` (a
  virtual thread under `spring.threads.virtual.enabled`; your `TaskDecorator` beans run around it), never a bounded pool a
  stalled call could queue behind; it is abandoned at the TSA timeout and ended by the read timeout, and it carries the
  caller's MDC and current observation, so the client's `http.client.requests` observation is a child of the seal. A concurrency limit you set for Boot's simple executors does not apply to it.
- Without a builder bean the **JDK `HttpClient`** carries the request, with the bundle's `SSLContext` when `tsa.ssl-bundle` is
  set.
- Define your own `TsaTransport` bean to replace both, or a whole `Timestamper` bean to replace the client: the binding
  consults an application `Timestamper` before it builds its own, so then no client is made and `datum.pdf.signing.tsa.url`
  is not used (see "Timestamps, trust and sandbox runs").

For a host that is not Spring, `JdkTsaTransport` takes the JDK's own knobs: `new JdkTsaTransport(HttpClient.newBuilder()
.proxy(...).sslContext(...).executor(...).authenticator(...).followRedirects(Redirect.NEVER).build())` (a client that follows
redirects is refused), passed to `new TimestampClient(url, timeout, credentials, transport)`.

### Storage

Plain-SQL scripts for the JDBC stores ship under `META-INF/datum/db/migration/{h2,postgresql,mysql}/` and are Flyway and
Liquibase compatible; their versions are unique across modules so one location can hold them all: `V100__datum_forms.sql`
(definition snapshots), `V200__datum_submissions.sql` (accepted-submission digests), `V300__datum_timestamp.sql` (the TSA
log and clients), `V400__datum_webauthn.sql` (passkeys, uses, challenge claims). With Flyway:

```yaml
spring:
  flyway:
    locations: classpath:META-INF/datum/db/migration/{vendor}
```

**Making the tables without a migration tool.** `datum.jdbc.initialize-schema` is Spring Session's setting for the same
need: `embedded` (the default) runs a module's script when its JDBC store starts and the database is an embedded in-memory one
(H2, HSQL, Derby), so a development or test application gets the tables with no script of its own; `always` does it in any
database; `never` leaves the schema to you (set it with Flyway or Liquibase, and in production). The script runs only when the
module's first table is missing (the scripts are not idempotent), after Flyway, Liquibase and `spring.sql.init`, so tables
made any other way are never made twice and `always` is safe to leave on; that is the one difference from Boot's `always`. A
database other than H2, PostgreSQL, MySQL or MariaDB has no script and is refused with `never` as the way out. The
persistent database's schema stays the application's decision: nothing here creates a table in one unless you say `always`.

A JDBC store is chosen when the application has a `DataSource` to give it and `spring-jdbc` on the classpath (any JDBC or JPA
starter brings it). The `DataSource` is the one marked **`@DatumDataSource`** (or a bean named `datumDataSource`) when there is
one, else the application's single or `@Primary` one, as Flyway's `@FlywayDataSource` and Spring Session's
`@SpringSessionDataSource` choose theirs:

```java
@Bean @DatumDataSource
DataSource datumDataSource() { ... }   // every Datum JDBC store, whatever @Primary is
```

With two plain data sources and none marked, the stores fall back to memory with their WARN (or define the store beans
yourself). The stores are the Spring bindings' own, written on
`JdbcClient` and `TransactionTemplate` with Spring's exception translation (a duplicate key is `DuplicateKeyException`,
a refused value `DataIntegrityViolationException`); the libraries hold only the SPIs, the in-memory stores and the
scripts. Without a `DataSource` the in-memory defaults apply, with the policy below. The shipped PostgreSQL and MySQL
scripts run against real PostgreSQL and MySQL in the `containers` Maven profile (see "Tests on real databases").

The transaction rule: every store call is a transaction of its own (`PROPAGATION_REQUIRES_NEW`) and never joins yours.
A call made while your transaction is open runs on another connection and commits on its own, so a remembered receipt,
a claimed challenge or a timestamp serial (taken before signing) stays when your transaction rolls back, and a serial
is never reused. The passkey replay guard takes its row lock (`SELECT ... FOR UPDATE`), checks and moves the counter
inside one such transaction. The transaction manager is yours when it is your only one and a JDBC manager of the
stores' `DataSource` (Spring Boot's `JdbcTransactionManager`, any `DataSourceTransactionManager`). Every other case, a
JPA or Hibernate manager, a JTA manager, one of another database, or several managers, gets a `JdbcTransactionManager`
of the stores' own on connections no other manager binds to the thread. Never JPA's: a new JPA transaction begins on
the entity manager open-in-view bound to the request, and its commit would flush your unsaved entity changes; and a
JDBC manager over the same key would take the connection JPA bound for your transaction and commit your flushed work
with the store's. Nothing is lost: each store call is a transaction of its own either way. To use another manager, or a
store of your own over a database, define the store bean yourself (the classes are public: `JdbcDefinitionSnapshotStore`,
`JdbcSubmissionIdempotencyStore`, `JdbcTsaSerialAllocator`, `JdbcTsaLog`, `JdbcTsaClientStore`,
`JdbcPasskeyRepository`, `JdbcPasskeyUseStore`, `JdbcChallengeClaims`, each built from `DatumStoreJdbc.of(dataSource,
transactionManager)`).

**XA and JTA.** The stores take a connection from the `DataSource` they were given and run their own local transaction on it; they never touch a transaction manager. Whether that connection joins a JTA transaction is the pool's rule, not the store's. A plain pool (Hikari, the Boot default) joins nothing, so a store call made inside your JTA transaction commits on its own and survives its rollback, as above. A JTA-aware pool (an XA data source under Atomikos, Narayana or a container's transaction manager) is expected to enlist every connection it hands out while a global transaction is open on the thread, and an enlisted connection is expected to take no local commit, so a store call made inside a JTA transaction against an XA data source should fail (the commit refused, nothing written). That failure is the documented behaviour of enlisted connections, **not observed here against a real transaction manager**: `DatumStoreJdbcTest` encodes it with a stub pool that refuses the local commit, which shows what the store does when the commit is refused and nothing about Atomikos or Narayana. Call the stores outside the global transaction (the Datum routes run on request threads, outside your transactions unless a filter opens one), or define the store beans over a non-XA `DataSource` of the same database (`DatumStoreJdbc.of(plainDataSource)`).

## SPIs

Each is a bean the application defines; the default is used when none exists. Hooks marked ordered are collected from
every bean.

| SPI | Package | Default | |
|---|---|---|---|
| `SubmissionHandler` | `submissions.spi` | logs the form and digest (never the answers), stores nothing and answers a fresh UUID, with a startup WARN | where accepted submissions are stored: `handle(AcceptedSubmission) -> SubmissionReceipt{id, reference, receipt}` |
| `FormDefinitionRepository` | `forms` | read-only, over `datum.forms.locations` | `find`, `save`, the conditional `save(definition, expectedSha256)` (refuses with `FormOutdatedException` when the stored hash is not the one given), `current`; implement it to store forms in a database |
| `DefinitionSnapshotStore` | `forms.snapshot` | bounded in memory with a WARN; JDBC when a `DataSource` exists | the versions a submission is judged against, by hash |
| `TranslationCatalogStore` | `forms.translation` | in memory; the start-up report WARNs when the builder is on, because the authors' translations are lost on a restart | the builder's translation grid |
| `DataSourceProvider` (ordered when there are several) | `forms.datasource` | none (404) | option lists and values a form loads (`GET /api/data-sources/{id}`). Several beans (separate modules each contributing a source) are asked in turn, in the framework's order, and the first whose `exists(id)` is true answers; override `exists` in each (the default answers true for every id, and the start-up report WARNs for a provider that keeps it); one bean, or one `@Primary`, is used alone as before |
| `SubmissionPreCheck` (ordered) | `submissions.spi` | none | refuse before the sandbox runs (anti-spam, quotas); sees `IncomingSubmission{formKey, mode, context}`, the context's channel, principal, client facts, headers and body digest |
| `SubmissionValidator` (ordered) | `submissions.spi` | none | host-side validation after the kernel's |
| `SandboxRulesProvider` (ordered) | `submissions.spi` | none | host rule modules for a form: `rules(formKey, definition, SubmissionContext)` |
| `SandboxContextContributor` (ordered) | `submissions.spi` | none | add to the run's context: `contribute(ContextBuilder, SubmissionContext)` |
| `HostOptionsCustomizer` (ordered) | `submissions.spi` | none | adjust the run settings per form: `customize(formKey, definition, RunSettings, SubmissionContext)` |
| `HostContextProvider` (one bean) | `submissions.spi` | none: no run carries a `hostContext`, and a rule reading `host.` is left unjudged (ADR 0142) | the values the form's `host.` names read, worked out from the request, never from the body: `hostContext(HostContextRequest{formKey, formVersion, mode, submission}) -> Optional<Map>`; see "The host context" |
| `DefinitionCustomizer` (ordered) | `forms` | none | adjust or refuse the public copy on its way to a filler (per-tenant defaults, hidden components); see "Lifecycle and hooks" |
| `BuilderSaveCustomizer`, `BuilderSaveValidator` (ordered) | `ui.builder` | none | adjust or refuse a definition before the kernel's check; judge it after the verdict, before the store |
| `PdfResultValidator` (ordered) | `pdf` | none | judge a PDF after the program made it, before its bytes leave (page-count, size policy) |
| `TimestampRequestCustomizer` (ordered) | `timestamp` | none | refuse a client, choose the policy among the accepted ones, state another accuracy, before a token is signed |
| `RegistrationCustomizer`, `RegistrationValidator` (ordered) | `webauthn` | none | the passkey ceremony's per-request policy (label, stricter user verification or resident key, refuse); judge a verified passkey before it is stored (AAGUID allow-list, attestation format) |
| `SignatureCheckCustomizer` (ordered) | `webauthn` | none | the signing ceremony's per-form policy, before a submission's assertion is verified: refuse by signer or passkey, require user verification, shorten the signing window |
| `PreCheckStatuses` | `submissions.receiver` | 403 for every code (`standard()`); `bySuffix()` to opt into 422 `.invalid` and 503 `.unavailable` | the HTTP status of a pre-check's refusal (the refusal itself names a code and words only); a mapping may answer 429, but with no `Retry-After` (a rate limit belongs in `SubmissionThrottle`) |
| `SubmissionThrottle` | `submissions.spi` | in memory, one per instance (the binding's development default) | `check` and `record` by a `ThrottleKey{ip, formKey, principal, kind, channel}`; see "Rate limiting" |
| `SubmissionIdempotencyStore` | `submissions.spi` | in memory; JDBC with a `DataSource` | keyed by form, version and submission key: a retried attempt is answered with the first receipt, a known key with another digest is 409 `submission.keyConflict` |
| `SubmissionSignatureCheck` | `submissions.spi` | none; provided by `-webauthn` | the signature seam of the receiver |
| `TsaTimeSource` | `timestamp` | the application's `Clock` (the system clock), always available | where the timestamp server gets "now" and whether it may trust it; see "Time source" |
| `PdfRequestCustomizer` (ordered), `PdfSigner`, `PdfTemplateSource`, `PdfDocumentSources` | `pdf`, `pdf.api` | the key store signer | PDF requests, the signer, template bytes, translations and option snapshots |
| `ErrorTranslator`, `WithheldAssets` (ordered) | `web.error`, `web.assets` | none | add a response for an exception; withhold an asset path |
| `TsaSerialAllocator`, `TsaLog`, `TsaClientStore`, `TsaKeyMaterial` | `timestamp` | JDBC or memory (see policy) | the timestamp server's stores and key |
| `Timestamper` | `timestamp` | the client of `datum.pdf.signing.tsa.url`, else the in-process authority | where seals get their timestamps; an application's bean (a qualified or custom authority) is used first |
| `PdfTrustPolicy`, `PdfVerifier` | `pdf.verify` | the configured anchors, no revocation checking, chains judged now | what makes a signer or a timestamp authority `trusted`; the verifier `POST /pdf/verify` completes with |
| `RunLog` | `sandbox.protocol` | one escaped line per entry on the logger `datum.sandbox` | where a real submission's guest log (`context.log`) goes |
| `SandboxDecorator` (ordered), `AbiProbe` | `sandbox.protocol` | none (the protocol itself, `SandboxService`); a fresh gate per proof on your `Clock` | wrap the sandbox the runtime builds, to observe every sandbox run; any number compose in their order |
| `PdfKernelDecorator` (ordered) | `sandbox.protocol` | none (the protocol itself, `PdfProgram`) | wrap the PDF program's kernel, to observe every PDF run |
| `DatumObservations` | `core.observation` | Micrometer's Observation API on your `ObservationRegistry`, else none | where Datum's observations go (see "Actuator and metrics") |
| `PasskeyRepository`, `PasskeyUseStore`, `ChallengeClaims`, `FormSigningSource`, `PasskeySubjectResolver` | `webauthn` | JDBC or memory (see policy) | the passkey stores; where a form's signing settings come from; who a principal is |

A minimal handler:

```java
@Bean
SubmissionHandler handler(Submissions submissions) {
    return accepted -> {
        // A unique key on the form and the submission key stores one submit attempt once, retries included.
        String id = submissions.save(accepted.formKey(), accepted.submissionKey(), accepted.canonicalDocument(), accepted.digest());
        return new SubmissionReceipt(id, "REF-" + id, null);
    };
}
```

**Ordering.** The ordered hooks (pre-checks, validators, rule providers, context contributors, host-option
customizers, definition customizers, builder save customizers and validators, PDF request customizers and result
validators, timestamp request customizers, passkey registration customizers and validators, signature-check
customizers, error translators,
withheld assets) are asked in Spring's own order, through
`ObjectProvider.orderedStream()`: `@Order`, `Ordered` and `@Priority`, lowest value first, and beans with no order
after the ordered ones. **A hook whose position relative to another matters must declare `@Order`**: two beans of equal
order (two unordered ones included) keep the order the container registered them in, which Spring does not promise and
an application should not rely on. Datum adds no sorter of its own.

**Nullability.** The packages an application implements or reads (`sandbox.protocol`, `sandbox.wasi`, `sandbox.diagnostics`, `core.hooks`,
`submissions.spi`, `webauthn` and `web.error`) are `@NullMarked` with [JSpecify](https://jspecify.dev): a type with no annotation is non-null, and `@Nullable` marks where a null is meant, such as an anonymous
caller's `principal`, a client address a non-HTTP channel does not have, a `HookProblem`'s `field` and `message`, a
`WebAuthnVerdict` that passed having no `failed`. Kotlin and IDE users who implement `GuestRuntimeProvider`, `RunLog`, a
hook, `PasskeyThrottle` or a decorator get real nullable and non-null types instead of platform types. JSpecify is an
optional dependency of those libraries (its version is pinned in `datum-bom`, 1.0.1, the one Spring Boot 4.2 manages): add
`org.jspecify:jspecify` to read the annotations, and the libraries run the same without it. NullAway is not enabled.

**The request view.** Each web stack builds a request's content type, headers, client address and principal in one place
(`MvcRequestViews` and `WebFluxRequestViews` in `datum-spring-web`, used by the submissions, PDF and passkey endpoints alike),
and an annotated controller of your own can take a `SubmissionRequest` parameter, resolved by the same rule once the
submissions binding is on (Servlet: a `HandlerMethodArgumentResolver` registered through a `WebMvcConfigurer`; WebFlux: through
a `WebFluxConfigurer`), to hand work to the receiver or `PdfApi` in process.

### Timestamps, trust and sandbox runs

Four seams sit where a mistake is silent, so each is one bean with a default that is the behaviour without the bean.

**Timestamper.** Seals are timestamped by your `Timestamper` bean when there is one (a qualified trust service's client,
an HSM-backed authority, anything that answers a granted RFC 3161 `TimeStampResp`); the binding then builds no client of
its own and names the `datum.pdf.signing.tsa.*` settings it leaves unused (the URL and credentials at INFO, the `policy` at
WARN: the tokens then carry whatever policy your bean asks for). Without one, the client of the server the `PdfSettings`
bean names (`datum.pdf.signing.tsa.url`, or your own settings bean's URL; a bean carrying `datum.pdf.signing.tsa.policy` as
its `reqPolicy`), else the timestamp server's in-process authority. When a policy is asked, a token granted under any other
policy is no token (RFC 3161 says a server issues under the policy asked or refuses), and a refusal names its PKIStatus,
failure bits (`unacceptedPolicy`, ...) and the server's words when the reply is a 200 `TimeStampResp` (both transports read
no body of another status, so a 4xx reads as the status alone). The
in-process `TimestampAuthority` is a `Timestamper` too but never counts as yours. Two beans of yours stop the start unless
one is `@Primary`. `info.datum.timestamp` says `custom`, `server`, `site` or `none`. The token is checked when the PDF is
verified like any other: the binding does not take a `Timestamper`'s word.

**PdfTrustPolicy.** Verification places a signer (and a timestamp authority) as `trusted` when the JDK's PKIX path build
reaches one of the policy's anchors. The default is `PdfTrustPolicy.standard()`: the anchors of
`datum.pdf.signing.trust-anchors`, no revocation checking, every chain judged now. A bean of yours changes that:

```java
@Bean
PdfTrustPolicy trustPolicy() throws Exception {
    return PdfTrustPolicy.builder("qualified")
        .revocationChecking(true, PKIXRevocationChecker.Option.PREFER_CRLS)   // the JDK's checker: OCSP, CRLs
        .certStores(List.of(CertStore.getInstance("Collection", new CollectionCertStoreParameters(myCrls))))
        .build();
}
```

or, to keep long-lived signatures trusted after their certificates expire, `.validationTime(PdfTrustPolicy.ValidationTime.SIGNING_TIME)`
without revocation checking, or with it only when `certStores` hold the CRLs that were current at each signing time (see
below).

With revocation checking on, a chain whose status cannot be learnt is not trusted (choose the JDK's `SOFT_FAIL` to accept
it); the network calls and their timeouts are the JDK's (`com.sun.security.enableCRLDP`, `com.sun.security.ocsp.timeout`).
`SIGNING_TIME` judges a signer's chain at the time its timestamp proves, only when that token verified whole and its
authority is this server's or trusted; the signature's own `/M` time is the signer's claim and never moves the time, and a
timestamp authority's own chain is always judged now. Under `SIGNING_TIME` the revocation check moves back too: the JDK
takes only a CRL or OCSP reply that was valid at that time, so today's CRL does not serve a chain judged in 2020, and
such a chain reads `unknown` (fail closed) unless the policy's `certStores` hold the archived CRL of that time. The verify
report names the policy (`"trustPolicy": {"name", "revocationChecking", "validationTime"}`) and each `trusted` signature the
instant its chain was judged at (`trustedAt`; absent for a site, self-signed or unknown signer, where no chain was judged). A `PdfVerifier` bean of yours (it is not final: extend it to log or add to the report) is used as given;
build its trust with `PdfTrust.withSiteSigner(signer.leaf())` or the server's own seals read as unknown (the start WARNs).

**RunLog.** A real submission's guest log goes to your `RunLog` bean (default: one line per entry on the logger
`datum.sandbox`, every control character escaped). Yours receives the text as the guest wrote it: escape it
(`RunLog.oneLine`) before it reaches a line-oriented log. Dry runs, smoke and warm-up runs relay nothing. The log is an
observer: when your `RunLog` throws (its sink is down), the entry is dropped with one WARN per run naming the exception's
class, and the submission's verdict stands.

**Sandbox runs.** The receiver, `SubmissionsApi` (the inspection) and the definition service (public copies, the builder's
checks) all run on one `Sandbox` bean. The runtime builds it itself at every start and recheck, over its own guarded engine,
slots, ABI gate and run log, and hands it to your `SandboxDecorator` beans in the framework's order (`@Order`, `Ordered`,
`@Priority`), as Spring Boot composes its `TaskDecorator`s: the first wraps the runtime's sandbox, each next one wraps the
one before, so the last sees each call first. `SandboxService` (the protocol: depth guard, slot, ABI gate, nonce, frame,
strict answer) stays final; observe every run, the ABI proof and the warm-ups included, with a decorator, and two parties
(your tracing and an audit library) decorate side by side:

```java
@Bean @Order(10) SandboxDecorator tracing(Tracer tracer) { return sandbox -> new TracingSandbox(sandbox, tracer); }  // implements Sandbox, delegating
@Bean @Order(20) SandboxDecorator audit(AuditLog log)    { return sandbox -> new AuditingSandbox(sandbox, log); }
```

A decorator must delegate every call to the sandbox it is handed and rethrow what that sandbox throws; one that answered
in its place, or answered a sandbox of its own, would take the kernel (and the runtime's backstop and stuck count) out of
the decision. A decorator is handed only the sandbox the runtime built, never the runtime's parts (there is no `SandboxFactory` or `PdfKernelFactory` bean to hand them over); that it wraps what it is
handed is a contract, which the code cannot enforce. The runtime's `datumSandbox` bean is replaceable, as a Spring
bean is: a `Sandbox` bean of your own is what the receiver, the definition service and the inspection run on. The ordered
decorators and Datum's `datum.sandbox.run` observation are applied to whichever bean exists, in a step the binding owns
(the Boot idiom: customizers apply to the bean that is there), so a replacement can never skip them. The `PdfRuntime` bean
is replaceable the same way, with the `PdfKernelDecorator` beans and `datum.pdf.run` applied to its program.
Prefer a decorator to a `BeanPostProcessor` for anything heavier than a wrapper: the `Sandbox` bean is a prototype, so a
post-processor runs on every call, and it sees the same request runs but not the runtime's own proof and warm-ups. The PDF
program's runs have the same seam: `PdfKernelDecorator` beans (`kernel -> new TracingPdf(kernel, tracer)`, implementing
`PdfKernel` by delegation) see the PDF program's ABI proof and every render, fill, sign and verify, so one observer in the
two covers every guest run. With an `ObservationRegistry`, Datum's own observation of each run (below) sits directly around
the protocol, inside your decorators. `AbiProbe` is a prototype bean on your `Clock`: keep yours a prototype, or a recheck
trusts the proofs it remembers (the runtime WARNs).

### Positioning of the timestamp server

No Java library packages an RFC 3161 server. Bouncy Castle's `tsp` classes are the building block `datum-timestamp` uses, DSS's
`KeyEntityTSPSource` is an in-process test source, and SignServer and EJBCA are products. Datum's authority is for
self-contained deployments and for receipts; a qualified or audited service means `datum.pdf.signing.tsa.url` pointed at a
commercial timestamp authority, or at a SignServer or EJBCA deployment you run.

### Time source

RFC 3161 asks a timestamp authority whose clock it cannot trust to refuse with `timeNotAvailable`. Datum's server reads
"now" through a `TsaTimeSource` (`libs/datum-timestamp`): `read()` answers `Reading.available(Instant)` or
`Reading.unavailable(reason)`. The default wraps the application's `Clock` bean and is always available. While a source
answers unavailable, `POST /tsa` answers **503** with a TimeStampResp (status rejection, failure info
`timeNotAvailable`, the reason as its statusString), no key is loaded and no serial taken, `TimestampRefusedEvent`
carries the failure info, and the `datum-tsa` health check is DOWN with `time: unavailable (reason)` (it says
`time: available` otherwise). A source that throws counts as unavailable, its message going to the log only. The reason
reaches clients, so keep hostnames and addresses out of it.

Datum ships no NTP client. A source that checks the system clock against a reference and refuses above a drift, with
Apache Commons Net (`commons-net:commons-net`, Apache-2.0), reading from a cached value a background task refreshes
(the pattern of SignServer's `TimeMonitor`):

```java
@Bean
TsaTimeSource ntpCheckedTime(Clock clock, TaskScheduler scheduler) {
    AtomicReference<TsaTimeSource.Reading> last = new AtomicReference<>(TsaTimeSource.Reading.unavailable("not checked yet"));
    Duration maxDrift = Duration.ofMillis(500);
    scheduler.scheduleWithFixedDelay(() -> {
        NTPUDPClient ntp = new NTPUDPClient();
        ntp.setDefaultTimeout(Duration.ofSeconds(2));
        try {
            ntp.open();
            TimeInfo info = ntp.getTime(InetAddress.getByName("pool.ntp.org"));
            info.computeDetails();
            long offsetMillis = info.getOffset() == null ? Long.MAX_VALUE : info.getOffset();
            last.set(Math.abs(offsetMillis) <= maxDrift.toMillis()
                ? TsaTimeSource.Reading.available(clock.instant())
                : TsaTimeSource.Reading.unavailable("the system clock is " + Math.abs(offsetMillis) + " ms from the reference"));
        } catch (IOException e) {
            last.set(TsaTimeSource.Reading.unavailable("the reference clock cannot be reached"));
        } finally {
            ntp.close();
        }
    }, Duration.ofSeconds(30));
    return () -> last.get() instanceof TsaTimeSource.Available ? TsaTimeSource.Reading.available(clock.instant()) : last.get();
}
```

(The scheduler is the application's `TaskScheduler`; the sketch trusts the last check for as long as it runs, so
`maxDrift` should be well inside `datum.tsa.accuracy`.)

## Lifecycle and hooks

Every capability runs its requests through the same kinds of hook, so the place to put a rule is the same
question everywhere:

| Kind | When | May | Throws |
|---|---|---|---|
| `*Customizer` (ordered list) | before the engine or the store is asked | adjust a typed draft in place, or refuse with `HookRefusedException`; never the ABI, the op, the program or the identity (a form's `id`, a token's digest) | anything else fails the request |
| `*Validator` / `*Check` (ordered list) | after the engine answered, before the effect | see the verdict; add errors (refuse) or warnings (ride along), as `HookFindings`; or refuse at once with `HookRefusedException` | anything else fails the request |
| `*Handler` (one) | the effect | store, deliver, issue | |
| `*Event` | after the effect | observe (Spring's `@EventListener`); never veto | a listener's failure is logged, never the request's (see "Events") |
| stores, providers, key material, clocks, time sources, transports, factories | wherever the capability needs them | be replaced by your bean | |

The hook interfaces and their call sites are in the libraries (the pipeline they interrupt lives there, as
`RestClientCustomizer` lives beside `RestClient`); the bindings collect every bean of a hook type in Spring's order
(`ObjectProvider.orderedStream()`: `@Order`, `Ordered`, `@Priority`; see "Ordering" above). Observation needs no hook:
with an `ObservationRegistry` Datum reports its own observations (see "Actuator and metrics"); listen to the events, or
wrap the engine with `SandboxDecorator` and `PdfKernelDecorator` beans. Customizers run each
over what the one before left, and the first refusal stops the later ones; validators all run, so every error is
reported at once (a `HookRefusedException` from a validator stops at once).

`HookRefusedException` (`core.hooks`) is the one typed refusal: `forbidden(code, message)`, `conflict(code, message)`,
`invalid(code, message)` or `invalid(List<HookProblem>)`, each `HookProblem` a `{field, code, message}` with a code of
letters, digits and `. _ : -`. Its kind is what a transport answers: on the routes `FORBIDDEN` is **403**, `CONFLICT`
**409**, `INVALID` **422**, with the errors body `{errors: [{field, code, message}]}` (one entry per problem, the first
problem's code as the problem-details `code`). A capability with its own 422 shape answers its problems in that shape
(the builder's `definition.refused`); the timestamp server, whose wire is RFC 3161, answers any kind as a `badRequest`
rejection. A non-HTTP caller (the services of "Using the engine without HTTP") reads the kind.

### Forms: `GET /forms/{key}/definition`

```
params -> form (FormDefinitionRepository) / version (DefinitionSnapshotStore) -> DefinitionCustomizer* -> kernel public copy (Sandbox) -> 200 | 304
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| parameters | | 400 `bad_request` (`public` not true or false) |
| the form, the version asked by hash, the catalog key's version | `FormDefinitionRepository`, `DefinitionSnapshotStore` | 404 `form.notFound` |
| customize (the public copy only: no `public` parameter, or `public=true`) | `DefinitionCustomizer` | its kind: 403, 409, 422; a throw, or a changed `id` or `version`, 500 `internal` |
| the kernel's public copy of what the customizers left (server-secret rules removed, whoever added them) | `Sandbox` | 503 `server.unavailable` for a form with secret rules while the runtime is down; 503 `server.busy` when no validation slot frees within `datum.runtime.validation.wait`; 422 `definition.tooDeep` |
| the effect | | 200 with the `ETag` of the bytes served; 304 for a matching `If-None-Match` |

A `DefinitionCustomizer` sees a `DefinitionDraft`: the `DefinitionRequest` (form key, the stored version's hash, current
or by hash, the principal, the locale Spring resolved from the request: MVC's `LocaleResolver`, WebFlux's
`LocaleContextResolver`, never null: with no `Accept-Language` MVC's resolver answers the servlet request's locale, the
JVM default on a servlet container, and the WebFlux handler falls back to the JVM default where its resolver answers none)
and a copy of the stored definition to change in place. Never customized: the author's copy
(`public=false`, whose `ETag` the builder's `If-Match` names) and the definition a submission is judged against (the
stored one: a customizer that hides a required component must make the submission side agree, or the hidden answer is
refused). The public copy is cached by the stored hash and each customizer's `cacheKey(request)`, or not at all when one
answers empty (the default, so a customizer's copy is made per request until it declares a key); a cached copy is used
only when its customized definition is the one this request's customizers left, so a key that names too little serves a
fresh copy (with a WARN), never another request's. With a customizer, a version asked by hash keeps
`datum.forms.cache.definition` (no-store by default) instead of the shareable `datum.forms.cache.snapshot`. The
translations and data-source reads have no customizer: the catalog's `ETag` is the store's and the builder writes it back
with `If-Match`, so a customized catalog would desynchronize the two.

### Builder: `PUT /forms/{key}`, `POST /forms`

```
admission (404) -> cap (413) -> If-Match (409) -> JSON (400) -> shape and id (422) -> language changes (400) -> finite numbers (422)
  -> BuilderSaveCustomizer* -> the host's rules again -> kernel check -> BuilderSaveValidator* -> store under the lock -> FormDefinitionSavedEvent -> 200 | 201
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| existence (save), the size, the precondition | `FormDefinitionRepository` | 404 `form.notFound`, 413 `bad_document`, 409 `form.outdated` (current `ETag`) |
| strict JSON, the shape, the id, the language changes, finite numbers | | 400 `bad_document`, 422 `definition.refused` (`definition.id.mismatch`, `definition.id.invalid`, `definition.number.nonFinite`), 409 `form.exists` (create) |
| customize | `BuilderSaveCustomizer` | `INVALID`: 422 `definition.refused`, each problem a finding (`errors[]` and `kernel[]`, its `field` as `where`); `FORBIDDEN` 403, `CONFLICT` 409 with the errors body; a throw, or a changed `id`, 500 `internal` |
| what the customizers left, held to the size, strict-JSON, shape and finite-number rules | | the same codes as above |
| the kernel's check | `Sandbox` | 422 `definition.refused` (the kernel's codes), `definition.tooDeep`, `definition.tooCostly`; 503 `server.unavailable` |
| validate (every validator, the verdict in `BuilderSaveCandidate`) | `BuilderSaveValidator` | errors: 422 `definition.refused` with every error as a finding; a `HookRefusedException`: its kind; a throw: 500 `internal`. Warnings: in the 200's `warnings`, after the kernel's |
| the store | `FormDefinitionRepository`, `TranslationCatalogStore`, `DefinitionSnapshotStore` | 409 `form.outdated` (raced), 501 `forms.readOnly` |
| the effect | | 200 (201 with `Location` for a create), the `ETag` of what was stored: the customized definition |

The same hooks run for `BuilderService` callers outside HTTP (`BuilderOutcome.Declined` carries the hook's refusal). The
translations write (`PUT /forms/{key}/translations`) has none.

### Submissions: `POST /submissions`, `/submissions/validate`, `/submissions/test`

```
admission (415) -> address limit (429) -> body (413, 400) -> throttle -> pre-check -> definition and version -> submission key (a delivery) -> journey
  -> option snapshot -> context (HostOptionsCustomizer*, SandboxRulesProvider*, SandboxContextContributor*, HostContextProvider) -> sandbox
  -> signature -> validators -> handler -> idempotency told -> events
```

A delivery's body is `{document, submissionKey}`: the document (or its signed wrapper) and the key the page mints once
per submit attempt and sends again on a retry (`datum-submit`'s `detail.submissionKey`; the shared glue posts it). The key
matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (`SubmissionContext.SUBMISSION_KEY`; a version 4 UUID fits). A body without
one, and the bare document, are 400 `bad_document`; the size cap is measured first (413). The test route takes the same body
and ignores the key; its 200 report holds four lists of component ids from the run's outcome (`visibilitySkipped`,
`clientDerived`, `clockDependent`, `serverRules`), each always present as an array and empty when none apply. A journey check (`/submissions/validate`) is `{document, scope, pageId?}`: the wrapper and `scope`
(`journey` or `page`) are required, `pageId` is required with `page` and refused with `journey`, each a 400 `bad_document`.

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission | | 415 `unsupported_media_type` |
| address limit (before the body is read) | `SubmissionThrottle` (`checkAddress`, `recordAddress`) | 429 `flood` with `Retry-After`; a replacement bean that does not implement them counts no address |
| body | | 413 `bad_document`, 400 `bad_document` (also a delivery with no usable `submissionKey`) |
| throttle (not the PDF dry run) | `SubmissionThrottle` | 429 `flood` with `Retry-After` |
| pre-check (every mode) | `SubmissionPreCheck`, `PreCheckStatuses` | the `Reject`'s own code, with the status the mapping names (403 for every code by default, `access.denied` included; with `PreCheckStatuses.bySuffix()` 422 for `.invalid`, 503 for `.unavailable`); a mapping that throws or answers no refusal: 500 |
| definition and version | `FormDefinitionRepository`, `DefinitionSnapshotStore` | 404 `form.notFound`, 409 `form.outdated` |
| submission key (a delivery) | `SubmissionIdempotencyStore` | a key accepted before with the same digest: 200 with the first receipt (`handled: true`), no run and no handler; with another digest: 409 `submission.keyConflict`, before the document is judged, whatever it holds |
| journey (validate's checks) | | 200 `{accepted: false, errors}` (`journey.required`, `journey.unknown`); 400 `bad_document` for a check that names no page of the journey. The verdict's `errors` hold only what blocks, `{field?, code, message?}`; warnings and info ride in `notes`, `{field?, code, severity, message?}`, left out when empty |
| option snapshot | `DataSourceProvider` | 503 `server.unavailable` |
| context customize | `HostOptionsCustomizer`, `SandboxRulesProvider`, `SandboxContextContributor` (each takes the `SubmissionContext`) | a throw: 503 `validator_unavailable` (customizer, contributor), 503 `server.unavailable` (rules provider); a `DatumException` they throw answers as itself; a customizer that sets a `RunSettings` word the program does not read fails as a throw does (503 `validator_unavailable`, never a quiet default) |
| host context (after the contributors, which cannot replace it) | `HostContextProvider` | a throw, a null answer, or a value outside the ABI's bounds (64 levels, 1,000,000 values, finite numbers, strict strings): 503 `server.unavailable` (no `Retry-After`), no run, the cause in the log at ERROR and never the values; a `DatumException` it throws answers as itself |
| sandbox | `Sandbox` (`SandboxDecorator`) | 422 `submission.rejected` with the kernel's errors; 503 `server.busy` (with `Retry-After`) / `server.unavailable`; a run that gave no answer, 503 `wasm.execution_error`, `outcome_too_large`, or `definition.tooDeep` for a registered form too deep (no `Retry-After`): never a 422, which a browser shows as "your answers are wrong"; the same on a journey check, which never answers a failed run as a 200 verdict |
| signature | `SubmissionSignatureCheck` (`-webauthn`; its `SignatureCheckCustomizer`s, see "Passkey signatures") | 422 `submission.rejected` (stage `signature`); a customizer's refusal: its kind |
| validators | `SubmissionValidator` | errors: 422 `submission.rejected`; a throw: 503 `validator_unavailable` |
| the effect | `SubmissionHandler` | 200 `{id, reference, status, digest, ...}`; the idempotency store is then told the key, digest and receipt |
| events | `SubmissionValidatedEvent`, `SubmissionRejectedEvent`, `SubmissionRedeliveredEvent`, `SubmissionThrottledEvent`, `JourneyCheckedEvent` | |

`HostOptionsCustomizer` and `SandboxRulesProvider` take the same `SubmissionContext` as the other hooks (channel,
principal, client facts), whatever the channel.

#### The host context

A rule can read facts about the visit rather than the answers, `host.role` or `host.region` (ADR 0142). The browser
reads them from the page's `hostContext`, which is for display: a client can set it to anything, and the envelope does
not carry it. The server judges such rules with values it works out itself. Declare one `HostContextProvider` bean; the
binding hands it to the submission service and the PDF facade, and two beans stop the start (one is never picked
silently). It is asked once per run, on a delivery, a journey's page or whole-journey check, a dry run and the dry run
behind a PDF (the PDF routes ask it again for the print, so the PDF is drawn under the same values). Its answer goes into
the run context as `hostContext` after every `SandboxContextContributor`, so none can replace it, and nothing of the body
or the document is ever read for it.

```java
@Bean
HostContextProvider hostContext() {
    return request -> {
        if (!(request.submission().principal() instanceof Authentication auth)) {
            return Optional.empty(); // anonymous: no context, the lenient reading
        }
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"));
        return Optional.of(Map.of("role", admin ? "admin" : "user"));
    };
}
```

`request.submission()` is the same `SubmissionContext` the other hooks read: the principal (on both web stacks, Spring
Security's `Authentication`), the headers as plain data, the client address and the channel; `formKey`, `formVersion`
and `mode` say which run it is. Empty means no context: the kernel judges as it did before the key existed (a field the
host shows is not required and is listed in `visibilitySkipped`, a calculation keeps the value sent). A map, even an empty
one, is a context: every rule reading `host.` is judged against it, and a key it lacks reads as no answer. The value is
written as JSON and held to the bounds the sandbox ABI gives the key (64 levels, 1,000,000 values, finite numbers, strings
without an unpaired surrogate). A provider that throws, answers null or answers a value outside those bounds is the
host's own fault, never a verdict: 503 `server.unavailable` (no `Retry-After`; the code of a data source that cannot answer), the cause in the log at ERROR (never the values), and no run. The PDF routes ask again for the print and answer the same way. A retry of an accepted
attempt (the same submission key and document) is answered with its first receipt before any run, so it keeps the first
verdict whatever the provider would answer now. A non-HTTP caller of `SubmissionService` gets the same provider over its
own `SubmissionContext`.

The submissions example's Spring profile `host-check` wires a TEST-ONLY provider that believes the header
`X-Datum-Test-Role`, for the Node host check's `host-context` capability; never enable it where real submissions are
taken (the example's README, "Running the host check against the example").

### PDF: `POST /pdf`, `/pdf/fill`, `/pdf/sign`

```
admission (415) -> address limit (429) -> body (413, 400) -> throttle (429) -> PDFs available (503) -> the receiver's dry run in PDF mode (422)
  -> PdfRequestCustomizer* -> PDF program (PdfKernel) -> PdfResultValidator* -> seal (PdfSigner, Timestamper) -> PdfRenderedEvent -> 200 application/pdf
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission | | 415 `unsupported_media_type` |
| address limit (before the body is read) | `SubmissionThrottle` (`checkAddress`, `recordAddress`) | 429 `flood` with `Retry-After`; a replacement bean that does not implement them counts no address |
| body, throttle, availability | `SubmissionThrottle` | 413, 400 `bad_document`, 429 `flood`, 503 `server.unavailable` |
| the answers | the receiver's pre-checks and validators (PDF mode) | 422 `submission.rejected`, the pre-check's own code |
| customize (env, options, hostContext, attachments, fonts; by op) | `PdfRequestCustomizer` | its kind: 403, 409, 422; a throw: 500 `internal` |
| the program | `PdfKernel` (`PdfKernelDecorator`) | 404 `layout.notFound`, 400 `layout.notTemplate`, 500 with the program's code; a run that gave no answer (time, memory, a throw): 503 `wasm.execution_error` or `outcome_too_large`, and a registered form nested too deep 503 `definition.tooDeep`, none with `Retry-After`, as on the submission routes (never a 422). The request carries the `HostContextProvider`'s `hostContext`, before the customizers |
| validate (every op that answers PDF bytes, before any seal) | `PdfResultValidator` | errors: 422 with the errors body (the first error's code); a `HookRefusedException`: its kind; a throw: 500 `internal`. Warnings: in `PdfResult.warnings()` (the routes send none) |
| seal | `PdfSigner`, `Timestamper`, `PdfTrustPolicy` | 500 `signature` for a layout that requires a seal the server cannot make, for a program signing handoff that is not over the prepared file (a byte range other than one gap reaching the end, a `digest` or `toBeSignedDigest` that does not match, signed attributes whose `messageDigest` is not that digest), for a signature algorithm the server does not make, and for a value the server's key gave back that it cannot embed (none, an ECDSA value that is not DER, a value that does not verify with the server's own certificate); a failed timestamp is a `sealing.timestamp` warning |
| the effect, events | `PdfRenderedEvent` | 200 with `X-Page-Count`, `X-Datum-Layout`, `X-Datum-Pdf-Theme` (the PDF theme the route's binding suggests, when it suggests one; a render call's or a layout's own theme still outranks it in the drawing), `X-Signed-By`, ... |

A refused PDF costs no signature and no timestamp, and announces no `PdfRenderedEvent`. `complete` (the second call of
caller-side signing) only embeds a signature into bytes a validator already let go and is not judged again.

### Timestamp server: `POST /tsa`

```
cookie (403) -> content type (415) -> client key (429, 401) -> flood (429) -> size (413)
  -> the request's policy -> TimestampRequestCustomizer* -> time source -> key -> serial -> signature -> TimestampIssuedEvent | TimestampRefusedEvent
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission | `TsaClientStore`, the flood | 403, 415, 401 with `WWW-Authenticate`, 429 with `Retry-After`, 413 (plain text) |
| the request's own policy | | 400 TimeStampResp rejection, `unacceptedPolicy` |
| customize (the endpoint's tokens, channel `http`; the host's own seals and receipts only for a customizer whose `appliesTo(channel)` says so, or one wrapped in `TimestampRequestCustomizer.everyChannel`) | `TimestampRequestCustomizer` | a `TimestampRefusedException`: its PKIFailureInfo bit (400, or 503 for `timeNotAvailable`/`systemFailure`); a `HookRefusedException` of any kind: 400 `badRequest` with its message; any other throw, a draft value out of bounds included: 503 `systemFailure` (the cause in the log only) |
| time, key, serial, signature | `TsaTimeSource`, `TsaKeyMaterial`, `TsaSerialAllocator` | 503 `timeNotAvailable`, 503 `systemFailure` |
| the effect, events | `TimestampIssuedEvent`, `TimestampRefusedEvent` | 200 TimeStampResp with the token |

A customizer chooses the policy only among `datum.tsa.policy` and `datum.tsa.accepted-policies`, and only when the
request names none (a request that names one is issued under it or refused, RFC 3161 section 2.4.1); the accuracy from 0
to 60 seconds. A refused request costs no key load and no serial. A customizer runs for `POST /tsa` only unless it opts
in: the host's own tokens carry no client, so a client policy that refuses an unknown client would refuse every seal, and
a seal whose timestamp fails goes out with a `sealing.timestamp` warning rather than failing, without the token its layout
asked for.

### Passkeys: `POST {passkeys}/challenge`, `POST {passkeys}/register`

```
challenge: 415 -> address limit (429) -> body (413, 400) -> form and signing (404, 503, 403) -> throttle (429) -> RegistrationCustomizer* (CHALLENGE) -> challenge issued
register:  415 -> address limit (429) -> body (413, 400) -> form and signing (404, 503, 403) -> throttle (429) -> readable (400) -> RegistrationCustomizer* (REGISTER)
           -> challenge claimed (400) -> handle and WebAuthn checks (422) -> new id and key (409) -> RegistrationValidator* -> store -> PasskeyRegisteredEvent
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| admission | `FormSigningSource`, `PasskeySubjectResolver`, the passkey throttle | 400 `passkey.bad_request`, 404, 503, 403 `signing.sign_in` / `signing.context` / `signing.register_off`, 429 `flood` |
| address limit (before the body is read) | the passkey throttle (`checkAddress`) | 429 `flood` with `Retry-After`; a replacement bean that does not implement it counts no address |
| customize (both calls; the label, a stricter user verification, a stricter resident key at the challenge) | `RegistrationCustomizer` | its kind: 403, 409, 422; any other throw, a value weaker than the policy included: 500 `internal` |
| the challenge, the WebAuthn checks | `ChallengeClaims` | 400 `passkey.challenge`, 422 `passkey.invalid` |
| the credential id and the key are new | `PasskeyRepository` | 409 `passkey.exists` |
| validate (every validator, the `PasskeyRecord` about to be stored: AAGUID, attestation format, flags, transports) | `RegistrationValidator` | errors: 422 with the errors body (the first error's code); a `HookRefusedException`: its kind; a throw: 500 `internal` |
| the effect, events | `PasskeyRepository`, `PasskeyRegisteredEvent` | 201 with the stored passkey (the challenge: 200 with the options) |

A customizer answers both calls alike: the options a browser was given prove nothing, and the registration call's user
verification is the one checked. A refusal at the challenge issues no challenge; one at the registration spends none.

**How a passkey is verified.** webauthn4j (`WebAuthnManager.createNonStrictWebAuthnManager()`, attestation
`none`, no trust anchors) parses and verifies both ceremonies; Datum keeps its policy around it. Before the library reads
a byte, the response must be readable: text members in base64url, the client data strict JSON (8 levels, nothing after
it), the authenticator data laid out as WebAuthn 6.1 says (with AT a credential id of 1 to 1023 bytes, nothing after
the key or the extensions), and every CBOR item through `CborGate` (the row under "Fixed by contract"). webauthn4j then
checks the type, the challenge, the origin against `datum.webauthn.origins`, the relying-party id hash, user presence
and, when required, user verification, and the signature with the stored key (a fresh credential record, counter 0: the
counter rule is the signature verifier's, after the replay check). It is never given a topOrigin, so `crossOrigin: true`
and any `topOrigin` are refused, and Datum refuses `crossOrigin: true` again on its own reading, an origin that is not
exactly one of the configured texts (webauthn4j compares origins after normalising case, the default port, a path, a
query, a fragment and user info away, so `http://localhost/evil` would pass it; Datum compares the text as the browser
wrote it, which is also what a registration stores), and a challenge text other than the exact base64url it handed
out. For a registration Datum then holds the credential id the browser reported
to the authenticator data's, the COSE key to ES256 on P-256 (on the curve) or RS256 of at least 2048 bits, and the SPKI
the browser reported (`getPublicKey()`; one that is not base64 counts as a key that differs) to that key's. The SPKI it
stores is the JCA's encoding of webauthn4j's key. A refusal is named by its check
(`readable`, `type`, `challenge`, `origin`, `rpId`, `userPresent`, `userVerified`, `attestedCredential`, `credentialId`,
`publicKey`, `signature`, or `library` for a rule of webauthn4j's with no name here, such as a backup state without
backup eligibility); the library stops at the first refusal, so the record's `checks` map says which checks passed and
counts the rest as not passed. The wire reads only the name (`origin` and `rpId`, `userVerified` and the rest have their
own sentences under 422 `passkey.invalid` and `signature.invalid`).

### Passkey signatures: a signed `POST /submissions`

```
signature found (one) -> passkeys set up -> format jcs -> statement text -> signing times agree -> scope, statement
  -> the signed text rebuilt -> passkey known, not revoked, this form's, this person's, its user handle
  -> SignatureCheckCustomizer* (a signature this site judges) -> the assertion (webauthn4j, the stored key)
  -> replay -> counter -> window -> validators ... -> recordUse (the digest claimed; a refused claim: SubmissionSignatureVerifiedEvent invalid)
  -> handler -> stored (SubmissionSignatureVerifiedEvent valid) | the handler failed: releaseUse (no event)
```

| Stage | Hook | Refusal on the wire |
|---|---|---|
| the signature's shape and the form's settings | `FormSigningSource` | 409 `signature.stale` (scope, statement, format), 422 `signature.invalid` |
| the passkey | `PasskeyRepository` | 422 `signature.unknown`, `signature.unusable` (revoked, another form's or account's, another user handle) |
| customize (per form: refuse by signer or passkey, require user verification, shorten the window; never weaker) | `SignatureCheckCustomizer` | its kind: 403, 409, 422 with the errors body; any other throw, a weaker value included: 500 `internal` |
| the assertion, replay, counter, window | `PasskeyUseStore` | 422 `signature.invalid` (its sentence for `userVerified`, `replay`, `counter`, `window`) |
| the effect, events | `PasskeyUseStore`, `SubmissionSignatureCheck.stored`, `SubmissionSignatureVerifiedEvent` | 422 `signature.invalid` (the digest claimed or the counter moved meanwhile) or `signature.unusable` (revoked meanwhile) |

A customizer runs only for a signature this site judges: never for one an earlier step refused, and never for a
visitor's while visitors may not sign (that is 422 `signature.sign_in`). Its draft names the form, the submitter, the
registered passkey (owner, form, AAGUID, attestation format, flags, label) and the channel; it may set
`userVerificationRequired(true)` and a `window` of 1 s up to `datum.webauthn.window`. Each setting only tightens what
the draft holds now, so a later customizer (another starter's, say) cannot undo an earlier one: `false` once
verification is required, or a window longer than the current one, fails the request. A refusal propagates on every
channel, a dry run included, and records nothing.

### Web: every route

| Stage | Hook | |
|---|---|---|
| an exception becomes an answer | `ErrorTranslator` (ordered) | asked first, before the Datum mapping; answer an `ErrorResponse` or nothing |
| an asset path | `WithheldAssets` (ordered) | paths never served (case-folded), on top of the build's own withheld files |

The error body has one shape on every route: `{errors: [{field?, code, message?}]}`, or the same list inside an RFC 9457
object. `field` is present only when the error names a component, so a form-level error, a 5xx and a framework refusal
carry none (never `"field": null`; the validate verdict follows the same rule). `message` is there only when something
worded it: the sandbox's own message for a finding is sent as the sandbox gave it, on a check's 200 and on a delivery's
422; a hook's message (a validator, a pre-check, a `HookRefusedException`) is the text of the finding that hook raised.
Neither replaces the other, because each finding keeps the words of the stage that found it. A failure of the host
(503, 500) sends fixed words or none, never the guest's text. `Retry-After` is sent with 429 `flood` and with 503
`server.busy` only: a 503 `server.unavailable`, a failed run (`wasm.execution_error`, `outcome_too_large`,
`definition.tooDeep` for a registered form) and `validator_unavailable` are answered without it, because a retry of a
deterministic failure does not help. A run the host cancelled (a shutdown, an interrupted request thread) answers 503 `server.unavailable`. So does every new run refused while runs that would not stop fill their bound: the host's own count of runs its backstop cancelled and could not end (as many as there are slots, `stuckRuns` on health), and the engine's count of stopped runs that outlived `datum.runtime.stop-grace` (`datum.runtime.max-strays`, `strayRuns` on health). A runtime that could not stop its guests is a fault, not a queue to wait in, so neither carries `Retry-After`. The stuck run's own caller is answered as the budget stop it is: 503 `wasm.execution_error`. `server.busy` is only a slot wait that expired. The PDF routes and `POST /inspect` answer a failed run as a 503 too.

## Using the engine without HTTP

The routes are one way in. Under them sit two services with no transport in them, which an application
injects to judge or save without a request: a queue or event-bus consumer, a JDBC batch import, a device that syncs
answers it took offline, a re-validation of stored records on the form's current version, a git sync of form
definitions. They run the very
steps the routes run, in the same order, with the same hooks, stores and events; the routes are a thin HTTP layer over
them (admission and the mapping of the outcome to the status, code and headers of the endpoint catalog).

**Building the services and the settings without Spring.** Each service has a builder, the one construction
style, so a seam added later is one more method and not another positional constructor: `DefinitionService.builder()`
(`repository`, `snapshots`, `sandbox`, `events` required; `publicCacheSize`, `clock`, `tooCostlyMemory`, `customizers`),
`BuilderService.builder()` (`repository`, `definitions`, `translations` required; `types`, `maxDefinitionBytes`, `clock`,
`customizers`, `validators`) and `DatumSandbox.builder()` (nothing required: `settings`, `runtime`, `limits`, `hostOptions`, `events`, `runLog`,
`probes`, `sandboxDecorators`, `pdfKernelDecorators`, `observations`, `runTrace`, `captureSink`; see "The sandbox as a
library"), beside `SubmissionService.builder()` and `SubmissionReceiver.builder()`. The settings records (`FormsSettings`, `UiSettings`, `PdfSettings` with its
`Signing`, `Seal` and `Tsa`, `TsaSettings`, `PasskeySettings`, `WebAuthnSettings`, `WebSettings` with its parts,
`EngineSettings`) have `defaults()` and a `withX` copy for every component, so a replacement bean is one line (the sandbox's `SandboxSettings` is a tree with a `builder()` instead: see "The sandbox as a library"):

```java
@Bean
PdfSettings pdfSettings() {
    return PdfSettings.defaults().withFonts("all").withSeal(PdfSettings.Seal.defaults().withEnabled(true));
}
```

A copy goes through the record's constructor, so it is checked as a new value is.

**Submissions.** `SubmissionService` (`submissions.service`, a bean of the submissions starter, web application or not):

```java
SubmissionOutcome submit(FormRef form, JsonNode document, SubmissionContext context)
SubmissionOutcome validate(FormRef form, JsonNode document, SubmissionContext context)          // the whole journey
SubmissionOutcome validate(FormRef form, JsonNode document, JourneyCheck check, SubmissionContext context)
SubmissionOutcome test(FormRef form, JsonNode document, SubmissionContext context)              // a dry run
SubmissionOutcome test(FormRef form, JsonNode document, String logLevel, SubmissionContext context)
```

- `FormRef.fromDocument()` judges the form the document names (`versionContext.form.id`), as the routes do;
  `FormRef.of(key)` also refuses a document that names another form. The version check is never skipped: the document
  must carry the current `versionContext.form.version`.
- `SubmissionContext` is who sent it and through what: a `channel` (`http`, `jdbc`, `bus`, `sync`, `other`, or a word of
  your own, 1 to 64 letters, digits, `.`, `_`, `:`, `/`, `-`), and optionally the `principal`, client facts
  (`remoteAddress`, `userAgent`, `headers` as plain data), the `throttleKey` (`ThrottleKey.Caller{ip, principal}`; none
  means the throttle does not count this caller), a `bodyDigest` and, for a delivery, the `submissionKey` of its submit
  attempt (`withSubmissionKey`; `submit` without one is `Malformed`, before any run). `SubmissionContext.of("bus")` is a
  bare one; the `with...` methods add the rest. The routes build theirs from the request (`SubmissionContext.http(...)`: channel `http`,
  the address and User-Agent, the throttle key from the address and the principal's name, the SHA-256 of the raw body). The
  service counts the key's address as `CountedAddress` gives it: an IPv6 client by its /64.
- The pre-checks, the context contributors, the signature check and the validators all see the context
  (`IncomingSubmission.context()`, `CandidateSubmission.submissionContext()`), so one written for the routes serves a queue
  too, and one that must tell them apart reads `channel()`.
- `AcceptedSubmission.channel()` and every submission event carry the channel; `remoteAddress` and `userAgent` are there
  for the routes and absent (null) for a caller that gave none.
- The idempotency store is shared and keyed by the submission key, not the answers: a submit attempt accepted before on
  one channel, sent again with the same key and the same document, is answered `Redelivered` with its first receipt on
  any other, with no run and no handler. The same key with another document is `KeyConflict` (409
  `submission.keyConflict`), answered before that document is judged and never with the first receipt. Two people who
  give the same answers send two keys and are two records; a rejected delivery leaves its key free. Give each message a
  key that stays the same when it is delivered again (a broker's message id, say). The store is asked before the
  document is judged and told after the handler, with no lock between, so two deliveries of one attempt in flight at once
  (a device's sync beside a browser's retry) may both reach the handler, on any channel pair, the routes included: make
  the handler idempotent on `AcceptedSubmission.submissionKey()` (a unique key on the form key and the submission key,
  say), never on `digest()`, which two people with the same answers share.
- Re-validation judges against the current definition only: a record stored under an earlier version is `Outdated`
  (`FormRef` names a form, not a snapshot), so a nightly job re-validates the records of the current version.
- One size cap for every channel: `datum.web.api.max-body-size` (the routes' body cap) is the service's
  `maxDocumentBytes()`, measured on the tree as the fewest bytes its JSON text can take, so a body a route took always
  fits and a tree from elsewhere is held to the same number (`TooLarge`, before the throttle or anything else walks it).
  The service sees a tree you already parsed: read untrusted bytes with Datum's capped mapper,
  `DatumJsonMapper.create(limits.maxBodyBytes())` (the `ProgramLimits` bean), refusing bytes past the cap before you
  parse, as the routes do.

`SubmissionOutcome` is sealed; nothing in it is a header or a status. `Refused` carries the `PreCheckDecision.Reject`
as the hook gave it, a code and words only (read `refused.code()` and `refused.message()`); the routes choose
its status with `PreCheckStatuses`. What each record is on the routes:

| Outcome | Route answer |
|---|---|
| `Accepted(receipt, submission, warnings)` | 200 `{id, reference, status, digest, handled: false, receipt?, warnings?}` |
| `Redelivered(receipt, digest)` | 200, the first receipt with `handled: true` |
| `KeyConflict(digest)` | 409 `submission.keyConflict` (the key was accepted with another document) |
| `Rejected(errors, stage)` | 422 `{errors}` |
| `Checked(accepted, errors, notes, journeyId, pageId)` | 200 `{accepted, errors, notes?}` (`validate`): `errors` the blocking findings, `notes` the warnings and info, left out when empty |
| `DryRun(accepted, stage, errors, values, report)` | 200 with `report` (`test`) |
| `Outdated(currentVersion, currentSha256)` | 409 `form.outdated` (no hash on the wire) |
| `NotFound(formKey)` | 404 `form.notFound` (the key never echoed) |
| `Malformed(reason)` | 400 `bad_document` (also a delivery whose context carries no submission key) |
| `TooLarge(maxBytes)` | 413 `bad_document` (the routes refuse the bytes first, so they never reach it) |
| `Refused(decision)` | the pre-check's own code, with the status `PreCheckStatuses` names for it (403 by default; `bySuffix()` 422 `.invalid`, 503 `.unavailable`) |
| `Throttled(retryAfter, key)` | 429 `flood` with `Retry-After` |
| `Unavailable(code, reason, cause)` | 503 `server.unavailable`, `server.busy` or `validator_unavailable`, or 503 with the run's own code (`wasm.execution_error`, `outcome_too_large`, `definition.tooDeep`), on a journey check as on a delivery |

What a hook throws on its own (a `DatumException` with its code, any other exception, an `Error`) is not an outcome: it
reaches the caller as thrown, as it reaches the error mapper on the routes, and nothing is handled. A consumer that
acknowledges messages would acknowledge after any outcome but `Unavailable` and leave that one for a retry:

```java
@Component
class ImportedSubmissions {

    private final SubmissionService submissions;
    private final long maxBytes;
    private final DatumJsonMapper json;

    ImportedSubmissions(SubmissionService submissions, ProgramLimits limits) {
        this.submissions = submissions;
        this.maxBytes = limits.maxBodyBytes();               // datum.web.api.max-body-size, the routes' cap
        this.json = DatumJsonMapper.create(maxBytes);        // nesting, string, number and document limits
    }

    @KafkaListener(topics = "form-answers")                  // or a JMS/AMQP listener, a JDBC batch step, a sync endpoint
    void on(ConsumerRecord<String, byte[]> record, Acknowledgment ack) {
        byte[] message = record.value();
        if (message.length > maxBytes) {
            ack.acknowledge();                               // too large for good: dead-letter it
            return;
        }
        JsonNode document = json.mapper().readTree(message); // a JacksonException: not JSON, dead-letter it
        SubmissionOutcome outcome = submissions.submit(FormRef.fromDocument(), document,
            SubmissionContext.of(SubmissionContext.BUS)    // the message's place: the same key when it is delivered again
                .withSubmissionKey(record.topic() + ":" + record.partition() + ":" + record.offset()));
        if (!(outcome instanceof SubmissionOutcome.Unavailable)) {
            ack.acknowledge();                               // stored, a repeat, a reused key, or refused for good
        }
    }
}
```

The key must match `SubmissionContext.SUBMISSION_KEY` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), or
`withSubmissionKey` throws before the message is acknowledged. Kafka allows topic names that start with `_` or `.` and
run to 249 characters; on such a topic, key the message on a hash of its place instead, for example
`"kafka-" + HexFormat.of().formatHex(sha256(topic + ":" + partition + ":" + offset))`, which always fits.

`examples/submissions` has a runnable one without a broker: `QueuedSubmissions`, an in-memory queue of messages (bytes,
read under the cap with the capped mapper, or parsed trees) consumed by one worker on channel `bus`, and
`SubmissionChannelsIT`, which sends the security suite's golden documents through the route and through the queue and
gets the same verdicts, one submit attempt (its key) stored once whichever channel brings it first, the same answers
under another key stored again, the attempt's key with another document refused, and a document past the cap refused on
both.

**Builder writes.** `BuilderService` (`ui.builder`, a bean wherever `datum.builder.enabled=true`, web application or not):

```java
BuilderOutcome save(String key, JsonNode definition, String expectedSha256, Principal principal)
BuilderOutcome save(String key, JsonNode definition, String expectedSha256, LocaleChanges changes, Principal principal)
BuilderOutcome create(JsonNode definition, Principal principal)
BuilderOutcome create(JsonNode definition, LocaleChanges changes, Principal principal)
BuilderOutcome saveTranslations(String key, JsonNode catalog, String expectedEtag, Principal principal)
```

`expectedSha256` null saves as sent; a hash that is not current is `Outdated`. A definition or catalog past
`datum.builder.max-definition-size` (the service's `maxDefinitionBytes()`, measured on the tree as above) is `TooLarge`
in the place of the routes' 413 (after `NotFound`, before `Outdated`), so an import never stores a form its authors could
not save again from the builder; a catalog write for a form no one has is `NotFound` before its etag is read. The outcome
is `Saved(key, sha256,
version, removedLocales, catalog, warnings, kernelWarnings, created, savedAt)`, `CatalogSaved(key, etag, catalog,
savedAt)`, `Outdated(currentSha256, currentVersion)`, `CatalogOutdated(currentEtag)`, `Refused(code, errors, cause)`
(`definition.refused`, `definition.tooDeep`, `definition.tooCostly`, `catalog.invalid`), `ReadOnly(cause)`, `Exists(key,
currentSha256)`, `NotFound(key)`, `Malformed(reason)`, `TooLarge(maxBytes)`, `Unavailable(code, reason, cause)` or
`Declined(refusal)` (an application's `BuilderSaveCustomizer` or `BuilderSaveValidator` refused; see "Lifecycle and
hooks"). The kernel's check is never skipped; the per-form save lock is the routes' too. `BuilderApi` keeps what is HTTP: the 413 on the bytes, `If-Match`
(lists, weak and bare tags, `*`), the JSON reading, the `X-Datum-Locale-Changes` header, the `ETag`, the removed-locales
header and the `Location` of a create. The principal decides nothing in the service itself (who may build is your security in
front of the routes, and your own code elsewhere); the routes pass the request's, and the save hooks see it.

## Events

Published through the `datumEventPublisher` bean: Spring's `ApplicationEventPublisher` behind one guard
(`DatumEventPublisher.guarded`), synchronously on the calling thread with Spring's default multicaster. Each event follows the
effect it reports. Through this default a listener that fails (an exception, an `AssertionError`, a `LinkageError`, a
`StackOverflowError`) is logged under `datum.events`, and Datum's answer and the effect stand; an `OutOfMemoryError` is the
JVM's and goes on. A listener cannot veto; a rule that must refuse is a hook (see "Lifecycle and hooks"). Define your own
`DatumEventPublisher` bean to route Datum's events elsewhere (a recording publisher in tests, an outbox): it is used as
given, never wrapped in the guard (the guard is the default's; the libraries guard nothing), so it owns its
failure semantics. One that throws reaches the code that published, after the effect: the caller of the submission, the PDF,
the token or the save sees the failure although the submission was stored, the PDF made or the token issued (the builder's
"could not record this version" warning is the snapshot store's own failure only, `SnapshotNotRecordedException`), a guest
run the runtime stopped (budget, memory, trap) answers your exception in place of its typed refusal, and the runtime's start
fails on the ready event. Wrap yours in `DatumEventPublisher.guarded(..)` for the default's behaviour. An
outbox row that must commit with the record belongs in your `SubmissionHandler` (it stores the record, inside your
transaction), not in a publisher. Datum opens no transaction of its own: called inside yours (a batch, a
queue consumer), an event is published inside it, before the commit, so a listener that must see committed data is a
`@TransactionalEventListener(fallbackExecution = true)`. Whether a listener runs on the request thread is your choice (an
async multicaster, or `@Async`). Listen with `@EventListener`; each event's javadoc says when it is published.

A `SubmissionSignatureVerifiedEvent` states the delivery's final outcome: `valid` once the handler stored the document
(`SubmissionSignatureCheck.stored`, after the receipt and before `SubmissionValidatedEvent`), so a handler that fails
publishes no valid event and the retry that is stored publishes one; `invalid` or `unverifiable` when the signature is
judged, and `invalid` for a stale signature and for a use refused when its digest is claimed (a replay that raced, a passkey
revoked meanwhile), before the handler.

| Event | When |
|---|---|
| `SubmissionValidatedEvent{submission, receipt}` (and `channel()`, the submission's) | a submission was accepted and handled |
| `SubmissionRejectedEvent{formKey, errors, stage, remoteAddress, channel}` | a submission was refused |
| `SubmissionRedeliveredEvent{formKey, digest, receipt, channel}` | a retried submit attempt (a known key with the same digest) was answered with the first receipt |
| `SubmissionThrottledEvent{key, kind, retryAfter, channel}` | the throttle said no |
| `JourneyCheckedEvent{formKey, journeyId, pageId, accepted, channel}` | a page check ran |
| `SandboxRunInterruptedEvent{program, reason, elapsed}` | a run ended by a host fault |
| `SandboxReadyEvent{engine, sandboxAbi, pdfAbi, warmUpMillis}` | the runtime proved its programs (`engine` is the engine's `EngineInfo`) |
| `FormDefinitionSavedEvent{key, sha256, previousSha256}` | the builder saved a definition |
| `PdfRenderedEvent{formKey, op, bytes, layoutId, signed, timestamped}` | a PDF was made (best effort for a record: the PDF leaves whatever a listener does) |
| `PdfVerifiedEvent{sha256, size, documentId, signatures, trustPolicy}` | a posted PDF was verified (the report's facts, never the file) |
| `TimestampIssuedEvent{serial, genTime, imprintAlgorithm, client}`, `TimestampRefusedEvent{failInfo, reason}` | the timestamp server answered |
| `PasskeyRegisteredEvent`, `PasskeyRevokedEvent` | a passkey was stored, or revoked and removed |
| `SubmissionSignatureVerifiedEvent{formKey, status, credentialId, checks}` | a delivery's signature has its final outcome (above) |

## Actuator and metrics

Expose what you need (`management.endpoints.web.exposure.include=health,info,datum`).

- **Health**: `datum` is a composite with one member per check (each a `DatumHealthCheck` bean), each UP or DOWN with its
  details under `components.datum.components.<check>`, so a health group can take one of them
  (`management.endpoint.health.group.readiness.include=readinessState,datum/runtime` keeps a TSA or passkey problem out of
  readiness). `management.health.datum.enabled=false` (or `management.health.defaults.enabled=false`) turns it off, and
  `management.info.datum.enabled=false` turns off `info.datum`. The checks: `runtime` (state, `engine`, `engineRelease`, `engineMode`, `pdfCapable`, `engineNotes`, ABIs, slots and slots in use, runs in flight, `stuckRuns`, `strayRuns`, `pdfUnavailable` when a PDF cannot run, and `capture` with its `dropped` and `failed` counts while the failed-run capture is on), `pdf` (with `engine` and `engineMode`), `datum-tsa` (also
  `serials: jdbc | memory (acknowledged)`), `datum-webauthn`. With `fail-fast=false` a runtime that could not start is
  DOWN with the reason. A capability that cannot work because of a permanent
  platform fact (an engine on bytecode, no PDF program) is UP with `available: false` and the reason, never DOWN: DOWN is for
  outages, and a readiness probe would restart the instance for ever where nothing can fix it.
- **Info**: `info.datum` holds the engine version (`engineVersion`, the form engine the bundles were built from), the
  ABIs, the build id, the capabilities present and what each added (for example `engine`, `engineRelease` and
  `engineMode` for the WebAssembly engine, the throttle, `idempotency: memory | jdbc | custom`).
- **Endpoint** `/actuator/datum`: the runtime's state on a read (no free-text reasons or engine notes) with the effective settings report under `settings` ([Diagnostics](#diagnostics)), and on `POST` a recheck that
  reloads program overrides and warms up again, so an operator who fixed a program file brings a DOWN runtime back
  without a restart.
- **Metrics** (Micrometer, when present): `datum.runs` (timer, tags `program`, `outcome`), `datum.runs.wait`,
  `datum.runs.active`, `datum.runs.slots`, `datum.runs.rejected`, `datum.submissions`, `datum.throttled`. The busy count
  `datum.runs.rejected{reason=busy}` is told by the run slots themselves, so a refusal of any caller is counted:
  the routes, a queue consumer, a batch, the definition service.
- **Observations** (Micrometer's Observation API, when the application has an `ObservationRegistry`, which the
  actuator starter brings): `datum.submission` (low-cardinality `mode`, `channel`, `outcome`, `stage`; the form's key as the
  high-cardinality `form`, only once the form was found), `datum.sandbox.run` (`op`, `outcome`, `engine.mode`; a validation's
  slot wait inside it), `datum.pdf.run` (the same, per PDF program call), `datum.pdf` (`op`, `outcome`, `seal`, `timestamp`;
  `form`) and `datum.tsa.issue` (`channel`, `outcome`: `granted` or the RFC 3161 failure name). Each is started with its
  scope open on the calling thread, so under Spring MVC a submission's spans are children of the HTTP request's and its
  sandbox run a child of the submission (`examples/submissions` `ObservationTraceIT`); the TSA call carries the seal's
  observation and MDC to its thread, so RestClient's `http.client.requests` is a child of the seal. On WebFlux the request's
  observation is not on the thread unless Reactor's context propagation is on (`spring.reactor.context-propagation=auto` with
  `io.micrometer:context-propagation`); otherwise Datum's observations start their own traces. The names are apart from the
  meters above, which stay as they are; a meter registry makes a timer and a `.active` long task timer of each.
  `management.observations.enable.datum.sandbox=false` (or `datum.pdf`, `datum.submission`, `datum.tsa`, `datum`) switches a
  family off. Without a registry nothing changes: no observation, no meter, no wrapper around the sandbox. Keys never carry
  answers, bytes or digests.

## OpenAPI

With springdoc on the class path, every enabled route is documented, one group per capability named with the prefix
`datum-`: `datum-forms`, `datum-ui` (the builder writes, also listed in `datum-forms` because they share its paths),
`datum-submissions`, `datum-pdf`, `datum-tsa`, `datum-webauthn`. `GET /v3/api-docs/datum-forms` and the Swagger UI
group picker follow. The routes come from one catalog, `DatumEndpointCatalog` in `datum-web-core`, so a route that is
switched off is absent and a document that disagrees with the code fails a test. The 403 `access.denied` rows stay in the
catalog, described as the application's security (what `DatumSecurityResponses` answers when it is installed). `datum.web.openapi.enabled=false`
registers no group; springdoc itself is optional.

## The page glue

`datum-host.js` is a small module served beside `host.json` (`{assets}/datum-host.js`, `{assets}/host.json`). The
application writes its own pages and sets every element attribute itself; the glue only saves the plumbing:

```html
<script type="module" src="/datum/assets/datum-host.js"></script>
<script type="module">
  await DatumHost.load({ bundle: 'form' });            // imports datum-form.js from the versioned path
  DatumHost.submit(document.querySelector('#f'));
</script>
```

`DatumHost.load` reads `host.json` (build id, assets base, API base, CSRF names, and the `bindings` table of `datum.bindings.*`) once; `binding(element, { formKey })` sets the `binding` of a `<datum-form>` to the binding that route is drawn by (the page registers the design systems it loads on its own `bindings`); `submit` posts each accepted
submission to `{api}/submissions` with the CSRF header and shows the receipt or the refusals; `dataSources` builds the
loaders for `{api}/data-sources/{id}`; `builder` wires a `<datum-form-builder>` to the definition and save endpoints
(story three). `host.json` is never cached; everything under the build id is `immutable`.

### How the files are served

The versioned files (`{assets}/{buildId}/**`) are served by the **web framework's own resource handler**: Spring MVC's
`ResourceHandlerRegistry` and WebFlux's resource handler, from `classpath:/META-INF/datum/assets/`. The framework finds the
file, names its media type (its `mime.types`), answers conditional and range requests, writes the validators and the
registration's `Cache-Control: max-age=<cache-period>, public, immutable`. Datum adds one thing in front: a gate
(`AssetService.gate`, a `ResourceResolver` first in the handler's chain, so it judges exactly the path the framework would
resolve) that answers 404 unless

- the first segment is the manifest's build id (a stale page after a deploy gets a 404 that no cache keeps), and
- the rest is a plain ASCII `a/b/c.ext`: no dot or empty segment, no percent sign (so `%2e%2e` and `%2f` mean nothing), no
  semicolon (the framework drops path parameters, so `datum-builder.js;x=1` would otherwise name the file under another
  spelling), no backslash or colon, nothing outside printable ASCII (a case-insensitive file system folds characters such as
  the Kelvin sign onto letters), and
- the file is not one of an omitted feature (`datum.web.assets.omit-features` and the manifest's list) and no `WithheldAssets`
  bean withholds it: the builder's files while `datum.builder.enabled` is off. Both lists are compared case-folded as well, because
  an exploded class path on a case-insensitive file system resolves `DATUM-BUILDER.JS` to `datum-builder.js`.

Both stacks answer every miss the same way: a bare `404` with `Cache-Control: no-store` and no body, whether the gate refused
the path or the path passed and names no file. On MVC an interceptor on the assets path does it; on WebFlux a `WebFilter` ordered
after Spring Security's chain does. Both run the gate on the raw request URI (nothing decoded, no slash collapsed), so a
trailing or doubled slash and a segment ending in a dot are misses, not a spelling the framework normalises to a file. `host.json`
and `datum-host.js` are two small router-function routes asked first.

## Building from source

The reactor generates the assets itself: the root project runs `integrations/jvm/scripts/build-assets.mjs` once per build, at
`generate-resources`, from `packages/datum/dist` (so `npm run datum:build` comes first, and `node` is on the
`PATH`). It writes `integrations/jvm/target/datum-assets/<module>/` for every module, `target/datum-assets/assets.properties`
(the `Datum-*` jar manifest entries) and the kit's fixtures, and each module's pom maps its directory into the jar under
`META-INF/datum/`. Nothing generated sits beside a module's sources. `./mvnw clean` at the root removes it; a build of one
module with `-pl` does not start the root and reuses the last generation (`./mvnw -N generate-resources` makes one without
building anything, and a module that finds none refuses to build, naming that command). A dist that is missing is refused
before anything is generated, naming `npm run datum:build`; a dist older than its sources is refused by the script.

| Property | |
|---|---|
| `-Ddatum.assets.skip=true` | reuse the generation that is there (the release's deploy run does) |
| `-Ddatum.assets.allowStale=true` | generate from a dist older than its sources |
| `-Ddatum.assets.omitFeatures=pdf,journeys` | leave out the files of these features (ADR 0143) |

`npm run jvm:assets` runs the same script into the same directory. The tests' golden files are generated there too:
`target/datum-assets/<module>/test-fixtures/`, mapped by the parent pom as a test resource directory, so they are on the test class
path as `datum-fixtures/` and nothing generated sits beside `src`.

## Fixed by contract

What is not a property, and why. Each row is a floor the wire, the ABI or a security contract pins: a setting that moved it
would make the answer differ between hosts or reopen a hole the suites close. The contract is named so the number can be
traced; every one is held by a test in the library that applies it and by the conformance suites
(`packages/conformance-suite`, the Java kit and `datum-host-check`).

| Fixed value | Where | The contract that pins it |
|---|---|---|
| a run's stdout 32 MiB and stderr 64 KiB | `Budget` | the frame protocol and the hardening port (`SandboxHardeningIT`, `HardeningContract`: a 40 MiB answer is refused) |
| an outcome of at most 8 Mi UTF-16 units | `SandboxService` | the TypeScript hosts' `maxResultLength`; the `outcome_too_large` code in the error catalog |
| answer JSON nested at most 512 deep; component depth 32, raw definition depth 256 | `StrictJson`, `DefinitionDepth` | security suite DEF-06 (`definition.tooDeep`) |
| a 16-byte nonce from one `SecureRandom`; the guest globals removed | `Nonce`, `RunScript` | the frame protocol (a forged outcome is refused) |
| sandbox ABI 4.1.0 (floor 4.0.0), PDF ABI 4.0.0 (floor 4.0.0) | `SandboxAbi`, `PdfAbi` | the programs' ABI and the golden answers (`abi-4.1.json`); a program that does not answer for the floor is refused at start |
| the bounds of every `datum.runtime.*` budget (time, memory, slots, wait, body) | `ProgramLimits` | the documented clamps (a validation run is at most 60 s, a PDF run 300 s, 64 slots, a wait of 0 to 10 s) |
| SHA-256 for the canonical digest | `CanonicalJson`, `Program` | the digest contract (`canonical.json`, the JCS vectors) |
| JSON bodies nested at most 256 deep, numbers at most 1000 characters | `DatumJsonMapper` | the wire hardening vectors of the security suite (SEC-*) |
| a form key of 1 to 128 letters, digits, dots, hyphens or underscores | `FormKeys` (the one rule: the receiver, the PDF routes, the builder, the passkeys and the read routes all ask it) | the URL segment and the snapshot table's `form_key VARCHAR(128)` |
| 1000 candidate texts of at most 512 bytes per data source | `DataSourceOptions` | the sandbox's option snapshot |
| 10,000 translation entries, 64 locales, 16 KiB of text, 190 characters of key | `TranslationCatalog` | the sandbox's translation limits |
| a submitted document nested at most 64 deep | `SubmissionService` (and the receiver, on the body) | security suite REC-04 |
| 10,000 components, 2000 options a component and 50,000 in all, 200 problems, a 64-character version | `DefinitionShape` | the sandbox's definition limits and the builder contract (`BuilderContract`) |
| PDF slots `min(2, CPUs)` and a wait of at most 10 s | `SandboxSettings` | the PDF pool plan and the 503 `server.busy` contract |
| signature algorithms RSA and ECDSA with SHA-256, 384 or 512; 64 certificates of 16 KiB | `PdfVerifier` | the PDF program's `verify` op |
| the signing key rules (a usable key, a chain, an algorithm the kernel signs) | `KeyStorePdfSigner` | the PDF program's `pdf.sign` |
| imprints over SHA-256, 384 or 512 only; a stated accuracy of at most 60 s; the media types; a request of at most 1 MiB | `TimestampQuery`, `TimestampAuthority`, `TsaEndpoint`, `TsaSettings` | RFC 3161 and the timestamp contract (`TsaContract`, the openssl round trips) |
| the timestamp certificate rules | `TsaCertificateRules` | RFC 3161 section 2.3 (`id-kp-timeStamping`, critical) |
| ES256 and RS256 only, P-256 on the curve, RSA at least 2048 bits; never `crossOrigin` or a `topOrigin`; attestation `none` | `RegistrationOptions`, `CoseKey`, `WebAuthnVerifier`, `RegistrationCeremony` | the passkey contract (`PasskeysContract`); a choice of this host to verify only what it can prove |
| a challenge lives 10 s to 1 h | `PasskeyChallenges` | the ceremony's replay guard (the nonce claim is kept as long) |
| a passkey request body of at most 64 KiB; CBOR nested at most 16 deep, definite lengths only, no floats or simple values but false, true, null and undefined, integers within 64 bits, map keys integer or text and never repeated (keys compared as webauthn4j names them, so the integer -2 and the text "-2" are one key), no text key that spells an integer; a credential id of 1 to 1023 bytes; stored public keys of at most 16 KiB | `PasskeysApi`, `CborGate`, `WebAuthnVerifier`, `JdbcPasskeyRepository` | the registration refusals of `PasskeysContract`, `CborGateTest` and `WebAuthnVerifierTest` (phase 11: the pre-gate in front of webauthn4j) |
| a stop grace of 5 s and `max(2, CPUs)` stray runs; one `SecureRandom` for guest entropy; a read-only `/app` | `EndiveGuestRuntime`, `ReadOnlyFileSystem` | the engine kit (`datum-sandbox-tck`'s hardening and runtime contracts) |

The development stores (`InMemoryTsaLog` 1000 rows, `InMemoryTsaFlood` 50,000 keys), the self-signed development
certificate, the correlation header and its 12-hex id, and the English wire messages (an `ErrorTranslator` rewrites them)
are conveniences, not contracts, and are not settings either.

## The sandbox as a library

Everything that runs a WebAssembly program on the JVM is one framework-free library, `datum-sandbox`
([ADR 0176](adr/0176-one-sandbox-library-per-server-language.md)): finding and choosing an engine, the
hardened run, the Datum run protocol, the lifecycle, the settings and their clamps, and the diagnostics. A capability asks
it for a validator or a PDF kernel and knows nothing of engines, slots, nonces or ABI floors.

| Module | What it is |
|---|---|
| `datum-sandbox` | the library: `.wasi` (the generic hardened WASI run, no Datum type in it), `.protocol` (the Datum run protocol: `Program`, `RunScript`, `Nonce`, `Frame`, the ABI probes, `RunClassifier`, `VerdictMapper`, `RunSlots`, `SandboxService`, `PdfProgram`), `.runtime` (`DatumSandbox`, `SandboxSettings`), `.diagnostics`, `.events`, `.observation` |
| `datum-sandbox-endive`, `-endive-jffi`, `-endive-panama` | the Endive engine and the two native runners (selector modules the submissions starter brings) |
| `datum-sandbox-tck` | the in-process engine kit an engine's tests implement ([Engines](#engines)) |
| `datum-sandbox-spring` | the Spring binding: `datum.runtime.*` and `datum.host.*`, the beans, the lifecycle, the `runtime` health check, the `datum` actuator section, the failure analyzers |

`datum-submissions` and `datum-pdf` depend on `datum-sandbox`, and their Spring bindings on `datum-sandbox-spring`, which gives
both their runtime. `datum-pdf-spring` keeps the submissions binding only for the receiver behind `POST /pdf`. `datum-sandbox` depends on `datum-core` and
`datum-programs` and on no framework.

**Without a framework** the entry point is `DatumSandbox`, which is `AutoCloseable`. This is the shape of
`PlainJavaSandboxIT` in `datum-sandbox-endive`, which runs it with no Spring on the class path:

```java
try (DatumSandbox sandbox = DatumSandbox.builder().build()) {
    sandbox.start();
    SandboxResult result = sandbox.sandbox().validate(context, List.of(), false);
    sandbox.status().isUp();      // details() carries the engine, mode, ABIs, slots
    sandbox.explain().toString(); // the settings report
}
```

With no runtime given, the builder selects the engine named by `SandboxSettings.engine().id()` (default `endive`) from the
class path and uses the packaged programs; `close()` stops the sandbox and closes an engine it made. The settings, the
event publisher, observations, decorators, a `GuestRuntime` of your own and the diagnostics seams are optional builder
inputs. `SandboxSettings.builder()` takes every `datum.runtime.*` and `datum.host.*` key as a nullable setter and clamps
as the Spring properties do, so a plain-Java host and a Spring one run the same.

**The settings report.** `DatumSandbox.explain()` answers a `SettingsReport`: one line per key with the value in force
and where it came from, `default`, `configured`, `clamped from <asked> to <bound>`, or `REPLACED` when the application
supplied that input (its own limits, host options, engine settings or runtime) in place of the setting:

```
Datum sandbox settings:
  datum.runtime.engine = endive (default)
  datum.runtime.warm-up-runs = 1 (configured)
  datum.runtime.validation.time-limit = PT1M (clamped from PT1M30S to whole seconds in [1, 60])
```

A concurrency of `0` shows the slot count it resolves to beside it. With Spring the report is logged once at start
(see [Diagnostics](#diagnostics)); the clamp WARNs are produced from the same report.

## Engines

The programs run in QuickJS compiled to WebAssembly, and a WebAssembly *engine* runs it on the JVM. The seam is an SPI in
`datum-sandbox`'s `.wasi` package (ADR 0152, ADR 0176); **Endive is the only engine** (`datum-sandbox-endive`, which the
submissions starter brings with its JFFI and Panama runners). GraalWasm was measured as a second engine and is not offered.

**The SPI.** An engine module registers a `GuestRuntimeProvider` in
`META-INF/services/com.argusvane.datum.sandbox.wasi.GuestRuntimeProvider` and is found with
`java.util.ServiceLoader`. A provider has an `id()` (`endive`), an `availability()` (`Available(notes)` or
`Unavailable(reason)`: are its classes and native code loadable here, is the JDK one it supports) and
`create(EngineLimits, EngineSettings)`, where `EngineLimits` holds the least and greatest memory a run may be given. The
`GuestRuntime` it makes runs one `GuestRun` (the files of the guest's read-only `/app`, its argv, its stdin and a `Budget`)
and answers a `RunOutput`; it reports an `EngineInfo` (id, the engine's release, its mode: a native runner's name or
`bytecode`, and notes), which health, `info.datum` and `SandboxReadyEvent` carry instead of any one engine's fields.
`GuestRuntimes.discover(loader)` lists what the class path holds (a provider that cannot be loaded is listed as broken,
never hides the others) and `GuestRuntimes.select(id, loader)` picks one. Whether the PDF program can run is the
sandbox's call (an engine in mode `bytecode` cannot), not a field of the engine.

**Selection.** The binding selects by `datum.runtime.engine` (default `endive`) through the providers on the
application's class loader; no class name is configured and nothing is loaded by reflection on a name. An id no provider
has, an unavailable engine, or two providers claiming one id stop the start, whatever `datum.runtime.fail-fast` says (a
configuration error, not a program to prove later), with the provider's reason and the engines found, printed as the
Description and Action shown under [Configuration](#configuration).

An application's own `GuestRuntime` bean wins (`@ConditionalOnMissingBean`), and the property is then not read; such a
runtime overrides `engineInfo()` to say what it is (the default reports its class name and mode `unknown`).

**Bytecode.** An engine whose `EngineInfo` says mode `bytecode` (Endive with no native code for the platform, or with no
runner it can use) stops the start unless `datum.runtime.allow-bytecode=true`. `DatumSandbox.start()` decides it on the
`EngineInfo`, before any program is proved, so an application's own runtime that reports `bytecode` is held the same way;
a runtime that reports `unknown` is not. It is not softened by `datum.runtime.fail-fast=false`: fail-fast is for a proof a
recheck can pass later, and the platform does not change between rechecks. The refusal is `EngineBytecodeException` (a
`DatumConfigurationException`), which the failure analyzer prints as a Description with the engine's notes (for Endive,
the platform and the runners passed over) and an Action with the two fixes:

```
Description:
The endive engine would run the programs as JVM bytecode on this platform, and datum.runtime.allow-bytecode is false, so
Datum does not start (on bytecode, validation is several times slower and the PDF program cannot run). The engine says:
<the engine's notes>

Action:
Run on a platform the engine has native code for, with a native runner it can use (the engine's words above name what is
missing), or set datum.runtime.allow-bytecode=true to start on bytecode anyway (validation runs, slower, and the PDF
routes answer 503).
```

A host that catches the refusal finds the runtime DOWN (not ready) with a fixed reason that leaves the notes out, and every
run refused with 503 `server.unavailable`; a recheck does not bring it up.

**What an engine implements.** The engine-neutral half of a run is `datum-sandbox`'s `RunHarness`: a platform worker thread
per run, the stop at the time budget (the future is cancelled and the thread interrupted only while `_start` runs, never
during set-up, so linear memory mapped by an instance being built cannot leak), a fresh read-only in-memory `/app`
(Jimfs) holding only the run's files, the bounded stdout and stderr, the bound on stopped runs that outlive their
grace, and the reading of how a run ended. An engine implements only `GuestEngine`: wire the run's streams, arguments,
entropy and directory into its WASI layer, instantiate the module with the budget's memory limit without starting it,
call `_start`, and say what its own exceptions mean (an exit with its code, a trap, an interrupt, its wrap of the JVM out
of heap). `EngineSettings` carries the stop grace (5 s) and the stray bound (one per CPU, at least two). Jimfs is an
optional dependency of `datum-sandbox`; an engine module declares it. The `.wasi` package imports no Datum type (a
boundary test holds it to the JDK, SLF4J, JSpecify and Jimfs), so the generic run is usable with no Datum program.

**The engine kit.** `datum-sandbox-tck` is the in-process counterpart of the host kit: JUnit 5 contract interfaces an
engine module's tests implement against its `GuestRuntime`, with the real programs (`datum-programs`) and the fixtures
pinned by the conformance suite and the PDF kernel, carried in the kit's jar:

| Contract | Holds the engine to |
|---|---|
| `WasiHardeningContract` | the generic run alone, with no Datum program: a read-only `/app` of exactly the run's files as the only preopen, no environment, the budget's time and memory, output caps that stop the run even when the guest catches the write, every byte kept however the run ended, runs stopped together, instances closed, the stray bound, a closed runtime |
| `RuntimeContract` | the private read-only `/app` and nothing reachable outside it (dot segments, absolute paths, symbolic links, `import()` of a host file), every way a run ends with the started marker kept, the output caps, a loop stopped at its budget and the next run answering, a host interrupt, QuickJS's own out-of-memory exit, parallel streams, eight runs stopped at once, shutdown, and a hundred settled runs that add less than 4 MiB of heap after GC and no thread (the slope after fifty runs, not one delta; an engine with a known leak declares it with `knownHeapLeak()` and the check reports it as aborted until the leak is gone, then fails) |
| `SandboxHardeningContract` | the sandbox hardening through `SandboxService`: a stale program refused by the ABI probe, a rule module that cannot forge an outcome, rebind the kernel or write outside the frame, thrown words, the output cap, the depth guard, the loop, memory and recursion stops, the smoke run |
| `GoldenVerdictsContract` | the golden outcome byte for byte and the six control verdicts |
| `PdfRenderContract` | the documents rendered to their pinned hashes (for a PDF-capable engine) |

```java
class MyEngineRuntimeIT implements RuntimeContract, SandboxHardeningContract {
    private static final MyEngineRuntime RUNTIME = new MyEngineRuntime();

    @AfterAll
    static void stop() { RUNTIME.close(); }

    @Override public GuestRuntime runtime() { return RUNTIME; }
    @Override public GuestRuntime newRuntime() { return new MyEngineRuntime(); }
}
```

`datum-sandbox-endive`'s `EndiveRuntimeIT`, `WasiHardeningIT`, `SandboxHardeningIT`, `GoldenIT` and `PdfRenderIT` are the
implementations here (on JFFI, and again on Panama on Java 25); its own tests cover what only Endive has (the runner
selection, the six native targets, the bytecode fallback, the native-memory bookkeeping of a stopped set-up).

## Diagnostics

Three tools answer "what is the sandbox doing, and why did that run fail". They sit beside the runs, never in them: none
can change a run's answer, and none blocks a run. Their keys are `datum.runtime.diagnostics.*`:

| Property | Default | Meaning |
|---|---|---|
| `datum.runtime.diagnostics.trace` | `off` | which runs get a trace line: `off`, `failures` or `all` (the proofs and warm-ups included). Any other word stops the start |
| `datum.runtime.diagnostics.report` | `true` | log the effective settings once at start, at INFO on the logger `datum.sandbox.settings` |
| `datum.runtime.diagnostics.capture.enabled` | `false` | keep failed runs on disk for debugging (see the warning below) |
| `datum.runtime.diagnostics.capture.directory` | none | where captures go; required when the capture is on and no `RunCaptureSink` bean of yours is supplied |
| `datum.runtime.diagnostics.capture.max-runs` | `20` | the most captures kept; the oldest go first. Below 1 stops the start |
| `datum.runtime.diagnostics.capture.max-bytes` | `64MB` | the most bytes all kept captures take together; one capture larger than this is dropped. Below 1 byte stops the start |
| `datum.runtime.diagnostics.capture.queue-bytes` | `64MB` | the most bytes of captures waiting to be written; one that does not fit is dropped and counted. Below 1 byte stops the start |

**The run trace.** One line per traced run at INFO on the logger `datum.sandbox.trace`, with these fields in this order,
as `key=value` pairs:

```
run program op abi engine mode slotWaitMs prepareMs instantiateMs startMs totalMs termination exit outcome stdinBytes stdoutBytes stderrBytes capture
```

`run` is a random 12-hex id (it names the capture too, and is not the run's nonce), `program` is `sandbox` or `pdf`,
`mode` is the engine's mode, the times are milliseconds with one decimal (`-` when the engine does not measure a step),
`termination` and `exit` are how the run ended, and `outcome` is the protocol's word for it: `verdict` and `refused` are
the program's own answers (a stale program's refusal of the probe, `abi_mismatch`, is a `refused`); anything else
(`budget`, `memory`, `trap`, `threw`, `output_cap`, `outcome_too_large`, `not_json`, `no_outcome` (a PDF answer with no
boolean `ok` included), `frame`, `interrupted` (a stop, a cancel, or the JVM out of heap), `unavailable` (the runtime could not start the run, or refused it past the stray bound), `error`) is a **failed run**, which is what `failures`
traces and what the capture keeps. A run cancelled past the host's backstop whose thread did not end is traced with `termination=stuck` and the outcome `budget` (the metric is `datum.runs{outcome=stuck}`), so it stays apart from an ordinary budget stop in the trace while its caller gets the same answer. `capture` is the id the failed run was queued under, or `dropped`. A line never holds an
answer, a definition or a byte of stdin or stdout, only their lengths. A run refused because no slot was free, or before it
was made, makes no line, under `all` too. Supply a `RunTrace` bean (or `DatumSandbox.Builder.runTrace`) to route the
`TraceRecord` somewhere else; it is called on the run's thread after its slot is released, and one that throws is logged
and the answer stands.

**The failed-run capture.** For a failed run, the capture writes `stdin.bin`, `stdout.bin`, `stderr.bin`, `run.js` and a `meta.json`
(the trace fields and the settings report) under `<directory>/<id>/`, so a failure can be replayed outside the host. The
write happens on a thread of its own from a queue bounded in bytes; a capture that does not fit is dropped, counted and
WARNed at most once a minute.

> **A capture holds the submitted answers and the form definition, which are personal data, in clear text on disk.**
> Turn it on to debug, and off again after. The start logs one WARN saying so.

The directory is the operator's to protect. The start refuses (naming `datum.runtime.diagnostics.capture.directory`)
unless it is a real directory, not a link, owned by the JVM's user, with no group or other permission, on a POSIX file
system; it is created `0700` if missing, files are `0600` from creation, and on macOS it must also carry no access control
list (inherited ones count: remove the parent's with `chmod -N`). The checks are repeated before every write. Windows and
ACL-only file systems are refused. The JDK reads no macOS ACL, so the sink asks `/bin/ls -lde` (an absolute path, no shell,
`--` and the directory as one argument, a timeout, bounded output) at open and before every write and refuses on a `+` in the mode column or any entry line; a check
that cannot run, or whose answer does not parse, refuses too (it fails closed). Linux POSIX ACLs are not read: a named entry
shows through the group bits, which the mode check refuses. A capture is complete or absent under its name (it is written into
`.partial-<id>`, every file created `0600`, `CREATE_NEW` and `NOFOLLOW_LINKS` and forced to disk before the rename, and the directory renamed in one move), and eviction renames `<id>` to `.evict-<id>` before deleting, so a name never holds
half a capture and only directories named like captures are touched. A `.partial-*` or `.evict-*` entry left by a JVM that
died mid-write is never removed for you; the start WARN counts them. Supply a `RunCaptureSink` bean to keep captures elsewhere (an object store, say): the
bounds, the queue and the one writer thread stay the library's.

The capture's remaining rules. The owner check compares the directory's owner with the owner of a probe file (`0600`,
removed at once) the sink creates in it, so it is the effective user and not whatever `user.name` says. Before each write
the directory is checked again by file key: a best effort by path, not a handle, and what makes a swap harmless is that
every file is created `0600` with `CREATE_NEW` and `NOFOLLOW_LINKS`. Names come from the capture id alone (a time and a random run id) and hold
no request text. The oldest captures go first, by id (which sorts by time), never the capture just written. A bound below
1 refuses the start and nothing clamps. A start refuses (`IllegalStateException`) while the writer of the last start is
still finishing a write after its stop; a start that fails after its writer began stops that writer, and the capture then
takes nothing. Whatever a sink or a trace throws, an `Error` included, is caught, logged by class and counted, and the run's
answer stands; only a `VirtualMachineError` that says the JVM itself is broken (`InternalError`, `UnknownError`) is
rethrown on the run's thread, and the writer thread counts every failure and goes on. The reasoning is in
[ADR 0176](adr/0176-one-sandbox-library-per-server-language.md).

**The settings report.** At start, before the programs are proved, one block at INFO on `datum.sandbox.settings`: every
`datum.runtime.*` and `datum.host.*` key with its value and source (see [The sandbox as a library](#the-sandbox-as-a-library)),
the engine's id, release, mode and notes, each program's sha256 and ABI, and where the trace and the capture go. URL
passwords and query values are masked. `GET /actuator/datum` carries the same report under `settings`, without the
capture directory, a program override's location or the engine's notes (a read names no host path).

## Heap and pool guidance

Each validation or PDF run is one QuickJS instance in a fresh in-memory file system. Under a native runner its
WebAssembly memory is off the Java heap; each instance also takes a few MiB of heap (a warm run allocates under 8 MiB
on the Panama runner and under 2 MiB on JFFI, the program's copy included) and about 0.4 s (figures measured on a
developer laptop) to set up. A run's output is held on the heap too, up to its cap. A container's memory should
therefore cover roughly: slots times the per-run memory limit (off-heap), plus the heap, which holds the
application's own heap and slots times 16 MiB (`MemoryBudget.SETUP_HEAP`, twice the larger measured figure). The
defaults are 5 s and 32 MiB for validation (slots: one per CPU) and 15 s and 256 MiB for PDFs (slots: the smaller of
2 and the CPUs).

At start the runtime (`MemoryBudget`) makes two checks and logs one WARN for each that fails. The first compares the
slots times the memory budgets with the memory the JDK reports as available to the JVM
(`OperatingSystemMXBean#getTotalMemorySize`) minus the heap's maximum: when every slot full at once would not fit, the
kernel stops the process with no Java error. That figure is the container's memory limit when the JVM runs under one,
and **the host's physical RAM when no container limit applies**, so on a bare host the check only says whether the
slots outgrow the machine; a runtime without `jdk.management` skips it. The second compares the slots times 16 MiB
(plus the linear memory, which a bytecode engine keeps on the heap) with the heap's maximum: a heap that runs out
mid-run fails every run in flight (503), not only one. Lower `datum.runtime.validation.concurrency`, `datum.runtime.pdf.concurrency` or the memory budgets, lower
`-Xmx`, or give the container more memory. Warm validation takes about 0.45 s and a PDF about 3.3 s, so a slot count
above the number of CPUs buys nothing. A request that cannot get a slot within `wait` answers 503 `server.busy` with
`Retry-After`. A runtime with no native provider for the platform does not start unless `datum.runtime.allow-bytecode=true`
([Engines](#engines)); allowed, it runs on bytecode with its linear memory on the Java heap, says so on health
(`engineMode: bytecode`, `pdfCapable: false`) and reports the PDF path unavailable (503) rather than run it slowly.

## Security notes

- **CSRF.** The endpoints are ordinary POSTs, so Spring Security's CSRF applies. The glue reads the token from the
  `XSRF-TOKEN` cookie (or a `<meta name="_csrf">`) and sends it as `X-XSRF-TOKEN`; the names are
  `datum.web.csrf.*`, and `host.json` tells the glue. The recipe that matches:
  `CookieCsrfTokenRepository.withHttpOnlyFalse()` with a plain `CsrfTokenRequestAttributeHandler` (the masking handler
  expects a masked token the page cannot compute) and a small filter that touches the deferred token so the first
  save of a page already has its cookie. [examples/ui-builder-jpa](../integrations/jvm/examples/ui-builder-jpa/README.md)
  has it in full. The timestamp server refuses a request that carries any cookie (403, by default) so a browser cannot be
  made to ask it.
- **Who may call a route is Spring Security's.** Datum ships no access policy (framework-first, as ADR 0152
  records): a route that is switched on is open until the application's filter chain says otherwise. With
  `spring-boot-starter-security` on the class path, `datum-spring-web` gives the chain two things and secures nothing
  itself:
  - **`DatumRequestMatchers`** (servlet) and **`DatumExchangeMatchers`** (WebFlux), beans with one matcher set per
    capability (the route groups are `DatumRouteGroups` in `datum-web-core`, from the endpoint catalog), built from the paths the routes are mapped under (`datum.web.api.path`, `datum.web.assets.path`,
    `datum.tsa.path`, `datum.webauthn.path`, as your own `WebSettings`, `TsaSettings` or `PasskeySettings` bean holds
    them when you define one), so the rules follow the routes wherever they move: `formsRead()` (the public copy of a
    definition and its translations), `builderReads()` (the full definition, `?public=false`, server-secret rules
    included; a 404 whatever the rules say while `datum.builder.enabled` is off), `builderWrites()`, `dataSources()`, `submissions()`, `validate()`, `dryRun()`,
    `inspect()`, `pdf()` (render, fill, sign), `pdfVerify()` (verify and the server's certificate), `passkeys()`,
    `tsa()`, `assets()`, and `all()`. A `GET` route's matcher also takes `HEAD`. The definition route belongs to
    `formsRead()` only without `public` or with `public=true` alone; any other value is `builderReads()`.
  - **`DatumSecurityResponses`** (servlet) and **`DatumServerSecurityResponses`** (WebFlux): an access-denied handler
    answering 403 `access.denied` and an authentication entry point answering 401 `unauthorized` with the
    `WWW-Authenticate` challenge you pass, both `no-store` JSON (problem details under
    `datum.web.api.problem-details`). Install them for Datum's routes only, so your login page keeps working. On
    WebFlux hand the access-denied handler to the CSRF spec as well
    (`.csrf(csrf -> csrf.accessDeniedHandler(responses.accessDeniedHandler()))`): Spring Security's WebFlux `CsrfSpec`
    does not take the exception-handling handler, so without it a missing CSRF token is a plain-text 403, where the
    servlet chain answers `access.denied` JSON. [examples/webflux-pdf](../integrations/jvm/examples/webflux-pdf/README.md)
    does it.

  ```java
  @Bean
  SecurityFilterChain chain(HttpSecurity http, DatumRequestMatchers datum, DatumSecurityResponses responses) throws Exception {
      return http
          .authorizeHttpRequests(requests -> requests
              .requestMatchers(datum.builderWrites(), datum.builderReads(), datum.dryRun(), datum.inspect()).hasRole("EDITOR")
              .requestMatchers(datum.dataSources()).authenticated()
              .requestMatchers(datum.formsRead(), datum.submissions(), datum.validate(), datum.assets()).permitAll()
              .anyRequest().authenticated())
          .httpBasic(Customizer.withDefaults())
          .exceptionHandling(exceptions -> exceptions
              .defaultAuthenticationEntryPointFor(responses.authenticationEntryPoint("Basic realm=\"forms\""), datum.all())
              .defaultAccessDeniedHandlerFor(responses.accessDeniedHandler(), datum.all()))
          .build();
  }
  ```

  The lines every chain writes the same way are opt-in factories, never beans (Spring Security applies every
  `Customizer<HttpSecurity>` bean to every chain, which would take yours from you). `responses.recipes()` gives them:
  `exceptionHandling(datum.all(), challenge)` is the two `...For(.., datum.all())` lines above;
  `csrfForGlue()` is the cookie CSRF recipe the page glue reads (`CookieCsrfTokenRepository.withHttpOnlyFalse()` on the
  `datum.web.csrf.*` names, with the plain request handler) and `csrfCookieFilter()` the filter that loads the deferred
  token so the cookie is written on every response. On WebFlux `DatumServerSecurityResponses#recipes()` has the same three
  (`csrfForGlue(matcher)` also limits CSRF to the writes you name, and gives the `CsrfSpec` Datum's denied handler):

  ```java
  DatumSecurityRecipes recipes = responses.recipes();
  http.csrf(recipes.csrfForGlue())
      .addFilterAfter(recipes.csrfCookieFilter(), CsrfFilter.class)
      .exceptionHandling(recipes.exceptionHandling(datum.all(), "Basic realm=\"forms\""));
  ```

  A rule for one of Datum's routes belongs in the chain too: the `webflux-pdf` example keeps its timestamp server to
  loopback callers with `.matchers(datum.tsa()).access(loopbackOnly())` (Spring Security's `IpAddressReactiveAuthorizationManager`
  for `127.0.0.0/8` and `::1`), not a filter beside the chain.

  **Per form**: the matchers are Spring Security's `PathPatternRequestMatcher`s, so the path variables reach an
  `AuthorizationManager` through `RequestAuthorizationContext` the standard way:
  `.requestMatchers(datum.builderWrites()).access((auth, ctx) -> new AuthorizationDecision(editors.mayEdit(auth.get(), ctx.getVariables().get("key"))))`
  (a definition route's `key` may carry the catalog's `@version` suffix: strip it). A query parameter is
  `ctx.getRequest().getParameter("form")` (the data-source route's `?form=`). On WebFlux the same with
  `AuthorizationContext.getVariables()` and `.matchers(...).access(...)`. A per-form rule covers only the matchers it
  is written on: one on `formsRead()` does not cover `builderReads()`, whose `?public=false` copy of the same form
  carries its server-secret rules, so repeat it there (and on `builderWrites()`) for a form some editors may not see.

  Where the form is in the body (a delivery, a check, a dry run, a PDF) no request matcher can see it: a
  `SubmissionPreCheck` is asked for every one of those (the PDF endpoints run the receiver's dry run), and its
  `IncomingSubmission` carries the form key and `principal()`, the caller your chain admitted, so it refuses one form to
  one person with its own code (`Reject.of("access.denied")` keeps the wire's, 403, as every code is by default; a
  `PreCheckStatuses` bean, `PreCheckStatuses.bySuffix()` or your own, maps codes to other statuses). Read the caller there, not
  from `SecurityContextHolder`: on WebFlux the receiver runs on the elastic scheduler, where no thread-bound security
  context exists.

  Two body-named forms have no per-form hook. The passkey ceremony (`POST {webauthn}/challenge` and `/register`)
  names its form in the body and asks no pre-check, so who may make a passkey is `passkeys()` as a whole (the
  `GET {webauthn}/passkeys?form=` list's form is a query parameter a matcher can read); a passkey made at a form the
  person may not use signs nothing there, because the delivery it would sign still passes your pre-check. And
  `POST {api}/forms` creates under the body's id with no principal in `FormDefinitionRepository.save`: on a servlet
  stack `save` runs on the request thread, so `SecurityContextHolder.getContext().getAuthentication()` names the
  caller there; on WebFlux it does not (the elastic scheduler again), so restrict who may create at all with a rule
  for `POST {api}/forms` ahead of `builderWrites()`, and keep per-id rules to the servlet stack or to the ids'
  shape.

  **Without a chain** every route that is on is open. That is right for a public form; for the builder's writes, the
  passkey endpoints and the timestamp server in client mode (as its `TsaSettings` bean says, yours if you replaced it) the start logs a WARN (`datum.web`) when no
  `SecurityFilterChain` (or `SecurityWebFilterChain`) bean and no Spring Security filter proxy exist: "these routes are
  open: add spring-boot-starter-security and secure DatumRequestMatchers". Spring Security's default chain (everything
  needs a sign-in) counts as a chain on both stacks: on a servlet stack Spring Boot declares it as a bean, on WebFlux
  Spring Security builds it inside its filter proxy (`WebFilterChainProxy`), which is what the check looks for there. The refusals are 401 or 403; without Datum's handlers their bodies are Spring
  Security's own (none), which both host kits accept. A refusal comes before the route's own checks, so a route that
  is switched off answers 401 or 403 rather than 404 to someone the chain refuses.

  **What stays Datum's**: the passkey context. A form's Test context is the one way to make a
  passkey at a form while `datum.webauthn.register-at-submit` is off, and its name is in the body, so the module keeps
  that rule: only the roles in `datum.webauthn.test-roles` (read from the Spring Security authentication; empty, the
  default, means nobody) may use it, anything else is `signing.context`. The match is exact: it does not follow a
  `RoleHierarchy`, because this check gates who may make test passkeys and a hierarchy would admit more principals than the roles
  named. The rule is a `PasskeyTesters` bean (a one-method `Predicate<Principal>`): declare one of your own for another rule
  (an OIDC group claim, a tenant check) and the default backs off, without replacing the whole `PasskeysApi`. The facades keep the principal only where
  Datum's own work needs it: the passkey subject, the data-source provider's call, and the accepted submission's
  client facts. Examples: [ui-builder-jpa](../integrations/jvm/examples/ui-builder-jpa/README.md) (MVC, form admins
  build) and [webflux-pdf](../integrations/jvm/examples/webflux-pdf/README.md) (WebFlux), [passkeys](../integrations/jvm/examples/passkeys/README.md).
- **Memory-store policy.** Two kinds of in-memory default, two behaviours. State that a second instance or a restart
  would get *wrong in a way that matters for trust* **refuses to start** unless a SQL store exists or the application
  acknowledges a single instance: the passkey store, the replay guard and the challenge claims
  (`datum.webauthn.allow-memory-stores=true`), and the timestamp server's serial allocator and log
  (`datum.tsa.allow-memory-stores=true`; a second instance could issue the same serial twice). With the flag the
  start logs a WARN and the health detail says `memory (acknowledged)`. State that is only *less effective* when it
  is per instance **starts with a WARN and a health or info detail**: the submission throttle and the timestamp server's
  request counter (the bindings' development defaults, see "Rate limiting"), the definition snapshot
  store, and the idempotency store (a retried submit attempt is answered with the first receipt, and a reused key
  refused, only on the instance that took it). Supply a `SubmissionThrottle` bean for one limit across instances, or one `DataSource` and the V100/V200
  scripts. The development default takes `datum.web.throttle.limits.<kind>` (a limit for `submit`, `validate`, `test`, `pdf` or
`register` of its own) and `datum.web.throttle.max-keys` (the windows it holds); the in-memory idempotency store takes
`datum.submissions.idempotency.memory-size`. They shape the defaults the binding supplies and are not read once you supply
your own bean.

The throttle sees the address Spring's `ForwardedHeaderFilter` left on the request, so behind a proxy turn
  that on (`server.request.header.forwarded.strategy`). An IPv6 client is counted by its /64.
- **Unknown input.** The receive pipeline refuses a non-JSON content type (415), an oversized body (413) and bad JSON
  (400) before it reads anything, and a sandbox that cannot run (503) never lets a document through unchecked.

## Rate limiting

Rate limiting is the framework's and the application's concern, not Datum's (framework-first). The libraries
define three contracts and the Spring bindings ship a single-instance development default for each, each logging a WARN
that it counts per instance: `SubmissionThrottle` (`check` and `record` by a `ThrottleKey`; the default is
`InMemorySubmissionThrottle` in `datum-submissions-spring`, configured by `datum.web.throttle.*`), `TsaFlood` (the
timestamp server's request counter; `InMemoryTsaFlood` in `datum-timestamp-spring`, `datum.tsa.flood.*`) and
`PasskeyThrottle` (the passkey challenge and registration limit; by default `SubmissionsPasskeyThrottle` in
`datum-webauthn-spring`, which counts under the submission throttle's `REGISTER` kind, so one bean limits both; it answers
`check(ip, formKey, principal)` with a `PasskeyThrottle.Decision`, `ALLOW` or `Deny(retryAfter)`, so "allowed" and "retry
now" cannot be confused as a `null` and a zero `Duration` could be).
Replace any of them with a bean of the same type: a gateway's limit, a Redis-backed counter, or a token bucket library.
A sketch with Bucket4j (not shipped or tested here; keep the map bounded, with Caffeine for instance):

```java
@Bean
SubmissionThrottle submissionThrottle() {
    Map<String, Bucket> buckets = new ConcurrentHashMap<>();
    Function<ThrottleKey, Bucket> bucketOf = key -> buckets.computeIfAbsent(key.kind() + "|" + key.ip() + "|" + key.formKey(),
        k -> Bucket.builder().addLimit(Bandwidth.builder().capacity(60).refillIntervally(60, Duration.ofMinutes(1)).build()).build());
    return new SubmissionThrottle() {
        @Override
        public ThrottleDecision check(ThrottleKey key) {           // reads only: Datum calls record() when the request counts
            EstimationProbe probe = bucketOf.apply(key).estimateAbilityToConsume(1);
            return probe.canBeConsumed() ? ThrottleDecision.ALLOW : new ThrottleDecision.Deny(Duration.ofNanos(probe.getNanosToWaitForRefill()));
        }

        @Override
        public void record(ThrottleKey key) {
            bucketOf.apply(key).tryConsume(1);
        }
    };
}
```

The throttle sees the address Spring's `ForwardedHeaderFilter` left on the request: behind a proxy, enable it
(`server.request.header.forwarded.strategy`). An address is counted as `CountedAddress` (datum-core) gives it: an IPv6
client by its /64, since one host is commonly handed a whole /64, and an IPv4-mapped address as its IPv4 address. `datum.web.throttle.enabled=false` removes the default and leaves the limit to the
gateway.

## The forms files

`datum.forms.locations` is a list of resource patterns; the default repository is read-only and reads each file as one
definition whose `id` is its key (the file name when it has none). A bad file stops the start, naming the file. Every
pattern, `classpath:`, `classpath*:` and `file:` alike, is read by Spring's own resource pattern resolver, so it means
what it means everywhere else in a Spring application (Ant-style `*`, `?` and `**`; results sorted by location):

- `file:/etc/datum/forms/intake.json` is that one file.
- `file:/etc/datum/forms/*.json` is the `.json` files directly in that directory.
- `file:/etc/datum/forms/**/*.json` is the `.json` files in that directory and below it.

A location that matched nothing logs `The Datum form location "..." matched no resources; check
datum.forms.locations.`. Spring walks the whole tree below the base of a pattern, so a directory in it that cannot be
read makes Spring log "Failed to search in directory" and find nothing below that base: the start goes on without
those forms, and the WARN above names the location. There is no form list route: which forms exist is the
application's own query (a repository method, an actuator endpoint). Store forms in a database by providing your own
`FormDefinitionRepository` (`find`, `save`, `current`).

## Testing your application

`datum-spring-boot-starter-test` (test scope) gives `@AutoConfigureDatum` (a test context with a `FakeGuestRuntime`
in place of the sandbox, so tests do not need the native runtime), `DatumTestForms` (fixture definitions and an
in-memory repository), `DatumMockMvc`, `DatumMockMvcTester` (Boot 4's AssertJ `MockMvcTester`), `DatumWebTestClient` and
`DatumRestTestClient` (`RestTestClient`) helpers, `DatumApiDocs` and `DatumTck`.

`@AutoConfigureDatum` is built as Boot's own test annotations are: `@ImportAutoConfiguration` with a
`META-INF/spring/com.argusvane.datum.starter.test.AutoConfigureDatum.imports` file, so the fake backs off for your own
`GuestRuntime` bean whatever order your test configurations load in, appears in the condition report, and composes with
slices (`@WebMvcTest` together with `@AutoConfigureDatum`). `testForms = true` sets `datum.test.forms=true`. The helpers take
the API base from your configuration: `DatumMockMvc.of(mvc, environment)`, `DatumMockMvcTester.of(tester, environment)`,
`DatumWebTestClient.of(client, environment)` and `DatumRestTestClient.of(client, environment)` read `datum.web.api.path`
(`/api` when you set none), where the one-argument constructors keep the literal `/api`.

### The host test kit (TCK)

The wire contract of every endpoint exists as JUnit 5 interfaces in `datum-host-tck`
([README](../integrations/jvm/tck/datum-host-tck/README.md)); the Spring examples run them, and a team can run them
against its own deployment. A test class implements the contracts of the capabilities it has and returns a target:

```java
@SpringBootTest(webEnvironment = RANDOM_PORT)
@TestPropertySource(properties = {"datum.web.api.endpoints.submissions=true", "datum.web.api.endpoints.validate=true",
    "datum.web.api.endpoints.definition=true", "datum.web.api.endpoints.test=true", "datum.web.assets.enabled=true",
    "datum.forms.locations=" + DatumTck.FIXTURE_FORM_LOCATION})
class MyHostIT implements SubmissionsContract, SubmissionsDryRunContract, FormsContract, AssetsContract {
    @LocalServerPort int port;
    @Override public HostTarget target() { return DatumTck.local(port); }
}
```

What each capability needs from the application under test:

| Capability | Switch or key |
|---|---|
| `submissions`, `forms`, `assets` (besides the switches below) | the kit's fixture form in `datum.forms.locations` (`DatumTck.FIXTURE_FORM_LOCATION`, or the same file served by another repository) |
| `submissions` | `datum.web.api.endpoints.submissions=true` and `.validate=true` (every route is opt-in) |
| `forms` | `datum.web.api.endpoints.definition=true` |
| `assets` | `datum.web.assets.enabled=true` |
| `submissions-test` | `datum.web.api.endpoints.test=true` (the dry-run route is opt-in) |
| `builder` | `datum.builder.enabled=true`, a security chain that lets the test person build and refuses the others (401 or 403, any body); the target names the form a person may build (`HostTarget`; `datum.tck.build-form` and `datum.tck.builder-enabled=true` for `HostTck`) |
| `pdf` | the PDF starter; the seal tests also need a signing key (`datum.pdf.signing.*`) and the target's `pdfSigning` (`datum.tck.pdf-signing=true` for `HostTck`); the per-route test (two routes on one host get each route's catalog PDF theme) needs the fixture form and its copy (`DatumTck.FIXTURE_FORM_B_LOCATION`) in `datum.forms.locations`, `datum.bindings.*` routing the copy to a binding whose PDF theme is the kit's `datum-host-check-pdf` (`datum.bindings.pdf-themes.datum-host-check-pdf=` `DatumTck.FIXTURE_PDF_THEME_LOCATION`) and the fixture form to another, and the target's `pdfBindings` (`datum.tck.pdf-bindings=true`); they are skipped, not passed, without it |
| `tsa` | `datum.tsa.enabled=true` |
| `passkeys` | `datum.webauthn.enabled=true` with a form that asks for a signature, named by the target (`datum.tck.signing-form` for `HostTck`) |
| `hardening` | a test deployment that registers the kit's hostile rule module for the fixture form (a `SandboxRulesProvider` answering `TckFixtures.hardeningRules()`); never in a deployment people use |
| `runtime-down` | a test deployment started with `datum.runtime.programs.sandbox` set to the kit's stale program and `datum.runtime.fail-fast=false` |
| `flood` | the default throttle with a limit the run can exceed, and an address limit it can exceed (FLD-02 posts up to 400 times; the submissions example uses `datum.web.throttle.limit=30` and `datum.web.throttle.address-limit=200`; FastAPI: `DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200`); it runs last because it spends the request budget |

Against a deployed application, the runner is `HostTck`:

```sh
java -cp "datum-host-tck.jar:<junit-jupiter, junit-platform-launcher, assertj, jackson-databind>" \
  com.argusvane.datum.tck.HostTck \
  datum.tck.base-url=https://forms.example datum.tck.capabilities=submissions,forms,assets
```

Exit **0** when every selected contract passed and each named capability had at least one test succeed; **1** when a
test failed; **2** for a usage error, including a named capability that asserted nothing because every test was skipped
for a missing key (`builder` without `build-form`, `passkeys` without `signing-form`). The submissions, builder and
passkeys contracts write, so aim them at a test deployment. A host that guards its writes with Spring Security's cookie
token takes `datum.tck.csrf=cookie:XSRF-TOKEN:X-XSRF-TOKEN`, the Java twin of the Node kit's `--csrf`: the token cookie any
earlier reply set (else the cookie of a `GET` of the base URL) is echoed as the header on every write and as the cookie on
every request, one token for each of the visitor and the two people.

The same contracts exist as a command with no JDK: `datum-host-check` in the conformance suite
(`packages/conformance-suite`, [Host conformance](conformance-suite.md#host-conformance-datum-host-check)) is the Node
port, case for case, and is the gate every other host runs; it works against any Spring deployment:

```sh
datum-host-check --endpoint https://forms.example --capabilities submissions,submissions-test,forms,assets,flood
```

It takes the same keys (`--builder-enabled`, `--pdf-signing`, `--signing-form`, `--build-form`, `--header`,
`--person-header`, `--csrf cookie:XSRF-TOKEN:X-XSRF-TOKEN`), writes `report.json` and `report.md` with `--out`, and
exits 0 to 4. `datum-host-check fixtures --out <dir>` writes the fixture form, the hostile rule module and the stale
program for the two test deployments (`hardening`, `runtime-down`); the submissions example registers the hostile
module with `--datum.example.hardening-rules=<dir>/hardening-rules.js --datum.runtime.validation.memory=512MB`. The
flood case spends the throttle: boot a fresh application for each run (the Java kit and the Node kit never share one),
with `--datum.web.throttle.limit=30 --datum.web.throttle.address-limit=200`; at the default address limit of 600, FLD-02
never reaches 429.

### Tests on real databases

The stores' tests run on H2 in its PostgreSQL and MySQL modes in every build. H2 does not reproduce PostgreSQL's generated-key
behaviour, `SELECT ... FOR UPDATE` locking, duplicate-key races or SQLState codes, so the same contracts also run on a real
PostgreSQL 17 and a real MySQL 8.4 in Testcontainers: the snapshot and idempotency stores (their contracts and eight threads
racing one key), the timestamp serials (concurrent allocations each get their own), the client store, and the passkey stores
(`JdbcStoresContract`, including the row-locked counter move). The tests are tagged `containers` and left out of a default
build, so a machine without Docker stays green. The `containers` profile lets them in:

```sh
./mvnw -Pcontainers verify                                                        # everything, container tests included
./mvnw -Pcontainers -Ddatum.test.groups=containers -pl spring/datum-forms-spring verify   # only the container tests of one module
```

The profile is active on its own on a GitHub Actions Linux runner (it needs the `GITHUB_ACTIONS` variable and the Docker socket,
which macOS and Windows runners lack), so the CI job that runs `./mvnw verify` runs them there; `-P!containers` turns it off.
With the profile on and Docker not answering, the tests are skipped by Testcontainers (`disabledWithoutDocker`), not failed.

### The security suite

The TCK proves what a host promises; the security suite proves what it refuses. Its endpoint mode sends the attack
vectors (forged outcomes, smuggled journey members, oversized and malformed bodies, replays) at the same receiving
routes:

```sh
datum-security-check --endpoint https://forms.example --form datum-security-suite --profile submissions --allow-writes --i-installed-the-suite-fixture
```

Install the suite fixture form in the application first (`datum-security-check fixture --format submissions`); without the two flags the write vectors are skipped.

Its program mode checks the packaged `datum-sandbox-program.js` and runs with `--gate release` before a release.
[Conformance suite](conformance-suite.md) describes the CLI, the fixture and the report. A release runs both against the
same packaged example.

## Examples

Six applications under [`integrations/jvm/examples`](../integrations/jvm/examples/ui/README.md), each built and tested
by the reactor: `submissions` (story one), `ui` (story two), `ui-builder-jpa` (story three with JPA storage and
Spring Security), `passkeys` (signed submissions), `tsa-server` (a timestamp server), `webflux-pdf` (WebFlux, PDF
seals and the timestamp authority together).
