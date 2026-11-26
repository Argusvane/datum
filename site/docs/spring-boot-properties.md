# Spring Boot properties

Every `datum.*` property the [Spring Boot host](/spring-boot) reads, with its default and what it does. Set them in `application.yml` or `application.properties`, as environment variables or as command-line arguments, like any Spring Boot property.

```yaml
datum:
  web:
    api:
      max-body-size: 2MB
      endpoints:
        submissions: true
        validate: true
  runtime:
    validation:
      time-limit: 5s
  forms:
    locations: classpath:/datum/forms/*.json
  tsa:
    enabled: true
    signer:
      self-signed: true
```

Spring Boot's relaxed binding applies:

- **Names.** `datum.web.api.max-body-size` can also be written `datum.web.api.maxBodySize`, or as the environment variable `DATUM_WEB_API_MAXBODYSIZE`.
- **Durations.** They take the Spring forms (`5s`, `10m`, `PT1H`).
- **Sizes.** They take `KB`, `MB` and `GB`.
- **Enums.** An enum takes its word in any case.

A bad value is handled one of two ways. Each section below says which applies.

- **Stop.** A value that cannot work stops the start and names the property, for example `datum.web.throttle.limit is 0; it must be at least 1.`.
- **Clamp.** A few budgets are clamped instead: the message is logged once at WARN and the nearest allowed value is used.

The route switches are described on [Spring Boot](/spring-boot); the paths they open are listed on [the wire](/wire).

## Master switch and web

`datum.enabled` and everything under `datum.web.*`.

| Property | Default | Meaning |
|---|---|---|
| `datum.enabled` | `true` | Master switch. With `false` no Datum auto-configuration applies. |
| `datum.web.api.path` | `/api` | Where the JSON endpoints live. A leading slash is added and a trailing one removed; blank means the default. |
| `datum.web.api.max-body-size` | `1MB` | The largest request body a JSON endpoint reads, counted on the raw stream before parsing. It must be at least `1B`. The runtime then keeps it between `16KB` and `64MB` and logs a warning when it moves the value. |
| `datum.web.api.problem-details` | `false` | Answer errors as RFC 9457 problem details (`application/problem+json`) with the same codes. |
| `datum.web.api.busy-retry-after` | `5s` | The `Retry-After` carried by a `503 server.busy` answer. Whole seconds from `1s` to `1h`; a fraction or a value outside that stops the start. |
| `datum.web.api.endpoints.<key>` | off | One switch per endpoint, listed in the next table. Every endpoint is off until its key is `true`; a key that is not set is off. |
| `datum.web.assets.enabled` | `false` | Serve the form and builder bundles from the classpath under the versioned assets path. |
| `datum.web.assets.path` | `/datum/assets` | Where the assets are served. Files live at `{path}/{buildId}/...`. Same normalisation as the API path. |
| `datum.web.assets.cache-period` | `365d` | The `max-age` of the immutable asset answers. Not negative. |
| `datum.web.assets.omit-features` | none | A list of feature tokens whose files answer 404, added to what the build already left out. |
| `datum.web.csrf.header-name` | `X-XSRF-TOKEN` | The request header the page glue sends the CSRF token in. The token itself is Spring Security's. |
| `datum.web.csrf.cookie-name` | `XSRF-TOKEN` | The cookie the page glue reads the token from. |
| `datum.web.csrf.meta-name` | `_csrf` | The name of the page `meta` tag the page glue reads the token from. |
| `datum.web.throttle.enabled` | `true` | The built-in in-memory throttle on submission, validation, dry-run, PDF and passkey-registration routes. It is not created when the application supplies its own `SubmissionThrottle` bean. |
| `datum.web.throttle.limit` | `60` | Attempts allowed per window for one key, counted after the body is parsed because the key names the form. At least `1`. |
| `datum.web.throttle.address-limit` | `600` | Requests allowed per window for one address, on every route the throttle counts. A request is counted by its address (an IPv6 client by its /64, an IPv4-mapped address as its IPv4 address) after its `Content-Type` is accepted and before its body is read, whether or not the body later parses; one with no client address is not counted. It uses the window and `max-keys` of this section and the same in-memory store, in its own key space (Spring has no throttle storage property). At least `1`, or `0` to turn it off; a negative value stops the start. The default, 600, is ten times the default `limit`, so many people behind one office address still get through. It is off when `enabled` is `false`. Over it the answer is the same 429 `flood` as `limit`'s. |
| `datum.web.throttle.window` | `1m` | The span the limit counts over. Longer than zero. |
| `datum.web.throttle.by` | `ip`, `form` | What makes a key, in addition to the route kind: `ip`, `form` and `principal` (the signed-in user; `user` is accepted as a synonym). Any other word stops the start. `ip` counts an IPv6 client by its /64 and an IPv4-mapped address as its IPv4 address. |
| `datum.web.throttle.limits.<kind>` | unset | A limit for one route kind that differs from `limit`. The kinds are `submit`, `validate`, `test`, `pdf` and `register`; another name stops the start, and each value is at least `1`. Read only by the built-in throttle. |
| `datum.web.throttle.max-keys` | `10000` | The most windows the built-in throttle holds, from `16` to `10000000`. When it is full the expired ones go first, then a sixteenth of the live windows, one at a time from the caller (address and principal) holding the most: its window with the fewest attempts first, the newest among equals. |
| `datum.web.openapi.enabled` | `true` | Register Datum's springdoc groups when springdoc is on the classpath. |
| `datum.web.openapi.group-prefix` | `datum-` | The prefix of the group names (`datum-forms`, `datum-submissions` and so on). |

