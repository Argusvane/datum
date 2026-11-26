# ADR 0152: A Spring Boot host as capability modules on shared JVM libraries

## Status

Accepted.

## Context

The guide is [docs/spring.md](../spring.md); `integrations/jvm/README.md` ("Layout", "Libraries and
bindings") has the module map. This ADR keeps the decisions and their reasoning. It builds on ADR
0063 (WebAuthn-signed submissions), ADR 0142 (the validation gate fails closed), ADR 0143 (the
features model) and ADR 0151 (the security and conformance suite that holds every host's
receiving routes to the contract).

A team with a Spring Boot application needs Maven packages that follow Spring's conventions
(auto-configuration, `@ConfigurationProperties`, SPI beans, `ApplicationEvent`s, actuator) and
serve two stories first: "my form is on a page, and the server validates what it submits", and
"the renderer is on my page; load the schema from my server and submit back". The host has to
be hard: the sandbox protocol with its nonce frame, output caps and ABI gate, the receive
pipeline in the same order, the same wire codes as every other host.

The server hosts are the JVM ones, the Python ones and the Node `@argusvane/datum-submissions`
package; there is no Drupal module. A site on Drupal calls a server host over HTTP, or embeds the web
components and validates with the Node package.

A second JVM host would need the same decisions. Writing them a second time would be a defect,
so the decisions live in libraries that name no framework, and each framework gets a thin
binding.

## Decision

### 1. Capability modules, not layers

One module per capability, each with its own auto-configuration: core, forms, submissions, ui,
pdf, timestamp, webauthn. A consumer sees five capability starters, a test starter and a BOM.

The sandbox is not a capability but the library under them: `datum-sandbox` runs every WebAssembly
program for every capability (ADR 0176), with its engines, its test kit and its Spring binding as
modules of their own (section 6).

Group id `com.argusvane`, package root `com.argusvane.datum`, one reactor version and one tag
for the whole reactor, shared with the other hosts. The renderer and the builder are one module,
`datum-ui`, with the builder half behind `datum.builder.enabled`. The reactor lives in
`integrations/jvm/`. Spring Boot 4.x only (Jackson 3); the libraries compile `--release 17`.

### 2. Framework-free libraries plus thin bindings

`libs/` holds every decision and names no framework; `spring/` holds the Spring Boot bindings;
`tck/datum-host-tck` is the wire contract as a test kit.

- A **library** decides: status codes, error codes, the order of the receive pipeline, what a
  definition may be, how a run is classified, what a start-up check says. A **binding** reads the
  request, calls a library type, writes the reply and wires beans; it never decides a status,
  parses a body, judges a definition, orders the receiver, classifies a run or shapes an error.
  A `LibraryBoundaryTest` in each library (the one rule is `LibraryBoundaryRules`) forbids
  every framework package (Spring, Quarkus, `jakarta.ws.rs`, `jakarta.enterprise`,
  `jakarta.servlet`, Vert.x, Reactor, springdoc, SmallRye, MicroProfile), every binding package
  and `java.sql`; a `BindingBoundaryTest` in each binding forbids decisions.
- Each capability is a library with a `datum-<capability>-spring` binding. `datum-submissions`
  and `datum-pdf` take their sandbox from `datum-sandbox` and not from each other; `datum-pdf`
  keeps the `datum-submissions` dependency for `pdf.api` only, which judges `POST /pdf` answers
  through the receiver, the throttle and the host context. `datum-web-core` (package `com.argusvane.datum.web`) holds the neutral
  web pieces (the endpoint catalog, the asset service, the error model, `host.json`,
  `datum-host.js`) and `datum-spring-web` is the Spring side. Every endpoint is a neutral facade
  (`FormsApi`, `SubmissionsApi`, `BuilderApi`, `PdfApi`, `PasskeysApi`, `TsaEndpoint`); the
  servlet MVC and WebFlux classes only move bytes.
- Seams stand in for what a framework supplies: `DatumEventPublisher` (events without a bus
  type), `DatumOrdering` (one order for every ordered hook: explicit order first, unordered
  last, ties by class name), `DatumStartupCheck`, `FormSources.Resolver` (`file:` locations are
  resolved by the library as `java.nio` globs, class path locations by the binding), a settings
  record per capability onto which the Spring `@ConfigurationProperties` map, and `DatumSandbox`
  as a plain class with a lifecycle wrapper in the binding.
- `integrations/jvm` and `integrations/shared` name no other integration.
  `StandaloneIntegrationTest` (in `datum-core`) scans the JVM tree, and
  `npm run shared:check-neutral` scans the shared tree.

### 3. Both web stacks, no web-stack starter

Servlet MVC and WebFlux adapters sit behind optional dependencies and the one the application
runs is activated; the starters bring no web starter. Every enabled endpoint is documented for
springdoc (optional at runtime, one group per capability), generated from the one endpoint
catalog.

### 4. Every endpoint is off until switched on

A starter on the class path registers no route. A route is on only for an explicit `true` of its
`datum.web.api.endpoints.*` key or `datum.web.assets.enabled`; a boot lists the routes it enabled
in one INFO notice and says so when there are none. There is no forms-listing endpoint:
enumerating forms is the application's.

### 5. The packages store nothing

Accepted submissions go to the application's `SubmissionHandler`; events carry the rest.
Storage, drafts, schedules, caps, handlers and exports are the application's. Stores the
libraries need (definition snapshots, idempotency, TSA serials and log, TSA client state,
passkeys, passkey use, challenge claims) are SPIs with in-memory development defaults and SQL
migration scripts, versioned across the reactor by capability range and the same on every host.

- The SQL stores live in the Spring bindings on `JdbcClient`, `TransactionTemplate` and Spring's
  exception translation, through one `DatumStoreJdbc`; no library names `java.sql`.
- Every store call is a transaction of its own (`PROPAGATION_REQUIRES_NEW`), so none joins the
  application's transaction, and the manager is never JPA's or Hibernate's: a JPA store
  transaction flushes the open-in-view persistence context, and a JDBC manager over the
  `DataSource` key adopts the connection a JPA transaction bound and commits its flushed work.
- **Multi-process policy for every host.** State a second instance or a restart would get wrong
  *in a way that matters for trust* refuses to start on in-memory stores unless a SQL store is
  configured or an `allow-memory-stores` flag acknowledges a single instance: the passkey store,
  the replay guard and the challenge claims, and the timestamp server's serial allocator and log.
  State that is only less effective per instance (the throttle, the definition snapshots, the
  idempotency store) starts with a WARN and a health or info detail.

The scripts, the version ranges, the transaction rule and the policy are in docs/spring.md
("Storage", "Security notes").

### 6. The sandbox: one library, engines behind one seam, Endive in process

All of the WebAssembly work is `datum-sandbox` (ADR 0176 holds the decision and its reasoning;
docs/spring.md "The sandbox as a library" and "Engines" hold the module map and the seam).
`datum-sandbox` depends on `datum-core` (the contracts, the exception base, the event
publisher) and `datum-programs`, and on no framework, web module or capability; `datum-core`
never imports it. A boundary test keeps `.wasi` free of every Datum type.

- **The engine seam is `GuestRuntime`,** found through `GuestRuntimeProvider` and selected by
  `datum.runtime.engine` (default `endive`). An unknown or unavailable id stops the start whatever
  `datum.runtime.fail-fast` says, and an application's own `GuestRuntime` bean wins.
- **Endive is the engine.** The precompiled `Qjs` class (six native targets and bytecode) is
  built once in CI from the pinned `qjs-wasi.wasm` and shipped in `datum-sandbox-endive`, so
  every consumer runs identical code. With no native code for the platform, or no runner it can
  use, the engine reports mode `bytecode`; the host then refuses to start, whatever
  `datum.runtime.fail-fast` says, unless `datum.runtime.allow-bytecode=true`, because bytecode
  validation is several times slower and the PDF program cannot run in its budget. The check
  reads `EngineInfo`, so an application's own runtime is held the same way.
- **The hardening is built in and not an option:** the nonce frame, frozen intrinsics, output
  caps, budgets clamped to fixed bounds, the ABI probe, warm-ups and slots. A native-memory
  check at start (`MemoryBudget`) warns when the slots could exceed the container.
- **`datum-sandbox-spring` is the one Spring binding** of the library; the submissions and PDF
  bindings order after it, and a starter that brings either brings it. An engine's tests
  implement the contracts of `datum-sandbox-tck`. An engine that keeps heap per run declares it
  with `knownHeapLeak()` as a strict expected failure, never a wider bound, so a leak stays
  visible instead of being absorbed by a looser test.

### 7. Wire behaviour matches the other hosts

The wire is settled against `packages/submissions/src/http-mapping.ts`; parity with it beats any
prose. The statuses and codes are in docs/spring.md ("Lifecycle and hooks", "Web: every route").

- A slot wait that expires is 503 `server.busy`, which carries `Retry-After`; every other 503
  (`server.unavailable`) does not, because a retry of a deterministic failure does not help.
- An interrupted run (a stop, a cancelled request) is 503 `server.unavailable`. A run that passed
  its budget and would not stop answers its own caller 503 `wasm.execution_error`, like any budget
  stop, since that is what happened to it. While such runs fill their bound, every new run is 503
  `server.unavailable`, never `server.busy`: a runtime that could not stop its guests is a fault,
  not a queue to wait in. A data source that cannot answer is the same code.
- **Idempotency is by submission key,** not by digest (ADR 0064 decision 5). A known key with
  another digest is a 409 before the sandbox runs; a rejected delivery leaves its key free. Two
  deliveries in flight at once may both reach the handler (no lock between the look-up and the
  record), so handlers key their store by the submission key.
- Posted, unstored answers are never sealed with the server's key unless
  `datum.pdf.seal.posted-answers=true`; a throwaway certificate seals them. The server's key
  vouches for what the server stored or judged, not for whatever a caller posts.
- A capability that cannot work because of a permanent platform fact (a bytecode runner, no
  program) reports UP with `available: false` and the reason, never DOWN: DOWN is for outages, and a
  readiness probe would restart an instance for ever where nothing can fix it
  (docs/spring.md "Actuator and metrics").
- `datum-core` writes doubles exactly as ECMAScript's `Number::toString` on JDK 17 and 25 (one
  formatter shared by `CanonicalJson` and `Jcs`, proved against a Node oracle), so `Jcs` is
  in-tree and `java-json-canonicalization` is a test-scope cross-check only.

