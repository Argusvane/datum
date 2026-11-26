# Datum for the JVM

The server-side hosts for Datum forms on the JVM: Maven artifacts under group id `com.argusvane`, Java 17
or newer, one version for the whole reactor (`${revision}`, `0.1.0-SNAPSHOT` in the tree, set by `-Drevision` at release). The host is Spring Boot 4. The user guide is
[docs/spring.md](../../docs/spring.md); the design record is
[ADR 0152](../../docs/adr/0152-a-spring-boot-host-as-capability-modules-on-shared-jvm-libraries.md).
What every host is held to is the wire contract (the endpoint catalog, [integrations/shared/endpoint-catalog.json](../shared/endpoint-catalog.json)),
the conformance suite ([docs/conformance-suite.md](../../docs/conformance-suite.md)) and the kernel ABIs; this host checks itself
against them with the host test kit (`tck/`) and the engine test kit (`libs/datum-sandbox-tck`).

## Layout

| Directory | Modules | What lives there |
|---|---|---|
| `libs/` | `datum-core`, `datum-programs`, `datum-sandbox` (the sandbox protocol, runtime and settings), `datum-sandbox-tck`, `datum-sandbox-endive` (+ selectors `-jffi`, `-panama`), `datum-web-core`, `datum-forms`, `datum-submissions`, `datum-ui`, `datum-pdf`, `datum-timestamp`, `datum-webauthn`; beside each library whose test helpers (fixtures, fake runtimes, the library-boundary rule) other modules' tests share, an unpublished `datum-<lib>-test-support` module | every decision: the neutral facades (`FormsApi`, `SubmissionsApi`, `BuilderApi`, `PdfApi`, `PasskeysApi`, `TsaEndpoint`) and the transport-neutral services under the submission and builder ones (`SubmissionService`, `BuilderService`: the engine without HTTP, [docs/spring.md](../../docs/spring.md#using-the-engine-without-http)), the store SPIs with their in-memory development defaults and the SQL migration scripts (no JDBC: the SQL stores are the bindings'), the settings records, the error model, the endpoint catalog, the assets and `datum-host.js`; the engine SPI (`GuestRuntimeProvider` through `ServiceLoader`, `EngineInfo`, the engine-neutral `RunHarness`) in `datum-sandbox`, whose `DatumSandbox.builder().build()` runs the programs with no framework (settings, clamps and `explain()` in `SandboxSettings`), and the in-process engine kit `datum-sandbox-tck` that Endive's ITs implement ([docs/spring.md](../../docs/spring.md#engines)). No framework type: each module's `LibraryBoundaryTest` forbids Spring, Quarkus, JAX-RS, CDI, Vert.x, `java.sql` and `javax.sql`, in every library, with or without a store. A test-support module depends on its library, so the library's own tests compile the same sources through build-helper (a dependency back would be a cycle); the Spring bindings depend on it with test scope. No test-support module is in the BOM or deployed, and the release script refuses a tests jar. |
| `spring/` | `datum-spring-web`, `datum-sandbox-spring` (`datum.runtime.*`, the engine and sandbox beans, lifecycle, health, the `datum` endpoint), `datum-forms-spring`, `datum-submissions-spring`, `datum-ui-spring`, `datum-pdf-spring`, `datum-timestamp-spring`, `datum-webauthn-spring`, the starters `datum-spring-boot-starter-{submissions,ui,pdf,timestamp,webauthn,test}` | Spring Boot 4 bindings: auto-configuration, `@ConfigurationProperties` mapped onto the settings records, the MVC and WebFlux adapters that only move bytes, the SQL stores on Spring's `JdbcClient` and `TransactionTemplate` (each call a transaction of its own; `DatumStoreJdbc` in `datum-spring-web`), actuator and springdoc wiring. Each module's `BindingBoundaryTest` keeps decisions out of it. |
| `tck/` | `datum-host-tck` | the wire contract of every endpoint as JUnit 5 interfaces over a base URL, and the `HostTck` runner ([README](tck/datum-host-tck/README.md)) |
| `examples/` | `submissions`, `ui`, `ui-builder-jpa`, `passkeys`, `tsa-server`, `webflux-pdf` | six applications, built and tested by the reactor and never deployed; their integration tests run the kit's contracts |
| `scripts/` | | `build-assets.mjs` (generated assets, notices, fixtures), `release.mjs`, `notices.json`; see [scripts/README.md](scripts/README.md) |
| `datum-bom` | | every Datum artifact plus the pinned third-party libraries (Endive 1.2.0 exactly) |