The built-in throttle counts in memory, so each application instance counts on its own. Behind a proxy, enable Spring's forwarded-header handling so the client address is the real one. An IPv6 client is counted by its /64, since one host is commonly handed a whole /64.

### The endpoint switches

`datum.web.api.endpoints.<key>` takes these 11 keys. Paths are under `datum.web.api.path`.

| Key | Route |
|---|---|
| `submissions` | `POST /api/submissions`, the full receive pipeline |
| `validate` | `POST /api/submissions/validate`, a page's or a journey's check |
| `test` | `POST /api/submissions/test`, the dry run |
| `inspect` | `POST /api/inspect`, the inspection of a definition |
| `definition` | `GET /api/forms/{key}/definition` and `GET /api/forms/{key}/translations` |
| `data-sources` | `GET /api/data-sources/{id}` |
| `pdf` | `POST /api/pdf` |
| `fill` | `POST /api/pdf/fill` |
| `sign` | `POST /api/pdf/sign` |
| `verify` | `POST /api/pdf/verify` |
| `certificate` | `GET /api/server/certificate` |

The other routes have their own switches: `datum.builder.enabled` (`POST /api/forms`, `PUT /api/forms/{key}`, `PUT /api/forms/{key}/translations`), `datum.tsa.enabled` (`POST /tsa`, `GET /tsa/certificate`, `GET /tsa/certificates`) and `datum.webauthn.enabled` (the passkey routes under `/api/webauthn`).

## Runtime

`datum.runtime.*`: which engine runs the sandbox and the PDF program, how the runtime starts and stops, and the budgets of the two programs.

- Budgets, slots and waits are clamped to their bounds with a logged warning.
- `warm-up-runs`, `shutdown-grace`, `stop-grace` and `max-strays` are rejected when negative.
- An engine that would run as JVM bytecode stops the start unless `allow-bytecode` is `true`, whatever `fail-fast` says.