### 8. A transport-neutral service layer under the HTTP facades

Other callers (a queue consumer, a JDBC batch, a syncing device, a re-validation of records on
the current version, an import) use the engine without HTTP.

`datum-submissions`' `SubmissionService` holds the whole pipeline with `submit`, `validate` and
`test`, answering a sealed `SubmissionOutcome` with no header, media type or status the service
chose (the one status inside is the pre-check SPI's own, carried unread in `Refused`). A
`SubmissionContext` names the channel (`http`, `jdbc`, `bus`, `sync`, `other` or the caller's
word), the principal, the throttle key and the submission key, and every submission event
carries the channel. The body cap is the service's too, measured on the tree, so a tree from
elsewhere meets the same number. `SubmissionReceiver` is only the HTTP admission and the mapping
of the outcome to the catalog's status, code and headers; `datum-ui`'s `BuilderService` holds the
builder's writes the same way, behind `BuilderApi`. The service layer is in docs/spring.md
("Using the engine without HTTP").

### 9. One lifecycle hook model for every capability

Every capability has the same stages: ordered `*Customizer`s before the engine or the store
(adjust a typed draft or refuse), ordered `*Validator`s after the engine's verdict and before
the effect (errors refuse, warnings ride along), one handler for the effect, and events after
it. The interfaces and their call sites are in the libraries; the discovery and the order
(`ObjectProvider.orderedStream()`, `@Order`) are in the bindings, with no Spring type in a hook.

There is one typed refusal for every hook, `HookRefusedException`, with a transport-neutral kind
(`FORBIDDEN` 403, `CONFLICT` 409, `INVALID` 422 with the errors body); anything else a hook throws
fails the request. `PreCheckDecision.Reject` carries a code and words only; the HTTP receiver maps
the code to a status with `PreCheckStatuses` (403 for every code by default), so no
`SubmissionOutcome` holds a status.

The events are published through `DatumEventPublisher`; the binding's default publisher is
guarded (a listener's failure does not fail the request), and an application's own publisher
bean is used as given and owns its failure semantics. Capabilities and health checks are beans
collected by a registry, so replacing a facade or the runtime does not drop them, and sandbox and
PDF-runtime behaviour is decorated by composable ordered `SandboxDecorator` and
`PdfKernelDecorator` beans, not by a factory route. The stage diagram and the hook table per
capability are in docs/spring.md ("Lifecycle and hooks", "Events").

### 10. Framework-first: access, JDBC, resources, libraries and configuration

If the framework or the JDK already does a thing in the standard way, Datum exposes an
integration point and does not do it. Parity between hosts is the same capabilities and wire,
never the same implementation. For the JVM this means:

- **Access is the application's security.** There is no Datum access policy. `datum-web-core`
  names the routes by what an application secures them for (`DatumRouteGroups`, from the endpoint catalog; the definition route's full copy,
  `?public=false`, is the builder's group, never the public one) and words the two refusals (403
  `access.denied`; 401 `unauthorized` with the application's `WWW-Authenticate`);
  `datum-spring-web` turns these into Spring Security pieces the application installs, and warns
  when the builder's writes, the passkey endpoints or a client-mode timestamp server are on and no
  security chain exists. A rule about a form named in the body (a delivery, a check, a dry run, a
  PDF) is a `SubmissionPreCheck`, whose `IncomingSubmission` carries the caller's principal on
  both stacks; passkeys are secured as a whole. What stays Datum's: the passkey registration
  context, which is in the body; the Test context is for the roles of `datum.webauthn.test-roles`
  only (nobody by default), because it is the way to make a passkey at a form while registration
  at forms is off.
- **Stores use Spring's JDBC** (section 5), form locations go to Spring's resource resolver, size
  and duration parsing is Spring's, 405 rules sit on `PathPatternParser`, and `{assets}/**` is
  served by Spring's resource handlers on both stacks. The assets are generated into
  `target/datum-assets` by the Maven build itself, not checked in.
- **Where a library covers a thing, the library wins:** Caffeine for the bounded caches, the
  JDK's memory MXBean for the container budget, Bouncy Castle for the DER and PEM work and
  `PKIFailureInfo`, Jackson data binding for the language-changes header, one `EntityTags` helper
  for `ETag` and `If-Match`, Spring SSL bundles for the signing keys, Spring's `RestClient` behind
  a `TsaTransport` for outbound timestamp calls. `micrometer-observation` is optional in the
  libraries.
- **Configuration fails fast:** `SandboxSettings` validates at construction and names the
  property, and typed start-up refusals have a `FailureAnalyzer`. Security-relevant seams are
  beans: a `Sandbox` interface (one prototype bean for every caller), a `RunLog` bean for the
  guest's log, a `Timestamper` bean that wins over the URL and the in-process authority, and
  `PdfTrustPolicy` (the JDK's PKIX builder with revocation, a signing time proved only by a
  verified site or trusted timestamp).
- **Code conventions:** no Lombok (data types are records, unions are sealed interfaces),
  JSpecify `@NullMarked` on the SPI packages, SLF4J key-values, and every published jar carries
  `META-INF/LICENSE` and `META-INF/NOTICE`; the notices rule is bundled assets plus direct
  non-Boot libraries.

### 11. WebAuthn is webauthn4j first, with Datum's policy around it

webauthn4j's non-strict manager (attestation `none`, no trust anchors) parses and verifies
registrations and assertions; the assertion is verified with the stored SPKI and algorithm in a
fresh credential record whose counter the library never judges (the replay guard comes first).

Datum keeps its policy around the library, and the library never sees a byte before it: a
structural CBOR pre-gate (`CborGate`) and the authenticator-data layout, strict client data,
ES256 on P-256 or RS256 of 2048 bits and more, `crossOrigin` refused, the exact challenge text,
the exact origin text on the allow-list (the library compares normalised origins, so Datum
compares the text again), the relying-party id, the user-verification policy, and the reported
credential id and SPKI against the authenticator data's. The limits are in docs/spring.md ("Fixed
by contract", "Passkeys"). The first refusal ends the verdict, so a stored `checks` map counts a
check after it as not passed. The signing ceremony has a `SignatureCheckCustomizer` that can only
tighten (refuse, require user verification, shorten the window).

### 12. The host kit

`datum-host-tck` is the wire contract of every endpoint as JUnit 5 interfaces over a base URL,
depending on no Datum library and no framework. The cross-host gate is the Node kit,
`datum-host-check` in the conformance suite (ADR 0151, decision 9), which ports each
contract case and runs over HTTP with Node alone; the security suite's endpoint mode complements
both from the refusing side. The kits are in docs/spring.md ("The host test kit"). Shared test
helpers live in unpublished `*-test-support` modules, so no library publishes a `tests` jar; each
library compiles its own support module's sources into its tests with `build-helper-maven-plugin`
`add-test-source`, because a test-scope dependency on its own support module would be a cycle.

### 13. Release

`npm run jvm:release` is the release path (`integrations/jvm/README.md`, "Release"). The signing
key and the Central token are the maintainer's alone, and no script prints or handles them.

## Reasoning

- **Libraries plus bindings, not a Spring host with a Quarkus port later.** Status codes, the
  pipeline order and the wire codes are the contract every host shares. Putting them in a
  library with a boundary test makes "a status decided in a binding" and "a library that names a
  framework" the two defects, and makes a second binding a matter of wiring.
- **Capability modules over layers.** A capability's stores, hooks and migrations ship in its
  module.
- **Endive over Chicory, wasmtime-java and GraalWasm** for the runtime, with Redline. Compiling
  the engine in the consumer's application was rejected: it is a long experimental step over a
  binary the application would first have to download and verify. Shipping one precompiled class
  built in CI means every consumer runs identical code.
- **The packages store nothing** because storage, review, retention and exports belong to the
  application that owns the data; the handler and the events are the hand-off.
- **No access policy of Datum's own.** The application's Spring Security answers who may call.
- **webauthn4j first,** by section 10's rule that where a library covers a thing Datum
  hand-wrote, the library wins; Datum's gate and policy still refuse what Datum refuses.
- **No bundled `spring-security-webauthn`:** it is login-oriented. Design-system bindings and
  plugin jars, host chrome and the features gate are the page's, not the server's, and there is no
  extension registry.

## Consequences

- A Spring Boot team adds the BOM and one starter. Story one needs no assets; story two serves
  the form assets under a build-id path, with the builder one switch away and who may use it
  the application's Spring Security to say.
- The `Qjs` class is bound to the exact Endive version, which the BOM pins; Endive's runners are
  experimental, so a bump is a deliberate change. Each native instance costs transient heap and
  some set-up time, so slot counts and memory limits are operator decisions the docs spell out
  (docs/spring.md "Heap and pool guidance"). In-memory defaults are single-instance by design;
  the refuse-to-start rule makes that a choice, not an accident.
