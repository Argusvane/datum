# WebAssembly in Datum

Datum judges a submission, and prints a PDF on a server, with programs that run inside WebAssembly. This section explains what that means, how to run it, and how to lock it down on a server.

| Page | What it answers |
|---|---|
| This page | What runs in WebAssembly, why, and who is trusted with what |
| [Running the sandbox](/wasm-running) | How to run it in the page, on a Datum host and on a runtime of your own |
| [Hardening on a server](/wasm-hardening) | What a server must do around every run, and how to prove it does |

The pages around this section cover the rest:

- **Writing a check.** [Validation and the sandbox](/validation) has the routes a check can take, the context a rule reads and the error it returns.
- **The contract.** [Your own server](/server-programs) has the request, the outcome, the run protocol and the interface versions.
- **The numbers.** [Limits](/limits) has every cap in one place.

## The parts

Five parts sit one inside the other. Each has one job.

```text
your page or your server       builds the request
└─ a WebAssembly runtime       sets time, memory and mounts
   └─ the engine module        runs JavaScript
      └─ a program             judges answers, prints a PDF
         └─ your rule modules  your own checks
```

| Part | What it is | Where it comes from |
|---|---|---|
| The host | Your page, or your server's endpoint. It gathers what a run needs, starts the run and decides what the answer means | A Datum host ([Spring Boot](/spring-boot), [FastAPI](/fastapi)) or your own code |
| The runtime | What executes WebAssembly and enforces the limits on it | The browser in the page. On a server, wasmtime under FastAPI, Endive under Spring Boot, or one you choose |
| The engine module | A JavaScript engine compiled to WebAssembly. It is the only part that is WebAssembly | Two builds of QuickJS, one per kind of host. The page and a Node.js server run Bellard's QuickJS (2025-09-13, from quickjs-emscripten 0.32.0), inside `datum-wasm.js` with no file of its own. Spring Boot and FastAPI run QuickJS-ng 0.16.2 as `qjs-wasi.wasm`, a WASI command from its project's release page, held to one pinned hash. The two engines differ in places, so the security suite is run on each |
| The programs | Plain JavaScript text the engine module evaluates: `datum-sandbox-program.js` judges a submission, `datum-pdf-program.js` prints or fills a PDF | The build of Datum, beside the bundles: see [Files you host](/files) |
| Rule modules | Small JavaScript modules of your own that the sandbox program runs after its own checks | You write them: see [Rules of your own](/validation#rules-of-your-own) |

Two things follow from that shape:

- **The programs are not WebAssembly.** They are JavaScript, so one text runs in the page's engine, in the engine module and in a test. Nothing is compiled per form.
- **A form is data.** A definition is never compiled or executed. The program reads it, and its rules are formulas the program evaluates itself.

## Why WebAssembly

- **One program, one verdict.** A server in Java, Python, C# or Node.js runs the same program text as the page. No host ports a rule, so no host can disagree about one. The same definition and the same answers give the same outcome, byte for byte.
- **Nothing is ambient.** A WebAssembly module reaches only what its runtime hands it. A run is handed a request and a place to write an answer: no network, no clock, no environment, and no file but the programs.
- **The limits come from outside.** The time budget and the memory limit are the runtime's. The code being limited cannot raise them, turn them off or catch them.
- **A run leaves nothing behind.** On a server every run is a fresh instance, thrown away after it answers. Nothing one submission did is there for the next.

## What it is not

- **Not a place for a stranger's code.** Rule modules are code your team deploys, like any code on your server. The sandbox bounds what a mistake in one can cost; it is not a promise about code written to attack it. See [Who is trusted with what](#who-is-trusted-with-what).
- **Not where keys live.** A signing key never enters a run. The PDF program prepares the bytes to sign and your server signs them: see [Signing](/signing).
- **Not a way to fetch.** A run never reaches the network. What a rule needs from outside, the host resolves first and hands in.
- **Not the only gate.** Who may call an endpoint, how often and with how large a body are the host's to decide before any run starts.

## Where it runs

| Place | What runs there | Use it for |
|---|---|---|
| The page, with `wasm="auto"` | The sandbox program, in the engine module inside `datum-wasm.js` | Development and testing: the page shows the verdict a server would give before a server exists |
| The builder's Try it | The same module, beside the builder's bundle | An author sees the server's verdict while building: see [Embedding the builder](/embedding-the-builder) |
| A Datum host | Both programs, in the engine module, under the host's runtime | Production: every submission is judged, and PDFs are printed, filled and signed |
| A server of your own | Both programs, in the engine module, under a runtime you choose | A framework with no Datum host yet |
| The test command and the conformance suite | The sandbox program you built | Proving the program you ship before it serves a form: see [Testing a form](/testing) and the [conformance suite](/conformance) |

The page never runs the PDF program in WebAssembly. With `pdf="auto"` the PDF kernel is `datum-pdf.js`, plain JavaScript in the page, and it produces the same bytes as the PDF program does on a server.

The check in the page is a preview. A browser belongs to the person using it, so only the run on your server decides.

## The life of a run

A validation run on a server, from the request to the reply:

1. **The host receives a delivery.** It refuses a wrong content type, an oversized body and malformed JSON before anything else.
2. **It builds the run context.** The definition comes from the host's own store, never from the request. The answers come from the envelope. The host adds what only it knows: the day, the host values, the options its data sources hold, and its policies.
3. **It takes a slot.** A host runs a bounded number of runs at once. With no slot free in time it answers 503 `server.busy`.
4. **It starts a fresh instance.** The runtime instantiates the engine module with a memory limit and a deadline, mounts the program read-only, and wires the request to standard input and a bounded buffer to standard output.
5. **The engine module loads the program.** The host's script registers the rule modules, then calls the entry point with the request text.
6. **The program judges.** It bounds the request, digests the delivered document, works out what is shown and required, holds every answer to its field, then runs your validators.
7. **The program answers.** It writes the outcome as canonical JSON: the errors as codes, and the cleaned answers when nothing blocked.
8. **The host reads the answer.** It checks that the output is exactly one answer, parses it, and discards the instance.
9. **The host replies.** An outcome with cleaned answers is accepted. An outcome with a blocking error is a 422 with the codes. A run that gave no outcome is a 503, and nothing is stored.

In the page the steps are the same without the slot and the mount: the element builds the request, the engine module inside `datum-wasm.js` runs the program, and the verdict arrives on `datum-wasm-validated`. One thing differs. A form keeps its sandbox from one submit to the next, with the program and your rule modules loaded once. The program keeps its state where no rule module can name it, and the language's built-ins are frozen, so a run cannot change the one after it.

## What crosses the boundary

Text goes in and text comes out. Nothing else is shared: no object, no function, no handle.

| Direction | What | Bounded by |
|---|---|---|
| In | The run context as one JSON text: the form's root, the answers, the locale and the run's options | Length and nesting depth, checked before the run |
| In | The program and the rule modules, as source text | What your deployment ships |
| Out | The outcome as one canonical JSON text | Length, checked before it is parsed |
| Out | The run log, inside the outcome | 200 entries, each cut at 8 KiB |

- The keys of the request and the outcome are on [Your own server](/server-programs#the-sandbox-run).
- The caps are on [Limits](/limits#the-sandbox).

## What code in the sandbox can do

A rule module is an ES2020 program. It is handed one read-only context and returns codes.

| It can | It cannot |
|---|---|
| Read the answers, the definition and what the host handed in | Read the clock: `Date` is disabled. A rule that needs the day reads `context.today` |
| Compute with the whole language: strings, numbers, regular expressions, JSON | Draw a random number: `Math.random` is disabled |
| Return errors, warnings and information, as codes | Fetch, open a file or start a timer |
| Write to the run log with `context.log` | Print: there is no console |
| Add formula functions for the form's rules | Return a promise: a validator answers at once |
| Define helpers and globals of its own | Change a built-in: the language's own objects are frozen before a module loads |

A rule that tries one of the right-hand column either gets no such name or throws, and a validator that throws blocks the submission with `validator.failed`.

## Who is trusted with what

Every input to a run has a different owner. The design holds each one a different way.

| Input | Who supplies it | Trusted to | What holds it |
|---|---|---|---|
| The answers | Anyone who can reach the endpoint | Nothing | The program judges every key against the definition. The host bounds the body before the run |
| The delivered document | The same | Nothing | Digested inside the program before anything else reads it. Rules never see it |
| The definition | Your authors | Describe a form, not to spend your server | The `check` operation at save and at registration, the size caps, the refusal of runaway patterns, and the run's budgets |
| Rule modules | Your deployment | Run as your server's own code | Review, a version and a test before they ship. The frozen language and the answer frame are guard rails, not a boundary against an attacker |
| The programs | The Datum release you built | Judge and print correctly | A digest in the host packages, and the interface version probe at start |
| The engine module | Its project's release | Run JavaScript correctly | A pinned SHA-256, checked before it is compiled |
| The runtime | Its project | Confine the module | Its own releases: keep it patched |

The line that matters most is between the first three rows and the rest. Answers and documents come from the Internet, and a definition comes from an author who may make a mistake. Rule modules, programs, the engine module and the runtime are things you deploy.

[Hardening on a server](/wasm-hardening) turns each row into what a server does about it.

## The same bytes everywhere

A verdict is only portable if nothing in a run depends on where it ran.

- **No clock and no randomness.** The day is a value the host passes in as `today`. Without it a rule that reads the day is left unjudged and named in the outcome.
- **Canonical output.** The program writes its own outcome with keys sorted by UTF-16 code unit and no whitespace, so the text is the same from every engine.
- **The digest is the program's.** When the host sends the delivered document, the outcome carries its canonical text and SHA-256. Store or sign those, never your own re-serialisation.
- **The run log is plain data.** The same run gives the same log on every host.
- **Parity is tested.** The page and a server run different builds of a JavaScript engine, and the form makes its own checks in the browser's engine as well. `datum-security-check --parity` holds the form's own checks and the program to the same answer, vector by vector: see the [conformance suite](/conformance).

## Versions

Each program states the interface version it speaks, and a host refuses a program or a definition it was not built for.

- Build the programs from the release you deploy.
- Deploy them to servers first, or together with the browser bundle, so a server is never more lenient than the page in front of it.
- The current versions and the probe a host makes at start are under [Interface versions](/server-programs#interface-versions).

## Next

- Run it: [Running the sandbox](/wasm-running).
- Lock it down: [Hardening on a server](/wasm-hardening).
- Write a rule: [Validation and the sandbox](/validation#rules-of-your-own).
- See it work: [Example: validate on the server](/server-example-validate).
