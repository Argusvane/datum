# Submissions example: story one

The server validates what a form delivers. `datum-spring-boot-starter-submissions` runs the form's own rules in the
sandbox on every `POST /api/submissions`; `src/main/resources/datum/forms/endpoint-fixture.definition.json` (the
security suite's fixture form, key `datum-security-suite`) is the form, and `SubmissionsExampleApplication` supplies the
one thing the packages leave to you: a `SubmissionHandler` that stores what was accepted. This one logs and answers
`SUB-0001`, `SUB-0002`, ... as the reference.

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
./mvnw -q -B -pl examples/submissions -am package
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar
```

Because the form is the suite's, `datum-security-check --endpoint http://localhost:8080 ...` can attack this very
application. There is no controller in the application: everything on the wire is the starter's.

| What | Where | Default |
| --- | --- | --- |
| deliver a submission | `POST /api/submissions` | on here (`datum.web.api.endpoints.submissions: true` in `application.yml`) |
| check a journey page or the whole journey | `POST /api/submissions/validate` | on here (`validate: true`) |
| the form it receives for | `GET /api/forms/{key}/definition` | on here (`definition: true`) |
| dry run (nothing stored, no handler) | `POST /api/submissions/test` | off (`datum.web.api.endpoints.test=true`) |
| the kernel's inspection of a definition | `POST /api/inspect` | off (`datum.web.api.endpoints.inspect=true`) |
| the OpenAPI group `datum-submissions` | `/v3/api-docs/datum-submissions` | with springdoc on the class path |

Every Datum route is off until switched on (the start-up log lists the ones that are): a route that is off is absent (404, not 403), so the application may map the path itself.

The form's public copy (no server-secret rule) is `GET /api/forms/datum-security-suite/definition`; the security suite asks for it as
`/api/forms/datum-security-suite%401/definition` (the catalog key `id@version`), which answers the same while that version is current.
`/actuator/health` shows the datum runtime check and `/actuator/info` the capabilities (`info.datum`).

## Native access on JDK 24 and newer

The runtime picks Panama on JDK 25 and newer and JFFI below that (`ProviderSelector`). Both load native code, and from JDK 24 the JVM
warns about that unless native access is enabled: Panama calls `java.lang.foreign.Linker::downcallHandle`, JFFI calls `System::load`
(JEP 472). On JDK 17 to 23 neither runner warns and nothing needs setting. The executable jar's manifest says
`Enable-Native-Access: ALL-UNNAMED` (the module's `maven-jar-plugin` entry; Spring Boot's repackage keeps it), so `java -jar` runs without a
warning. The same thing for a run that does not start from the jar:

```
./mvnw -pl examples/submissions spring-boot:run -Dspring-boot.run.jvmArguments=--enable-native-access=ALL-UNNAMED
JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED java -cp ... com.argusvane.datum.examples.submissions.SubmissionsExampleApplication
```

Without it the runtime still starts and answers. On JDK 25 the JVM prints its own four-line `WARNING: A restricted method in
java.lang.foreign.Linker has been called` and the runtime logs one WARN naming the fix.

## The calls

A valid delivery (the suite's control CTL-01). The body of a delivery is `{"document": <the envelope>, "submissionKey": "<key>"}`: the key
names one submit attempt (1 to 128 letters, digits and `. _ : -`, starting with a letter or a digit), and a body without a usable one is
400 `bad_document`. A page mints a new key for each attempt and sends the same one on a retry; here `uuidgen` does:

```
DOC='{"versionContext":{"form":{"id":"datum-security-suite","version":"1"},"client":{"runtimeVersion":"x","rendererVersion":"x","schemaVersion":"1"}},"submission":{"locale":"en","values":{"name":"Ada Lovelace","code":"AB1234","addr":{"city":"Ottawa","pick":"ok"},"tags":{"x":true,"y":false},"rows":[{"sku":"s1","n":1}]}}}'
KEY=$(uuidgen)
```

200, accepted (the body is `{id, reference, status, digest, handled, receipt?, warnings?}`; `handled` is `false` here):

```
curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' -d "{\"document\":$DOC,\"submissionKey\":\"$KEY\"}"
```

Send the same body again, with the same key: 200 with the **first** receipt (the same `id` and `reference`) and `"handled": true`. The handler did not
run a second time and a `SubmissionRedeliveredEvent` fired instead of `SubmissionValidatedEvent`. A repeat is recognised by the form, its
version and the submission key (with the document's digest, which must match), in a `SubmissionIdempotencyStore`: bounded and in memory here (the startup WARN says so; `info.datum.idempotency`
is `memory`), JDBC when the application has one `DataSource` bean, or a `@Primary` one among several (table `datum_submission_digest`, script
`META-INF/datum/db/migration/<database>/V200__datum_submissions.sql` from the datum-submissions jar). The same document under a new key is a
second submission, the same key with a different document is 409 `submission.keyConflict`, and a rejected delivery leaves
its key free.

```
curl -s -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' -d "{\"document\":$DOC,\"submissionKey\":\"$KEY\"}"
```

422, the kernel's refusal (`required` on `name`; a body is `{errors: [{field, code, message?}]}`):

```
curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' \
  -d "{\"document\":$(echo "$DOC" | sed 's/"name":"Ada Lovelace"/"name":""/'),\"submissionKey\":\"$(uuidgen)\"}"
```

409 `form.outdated`, a page built from an older version of the form (the stale page reloads the form):

```
curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' \
  -d "{\"document\":$(echo "$DOC" | sed 's/"version":"1"/"version":"0"/'),\"submissionKey\":\"$(uuidgen)\"}"
```

413 `bad_document`, past `datum.web.api.max-body-size` (1 MB; the cap is counted on the stream, before anything is parsed):

```
head -c 1100000 /dev/zero | tr '\0' x | curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' --data-binary @-
```

415 `unsupported_media_type`, a Content-Type that is not JSON:

```
curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: text/plain' -d "$DOC"
```

429 `flood` with `Retry-After`, past `datum.web.throttle.limit` (60 a minute per address and form; lower it to see it quickly):

```
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar --datum.web.throttle.limit=3
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' -d "{\"document\":$DOC,\"submissionKey\":\"$(uuidgen)\"}"; done
```

The same 429, past `datum.web.throttle.address-limit` (600 a minute per address over every throttled route; 0 turns it
off). It counts a request after the Content-Type check and before the body is read, so bodies that never parse are
counted too: the fourth request below is 429, the first three 400 `bad_document`:

```
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar --datum.web.throttle.address-limit=3
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' -d '{'; done
```

503, the runtime cannot answer. Start with a program that cannot be read and `fail-fast` off: the application starts, the
health detail says why, and every submission is answered 503 (`server.unavailable`) rather than accepted unchecked.
A busy runtime is 503 `server.busy` with `Retry-After`; set `--datum.runtime.validation.concurrency=1
--datum.runtime.validation.wait=0s` and post two documents at once to see it.

```
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar \
  --datum.runtime.fail-fast=false --datum.runtime.programs.sandbox=file:/nonexistent.js
curl -i -X POST localhost:8080/api/submissions -H 'Content-Type: application/json' -d "{\"document\":$DOC,\"submissionKey\":\"$(uuidgen)\"}"
```

A journey check answers 200 `{accepted, errors, notes?}` whatever the verdict: `errors` holds only what blocks, warnings and info ride in `notes`. A run that failed is no verdict, so it is answered as a delivery is: 503 with the run's code (`wasm.execution_error`, `outcome_too_large`, no `Retry-After`) or 503 `server.unavailable`, never a 422. The request is `{document, scope, pageId?}` with `scope` required, and `pageId` only with `scope: page` (the fixture's journey is `main`):

```
curl -s -X POST localhost:8080/api/submissions/validate -H 'Content-Type: application/json' \
  -d "{\"document\":$(echo "$DOC" | sed 's/"locale":"en"/"locale":"en","journey":{"id":"main"}/'),\"scope\":\"journey\"}"
```

## Without HTTP

`QueuedSubmissions` is the same pipeline with no request: documents put on an in-memory queue (where a message listener,
a JDBC batch or a sync endpoint would put them) are taken by one worker and handed to the `SubmissionService` bean on
channel `bus` (docs/spring.md, "Using the engine without HTTP"). The route and the queue share the service, so a document
gets the same verdict either way, the handler stores it once whichever way it came first (the second answer is the first
receipt), and every event carries the channel it came in on (`SubmissionValidatedEvent.channel()`,
`SubmissionRejectedEvent.channel()`, ...). The queue names no throttle key, so the throttle does not count it; its own
bound (1,000 documents) is the backpressure. The handler's log line says the channel (`Accepted SUB-0001 for ... on bus`).
A message comes as bytes, as a broker hands it, or as a parsed tree: bytes past `datum.web.api.max-body-size` are refused
before they are read, the rest are read with Datum's capped mapper, and a tree meets the service's own cap, the same
number (the route answers 413 for the same document). Every message is queued with its submission key
(`offer(document, key)`, `offer(bytes, key)`; there is no keyless one): a broker's message id, say, the same when the
message is delivered again. "Stored once" holds one delivery at a time: two deliveries of one submit attempt in flight
at once can both reach the handler, on the route as on the queue, so a real handler keeps a unique key on the form key
and `AcceptedSubmission.submissionKey()`, never on the digest, which two people with the same answers share.

## Test-only switches for the external host kit

`datum-host-check` (packages/conformance-suite, docs/conformance-suite.md "Host conformance") proves the hardening and
runtime-down capabilities against this booted jar. Both are test deployments; neither is on by default.

```
# HRD-01..04: register the kit's hostile rule module for the fixture form (never on a host that takes real submissions)
datum-host-check fixtures --out /tmp/kit
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar \
  --datum.example.hardening-rules=/tmp/kit/hardening-rules.js --datum.runtime.validation.memory=512MB

# RDN-01: the stale program below the ABI floor, fail-fast off (every submission is 503)
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar \
  --datum.runtime.fail-fast=false --datum.runtime.programs.sandbox=file:/tmp/kit/stale-program.js
```

`datum.example.hardening-rules` is read by `HardeningRulesConfiguration`, which registers the module through a
`SandboxRulesProvider`; without the property the class is not loaded. The memory flag lets the module build its 40 MiB
answer so the run's output caps, not the module failing, are what stop it.

### Running the host check against the example

The Spring profile `host-check` (`HostCheckConfiguration` and `application-host-check.yml`) prepares one boot for the
Node host check's `submissions`, `submissions-test`, `forms`, `hardening` and `host-context` capabilities: it switches
the dry-run route on, serves the kit's host context fixture beside the example's form, registers the hostile rule
module, raises the validation memory and the throttle limit, and wires a TEST-ONLY `HostContextProvider` that reads
`X-Datum-Test-Role` for the form `datum-host-context` only. Never enable it where real submissions are taken. The profile
names no default for `datum.example.host-check-fixtures`, the directory `fixtures --out` wrote, so it refuses to start
without it:

```
datum-host-check fixtures --out /tmp/kit
java -jar examples/submissions/target/datum-example-submissions-0.1.0-SNAPSHOT-exec.jar \
  --spring.profiles.active=host-check --datum.example.host-check-fixtures=/tmp/kit
datum-host-check --endpoint http://localhost:8080 \
  --capabilities submissions,submissions-test,forms,hardening,host-context --out /tmp/report
```

`runtime-down` and `flood` each need a boot of their own (the stale program with fail-fast off; a low
`--datum.web.throttle.limit=30` and `--datum.web.throttle.address-limit=200`, which the other cases would exceed), as
described above and in
docs/conformance-suite.md ("Fresh deployments").

## What the application owns

- who may submit, check, dry-run or build: the application's Spring Security, with `DatumRequestMatchers` naming Datum's routes
  (`submissions()`, `validate()`, `dryRun()`, `builderWrites()`, ...) and `DatumSecurityResponses` answering the refusals in JSON
  (without Spring Security every route that is on is open, which is right for a public contact form); a rule that
  depends on the form, whose key is in the body, is a `SubmissionPreCheck` (its `IncomingSubmission` carries the form key and the
  caller's `principal()`);
- what an accepted submission becomes: the `SubmissionHandler` (a handler that throws answers 503 and stores nothing; events
  `SubmissionValidatedEvent` and `SubmissionRejectedEvent` carry the outcome to listeners);
- the proof runs at startup: `datum.runtime.startup-budget` (default 30s, 1s to 5m) is the time each ABI probe, smoke and warm-up run gets, so a loaded host
  does not refuse to start; requests keep the per-run budgets (`datum.runtime.validation.time-limit`, `datum.runtime.pdf.time-limit`);
- the limits of a gateway or a shared store: a `SubmissionThrottle` bean replaces the in-memory throttle (its `checkAddress` and
  `recordAddress` keep the address limit; left out, the replacement keeps none);
- the CSRF token when Spring Security is on the class path: `POST /api/submissions` is an ordinary POST to it.

## Tests

`SubmissionsExampleIT` boots the application with the real runtime and runs the host test kit's contracts
(`integrations/jvm/tck/datum-host-tck`: submissions, dry run, forms reads, flood) over HTTP: the golden documents of
`packages/conformance-suite/golden/abi-4.1.json` (CTL-01 valid, CTL-02 to CTL-04 invalid) and every refusal of the
receiving routes; it also checks this example's own handler references and actuator. `SubmissionsExampleDownIT` runs
the kit's runtime-down contract (the 503) with an unreadable program, `SubmissionsStaleProgramIT` with the kit's stale
program (`abi_mismatch`), and `SubmissionsHardeningIT` the kit's hardening contract: a test-only rule module makes a
loop, memory without bound, a 40 MiB answer and bytes after the answer frame, and each is refused (503 for a run that
gave no verdict) while the next submission still answers. `SubmissionsHostContextIT` runs the kit's host context contract
(HCX-01 to HCX-04) with a TEST-ONLY `HostContextProvider` that reads `X-Datum-Test-Role` for the kit's
`datum-host-context` form; the example itself wires no provider. `SubmissionChannelsIT` sends the golden documents through the route and through the queue: the
same rejections, the same 409 for a stale version, the same dry-run report, and a valid document stored once with
`bus` and `http` on its events. They are tagged `real-runtime` and run in `verify`.

## Running the integration tests outside the checkout

The kit carries the security suite's golden file and fixture form in its jar (`META-INF/datum-tck/`, copied by
the asset generation), so the ITs need nothing else from the checkout. A kit built without them reads the files from
the repository by walking up from the working directory, or from `-Ddatum.repo=<checkout>`.
