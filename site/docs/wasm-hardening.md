# Hardening WebAssembly on a server

A WebAssembly runtime confines a module only as far as the host tells it to. A run with no deadline can loop for ever, a run with the server's folder mounted can read it, and a run whose failure is read as a pass lets anything through. This page lists what a server does around every run, why, and how to prove a deployment holds.

- **On Spring Boot or FastAPI**, the host does most of it. Read [the checklist](#the-checklist), then [What a Datum host leaves to you](#what-a-datum-host-leaves-to-you).
- **On a host of your own**, every row is yours. Each section below says what to do and what to ask of your runtime.

[How Datum uses WebAssembly](/wasm) has the parts and who is trusted with what. [Running the sandbox](/wasm-running) has the mechanics of a run.

## What you are defending against

| Threat | Where it comes from | What stops it |
|---|---|---|
| Answers made to slip through: a value the form never offered, a key it does not define, an answer on a page the path skipped | Anyone who can reach the endpoint | The sandbox program, run over your server's own copy of the definition |
| A body made to cost: very large, or nested very deep | Anyone | Size and depth caps, applied before a run starts |
| A form that is costly to judge: a runaway pattern, a huge grid, a tree nested too deep | An author's mistake | The `check` operation at save, the pattern policy, the run's budgets |
| A rule module that loops, recurses or allocates without end | A bug in your own code | A deadline, a memory limit and a stack limit the runtime enforces |
| A rule module that prints an answer of its own, or changes a built-in so a later check passes | A bug, or a dependency you did not read | The answer frame and the frozen language |
| Code in a run reaching the host: a file, a variable of the environment, the network | Anything inside the instance | The runtime's configuration: hand a run nothing |
| A flood of runs taking every CPU and all the memory | Anyone | A bounded number of runs at once, a short wait, and rate limits before the sandbox: one by address before a body is read, one per form after it parses |
| A flaw in the engine module or the runtime | Software you deploy | A pinned module, a patched runtime, and the operating system's own confinement around the process |
| A verdict that was never given, read as a pass | Any failure at all | Failing closed: no outcome, no acceptance |

## The checklist

| # | Control | Spring Boot | FastAPI |
|---|---|---|---|
| 1 | [Verify the engine module and the programs](#verify-what-you-run) | Held to a pinned hash at build and compiled into the jar | Re-hashed against the pin at every start |
| 2 | [One fresh instance per run](#one-instance-per-run) | Done | Done |
| 3 | [Hand the run nothing](#hand-the-run-nothing) | Done: no environment, a read-only folder in memory holding only the program | Done: no environment, a private read-only folder holding only the program |
| 4 | [A deadline the runtime enforces](#a-deadline-the-runtime-enforces) | `datum.runtime.validation.time-limit`, 5 s | `datum.runtime.validation.time_limit`, 5 s |
| 5 | [A memory limit per instance](#memory-and-stack) | `datum.runtime.validation.memory`, 32 MiB | `datum.runtime.validation.memory`, 32 MiB |
| 6 | [Bound what goes in](#bound-what-goes-in) | `datum.web.api.max-body-size`, 1 MiB, and fixed depth caps | `datum.web.api.max_body_size`, 1 MiB, and fixed depth caps |
| 7 | [Bound what comes out](#bound-what-comes-out) | Fixed caps | Fixed caps |
| 8 | [Frame the answer](#frame-the-answer) | Done | Done |
| 9 | [Limit the runs in flight](#limit-the-runs-in-flight) | `datum.runtime.validation.concurrency` and `.wait` | The same names |
| 10 | [Fail closed](#fail-closed) | Done: a 503 with the run's code | Done |
| 11 | [Keep a run's words out of replies](#keep-words-out-of-replies) | Done | Done |
| 12 | [Prove the program at start](#prove-the-program-at-start) | `datum.runtime.fail-fast`, on. A start on bytecode is refused: `datum.runtime.allow-bytecode`, off | `datum.runtime.fail_fast`, on |
| 13 | [Keep the strict policies](#keep-the-strict-policies) | The defaults | The defaults |
| 14 | [Treat rule modules as server code](#treat-rule-modules-as-server-code) | Yours | Yours |
| 15 | [Guard the door before the sandbox](#guard-the-door) | Yours, with Spring Security | Yours, with your dependencies |
| 16 | [Confine the process](#confine-the-process) | Yours | Yours |
| 17 | [Keep the runtime patched](#keep-the-runtime-patched) | Yours | Yours |
| 18 | [Prove it](#prove-it) | Yours | Yours |

## 1. Verify what you run {#verify-what-you-run}

Three files decide every verdict: the engine module and the two programs. Hold each to a hash before it is used.

- **Pin the engine module.** Record the SHA-256 of the `qjs-wasi.wasm` you tested with, and refuse to compile a file with another hash. Check it when you fetch the file and again when the server starts.
- **Take it from its project's release page only.** Never from a mirror or a repackaged build you cannot trace to that release.
- **Pin the programs.** Build them from the release you deploy and record their hashes. A program swapped on disk changes what every submission is judged by.
- **Verify before compiling.** Hash first, then hand the bytes to the runtime. Never load a precompiled or cached module from a place another process can write.

What the Datum hosts do:

- **Spring Boot.** The build downloads the engine module, holds it to its pinned hash and size, and compiles it into a class in the jar. The file itself never ships, so there is nothing on disk to swap.
- **FastAPI.** The engine module ships in its own distribution with its hash, and the runtime hashes it again at every start. To run a copy of your own, set `datum.runtime.qjs_path` together with `datum.runtime.qjs_sha256`. The programs are held to the digests in their distribution.
- **Both.** A program you point `datum.runtime.programs.sandbox` at is still proved by the version probe before any run.

## 2. One instance per run {#one-instance-per-run}

- **Create the instance for the run and discard it after.** An instance's memory holds whatever the last run left in it. A reused instance lets one submission leave something for the next.
- **Share only the compiled module.** Compilation is the costly step and its result is read-only. Compile once at start and instantiate from it for every run.
- **Never pool instances to save time.** If a run is too slow to start, lower its cost another way: fewer rule modules, or more slots.
- **Release what a failed run held.** A run that traps, exits or is interrupted must still give its memory back. Check this in your runtime's API: in some, building the instance also starts it, and a start that fails skips your clean-up.

A host that embeds the engine in its own process can do the same. The Node.js service of `@argusvane/datum-submissions` builds a new WebAssembly instance, with its own memory, for every call, and builds the next one ahead so a request does not wait for it.

Only the page keeps its sandbox between runs, where the cost of a new one would be paid on every submit. Other things hold the line there:

- The program is one closure, so its state has no name a rule module can reach.
- The language's built-ins are frozen before any rule module loads.
- Rule modules register once, before the first run, and the list is then sealed.

The page's check is a preview, so this is not a server's exception. On a server, give every run an instance.

## 3. Hand the run nothing {#hand-the-run-nothing}

The engine module is a WASI command, and a rule module can import the engine's own system module. So treat everything the runtime hands the instance as readable by a rule module: its arguments, its environment, its mounted folders and its streams.

- **No environment.** Pass none. Never inherit the server's.
- **No inherited streams.** Wire standard input, output and error to buffers of the run's own. An inherited standard output lets a run write into your server's log.
- **Only the arguments the run needs.** The module's name, the flag that loads the program, and the script.
- **Mount one folder, read-only, holding only the program and the run's script.** Not your application folder: it holds the definitions, the rule files, your source and perhaps a key.
- **Make the folder the run's own.** Copy the files in. A symbolic link is either refused by the runtime or followed out of the folder, and neither is what you want.
- **Do not trust "read-only" alone.** Some WASI layers mount read-write whatever you ask, and some do not confine paths to the mount. Put the files where nothing else is, such as a fresh temporary folder or a file system in memory.
- **No sockets.** Grant no network capability to the instance. WASI gives none unless you add it.
- **Clean up.** A folder or a file made for a run is removed when the run ends, and on shutdown.

## 4. A deadline the runtime enforces {#a-deadline-the-runtime-enforces}

- **Set a wall-clock deadline on every run**, and have the runtime enforce it. A timer in your own code that only stops waiting leaves the run burning a CPU.
- **Stop the run itself.** The instance must be interrupted, not abandoned. Under a runtime that cannot interrupt an instance, run each run in a process of its own and end the process.
- **Do not share a timer between runs.** Where the deadline is a counter the whole runtime shares, one clock advances it for every run, and each run's deadline is its budget in ticks. A timer per run that advances the shared counter cuts short every other run in flight, and a run cut short is a submission that was never judged.
- **Count the whole run.** The budget covers loading the program and registering the rule modules, not only the call.
- **Cover the waits.** A deadline that interrupts running code may not reach code that is asleep inside a call to the host. Make sure a run that sleeps ends at its budget too.
- **Bound the runs that will not stop.** Give a stopped run a short grace to end. Count the ones that outlive it, and refuse new runs when there are too many, so that stuck runs cannot pile up unseen.
- **Budget the start separately.** Compiling the module and the first proof runs take longer than a normal run. Give the start its own, longer budget.

The Datum hosts' settings:

| What | Spring Boot | FastAPI | Default |
|---|---|---|---|
| A validation run's time | `datum.runtime.validation.time-limit` | `datum.runtime.validation.time_limit` | 5 s, at most 60 s |
| The grace a stopped run gets | `datum.runtime.stop-grace` | `datum.runtime.stop_grace` | 5 s |
| Stopped runs that may outlive it | `datum.runtime.max-strays` | `datum.runtime.max_strays` | One per CPU, at least 2 |
| The start's budget | `datum.runtime.startup-budget` | `datum.runtime.startup_budget` | 30 s |

A validation run that needs more than a few seconds is a sign of a form or a rule module that costs too much. Find the cause before you raise the limit.

## 5. Memory and stack {#memory-and-stack}

- **Limit the instance's linear memory**, through the runtime, for every run. An instance with no maximum grows until the operating system stops your server.
- **Keep the limit above what the module needs to start.** A limit below the module's initial memory fails every run. Refuse such a setting at start, never round it up silently.
- **Do not rely on the engine module's own flags.** A limit must sit outside the code it limits. Set memory and time on the runtime.
- **Leave the stack alone.** The engine's own stack check is compiled out under WASI, and the C stack its frames use is a fixed 64 KiB that no setting raises. The runtime's call-stack limit is not a bound on it, and asking for more makes every call fail. Bound the depth of what goes in instead, and treat a trap as no answer. The FastAPI host writes a canary over the lowest bytes of that stack before each run and reads an overrun as a trap. The Spring Boot host has no such check: its depth guard refuses a definition nested more than 32 component levels before the guest runs, and a call stack Endive exhausts, or a JVM `StackOverflowError`, is a trap; an overrun of the 64 KiB stack that exhausts neither is not detected there, so the depth guard is what keeps a definition below it. A trap answers 503 with no verdict.
- **Do the sum.** Every slot can hold its full limit at once. The process needs the slots times the per-run memory, on top of its own. Both Datum hosts compare that sum with the memory available at start and log a warning when it would not fit.
- **Expect out-of-memory in two shapes.** When the limit is reached inside one of your validators, the validator throws and the outcome is the blocking code `validator.failed`. Anywhere else the run ends with no outcome, and the answer is a 503. Neither is a pass.

## 6. Bound what goes in {#bound-what-goes-in}

Refuse a request for its size before any of it reaches a run.

- **Cap the body** at the web layer, before it is parsed.
- **Cap the nesting depth** in the JSON parser, before the document becomes objects.
- **Accept one content type**, `application/json`.
- **Refuse numbers that are not finite** and anything else that is not plain JSON.
- **Read the definition from your own store.** Never judge by a definition the request carries.
- **Check a definition when it is saved or registered**, with the `check` operation, so a form over a cap never reaches a run: see [Asking questions of a definition](/server-programs#asking-questions-of-a-definition).

| Cap | Spring Boot | FastAPI |
|---|---|---|
| Request body | `datum.web.api.max-body-size`, 1 MiB | `datum.web.api.max_body_size`, 1 MiB |
| JSON nesting in a body | 256 levels | 256 levels |
| Nesting in a submitted document | 64 levels | 64 levels |
| Component depth in a definition | 32 levels | 32 levels |

The program bounds its own request as well. The caps it holds are on [Limits](/limits).

## 7. Bound what comes out {#bound-what-comes-out}

A run writes text, and nothing stops a faulty one writing without end unless the host counts.

- **Cap standard output** while it is written. At the cap, stop keeping bytes and refuse the run. Do not collect everything and measure afterwards.
- **Cap standard error** much lower. It only ever holds a short reason.
- **Cap the outcome's length** before parsing it, and cap the depth the parser will follow.
- **Parse strictly.** The answer is one JSON object and nothing else.

The Datum hosts fix these, with no setting to loosen them:

| Cap | Value |
|---|---|
| Standard output of a validation run | 32 MiB |
| Standard error | 64 KiB |
| The outcome | 8 Mi characters, else `outcome_too_large` |
| Nesting of the answer | 512 levels |

## 8. Frame the answer {#frame-the-answer}

Without a frame, the host takes whatever a run printed as its verdict. Any code in the run that can reach standard output could then print a pass of its own.

- **Send a fresh nonce** with every run: 16 bytes from a secure random source.
- **Remove the ways to print** from the global scope before any rule module loads, and fail the run if one stays.
- **Freeze the language's built-ins** before any rule module loads, so a module cannot change what a later check calls.
- **Take hold of the entry points first**, in local variables, and call those.
- **Accept exactly one frame**: the started marker, the begin marker, the answer and the end marker, once each and in order, with only whitespace around them. Anything else refuses the run.

[The run protocol](/server-programs#the-run-protocol) has the steps in full. The frame is a guard against a mistake or a careless dependency. It does not make it safe to run a rule module you do not trust: see [control 14](#treat-rule-modules-as-server-code).

## 9. Limit the runs in flight {#limit-the-runs-in-flight}

- **Fix the number of runs at once.** More runs than CPUs buys nothing, and each holds memory.
- **Wait briefly for a slot, then refuse.** Answer 503 `server.busy` with `Retry-After`. A queue with no bound hides an overload until the server falls over.
- **Keep validation and PDF runs in separate pools.** A PDF run is far larger and slower. A burst of them must not take the slots submissions need.
- **Rate-limit before the sandbox.** A slot is the last line. A per-caller limit in front of it keeps one caller from holding them all.

| What | Spring Boot and FastAPI | Default |
|---|---|---|
| Validation runs at once | `datum.runtime.validation.concurrency` | One per CPU, at most 64 |
| The wait for a slot | `datum.runtime.validation.wait` | 2 s, at most 10 s |
| PDF runs at once | `datum.runtime.pdf.concurrency` | The smaller of 2 and the CPUs |

## 10. Fail closed {#fail-closed}

A run that gave no outcome judged nothing. Never let its submission through.

| How the run ended | What the host answers |
|---|---|
| An outcome with cleaned answers | Accepted |
| An outcome with a blocking error, a validator that threw included (`validator.failed`) | 422 with the codes |
| Stopped at its deadline or its memory limit | 503 `wasm.execution_error`, nothing stored |
| A trap, such as a stack that ran out | 503 `wasm.execution_error`, nothing stored |
| Output that is not exactly the frame | 503 `wasm.execution_error`, nothing stored |
| A rule module that would not load | 503 `wasm.execution_error`, nothing stored |
| An answer over the cap | 503 `outcome_too_large`, nothing stored |
| No slot in time | 503 `server.busy` with `Retry-After` |
| The runtime not ready | 503 `server.unavailable` |

- A 422 always means the answers were judged. A 503 always means they were not.
- Never retry a failed run with looser limits, and never fall back to a check outside the sandbox.

## 11. Keep a run's words out of replies {#keep-words-out-of-replies}

- **Reply with codes.** The text a rule threw, the engine's message and the standard error of a run go to your log, never into a response.
- **Keep the run log on the server.** It is for your logging. See [The run log](/server-programs#the-run-log).
- **Log without secrets.** Do not log the definition's text, a rule module's source or the body of a refused request.

## 12. Prove the program at start {#prove-the-program-at-start}

- **Probe the interface version** of each program before serving, and refuse a program of another major, or one below your floor.
- **Make a smoke run** through the same path a submission takes: the frame, the limits and a known verdict.
- **Stay unready until it passes.** Hold traffic back with a readiness check: the `runtime` member of the `datum` health component on Spring Boot, `/readyz` on FastAPI.
- **Leave fail-fast on.** With it off, the application starts and every run answers 503 until a recheck passes. That is safe, but it hides a broken deployment behind a live process.
- **Refuse a slower engine than you tested.** A runtime that falls back to an interpreter when it has no native code still gives the same verdicts, several times slower, so your time budgets no longer mean what you measured. The Spring Boot host refuses to start in that mode unless `datum.runtime.allow-bytecode` is `true`. Leave it `false` in production.

[Interface versions](/server-programs#interface-versions) has the probe.

## 13. Keep the strict policies {#keep-the-strict-policies}

| Policy | Keep it at | Why |
|---|---|---|
| A rule that does not parse | `fail` | `warn` drops the rule, and the check it made is gone |
| A regular expression of a runaway shape | `refuse` | `allow` runs it, and one answer can then hold a slot for the whole budget |
| Keys the form does not define | `strip`, or `reject` | `keep` passes through data nobody validated |
| Host values | Worked out by the server | A value the browser sent can be anything |

[The policy knobs](/server-programs#the-policy-knobs) has the setting names. `warn` and `allow` are for previews and staging.

## 14. Treat rule modules as server code {#treat-rule-modules-as-server-code}

A rule module runs inside the instance with the engine's whole language, and it can import the engine's own system module. The limits above bound what it can cost. They do not make it safe to run a module from someone you do not trust.

- **Deploy rule modules like code.** Review them, version them and ship them with the server. Never accept one from a request, from a form's author through the builder, or from a database row an editor can write.
- **Register the same module on both sides.** The page's copy is for preview. The server's copy decides.
- **Test each module before it ships.** `certifyWasmPlugin` loads a module in a sandbox and probes it: see [Loading the sandbox yourself](/validation#loading-the-sandbox-yourself).
- **Attack your host with its real modules.** `datum-security-check --plugins` registers them in every vector.
- **Keep them free of time and chance.** A module that finds a way to a clock breaks the promise that the page and the server agree.

## 15. Guard the door before the sandbox {#guard-the-door}

The sandbox judges answers. It does not decide who may send them.

- **Authenticate and authorise in your framework.** The Datum hosts ship no access policy: a route that is switched on is open until your security says otherwise.
- **Leave off what you do not use.** Every endpoint is off by default. The dry run, the inspect route and the builder's writes are for authors only.
- **Rate-limit per caller**, on the address your proxy vouches for. The hosts count every throttled request by its address before its body is read, so a body that never parses is counted too; the per-form limit counts after the parse.
- **Restrict who may save a definition.** An author can write a form that costs the full budget on every submission.

[Server hosts](/server-hosts) and each host's page have the switches.

## 16. Confine the process {#confine-the-process}

A runtime is software, and software has flaws. Put the operating system's own walls around the process, so that a flaw in the runtime is not the end of the story.

- **Run as an unprivileged user**, with no capabilities added.
- **Make the root file system read-only.** Give the process one writable temporary folder of its own. On FastAPI, name it with `datum.runtime.work_dir`.
- **Set a memory limit on the container** that covers every slot at its full limit, plus the application.
- **Allow no outbound network** but what the application itself calls: your database, a timestamp service, a data source.
- **Keep the default system-call filter** of your container runtime.
- **Keep keys out of the process's files.** Use a key service or a mounted secret, never a file in the folder a run could be handed by mistake.

Two limits of this kind can stop a runtime from starting:

- **A cap on address space.** A runtime reserves address space for each instance's memory. Under a tight `ulimit -v` the reservation fails at start.
- **A ban on executable memory.** A runtime that compiles the module to native code maps memory it can execute. A policy that forbids that stops it.

## 17. Keep the runtime patched {#keep-the-runtime-patched}

- **Follow your runtime's security advisories** and update when one lands. The runtime is the wall between a run and your server.
- **Move the engine module with a Datum release**, not on its own. The hosts pin the build they were tested with.
- **Re-run the proof** after any update: the smoke run, the conformance suite and your own forms' tests.

## What a Datum host leaves to you

On Spring Boot or FastAPI, controls 1 to 13 are done or are settings whose defaults are the safe ones. What is still yours:

1. Decide who may call each route, and switch on only the routes you use.
2. Put a rate limit in front, shared by every instance: see [Running more than one instance](/server-hosts#running-more-than-one-instance).
3. Review and version your rule modules.
4. Size the container for the slots times the per-run memory.
5. Confine the process as in [control 16](#confine-the-process).
6. Leave `fail-fast`, `formula-errors` and `risky-patterns` at their defaults.
7. Wire readiness to the runtime's health.
8. Run the conformance suite against the deployment.

## Notes by runtime

What each runtime used on this site can and cannot do. Check your own runtime against the same questions.

| Question | wasmtime | Endive | Node.js with `node:wasi` |
|---|---|---|---|
| Can it limit one instance's memory? | Yes, on the store | Yes, on the instance | No. V8 has one cap for the whole process |
| Can it interrupt a running instance? | Yes, by an epoch deadline | Yes, by interrupting the run's thread | No. Only ending what runs it stops it |
| Is a mount confined and read-only? | Yes, as configured | Not by itself. Mount a file system in memory behind a read-only layer | No. It mounts read-write and does not promise a sandbox |
| So the safe shape is | A store per run, one shared clock | An instance per run, on a thread of its own | A process per run, in a folder of its own |

- **wasmtime.** The epoch is shared by every store on an engine, which is why one clock ticks it. Standard streams are files in the .NET embedding, so the files need the same care as the mount: a folder of the run's own, removed after.
- **Endive.** Without native code for the platform, or a native runner it can use, it can only run the module as JVM bytecode: several times slower, and too slow for the PDF program. The Spring Boot host refuses to start that way, whatever `fail-fast` says. With `datum.runtime.allow-bytecode=true` it starts, logs a warning, says so on its health (`engineMode: bytecode`) and answers the PDF routes as unavailable.
- **Node.js.** A worker thread's resource limits cover the JavaScript heap, not a WebAssembly memory. That is why the safe shape is a process, with its memory flag and its timeout.

## The PDF program

The PDF program runs under the same rules with larger numbers.

- **It has no rule modules**, so it needs no frame. The whole of standard output must be one JSON object.
- **Its budgets are larger**: 256 MiB, and 15 s on Spring Boot or 60 s on FastAPI. That makes each run costlier, so give it fewer slots, in a pool of its own.
- **Print validated answers.** Send the cleaned `values` of a validation outcome, never the answers as posted.
- **A template is input.** A PDF an author uploaded is parsed inside the run. Cap its size where it is saved.
- **Keys never enter.** The program prepares the bytes to sign and the server signs them: see [Signing](/signing).
- **Cap what you read back.** A PDF handed to the verify route is bounded by `datum.runtime.verify-max-bytes` on Spring Boot and `datum.runtime.verify_max_bytes` on FastAPI, 20 MiB by default.

## Prove it

Settings are claims until something attacks them. The [conformance suite](/conformance) does.

```sh
# The program you ship, before it is deployed.
datum-security-check --program dist/datum-sandbox-program.js --plugins rules/intake-rules.js --out report/

# The running server: a looping rule, unbounded memory, a 40 MiB answer, output outside the frame.
datum-host-check --endpoint https://forms.test.example --capabilities submissions,hardening --out report/
```

- **`datum-security-check`** sends the gate's attack vectors. Three classes are the ones this page is about: `isolation` (nothing ambient, built-ins that cannot be changed, a document no rule can read), `resource` (loops, allocation, oversized requests, runaway patterns, the answer cap) and `abi` (the version gate). With `--pdf`, the `output` class sends hostile answers through the PDF program.
- **`datum-host-check --capabilities hardening`** needs a test deployment that registers the kit's hostile rule module. It checks that a loop is cut, that unbounded memory and an oversized answer are refused, and that stray output refuses the run.
- **`runtime-down`** checks that a runtime that could not prove its program answers 503 to every submission.
- **Run both in CI**, after every build and after every update of the runtime.
- **Read the skipped cases.** A pass means every case that ran behaved. It is not a penetration test.

## The worked examples

The four [worked examples](/server-example-validate) are short on purpose, to show the call and its outcome. They are not hardened hosts.

What they do:

- **Check the engine module's hash.** Each refuses to start, or to build, on a file that is not the release it names.
- **Mount only the programs.** A run reaches one folder made at start that holds the programs the endpoint runs, and nothing else of the server's.

What they leave out, against this page:

- The whole of standard output is taken as the answer, with no frame and no cap.
- Nothing limits the runs in flight.
- The PDF examples keep both programs in the one folder. A Datum host gives each run a folder with the one program it runs.

Use them to learn the run. For production use a Datum host, or build your own host to this page and hold it to the conformance suite.
