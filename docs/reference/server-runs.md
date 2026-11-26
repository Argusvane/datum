# Sandbox and server runs

Validating a submission in the QuickJS/WASM sandbox in the browser, and re-running the same
sandbox and PDF programs on a server. The bundles named here
are described in [Embedding the form and the builder](embedding.md).

## Validate in the sandbox

Validate in the sandbox (ADR 0046):

```html
<datum-form id="intake" wasm="auto" src="/forms/intake.json"></datum-form>
<script type="module">
  const form = document.getElementById("intake");
  // Rules of the page's own: an ES2020 program whose value is a module object with validators,
  // each returning codes and the field they belong to, never text. No closures, no Date, no fetch.
  form.wasmPlugins = [{ id: "intake-rules", version: "1.0.0", source: `({ validators: [(context) => {
    const name = context.values.fullName;
    const errors = typeof name === "string" && name.trim() !== "" && !name.trim().includes(" ")
      ? [{ code: "custom.fullNameIncomplete", componentId: "fullName", path: "fullName", stage: "intake-rules", source: "custom" }]
      : [];
    return { errors };
  }] })` }];
  // What the rules may read beside the values, gathered by the page per submit: the sandbox never fetches.
  form.wasmExternalData = () => ({ phoneCountries: ["CA", "US"] });
  form.messages = { "custom.fullNameIncomplete": { default: "Enter your first and last name." } };
</script>
```

`wasm="auto"` fetches `datum-wasm.js` from beside the bundle (else the URL given) once the form
is ready, and from then on every submit re-checks the field constraints, runs the page's rules
and strips any value the form does not define inside the QuickJS sandbox — the same program
gives the same verdict wherever it runs (ADR 0029). A submit before the module arrives waits
for it; a module that cannot load blocks the submission under `wasm.execution_error` rather
than skipping the stage. `datum-wasm-ready` reports the sandbox in place. A page that imports
the module itself assigns `createWasmValidationHost([...])` to `wasmValidationHost` instead —
the promise will do.

## The run log

The sandbox has no console; it has a run log (ADR 0050). A rule writes to `context.log`
(`debug` / `info` / `warn` / `error`), the kernel logs each of its own steps, and what was kept
comes back with the outcome: `<datum-form wasm-log-level="debug">` sets what a run keeps
(`off`, `error`, `warn` — the default, so a run that behaves returns nothing — `info` or
`debug`), and `datum-wasm-validated` carries it as `detail.logs`, beside the values sent, the
external data injected and the sandbox's verdict. Plain data only, so the same run yields the
same log on every host.

The run log's rules:

- Each call to `context.log` appends `{ level, message, data? }` to an array, which the outcome
  returns as `logs` beside `errors` and `values`; the host reads it after the run and forwards it
  to a logger of its own (the browser runtime puts it on `WASM_VALIDATION_COMPLETED` as
  `response.logs`, a FastAPI endpoint loops over `outcome["logs"]` into `logging`). It arrives
  after the run, not during it.
- The context's `logLevel` (`off`, `error`, `warn`, `info`, `debug`) is the threshold: the kernel
  keeps entries at or above it, and below it a call costs one comparison. The default is `warn`, so
  a run that behaves records nothing and `logs` is absent from its outcome. `FormRuntime` takes
  `wasmLogLevel` as a dependency and as a per-`submit()` option, `createFormRuntime` takes
  `wasmLogLevel`, and `<datum-form>` reads `wasm-log-level` at each submit, so it needs no rebuild.
- The kernel logs its own steps. At `debug`: the run's opening (schema, mode, field count), the
  unknown-field verdict, the constraint tally with each error's code and component, and each
  validator's tally. At `info`: unknown fields stripped or rejected, and the closing verdict
  (`accepted` or `blocked`, with counts). At `warn`: a pattern that does not compile or is risky and
  was skipped, and a plugin function result that is not plain data.
- `data` must be plain data, with no error stacks and nothing an engine formats differently; the
  parity tests compare logs at every level. The sandbox has no `Date`, so entries carry no
  timestamps and the host stamps the batch.
- A run keeps at most 200 entries, then counts what it dropped and closes with one `warn` entry
  saying so. A message over 8 KiB is cut with `... [truncated]`, and `data` over 8 KiB serialised is
  replaced by `{ truncated: true, size }`.