| Property | Default | Meaning |
|---|---|---|
| `datum.runtime.engine` | `endive` | The id of the engine that runs the programs. `endive` (in-process) is the only one shipped. An id no engine on the class path has stops the start and lists the engines found. Not read when the application supplies its own `GuestRuntime` bean. |
| `datum.runtime.fail-fast` | `true` | Stop the application context when the runtime cannot prove its programs at start. With `false` the application starts, health reports DOWN with the reason, and every run answers 503 until a recheck passes. |
| `datum.runtime.allow-bytecode` | `false` | Whether the application may start when the engine would run the programs as JVM bytecode: no native code for the platform, or no native runner it can use. `false` stops the start with a message naming the platform and the two fixes, whatever `fail-fast` says. `true` starts with a logged warning: validation runs several times slower, the PDF routes answer 503, and health reports `engineMode: bytecode`. |
| `datum.runtime.warm-up-runs` | `3` | Smoke runs made at start to warm the runtime up. `0` for none; negative stops the start. |
| `datum.runtime.shutdown-grace` | `10s` | How long a shutdown waits for runs in flight before it cancels them. Not negative. |
| `datum.runtime.startup-budget` | `30s` | The wall time of the proof runs at start and at a recheck (the version probes, the smoke run and the warm-up runs). A run gets the longer of this and its own budget. Whole seconds from `1s` to `5m`. |
| `datum.runtime.verify-max-bytes` | `20MB` | The largest PDF the verify route reads; over it the answer is 413. From `1MB` to `100MB`. The route needs `datum.web.api.endpoints.verify`. |
| `datum.runtime.stop-grace` | `5s` | How long a run that was stopped (at its time budget or by a shutdown) is given to end and close its instance before its output is read as it stands. Raise it on a slow host. Not negative. |
| `datum.runtime.max-strays` | `0` | How many stopped runs may outlive their grace before new runs are refused. `0` means one per CPU the JVM may use, at least two. Negative stops the start. |
| `datum.runtime.validation.time-limit` | `5s` | The wall time of one validation run. Whole seconds, `1s` to `60s`. |
| `datum.runtime.validation.memory` | `32MB` | The linear memory of one validation run, `4MB` to `1GB`. |
| `datum.runtime.validation.concurrency` | `0` | Validation runs at once, up to `64`. `0` is one per CPU. |
| `datum.runtime.validation.wait` | `2s` | How long a validation waits for a free slot before the answer is `503 server.busy`. Whole seconds, `0` to `10`; `0` refuses at once. |
| `datum.runtime.pdf.time-limit` | `15s` | The wall time of one PDF run. Whole seconds, `1s` to `300s`. |
| `datum.runtime.pdf.memory` | `256MB` | The linear memory of one PDF run, `32MB` to `4GB`. |
| `datum.runtime.pdf.concurrency` | `0` | PDF runs at once, up to `64`. `0` is the smaller of two and the number of CPUs. |
| `datum.runtime.pdf.wait` | `2s` | How long a PDF run waits for a free slot before `503 server.busy`. Whole seconds, `0` to `10`. |
| `datum.runtime.programs.sandbox` | packaged program | A `file:` or `classpath:` resource to run instead of the packaged sandbox program. The version probe still proves it, and the actuator's recheck reads it again. |
| `datum.runtime.programs.pdf` | packaged program | The same for the PDF program. |

The output size caps of a run are fixed and have no property.

### Diagnostics

`datum.runtime.diagnostics.*`: what the sandbox tells an operator about its runs. The trace and the capture are off until you switch them on; the settings report is on.

- The trace is one line per run on the logger `datum.sandbox.trace`. It carries how the run ran and ended and the lengths of its input and output, never an answer.
- The report is the effective settings, every value with where it came from (default, configured, clamped, replaced), the engine, and each program's sha256 and ABI, logged once at start on `datum.sandbox.settings`. `/actuator/datum` serves the same report under `settings`.
- The capture keeps a failed run's input, output, generated run script and a metadata file on disk. **It holds the submitted answers and the form definition, which are personal data, in clear text.** Turn it on to debug and off again after. The directory must be a real directory, owned by the application's user, with no group or other permission (on macOS, no access control list); the start refuses otherwise.

| Property | Default | Meaning |
|---|---|---|
| `datum.runtime.diagnostics.trace` | `off` | Which runs get a trace line: `off`, `failures` (a run that trapped, hit a cap or a budget, was stopped or could not start) or `all`. |
| `datum.runtime.diagnostics.report` | `true` | Log the settings report once at start. |
| `datum.runtime.diagnostics.capture.enabled` | `false` | Keep failed runs on disk for debugging. |
| `datum.runtime.diagnostics.capture.directory` | none | Where captures go. Required when the capture is on. Created with mode `700` if missing. |
| `datum.runtime.diagnostics.capture.max-runs` | `20` | The most captures kept; the oldest go first. At least `1`. |
| `datum.runtime.diagnostics.capture.max-bytes` | `64MB` | The most bytes all kept captures take together; one larger than this is dropped. At least `1B`. |
| `datum.runtime.diagnostics.capture.queue-bytes` | `64MB` | The most bytes of captures waiting to be written; one that does not fit is dropped and counted. A run never waits for a capture. At least `1B`. |

## Host options

