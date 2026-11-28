# The Java sandbox library

`datum-sandbox` runs Datum's two programs on the JVM: the sandbox program that validates a submission and the PDF program. It does the hard part of running them once, for every Java host:

- **Choosing the engine.** It finds and starts the WebAssembly engine.
- **Isolating each run.** Each run is a fresh instance with a read-only file system, a time and memory budget, and capped output.
- **Checking the answer.** Every answer is checked against the run protocol.
- **Proving the programs.** It proves the programs at start.
- **Limiting runs at once.** It caps how many runs go at the same time.
- **Reporting.** It tells you how its runs went.

It needs no framework, so it works in a plain `main`, a servlet container, Micronaut, Quarkus or anything else on the JVM. The [Spring Boot host](/spring-boot) is built on it. On Spring Boot, use the starters and set the same settings as [properties](/spring-boot-properties#runtime).

## Modules

| Artifact | What it is |
|---|---|
| `datum-sandbox` | The library: the settings, the lifecycle, the run protocol, the diagnostics. No engine and no framework. |
| `datum-programs` | The two programs, packaged. |
| `datum-sandbox-endive` | The engine, in-process. Add it with both of its runners. |
| `datum-sandbox-endive-panama`, `datum-sandbox-endive-jffi` | The engine's native runners. It uses Panama on Java 25 and newer, and JFFI before that. |
| `datum-pdf` | The PDF service (render, fill, sign, verify) over the sandbox. Only for PDFs. |
| `datum-sandbox-spring` | The Spring Boot binding. The starters bring it; you do not add it yourself. |
| `datum-sandbox-tck` | JUnit contracts for an engine of your own. |

```xml
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.argusvane</groupId>
      <artifactId>datum-bom</artifactId>
      <version>${datum.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-sandbox</artifactId>
  </dependency>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-programs</artifactId>
  </dependency>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-sandbox-endive</artifactId>
  </dependency>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-sandbox-endive-panama</artifactId>
    <type>pom</type>
  </dependency>
  <dependency>
    <groupId>com.argusvane</groupId>
    <artifactId>datum-sandbox-endive-jffi</artifactId>
    <type>pom</type>
  </dependency>
</dependencies>
```

Requirements:

- **Java.** 17 or newer.
- **Native access on JDK 24 and newer.** The engine uses native code, so the JVM wants native access. Do one of these:
  - Start the JVM with `--enable-native-access=ALL-UNNAMED`.
  - Put `Enable-Native-Access: ALL-UNNAMED` in the jar's manifest.
- **Logging.** The library logs through SLF4J. Add a provider, such as Logback, to see the settings report and the warnings.
- **Build from source.** The artifacts are not on Maven Central yet. Build the reactor under `integrations/jvm` first, as on [Spring Boot](/spring-boot#first-run).

## Validate a submission

Build a `DatumSandbox`, start it once, and validate as many submissions as you like. The builder needs no inputs: the engine is found on the class path and the programs are the packaged ones.

```java
JsonMapper json = JsonMapper.builder().build();
ObjectNode definition = (ObjectNode) json.readTree(Files.readString(Path.of("customer-intake.json")));

try (DatumSandbox datum = DatumSandbox.builder().build()) {
    datum.start();

    ObjectNode context = json.createObjectNode();
    context.set("form", definition.get("root"));
    context.set("values", json.readTree("{\"fullName\":\"\",\"contactMethod\":\"email\"}"));
    context.put("locale", "en");

    SandboxResult result = datum.sandbox().validate(context, List.of(), true);
    System.out.println(result.outcome().get("errors"));
}
```

```json
[{"code":"required","componentId":"fullName","path":"fullName","source":"wasm","stage":"field-constraints"}]
```

The context and the outcome are the ones on [Your own server](/server-programs#the-sandbox-run):

- **The context.** It takes the form's root, the answers and the locale, plus the optional keys listed there.
- **The outcome.** It lists the errors by code. When no error blocks, it also carries the cleaned-up `values`, which is what you store.
- **The last argument.** Pass `true` for a real submission, whose run log is passed to the library's run log, and `false` for a check.

`datum.sandbox()` also answers the other questions the sandbox program takes:

- `inspect`, about a definition;
- `check`, whether a definition may be saved;
- `publicCopy`, the copy of a definition a browser may be served.

`start()` proves both programs before it returns.

- **When a proof fails.** By default, `start()` throws.
- **Starting DOWN instead.** With `failFast(false)` in the settings, it starts DOWN: `status()` says why, and every run is refused until `recheck()` passes.
- **Threads.** A validation blocks the calling thread until it answers. The sandbox lets as many run at once as it has slots (one per CPU by default). A call that finds no free slot waits up to `validationWait` (2 s) and is then refused as busy.

## Settings

`SandboxSettings` holds every setting. Each builder method is a `datum.runtime.*` or `datum.host.*` property written in camel case: `validationTimeLimit` is `datum.runtime.validation.time-limit`, and `unknownFields` is `datum.host.unknown-fields`. A setting you leave out, or set to `null`, takes its default. [Spring Boot properties](/spring-boot-properties#runtime) lists every key with its default and bounds, and the FastAPI host reads the same names.

```java
SandboxSettings settings = SandboxSettings.builder()
    .validationTimeLimit(Duration.ofSeconds(3))
    .validationConcurrency(4)
    .unknownFields("reject")
    .trace("failures")
    .build();

try (DatumSandbox datum = DatumSandbox.builder().settings(settings).build()) {
    datum.start();
    // ...
}
```

How `build()` treats a value:

- **Out of bounds.** It is clamped to its bound, with one warning.
- **Cannot work.** It is refused with an exception that names the setting and what to do, such as an engine id no engine on the class path has.

`explain()` says what the sandbox runs with. It lists every setting with its value in force and where that value came from: `default`, `configured`, `clamped` from what was asked, or `replaced` when you handed the builder an input of your own in its place. With `.validationMemory(5L)` added to the settings above, part of it reads:

```text
Datum sandbox settings:
  datum.runtime.engine = endive (default)
  datum.runtime.fail-fast = true (default)
  datum.runtime.validation.time-limit = PT3S (configured)
  datum.runtime.validation.memory = 4194304 (clamped from 5 to [4194304, 1073741824] bytes)
  datum.runtime.validation.concurrency = 4 (configured)
  datum.runtime.pdf.concurrency = 0 (min(2, CPUs) = 2) (default)
  datum.host.unknown-fields = reject (configured)
  datum.runtime.diagnostics.trace = failures (configured)
  ...
```

## Status and shutdown

- **`status()`.** It says whether the sandbox is up and why not. `isUp()` is the readiness answer, and `details()` gives the state, the engine and its mode as a map for a health check.
- **`recheck()`.** It proves the programs again without a restart, reading a program override afresh. It never throws: a failure leaves the sandbox DOWN with the reason.
- **`stop()`.** It stops taking runs and waits `shutdownGrace` for the ones in flight, then cancels the rest.
- **`close()`.** It does the same and also closes the engine the sandbox made. `try`-with-resources calls it for you.

In a framework, build the sandbox once at application start, call `start()` from the framework's start hook and `close()` from its shutdown hook, and serve `status()` as a health check. The Spring binding does the same, and adds the properties, metrics and actuator endpoint.

## PDFs

The PDF service runs on the same sandbox. Add `datum-pdf`, and hand it the running sandbox:

```java
PdfService pdf = PdfService.builder().runtime(PdfRuntime.of(datum)).build();

ObjectNode accepted = (ObjectNode) datum.sandbox().validate(context, List.of(), true).outcome().get("values");
PdfResult file = pdf.renderSubmission(definition, accepted, "en", null, PdfOptions.defaults());
Files.write(Path.of("answers.pdf"), file.bytes());
```

- **What it renders.** Render the cleaned-up `values` from a validation, not what was posted.
- **The layout.** A `null` layout takes the one the answers choose.
- **Other inputs.** The builder also takes the signing key, fonts, a timestamp server and trust settings; [PDFs](/pdf) and [Signing](/signing) describe them.
- **Limits.** PDF runs have their own time, memory and concurrency settings (`pdfTimeLimit`, `pdfMemory`, `pdfConcurrency`).

## Diagnostics

All three are set on `SandboxSettings`. None of them can change a run's answer, and none can hold a run's slot.

### The run trace

`trace("failures")` writes one line for each failed run, and `trace("all")` one for every run, including the ones the sandbox makes at start. The line goes at INFO to the logger `datum.sandbox.trace`.

```text
run=cd7152c40e3f program=sandbox op=validate abi=1.0.0 engine=endive mode=panama slotWaitMs=0.0 prepareMs=0.3 instantiateMs=19.0 startMs=109.1 totalMs=129.7 termination=exited exit=0 outcome=verdict stdinBytes=1347 stdoutBytes=244 stderrBytes=0 capture=-
```

- **What it holds.** How the run went and how long each step took, how it ended, and the sizes of its input and output. It never holds an answer, the definition or the run's output.
- **What counts as failed.** A run that trapped, hit its time or memory budget or an output cap, was stopped, could not start, or gave an answer the protocol could not take.
- **What does not.** A validation that finds errors is a normal answer, not a failure.

To send the records somewhere else, such as metrics or an event bus, give the builder a `RunTrace`:

```java
DatumSandbox.builder()
    .settings(settings)
    .runTrace(record -> registry.timer("myapp.datum.runs", "program", record.program(), "outcome", record.outcome())
        .record(record.totalNanos(), TimeUnit.NANOSECONDS))
    .build();
```

### The failed-run capture

The capture keeps each failed run on disk so you can replay it: its input, its output, the generated run script and a `meta.json` with the trace fields and the settings report.

```java
SandboxSettings.builder()
    .captureEnabled(true)
    .captureDirectory("/var/lib/myapp/datum-captures")
    .build();
```

::: warning A capture holds personal data
A capture holds the submitted answers and the form definition, in clear text. Turn the capture on to debug a failure and off again after. The sandbox logs a warning saying so at every start while it is on.
:::

The directory must be one only the application's own user can read:

- **Missing.** It is created with mode `700`.
- **Refused at start.** The start is refused if the directory:
  - is a link;
  - belongs to another user;
  - gives the group or others any permission;
  - is on macOS and has an access control list.

  On a file system without POSIX permissions, such as Windows, the capture cannot be used.
- **Files.** Each is created with mode `600`.
- **Complete or absent.** A capture appears whole or not at all.

Bounds and timing:

- **Bounds.** `captureMaxRuns` (20) and `captureMaxBytes` (64 MB) bound what is kept, and the oldest captures go first.
- **The queue.** `captureQueueBytes` (64 MB) bounds what waits to be written. A capture that does not fit is dropped and counted.
- **Off the run's path.** The writing happens on a thread of its own, so a run never waits for its capture.
- **At stop.** What is still waiting is written in whatever is left of the shutdown grace.

To keep captures elsewhere, such as an object store, give the builder a `RunCaptureSink`. The bounds and the queue still apply.

### The settings report

At start, before the programs are proved, the sandbox logs one block at INFO on `datum.sandbox.settings`. It holds:

- what `explain()` lists;
- the engine and its mode;
- each program's sha256 and interface version;
- whether the trace and the capture are on.

Any user name and password in a URL is masked, and so are URL query values. Turn it off with `report(false)`.

## Builder inputs

Each of these is optional. Give one only when you need something other than the default.

| Builder method | What it replaces |
|---|---|
| `settings` | The defaults |
| `runtime(GuestRuntime)` | The engine found on the class path. You keep it and close it yourself. |
| `store` | Where the two programs are read from |
| `sandboxDecorators`, `pdfKernelDecorators` | Wrappers around every sandbox or PDF run, for tracing or an audit. A wrapper passes each call on and never answers in the program's place. |
| `runTrace`, `captureSink` | Where the trace and the capture go |
| `events`, `observations`, `runLog` | Where ready and interrupted events go, the observation of each run, and the programs' own run log |
| `clock`, `classLoader` | The clock the capture names are stamped from; the loader the engine and programs are found in |

An engine of your own implements `GuestRuntimeProvider`, registered for `java.util.ServiceLoader`, and is chosen with `engine("<its id>")`. Its tests implement the contracts in `datum-sandbox-tck`, which hold it to the same hardening as the shipped engine.
