# Running the WebAssembly sandbox

The sandbox runs in three places, and each takes more work than the one before: in the page, on a Datum host, and on a runtime of your own. This page walks through all three and ends with what to check when a run does not behave.

[How Datum uses WebAssembly](/wasm) explains the parts named here: the runtime, the engine module, the programs and the rule modules.

| Where | You do | Use it for |
|---|---|---|
| [In the page](#in-the-page) | Serve one file and set one attribute | Development and testing |
| [On a Datum host](#on-a-datum-host) | Add a package and switch a route on | Production on Spring Boot or FastAPI |
| [On a runtime of your own](#on-a-runtime-of-your-own) | Start each run yourself | A framework with no Datum host |

## In the page

The page runs the same sandbox program a server runs, so a form shows the server's verdict before a server exists.

1. **Serve the module.** Keep `datum-wasm.js` in the folder with `datum-form.js`: see [Files you host](/files).
2. **Allow WebAssembly.** Under a Content-Security-Policy, add `'wasm-unsafe-eval'` to `script-src`: see [Security headers](/security-headers).
3. **Turn it on.** Set `wasm="auto"` on the element, or give `wasm` the module's address.
4. **Give it your rules.** Assign your rule modules to `wasmPlugins`, and what they read beside the answers to `wasmExternalData`.
5. **Read the verdict.** Listen for `datum-wasm-validated`.

```html
<datum-form id="intake" src="/forms/intake.json" wasm="auto" wasm-log-level="info"></datum-form>
<script type="module">
  const form = document.querySelector("#intake");
  form.wasmPlugins = [{ id: "intake-rules", version: "1.0.0", source: await (await fetch("/rules/intake-rules.js")).text() }];
  form.addEventListener("datum-wasm-validated", (event) => {
    console.log(event.detail.blocked, event.detail.outcome?.errors, event.detail.logs);
  });
</script>
```

[Validation and the sandbox](/validation#in-the-page) has every setting, the context a rule reads and a live example.

### What the element does with it

- **One fetch per address.** The module is fetched once and shared by every form on the page. Each form builds a sandbox of its own from it.
- **The page's own origin.** An address on another origin is refused unless `allow-origins` lists it.
- **A version check.** A module built for another interface version than the element's is refused. Serve both from one build.
- **A submit waits.** A submit made before the module has arrived waits for it.
- **One sandbox per form.** The program and your rule modules are loaded once, and every submit of that form runs in the same sandbox. Changing `wasm` or `wasmPlugins` builds a new one.
- **On the page's own thread.** A run holds the page until it ends, which is at most its budget. That is one more reason to keep rule modules small.
- **A failure blocks.** A module that will not load, a rule that answers wrongly and a run past its budget all block the submit with `wasm.execution_error`. Nothing passes unchecked.

### Budgets in the page

| What | Default | Set with |
|---|---|---|
| Loading and building the module | 15 s | `wasm-timeout` |
| Starting the sandbox | 2 s | `maxStartupMs`, when you build the sandbox yourself |
| One run | 250 ms, scaled up with the rules, the definition and the request to at most 5 s | `maxEvalMs`, when you build the sandbox yourself |
| Memory | 32 MiB | `memoryLimitBytes`, when you build the sandbox yourself |

[Loading the sandbox yourself](/validation#loading-the-sandbox-yourself) shows `createWasmValidationHost`, which takes those three options.

### When to leave it out

- **In production.** A page that delivers to a server that validates does not need the sandbox. Leaving it out saves the download and keeps `'wasm-unsafe-eval'` out of your policy.
- **As the only check.** The browser belongs to the person using it. A verdict made there is a preview, and only your server's run decides.

### In the builder

The builder's Try it runs the same module, so an author sees the server's verdict while building. It looks for `datum-wasm.js` beside its own bundle: see [Embedding the builder](/embedding-the-builder).

## On a Datum host

A Datum host carries the runtime, the engine module and both programs. You add the package and switch the routes on.

| | Spring Boot | FastAPI |
|---|---|---|
| What brings it | `datum-spring-boot-starter-submissions` | The `submissions` extra |
| The runtime | Endive, in the JVM | wasmtime, in the Python process |
| The engine module | Compiled into the jar when the host is built | A distribution of its own, hashed at every start |
| The programs | Packaged, and proved at start | Packaged with their digests, and proved at start |
| Your rule modules | A `SandboxRulesProvider` bean | `rules_providers` |
| What only the server knows | A `SandboxContextContributor` bean | `context_contributors` |
| Ready when | The `runtime` member of the `datum` health component is up | `/readyz` answers |
| Settings | [Spring Boot properties](/spring-boot-properties#runtime) | [FastAPI settings](/fastapi-settings#datum-runtime) |

### What happens at start

1. **The engine is chosen** by `datum.runtime.engine`. An id no installed engine has stops the start.
2. **The engine module is made ready.** FastAPI hashes it against its pin and compiles it. Spring Boot loads the code compiled at build.
3. **Each program is probed** for its interface version. A program that does not answer for the version the host needs is refused.
4. **Smoke runs warm it up**: three by default, through the same path a submission takes.
5. **The runtime reports ready.** A run asked for before then answers 503 `server.unavailable`.

With fail-fast on, the default, a failure at any step stops the application. With it off, the application starts, health reports the runtime down with the reason, and every run answers 503 until a recheck passes.

### What a request does

1. The host refuses a body for its type, size or depth.
2. It takes a validation slot, or answers 503 `server.busy` after the wait.
3. It runs the sandbox program in a fresh instance, with a fresh nonce.
4. It reads the framed answer and maps it: accepted, 422 with codes, or 503 with the run's code.

[The wire](/wire) has every route and status.

### What to check after a deploy

- **Readiness is wired** to the runtime's health, so traffic waits for the proof runs.
- **The engine's mode.** Spring Boot's health names the native runner in use. Without native code for the platform the host does not start, unless `datum.runtime.allow-bytecode` is `true`. Then the mode is `bytecode`: validation still runs, slower, and the PDF routes answer 503.
- **The memory warning.** Both hosts log a warning at start when every slot at its full limit would not fit the memory available. Lower the slots or raise the container's memory.
- **The start time.** Under wasmtime, compiling the engine module takes about a second on a laptop and several seconds on a small virtual machine. Raise the start's budget on a small host.

## On a runtime of your own

Do this when your framework has no Datum host. The four [worked examples](/server-example-validate) show it in Python, Java, C# and Node.js. Read them beside this section, then harden the result with [Hardening on a server](/wasm-hardening).

### 1. Choose a runtime

Any runtime with WASI preview 1 runs the engine module. To run it safely the runtime must also answer yes to these:

| Can the runtime | Why it matters |
|---|---|
| Limit the memory of one instance? | Without it one run can take the server's memory |
| Interrupt a running instance at a deadline? | Without it a looping rule holds a CPU for ever |
| Mount a folder read-only, confined to that folder? | The run must reach the programs and nothing else |
| Wire standard input and output to buffers? | The request goes in and the answer comes out that way |
| Compile once and instantiate many times? | Compiling is the slow step |

A runtime that lacks one is still usable if something else supplies it. Node.js cannot limit or interrupt one instance, so the Node.js example gives each run a process of its own. [Notes by runtime](/wasm-hardening#notes-by-runtime) compares the ones used on this site.

### 2. Get the three files

| File | From | Check |
|---|---|---|
| `qjs-wasi.wasm` | Its project's release page. The endpoint files in the worked examples carry the download line | Its SHA-256, before it is compiled |
| `datum-sandbox-program.js` | The build of Datum, beside the bundles | Built from the release you deploy |
| `datum-pdf-program.js` | The same | The same |

Use the release the Datum hosts pin unless you have a reason not to. It is the one the programs are tested against.

- The [Spring Boot](/spring-boot) and [FastAPI](/fastapi) host packages carry the release and its SHA-256.
- The endpoint files in the [worked examples](/server-example-validate) carry the same two values, and refuse any other file.

### 3. Start once

At start, before the first request:

1. Read the engine module and check its hash.
2. Compile it. Keep the compiled module for the life of the process.
3. Probe each program's interface version: see [Interface versions](/server-programs#interface-versions).
4. Make one run with a known answer, and refuse to serve if it is wrong.

### 4. Make a run

The engine module is a command. A run is one start of it, with arguments, one mounted folder and the standard streams.

| Argument | What it does |
|---|---|
| `qjs` | The command's own name |
| `--std` | Makes the engine's `std` module a global, which the script uses to read standard input |
| `-I /app/datum-sandbox-program.js` | Evaluates the program first |
| `-e <script>`, or the path of a script file | What to run after the program |

The script is yours. The shortest one that validates registers a rule module and prints the outcome:

```js
__datum_register(/* the text of one rule module */);
print(__datum_run(std.in.readAsString()));
```

For a PDF it is one line, because the entry point answers with a promise that settles before the command exits:

```js
__datum_pdf(std.in.readAsString()).then((json) => print(json));
```

A host that takes its answers seriously does not use the short validation script. It writes a framed one, with a nonce, so that nothing but the program can have printed the answer: see [The run protocol](/server-programs#the-run-protocol).

For every request:

1. **Build the request text**: the run context as JSON. [The sandbox run](/server-programs#the-sandbox-run) has the keys.
2. **Create a fresh instance** from the compiled module, with a memory limit and a deadline.
3. **Wire it**: the arguments above, no environment, a read-only folder holding the program as `/app`, the request on standard input, and bounded buffers on standard output and standard error.
4. **Call `_start`**, the command's entry point.
5. **Read how it ended**, below.
6. **Discard the instance.** Never use one twice.

### 5. Read how it ended

| The runtime reports | It means | The host |
|---|---|---|
| `_start` returned, or exit code 0 | The script finished. The answer is on standard output | Checks the frame, then parses the answer |
| A non-zero exit code | Something threw outside a validator: a rule module that would not load, or a request the program could not read. The reason is on standard error | Logs the reason and answers 503. No verdict |
| A trap of the interrupt kind | The deadline | Answers 503. No verdict |
| Any other trap | The stack ran out, or the module failed | Answers 503. No verdict |
| Growth refused at the memory limit | The engine throws "out of memory" inside the run | A non-zero exit, or `validator.failed` when a validator was running |
| Output past its cap | A run that printed without end | Answers 503. No verdict |

A throw inside one of your validators is not an exit. The program catches it and answers with the blocking code `validator.failed`, so the host sees a normal outcome and replies 422.

Your runtime names these in its own way: an exception with an exit code, a trap with a code. Map each one once, and treat anything you did not map as no verdict.

### 6. Set the budgets

Start from what the Datum hosts use, and change a number only with a measurement behind it.

| | Validation | PDF |
|---|---|---|
| Time | 5 s | 15 s to 60 s |
| Memory | 32 MiB | 256 MiB |
| Runs at once | One per CPU | The smaller of 2 and the CPUs |

- A validation run usually ends well inside a second. The budget is a bound on a runaway, not a response time to plan around.
- Memory for the process is the runs at once times the per-run memory, plus the application's own.
- [Limits a host sets](/server-programs#limits-a-host-sets) has the full table.

### 7. Hold it to the suite

- `datum-security-check --program` attacks the program file you ship.
- `datum-host-check` holds your endpoints to the wire, and its `hardening` group checks the limits on a live server.

See the [conformance suite](/conformance).

## From Node.js, without a runtime of your own

The `@argusvane/datum-submissions` package is a service that registers a definition, takes an envelope and answers with a verdict. It runs the sandbox for you: see [Validating a submission on a server](/engine#validating-a-submission-on-a-server).

Its Node.js entry does not start the engine module as a command. It embeds the engine, as the page does, and runs it in a worker thread:

- **A fresh sandbox for every call.** Each run gets a new WebAssembly instance with its own memory, the program and your rule modules loaded into it. It answers once and is discarded, so nothing a run did is there for the next.
- **The next one is built ahead.** After each answer the worker builds the next sandbox, so a lone request does not wait for it. Back to back, a run costs about 70 ms on a laptop, most of it loading the program.
- **One worker, one queue.** Calls are answered in order, so a slow run delays the ones behind it. Limit how many requests reach it.
- **A hard stop.** A run still going half a second past its budget ends with its worker thread, and the next call starts a new one.
- **The same caps.** 32 MiB of memory, a 1 MiB stack, a request of at most 320 levels, and an answer of at most 8 Mi characters.

With `worker: false` the sandbox runs on the calling thread. Each call still gets a fresh one, but there is no hard stop for a run that outlasts its deadline and no ceiling on the WebAssembly memory it grows, and the whole process waits while it runs. Keep the worker on a server.

## When a run does not behave

### In the page

| What you see | Likely cause | Do |
|---|---|---|
| `datum-error`: the validation sandbox could not be loaded | The policy has no `'wasm-unsafe-eval'`, or `datum-wasm.js` is not beside the bundle | Add the directive, or give `wasm` the file's address |
| `datum-error` and the `wasm` attribute is ignored | The address is on another origin | List the origin in `allow-origins` |
| The module is refused after it loads | It was built for another interface version | Serve `datum-form.js` and `datum-wasm.js` from one build |
| Every submit is blocked with `wasm.execution_error` | A validator returned a promise or a wrong shape, `wasmExternalData` failed or timed out, or a run passed its budget | Read `detail.executionError` on `datum-wasm-validated` |
| A submit is blocked with `validator.failed` | A validator threw | Read the run log at `error`: it has the message |
| The page and the server disagree | The server has another copy of the form or the rules, or the server was not given a value the page had | Compare the two copies, then read `clockDependent`, `visibilitySkipped` and `clientDerived` in the server's outcome |

### On a server

| What you see | Likely cause | Do |
|---|---|---|
| The start is refused, naming two hashes | The engine module is not the pinned file | Fetch the pinned release again. On FastAPI, set `qjs_sha256` only for a copy you chose on purpose |
| The start is refused with an interface version | The program is from another release than the host | Build the programs from the release you deploy |
| The start runs out of time | The engine module is still compiling on a small machine | Raise the start's budget, and gate traffic on readiness |
| The start fails reserving memory | A cap on address space, such as `ulimit -v` | Raise the cap, or lower the per-run memory |
| Every run fails at once after a change to memory | The limit is below what the module needs to start | Raise it. The Datum hosts refuse such a limit at start |
| Every run fails after a change to the stack | The stack was raised above the module's own | Put it back |
| Runs are interrupted that were not slow, under load only | A timer per run is advancing a deadline counter every run shares | Use one clock for all runs: see [control 4](/wasm-hardening#a-deadline-the-runtime-enforces) |
| The program is not found in the mount | The file in the mounted folder is a symbolic link | Copy the file in |
| Unexpected text on standard error under Node.js | Node's warning that its WASI is experimental | Start the run's process with that warning disabled, as the example does |
| 503 `server.busy` under light load | Stopped runs that have not ended are holding slots | Find the rule module or form that does not stop, and read the stray count on health |
| 503 `wasm.execution_error` for one form only | That form's rules or patterns cost more than the budget | Run `check` on the definition, and its tests with `--program` |
| Spring Boot does not start, naming `datum.runtime.allow-bytecode` | No native code for the platform, or no native runner the engine can use | Run on a supported platform with a native runner. The message names what is missing |
| The PDF routes answer 503 on the JVM | `datum.runtime.allow-bytecode` is `true` and the engine runs as bytecode | Run on a supported platform: health shows `engineMode` |

## Next

- Lock the server down: [Hardening on a server](/wasm-hardening).
- The request and the outcome, key by key: [Your own server](/server-programs).
- A full endpoint in four stacks: [Example: validate on the server](/server-example-validate).