`datum.host.*`: options the host sets on every validation run. They bind as enums, so a word the sandbox does not read stops the start with Spring's binding error naming the property.

| Property | Default | Meaning |
|---|---|---|
| `datum.host.formula-errors` | `fail` | What a formula that cannot be evaluated does. `fail`: the run fails. `warn`: the formula's value is empty and the run goes on. |
| `datum.host.risky-patterns` | `refuse` | What a regular expression that repeats a repeat does. `refuse`: the pattern is refused. `allow`: the pattern runs. |
| `datum.host.time-zone` | JVM default | The zone `today()` and the clock-dependent rules read, as a zone id such as `America/Toronto`. Empty is the JVM's zone; an id that is not a zone stops the start. |
| `datum.host.unknown-fields` | `strip` | What an answer the form has no component for does. `strip`: it is dropped. `keep`: it is kept. `reject`: the submission is refused. |
| `datum.host.log-level` | `warn` | How much of a run's log the program keeps and the host relays: `off`, `error`, `warn`, `info` or `debug`. |

## Submissions

`datum.submissions.*`: settings of the development defaults the submissions module supplies. An application that supplies its own store ignores them.

| Property | Default | Meaning |
|---|---|---|
| `datum.submissions.idempotency.memory-size` | `10000` | How many accepted documents the in-memory idempotency store remembers (used when there is no `DataSource` and no store bean); past it the oldest is forgotten. From `16` to `10000000`, otherwise the start stops. |

## Forms

`datum.forms.*`: where definitions are read and how they are cached. Values below their minimum stop the start.

| Property | Default | Meaning |
|---|---|---|
| `datum.forms.locations` | `classpath:/datum/forms/*.json` | Spring resource patterns of the definition files the default repository reads. |
| `datum.forms.snapshots.max-entries` | `500` | The most snapshots the in-memory store keeps, least recently used out first. At least `1`. |
| `datum.forms.snapshots.public-copy-cache-size` | `256` | The most public copies kept, by definition hash. At least `1`. |
| `datum.forms.data-sources.timeout` | `15s` | How long one provider call may take. Positive. |
| `datum.forms.data-sources.max-threads` | `16` | The most provider calls in flight at once; a hung provider can hold this many threads. At least `1`. |
| `datum.forms.too-costly-memory` | `300s` | How long a definition the sandbox could not check in time is refused without another run. From `1s` to `1h`. |
| `datum.forms.cache.definition` | `no-store` | The `Cache-Control` of a definition answer. Not blank and no line breaks. |
| `datum.forms.cache.snapshot` | follows `cache.definition` | The `Cache-Control` of the public copy of a version asked for by hash. Set a cacheable value only when the read routes are unauthenticated: a shared cache may then keep the answer, and the bytes of a public copy can change under the same hash after an upgrade. |

## Builder

`datum.builder.*`: whether this application is a place where forms are authored. See [Spring Boot](/spring-boot).

| Property | Default | Meaning |
|---|---|---|
| `datum.builder.enabled` | `false` | Serve the builder bundle and register the form write endpoints. |
| `datum.builder.max-definition-size` | `1MB` | The largest definition a save reads, counted on the raw stream before parsing; over it the answer is 413. From `1B` to `64MB`. |

## JDBC

| Property | Default | Meaning |
|---|---|---|
| `datum.jdbc.initialize-schema` | `embedded` | Whether the Datum modules create their tables when a JDBC store starts. `embedded`: only in an embedded in-memory database (H2, HSQL, Derby). `always`: in whatever database the stores use. `never`: not at all, for an application that runs the shipped scripts with Flyway or Liquibase. A module's script runs only when its first table is missing, so `always` never creates a table twice. |

## Bindings

`datum.bindings.*`: which design-system binding each form route is drawn by, and the PDF theme its PDF prints under. The host's configuration says it, never the form's definition.

```yaml
datum:
  bindings:
    default: datum
    routes:
      contact: gcds
    catalog:
      gcds:
        label: GC Design System
        pdf-theme: gcds
    pdf-themes:
      gcds: classpath:/pdf/gcds.json
```