## Libraries and bindings

The split exists so a second host reuses the first one's decisions. A **library** decides: status codes, error codes,
the order of the receive pipeline, what a definition is allowed to be, how a run is classified, what a startup check
says. A **binding** reads the request, calls a library type and writes the reply, and wires beans: it may not decide a
status, parse a body, judge a definition, order the receiver, classify a run or shape an error. Where a framework has
a capability the library needs (an event bus, the class path), the library takes a small
interface (`DatumEventPublisher`, `FormSources.Resolver`) and the binding supplies it.
Package names follow the rule: `com.argusvane.datum.<module>` for a library (`datum-web-core` is `com.argusvane.datum.web`), `...<module>.spring` (and
`springweb.mvc`, `springweb.webflux`, `springweb.autoconfigure`) for a Spring binding.

A consumer's pom is a BOM import plus a starter:

- story one, the form is on my page and the server validates it: `datum-spring-boot-starter-submissions`
  (`POST /api/submissions/validate`, `/api/submissions`, the `SubmissionHandler` hook, events; no browser assets);
- story two, the server also serves the form: `datum-spring-boot-starter-ui` (the elements' assets, the definition
  endpoint, the thin glue); `datum.builder.enabled=true` adds the builder;
- `-pdf`, `-timestamp` and `-webauthn` for the other capabilities, `-test` for tests.

A starter on the classpath registers no route until the application switches it on: every
`datum.web.api.endpoints.*` switch and `datum.web.assets.enabled` default to false, and `datum.builder.enabled`,
`datum.tsa.enabled` and `datum.webauthn.enabled` already did. The start-up log lists the routes that are on (method,
path, the switch), or says that none is and names the properties. The set for each story is the table "Switches per
story" in [docs/spring.md](../../docs/spring.md#switches-per-story); the examples set theirs in `application.yml`.

## The sandbox library

`libs/datum-sandbox` runs every WebAssembly program for every capability, with no framework ([ADR 0176](../../docs/adr/0176-one-sandbox-library-per-server-language.md)).
Its `.wasi` package is the generic hardened WASI run (no Datum type; a boundary test holds it), `.protocol` the Datum run protocol,
`.runtime` the lifecycle and `SandboxSettings`, `.diagnostics` the trace, the capture and the settings report. Engines are
modules of their own behind `GuestRuntimeProvider`: `datum-sandbox-endive` (and its `-jffi` and `-panama` selectors), checked by
`datum-sandbox-tck`; `datum-sandbox-spring` is the Spring binding. A host with no framework runs the programs like this (the shape of
`PlainJavaSandboxIT` in `datum-sandbox-endive`):

```java
try (DatumSandbox sandbox = DatumSandbox.builder().build()) {
    sandbox.start();
    SandboxResult result = sandbox.sandbox().validate(context, List.of(), false);
    System.out.println(sandbox.explain());   // every setting, with where its value came from
}
```