- The kernel builds the log inside `runKernel` (`kernelCreateLog` opens it from `logLevel`, `kernelFinishLog` closes it into `logs`); both are in `PORTABLE_KERNEL_FUNCTIONS` so the QuickJS program carries them, and the in-process reference adapter needs nothing of its own.
- There is no host callback for the log: the program's string protocol is one-directional, and a
  rule cannot rely on anything beyond `context.log` and the returned `logs`.

## Validate on the server

Validate on the server too (ADR 0046): the build also writes `dist/datum-sandbox-program.js`,
the program the browser's sandbox runs, as a plain script any QuickJS evaluates. A server that
must not trust the browser re-runs it over the delivered envelope — here in Python, in
QuickJS-ng's own WebAssembly build, `qjs-wasi.wasm` from
[its releases](https://github.com/quickjs-ng/quickjs/releases), under `wasmtime`, one run per
request — and answers with the same codes, which the page hands to `setErrors` for its messages
to word:

```python
import json, math, threading, time
from wasmtime import Config, Engine, ExitTrap, Linker, Module, Store, WasiConfig  # pip install wasmtime
config = Config(); config.epoch_interruption = True     # the time budget: a run past its deadline traps
engine = Engine(config); linker = Linker(engine); linker.define_wasi()
QJS = Module.from_file(engine, "qjs-wasi.wasm")        # QuickJS-ng's WebAssembly build, compiled once

TICK = 0.05                                            # one clock for every run at once (see below)
def clock():
    while True: time.sleep(TICK); engine.increment_epoch()
threading.Thread(target=clock, daemon=True).start()

def qjs(argv, stdin_path, seconds, memory):            # one run: this dir read-only as /app, stdin in, stdout out
    out, store, wasi = [], Store(engine), WasiConfig()
    store.set_limits(memory_size=memory); store.set_epoch_deadline(math.ceil(seconds / TICK) + 1)
    wasi.argv = ["qjs", "--std", *argv]; wasi.preopen_dir(".", "/app", fs_mutable=False)
    wasi.stdin_file = stdin_path; wasi.stdout_custom = out.append; store.set_wasi(wasi)
    try: linker.instantiate(store, QJS).exports(store)["_start"](store)
    except ExitTrap as exit:                            # exit 1: a rule threw; a Trap is the budget, or the stack
        if exit.code: raise
    return b"".join(out).decode()

RULES = open("rules/intake-rules.js").read()           # context.json: {formId, form, values, locale, externalData, logLevel}
outcome = json.loads(qjs(["-I", "/app/datum-sandbox-program.js", "-e",
                          "__datum_register(" + RULES + "); print(__datum_run(std.in.readAsString()));"],
                         "context.json", 0.25, 32 * 1024 * 1024))
# outcome["errors"]: [{ code, componentId, ... }] — 422 with { field, code } per entry;
# outcome["values"]: the sanitized submission, keys the form does not define stripped;
# outcome["logs"]: the run log (ADR 0050), [{ level, message, data? }] — forward it to logging.
```

Each request is a run of its own — a fresh instance over the shared compiled module — so
requests share nothing and need no lock; the mount, stdin and stdout are all a run can reach,
and the budget and the memory are wasmtime's to enforce. The one thing the runs do share is
the engine's epoch, which the budgets are kept by, and that is why one clock ticks it for every
run at once and a run's deadline is its budget in ticks (plus one, for the tick already under
way): a timer per run, fired when its budget was spent, would advance the epoch under every
other run in flight too, cutting short one that had set its deadline a tick earlier — a wrong
verdict for a submission that was never judged.