| Property | Default | Meaning |
|---|---|---|
| `datum.bindings.default` | `datum` | The binding of a route with no override. Blank means `datum`. |
| `datum.bindings.routes.<form-key>` | none | The binding a form key is drawn by. |
| `datum.bindings.catalog.<id>.label` | the id | The name shown where bindings are listed. |
| `datum.bindings.catalog.<id>.pdf-theme` | none | The PDF theme the binding suggests; none means the engine's own. |
| `datum.bindings.pdf-themes.<id>` | none | A resource holding the JSON theme object of a suggested PDF theme. |

The catalog starts with the `datum` binding the bundles carry, which suggests the engine's own PDF look. A PDF of a form carries its binding's PDF theme below the theme of the render call and of the layout.

## PDF

`datum.pdf.*`: what the PDF service is built from. An unknown `fonts` or `seal.certify` word, or a `signing.tsa.timeout` under one second, stops the start.

| Property | Default | Meaning |
|---|---|---|
| `datum.pdf.enabled` | `true` | Whether the PDF capability is on. |
| `datum.pdf.fonts` | `default` | The fonts a request carries unless the caller asks for another pack. `default`: DejaVu Sans and Sans Bold. `standard`: five faces (sans, bold, oblique, mono, mono bold). `all`: all seven faces. |
| `datum.pdf.signing.ssl-bundle` | none | The name of a Spring Boot SSL bundle (`spring.ssl.bundle.jks.<name>` or `.pem.<name>`) whose key store holds the server's PDF signing key and chain. The bundle's `key.alias` and `key.password` pick and unlock the key. |
| `datum.pdf.signing.retired-certificates` | none | A PEM resource with certificates the server signed with before a rotation; a signature by one verifies as `site_retired`. |
| `datum.pdf.signing.trust-anchors` | none | A PEM resource of trust anchors; signers and timestamp authorities that chain to one verify as `trusted`. |
| `datum.pdf.signing.tsa.url` | none | The URL of a named timestamp server. Empty uses the in-process authority when it is active. |
| `datum.pdf.signing.tsa.timeout` | `10s` | How long a whole timestamp request may take. At least `1s`. |
| `datum.pdf.signing.tsa.ssl-bundle` | JDK trust | A Spring Boot SSL bundle for the TLS connection to the timestamp server: its trust store checks the server, and its key store, when it has one, presents a client certificate. |
| `datum.pdf.signing.tsa.bearer-token` | none | A bearer token sent in the `Authorization` header. Never logged. |
| `datum.pdf.signing.tsa.basic-user` | none | The user name for HTTP Basic authentication to the timestamp server. |
| `datum.pdf.signing.tsa.basic-password` | none | The password for HTTP Basic authentication. Never logged. |
| `datum.pdf.signing.tsa.policy` | none | The `reqPolicy` object identifier (dotted) every request carries, for a server that issues under several policies. Unset asks for none. Read only with `url`. |
| `datum.pdf.seal.enabled` | `false` | Seal issued PDFs with the server's key. |
| `datum.pdf.seal.layouts` | all layouts | A list of the layouts to seal; empty seals every layout. |
| `datum.pdf.seal.certify` | `noChanges` | The kind of signature. `noChanges`: certifying, no change allowed afterwards. `formFill`: certifying, form filling allowed. `annotate`: certifying, form filling and annotations allowed. `none`: an approval signature, not a certifying one. |
| `datum.pdf.seal.timestamp` | `true` | Ask a timestamp server for a token over the seal, when one is available. |
| `datum.pdf.seal.reason` | none | The signature's reason. |
| `datum.pdf.seal.location` | none | The signature's location. |
| `datum.pdf.seal.visible` | unset | `false` for an invisible signature; unset or `true` keeps the default appearance. |
| `datum.pdf.seal.posted-answers` | `false` | Seal the PDFs of posted, unstored answers (`POST /api/pdf`, `/api/pdf/fill`, `/api/pdf/sign`) with the server's key. Off, a throwaway test certificate seals them, so the server's key only vouches for documents the application itself issued. |

## Timestamp server

`datum.tsa.*`: the RFC 3161 [timestamp server](/timestamps). Off by default: without `enabled=true` the routes answer 404.