The diagnostics keys (all under `datum.runtime.diagnostics.`; the guide is [docs/spring.md](../../docs/spring.md#diagnostics)):

| Key | Default | |
|---|---|---|
| `trace` | `off` | `off`, `failures` or `all`: one line per run on the logger `datum.sandbox.trace` |
| `report` | `true` | the settings report at start, on the logger `datum.sandbox.settings` |
| `capture.enabled` | `false` | keep failed runs on disk; **they hold the submitted answers and the form definition in clear text** |
| `capture.directory` | none | required when the capture is on and no `RunCaptureSink` is supplied; owner-only (`0700`), refused at start otherwise |
| `capture.max-runs` | `20` | the most captures kept |
| `capture.max-bytes` | `64MB` | the most bytes all kept captures take |
| `capture.queue-bytes` | `64MB` | the most bytes waiting to be written |

## Build

From this directory, with the Maven wrapper (JDK 17 or newer; the `jdk25` profile turns on the Panama runner's
integration tests when the JDK is 25 or newer):

```sh
./mvnw -B verify                         # the whole reactor
./mvnw -B -pl spring/datum-forms-spring verify    # one module, with its dependencies installed in ~/.m2
./mvnw -B -Pdev-native clean install -DskipTests -DskipITs  # a local install of the runtime
```

`-DskipTests` skips the unit tests only: the failsafe integration tests still run unless `-DskipITs` goes with it (a whole-reactor install
that leaves it out took 19 minutes on a busy machine, most of it integration tests). A local install of one starter and what it needs is
`./mvnw -B -Pdev-native -pl spring/datum-spring-boot-starter-submissions -am clean install -DskipTests -DskipITs`, about 3 minutes.

`datum-sandbox-endive` compiles the pinned `qjs-wasi.wasm` into a `Qjs` class with Endive for six native targets, 12 to
16 minutes; `-Pdev-native` compiles the host's target only, for local iteration (the release profile refuses it). Use
it for any build that touches that module. The plugin compiles on every build, also when its output is already in
`target/`; `-Pendive-prebuilt` builds over that output without compiling (no `clean`: it stops when the output is not
there, and the release profile refuses it). The JVM workflow (`.github/workflows/jvm.yml`, started by hand rather than on
every push) compiles once in its `jvm-runtime` job, caches the output, and builds every Java version with that profile.

The browser assets, programs and notices the jars carry are build output that the build generates itself: the root
project runs `scripts/build-assets.mjs` once per reactor build (exec-maven-plugin, `generate-resources`) from
`packages/datum/dist`, so build those first (the "Before you build" block of any [example](examples/ui/README.md#before-you-build) lists the commands) and have `node` on the `PATH`. They land in
`integrations/jvm/target/datum-assets/<module>/` (with `assets.properties`, the `Datum-*` manifest entries), each module's pom
maps its directory into the jar, and `./mvnw clean` at the root removes them; nothing generated sits beside a module's
sources: the test fixtures too are generated into `target/datum-assets/<module>/test-fixtures/`, which the parent pom maps as a test resource
directory (they appear on the test class path as `datum-fixtures/`). A
`-pl` build of one module does not start the root and reuses the last generation; `./mvnw -N generate-resources` makes one
(`npm run jvm:assets` at the repository root is the same script, under the dist lock). `-Ddatum.assets.skip=true` reuses
what is there, `-Ddatum.assets.allowStale=true` generates from a dist older than its sources, `-Ddatum.assets.omitFeatures=a,b`
leaves features out. Never edit the generated files by hand.

From the repository root, `npm run jvm:test` runs the same verify.

CI builds the reactor on Temurin 17, 21 and 25 and checks that the working tree stays clean; the node harness for
`datum-host.js` needs Node 20 or newer and fails, not skips, under `CI=1`.

## Release

`npm run jvm:release -- --version <x.y.z>` rebuilds the assets, runs the security suite's program mode with
`--gate release`, runs `./mvnw -B -ntp -Prelease -Drevision=<x.y.z> clean deploy` and checks every jar (including the
three Endive engine jars; no tests jar exists, the shared test helpers are in the unpublished `libs/*-test-support` modules): `META-INF/LICENSE`, `META-INF/NOTICE`, the
`Datum-*` manifest entries, no SNAPSHOT dependency. It writes `dist/datum-jvm-<x.y.z>/release.json`, `SHA256SUMS` and a
README with the BOM snippet, and prints the tag to create (`v<x.y.z>`; one version and one tag for the whole JVM
reactor, the tag the other hosts' releases use too). `--dry-run` builds the sources and javadoc jars with signing skipped and deploys nothing. Signing needs the
maintainer's GPG key and publishing the Central token in `~/.m2/settings.xml`; neither is ever printed or handled by a
script. Options and the post-checks are in [scripts/README.md](scripts/README.md).

## Testing a host

The host test kit proves a deployment answers as specified, and the security suite proves it refuses what it must; both
run in CI against the packaged `examples/ui` application. See "Testing your application" in
[docs/spring.md](../../docs/spring.md#testing-your-application) and the kit's [README](tck/datum-host-tck/README.md).