The same on the JVM, with no native library and no JNI: [Endive](https://endive.run), the
Bytecode Alliance's WebAssembly runtime for Java, compiles the same `qjs-wasi.wasm` at build
time through its Maven plugin — to native code with Redline (Cranelift, the code generator
behind wasmtime; experimental in Endive 1.1.0) for Linux, macOS and Windows on x86_64 and
aarch64, and to JVM bytecode as the fallback anywhere else — into a class the jar carries.
The run is the same protocol: one instance per request over the WASI imports, the two
programs in an in-memory directory (Jimfs) as `/app`, the request on stdin, the answer on
stdout, the memory a limit on the instance, the budget a `Future` that interrupts the run —
the run's own, with no engine-wide clock to share, so nothing one run does can trip another:

```java
var wasi = WasiPreview1.builder().withOptions(WasiOptions.builder()   // run.endive:wasi
        .withArguments(List.of("qjs", "--std", "-I", "/app/datum-sandbox-program.js", "-e", script))
        .withDirectory("/app", APP).withStdin(stdin).withStdout(out).withStderr(err).build()).build();
var imports = ImportValues.builder().addFunction(wasi.toHostFunctions()).build();
var run = worker.submit(() -> {                                       // _start runs as the instance is built
    try (var instance = Qjs.builder().withImportValues(imports)       // Qjs: the class the plugin compiled
            .withMemoryLimits(new MemoryLimits(QJS_PAGES, 32 * 1024 * 1024 / 65536)).build()) { return null; }
});
run.get(5, TimeUnit.SECONDS);                                         // past the budget: run.cancel(true)
```

The same in C#, on the same engine: [Wasmtime](https://www.nuget.org/packages/Wasmtime), the
Bytecode Alliance's .NET embedding of wasmtime, carries its native library in the package for
Windows, macOS and Linux on x64 and arm64, so an ASP.NET Core endpoint is `main.py` line for
line — the module compiled once at start, a store per run with the memory limited on it, the
budget a deadline on the epoch the same shared clock ticks. WASI's standard streams are files
in this embedding, so the request goes in as one and the answer comes back as one:

```csharp
var engine = new Engine(new Config().WithEpochInterruption(true));  // Wasmtime 44.0.0 on NuGet
var qjs = Module.FromFile(engine, "qjs-wasi.wasm");                 // compiled once, at start
var linker = new Linker(engine); linker.DefineWasi();
var clock = new Timer(_ => engine.IncrementEpoch(), null, tick, tick);  // tick = 50 ms, for every run at once

using var store = new Store(engine);                                // one run
store.SetLimits(memorySize: 32 * 1024 * 1024);
store.SetEpochDeadline((ulong)Math.Ceiling(0.25 / tick.TotalSeconds) + 1);
store.SetWasiConfiguration(new WasiConfiguration().WithArgs(args)  // ["qjs", "--std", "-I", "/app/datum-sandbox-program.js", "-e", script]
    .WithPreopenedDirectory(".", "/app", WasiDirectoryPermissions.Read, WasiFilePermissions.Read)
    .WithStandardInput(stdinPath).WithStandardOutput(stdoutPath).WithStandardError(stderrPath));
try { linker.Instantiate(store, qjs).GetFunction("_start")!.Invoke(); }
catch (WasmtimeException exit) when (exit.ExitCode is int code)    // exit 1: a rule threw, and stderr says what
{ if (code != 0) throw new SandboxException(File.ReadAllText(stderrPath).Trim()); }
catch (TrapException trap) { throw new SandboxException(trap.Type.ToString()); }  // Interrupt: the budget; StackOverflow: the stack
var outcomeJson = File.ReadAllText(stdoutPath).TrimEnd('\n');
```

The same in Node.js, with nothing to install beside Node: V8 runs `qjs-wasi.wasm`, and
`node:wasi` (in the runtime since Node 20) gives it its system interface. What V8 lacks is a
store to hang a limit on — a module's memory is capped for the whole process, by the
`--wasm-max-mem-pages` flag, and nothing interrupts a running instance short of ending what runs
it — so an Express endpoint runs each request as a process of its own over a runner of a dozen
lines: the flag for its memory, a timeout for its budget (the run's own, with no clock to
share), the request on its stdin and the answer on its stdout, and the two programs in a
directory of the run's own, since Node's WASI mounts read-write and promises less than
wasmtime's sandbox. A run pays for the process's start and the module's compilation, about a
fifth of a second, so the validation budget is the Java's five seconds:

```js
// qjs.mjs — one run: node --wasm-max-mem-pages=<pages> --disable-warning=ExperimentalWarning qjs.mjs <qjs arguments>
const wasi = new WASI({ version: "preview1", args: ["qjs", "--std", ...process.argv.slice(2)], preopens: { "/app": "." }, returnOnExit: true });
const instance = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync("qjs-wasi.wasm")), wasi.getImportObject());
process.exitCode = wasi.start(instance);                          // 1: a rule threw, and stderr says what

// main.mjs — one run per request, in a process of its own, started in APP: the two programs and nothing else
const run = spawn(process.execPath, ["--wasm-max-mem-pages=" + 32 * 1024 * 1024 / 65536, "--disable-warning=ExperimentalWarning",
    "qjs.mjs", "-I", "/app/datum-sandbox-program.js", "-e", script], { cwd: APP, timeout: 5000 });
run.stdin.end(contextJson);   // the answer comes back on run.stdout; at "close", a signal is the budget (interrupt), exit 1 a throw
```

The docs site's "Your own server" pages show the server examples in Python, in Java (Spring Boot), in C#
(ASP.NET Core) and in Node.js (Express), one choice for the whole site; the Java, the C# and the
Node build and answer as the Python does, the PDF byte for byte the same.

## In process on Node: a fresh sandbox per call

A Node server that embeds `@argusvane/datum-quickjs-wasm-host` runs the same program with a sandbox built for each call (ADR 0181). A sandbox is a new WebAssembly instance of the engine with its own linear memory (each `newQuickJSWASMModuleFromVariant` runs the Emscripten loader again), a QuickJS runtime and context in it, the program evaluated, the entry points captured before the freeze and any plugin, and the plugin modules registered. It serves one call (a run, an inspect, the scaled budget's `inspect` question and the ABI probe alike) and is thrown away, so nothing one submission's run did reaches the next: a global it defined, state a plugin module kept, a prototype a plugin patched with the freeze off, memory it grew. The prepared-definition cache has nothing to keep (the host sizes it to 0), and the scaled budgets are remembered on the host's side by a hash of the definition.

`@argusvane/datum-submissions/node` builds the validator: `createQuickJsValidator({ worker: true })` is the default and binds `QuickJsWorkerHost`; `worker: false` binds `QuickJsFreshSandboxHost` (the package's main entry), the same fresh sandbox per call on the calling thread, built when the call comes, with no second clock and no ceiling on the instance's WebAssembly memory. An option that exists only on the worker throws with `worker: false`.

`QuickJsWorkerHost` (`@argusvane/datum-quickjs-wasm-host/worker`, Node only; the browser keeps the synchronous adapter and its reused sandbox) keeps one `node:worker_threads` worker for its whole life and a fresh sandbox per call inside it:

- The worker builds the next sandbox as soon as a call's answer is posted and says `ready`. The host sends a call only after that, and forgets the readiness as it sends. The worker takes the sandbox and clears it in one step and marks its memory spent, refusing a call in a memory it has seen. A build that fails after a call fails the call waiting for it, typed as a startup failure (`compile_error`, or `interrupted` past `bootTimeoutMs`), and the thread is replaced; the call after it gets a new worker.
- The host answers promises, queues calls, and terminates the worker at `maxEvalMs` plus `killSlackMs` (default 500 ms), answering `interrupted`; the next call starts a new worker over the same program and plugins.
- A running call is also interrupted when its instance's WASM memory passes `maxWasmHeapBytes` (default 512 MiB, checked at every interrupt poll, so it stops growth made of many small steps and not one huge native allocation), and the worker thread has `resourceLimits.maxOldGenerationSizeMb` (default 512), past which Node terminates the worker and the host replaces it. `memoryLimitBytes` (32 MiB) bounds QuickJS objects, not string data. What a call grew goes with its instance.
- There is one worker and one first-in-first-out queue, and it is unbounded: each queued call holds its request string (up to `maxRequestLength`), and a slow or killed call delays every form behind it. A host admits requests (a rate, a queue depth) before the sandbox.
- The worker drops a sandbox whole, unfreed, when a host-side error poisoned its runtime or a job is still queued in it, because freeing such a runtime aborts the instance. A queued job never runs, so a plugin that queues a spinning job costs the call nothing.

`QuickJsFreshSandboxHost` settles queued jobs under the call's own deadline and, on `dispose`, runs what is left for up to 250 ms before freeing the runtime; only a poisoned runtime is dropped whole. A plugin that queues a spinning job therefore holds the thread for the call's whole budget and that grace, and a native call that runs long outlasts the QuickJS interrupt handler, which only polls every few thousand VM operations. A server keeps the worker for that reason.

The options both hosts take: `plugins`, `program` (default the one built from the engine's source), `checkProgramAbi` (default true: a program handed in is proved to answer for the host's ABI before it judges anything), `maxEvalMs` (the scaled default when unset; see [Sandbox ABI](sandbox-abi.md#the-program-and-its-limits)), `maxStartupMs` (2,000), `memoryLimitBytes`, `maxStackSizeBytes`, `maxResultLength`, `maxRequestDepth`, `maxRequestLength` and `freezeIntrinsics` (default true). The worker adds `killSlackMs`, `bootTimeoutMs` (15,000 ms for a sandbox to be ready, a new worker's first included), `maxWasmHeapBytes` and `maxOldGenerationSizeMb`.

## Render, fill and sign PDFs on the server

Render the record on the server too (ADR 0043): the build copies the PDF program beside the
bundles as `dist/datum-pdf-program.js`, the executor the browser's PDF button runs, and a
server runs it the same way to answer a submission with its PDF — the same layout, the same
bytes. The program's `__datum_pdf` answers with a promise, which settles before `qjs` exits;
it takes the fonts as base64 (from `dist/fonts/`), the data-source options the server
resolved, and the only time and identity it ever sees:

```python
def render(request_path):                              # the document profile: 15 s, 256 MiB
    return json.loads(qjs(["-I", "/app/datum-pdf-program.js", "-e",
                           "__datum_pdf(std.in.readAsString()).then((json) => print(json));"],
                          request_path, 15, 256 * 1024 * 1024))
response = render("request.json")  # {"abi": "4.0.0", "op": "document", "form": form["root"], "pdf": form.get("pdf"),
                                   #  "values": outcome["values"], "locale": "en", "optionSnapshot": {"country": COUNTRIES},
                                   #  "fonts": FONTS, "env": {"createdAt": "2026-09-09T12:00:00.000Z", "documentId": "abc-123"}}
# response["bytes"] is the PDF as base64: answer it as application/pdf; the page shows the blob.
```

The same call fills an existing PDF form: with a template layout on the definition (the PDF's
fields and what fills each, authored in the builder's PDF mode) the server sends that layout —
or its `layoutId` — plus `"template": {"data": <the PDF, base64>}` from its own disk, and the
kernel writes the answers into the AcroForm's fields, left editable, locked or flattened as
the layout's options say; `response["fields"]` reports each one filled, cleared, missing or
unsupported. The docs' [Fill a PDF on the server](../../site/docs/server-example-fill.md) example is that
endpoint.

Which layout prints can follow the answers (ADR 0044). A layout's `when` — a condition over the
answers as they would be submitted, by component id — is tried in the order of `pdf.layouts`,
and a request that names no `layoutId` prints the first layout whose condition holds, else the
declared default: the same layout as the browser's PDF button and the submissions server pick
for the same answers. The `document` reply names the layout it printed (`layoutId`,
`layoutKind`, `layoutChoice`). A server that sends a template's bytes asks
`build` first and sends its `layoutId` back with that layout's PDF: the program refuses bytes a
condition would pour into another template. In the builder a layout's condition is its root's
Rules tab ("Print this layout when", fields suggested as "Label (id)"), its turn is set with
Move up / Move down in the layout's menu, a layout with a condition wears a Conditional badge in
the dropdown, the form's own Form panel says the order in words, and a component renamed on the
Form tab is followed into every condition; advice about a condition (one that never holds,
reads `host.`, names an entry field or counts a section's entries, is pre-empted by an earlier
one) never holds a Save back.

And sign it (ADR 0061): a record the server produced can say so in a way any PDF viewer
checks. Add `"signature": {"certificates": [<DER, base64>...]}` to the `document` request —
the layout says how (which `pdf-signature` block, certified or not, the reason) — and the
kernel places the signature field, hashes the file and answers with the prepared bytes and
`response["signing"]["toBeSigned"]`, the DER attributes to sign. The server signs those with
its own key (`cryptography`, `java.security`, `System.Security.Cryptography`, `node:crypto`,
or a KMS — the key never enters the sandbox), then `{"op": "complete", "pdf": {"data": ...},
"signing": {"certificates": [...], "value": <base64>}}` embeds the CMS: a PAdES-B-B signature
(`ETSI.CAdES.detached`), certified with no changes allowed when the layout asks, PDF/A kept.
`{"op": "verify"}` reads a file's signatures back with everything but the value checked; the
server checks the value with its platform crypto and trusts its own certificate. The docs
site's server signing example (`site/docs/server-example-sign.md`) is that endpoint, with a second one that verifies.