| Property | Default | Meaning |
|---|---|---|
| `datum.tsa.enabled` | `false` | Turn the timestamp server on. |
| `datum.tsa.path` | `/tsa` | Where it answers; `/certificate` and `/certificates` hang below it. |
| `datum.tsa.access` | `clients` | Who may ask for a token. `clients`: a caller with a registered client key. `open`: anyone, with flood limits still applied per address (an IPv6 client counted by its /64). |
| `datum.tsa.policy` | the Datum default | The policy object identifier tokens name. |
| `datum.tsa.accepted-policies` | none | Further policy identifiers a request may ask for with `reqPolicy`; the token then names the policy asked for. The issuing policy is always accepted. Any other one is refused with `unacceptedPolicy`. |
| `datum.tsa.accuracy` | `1s` | The accuracy tokens state. Whole milliseconds from `0` to `60s`; zero states none. A value outside that is clamped. |
| `datum.tsa.max-request-size` | `16KB` | The largest request body read. From `1B` to `1MB`. |
| `datum.tsa.flood.limit` | `1000` | Tokens allowed per window, per client (per address for open requests, an IPv6 client counted by its /64). `0` turns the limit off. |
| `datum.tsa.flood.window` | `1h` | The span the flood limit counts over; a fixed window. At least `1s`. |
| `datum.tsa.flood.failed-keys` | `10` | Wrong client keys one address (an IPv6 client by its /64) may present per hour before it is answered 429 with `Retry-After: 3600`. From `1` to `10000`. |
| `datum.tsa.signer.ssl-bundle` | none | The SSL bundle whose key store holds the server's timestamp signing key and chain. With neither this nor `self-signed`, every request is answered `systemFailure` and health is DOWN. |
| `datum.tsa.signer.self-signed` | `false` | Make a throwaway self-signed certificate at start. Development only: tokens verify against no one. Setting it together with `ssl-bundle` stops the start. |
| `datum.tsa.client-store` | `properties` | Where client keys live. `properties`: the `clients` list. `jdbc`: the `datum_tsa_client` table, which needs a `DataSource`. |
| `datum.tsa.clients` | none | For the `properties` store, the SHA-256 of each client key in lower-case hex, each optionally written `label=hash`. Keep only the hash, never the key. |
| `datum.tsa.retired-certificates` | none | A list of PEM files (a Spring resource each) of certificates the server signed with before, served by `/certificates`. |
| `datum.tsa.session-cookies` | `*` | Cookie names that make a request a browser session's; such a request is refused with 403. The default `*` refuses a request that carries any cookie. A list of names refuses only those, whatever their case, and `*` in the list means any. |
| `datum.tsa.allow-memory-stores` | `false` | Acknowledge single-instance use of the in-memory serial allocator. Without a `DataSource` and the timestamp migration, or your own `TsaSerialAllocator` bean, the start is refused unless this is `true`. |

## Passkeys

`datum.webauthn.*`: passkey registration and passkey-signed submissions. Off by default: without `enabled=true` the routes answer 404.

- Unknown members under this prefix stop the start, and so does a word outside a setting's set.
- Nothing is taken from the request's `Host` header: until `rp-id` and `origins` are set the routes answer `503 signing.not_set_up` and health is DOWN.

### Site settings

| Property | Default | Meaning |
|---|---|---|
| `datum.webauthn.enabled` | `false` | Turn passkeys on. |
| `datum.webauthn.rp-id` | empty | The relying-party id: the registrable domain passkeys are bound to, such as `example.org`. Empty means not set up. |
| `datum.webauthn.rp-name` | the `rp-id` | The name the browser shows for the site. |
| `datum.webauthn.origins` | none | The origins a client may write, exactly: scheme, host and port, no path, such as `https://forms.example.org`. |
| `datum.webauthn.anonymous` | `false` | Let visitors who are not signed in make passkeys and sign. |
| `datum.webauthn.register-at-submit` | `true` | Let people register a passkey when they submit a form. The Test context still may when this is `false`. |
| `datum.webauthn.window` | `600s` | How long a signature may take to arrive. Whole seconds, at least one. |
| `datum.webauthn.challenge-ttl` | `300s` | How long a registration challenge holds, which bounds the page's whole ceremony. From `10s` to `1h`. |
| `datum.webauthn.path` | `/api/webauthn` | The base path of the endpoints; `/challenge`, `/register` and `/passkeys` hang below it. Must not be empty. |
| `datum.webauthn.passkeys` | `site` | `site`: a passkey signs for every form. `form`: only for the one it was made on. |
| `datum.webauthn.secret` | empty | The HMAC key of registration challenges: at least 32 bytes, and the same on every instance. Empty makes one at start, which one instance only can use. |
| `datum.webauthn.label-path` | empty | The answer (a value path) that names a visitor's passkey, told to the page. |
| `datum.webauthn.test-roles` | none | Roles, read from the Spring Security authentication (`FORM_ADMIN` matches `ROLE_FORM_ADMIN`), that may make a passkey in a form's Test context. Empty: nobody. |
| `datum.webauthn.keep-years` | `0` | Years signed submissions are kept at least, whatever retention says; `0` lets retention decide. From `0` to `100`. For the application's own retention job. |
| `datum.webauthn.resident-key` | `required` | The `residentKey` requirement a registration asks the authenticator for: `required`, `preferred` or `discouraged`. `required` gives a passkey the browser can offer without being told which. |
| `datum.webauthn.challenge-skew` | `60s` | How far ahead of this server's clock a challenge's issue time may be, for a challenge made on another server whose clock runs ahead. From `0` to `5m`. |
| `datum.webauthn.signed-at-skew` | `60s` | How far apart the two signing times a signature carries (the result's and the assertion's) may be. From `0` to `10m`. |
| `datum.webauthn.anonymous-grace` | `24h` | How long an anonymous passkey that signed nothing is kept before the purge removes it. From `1h` to `30d`. |
| `datum.webauthn.allow-memory-stores` | `false` | Acknowledge single-instance use: the passkey, replay-guard and challenge stores may live in this process's memory. Without it the application refuses to start unless a SQL store is configured, because a replay guard in memory is one per process. |

### Form defaults

These apply to every form. `datum.webauthn.forms.<key>.*` overrides each per form.

| Property | Default | Meaning |
|---|---|---|
| `datum.webauthn.mode` | `off` | Whether a form's submissions are signed with a passkey. `off`: not signed. `optional`: a visitor may sign. `required`: a visitor must sign. |
| `datum.webauthn.scope` | `envelope` | What a signature covers. `envelope`: the whole submission envelope. `submission`: the submission document. `values`: the answers only. |
| `datum.webauthn.placement` | `embedded` | Where signatures land, as the page is told (the verifier reads both). `embedded`: inside the submission. `wrapper`: wrapping the submission. |
| `datum.webauthn.user-verification` | `preferred` | The user verification a signature asks for. `required`: the authenticator must verify the user. `preferred`: asked for, not demanded. |
| `datum.webauthn.statement` | empty | The statement the signer sees and signs; empty for none. |
| `datum.webauthn.verify` | `true` | Whether a signature that cannot be verified refuses the submission. An invalid signature always does. |
| `datum.webauthn.unavailable` | `refuse` | What a required form does with a submission from a browser without passkeys. `refuse`: refuse it. `accept`: accept it unsigned. |

### Per-form overrides

`datum.webauthn.forms.<key>.*` takes the same seven members as the defaults above, with the same words. A member left unset keeps the default.

| Property | Default | Meaning |
|---|---|---|
| `datum.webauthn.forms.<key>.mode` | the default `mode` | This form's signing mode: `off`, `optional` or `required`. |
| `datum.webauthn.forms.<key>.scope` | the default `scope` | `envelope`, `submission` or `values`. |
| `datum.webauthn.forms.<key>.placement` | the default `placement` | `embedded` or `wrapper`. |
| `datum.webauthn.forms.<key>.user-verification` | the default `user-verification` | `required` or `preferred`. |
| `datum.webauthn.forms.<key>.statement` | the default `statement` | The statement the signer sees and signs. |
| `datum.webauthn.forms.<key>.verify` | the default `verify` | Whether a signature that cannot be verified refuses the submission. |
| `datum.webauthn.forms.<key>.unavailable` | the default `unavailable` | `refuse` or `accept`. |

A form key that contains a dot must be written in brackets, `forms[my.form].mode`. Written `forms.my.form.mode` it would be read as a form `my` with a member `form`, and the form meant to require a signature would sign nothing.

```yaml
datum:
  webauthn:
    enabled: true
    rp-id: example.org
    origins: https://forms.example.org
    forms:
      grant:
        mode: required
        scope: values
```
