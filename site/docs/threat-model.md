# Threat model

What Datum protects, who and what it trusts, what the sandbox isolates and what it does not, and what stays the job of the page and the server that host it. Read this before you put a form in front of people you do not know. To report a flaw, follow the [security policy](https://github.com/argusvane/datum/blob/main/SECURITY.md).

## What is being protected

| Asset | Why it matters |
|---|---|
| The verdict on a submission | A submission accepted that the form should have refused puts bad data in your records. Everything below serves this one most |
| The server and what it can reach | A form is data and a rule is code. Neither should be able to spend or read your server |
| The signing keys and the signed record | A signature is only worth what keeps the key out of reach and the signed bytes honest |
| The page that embeds the form | Datum's code and what it loads run with the page's privileges |
| The person's answers | Drafts, submissions and PDFs hold personal data |

## Who the adversary is

- **Anyone who can reach an endpoint.** They send bodies of their own making: answers a form never offered, keys it does not define, huge or deeply nested JSON, floods.
- **A form author who makes a mistake.** A definition with a runaway pattern, a huge grid or a deep tree can cost more than it should. This is the common case, and it is treated as a risk, not as an attack.
- **A hostile or careless dependency.** A rule module, a plugin, a design-system file or a runtime that does more than it should.
- **A page that is not yours.** Another origin that tries to use the form's loaders, the signing agent or a draft.

Datum does not defend against a malicious operator of the page or the server. Whoever deploys the code, picks the rule modules and holds the keys is trusted.

## Trust boundaries

Datum has five boundaries. At each, one side supplies something and the other side decides how far to believe it.

| Boundary | Untrusted side | Trusted side | What holds it |
|---|---|---|---|
| The wire | The browser, and anyone who can send a request | Your server's host | The host bounds the body, accepts one content type, and judges every answer against the definition **from its own store**, never one the request carries |
| The sandbox | The request, and the rule modules run inside it | The host and its process | A fresh instance per run with no environment, network or files but the program; a deadline, a memory limit and an output cap set by the runtime; a framed answer; failing closed |
| The browser page | Datum's own loaders and what a form or definition asks them to fetch | The page and its policy | The page's Content Security Policy, `allow-origins`, subresource integrity and Trusted Types: see [Security headers](/security-headers) |
| Code you load | Plugins, rule modules, design-system scripts and stylesheets | The page or the server that loads them | Review, versions, pinning and integrity checks, which are yours: Datum bounds the cost, not the intent |
| Keys | Everything above | Your key service, the person's authenticator, the signing agent | Keys never enter a run: the PDF program prepares the bytes and the server, the browser's authenticator or the agent signs them |

### The browser

- The form runs in the page, in a shadow root, with the page's own privileges. A policy of `script-src 'self'` and a strict `style-src` is enough for the plain form; each optional part names the one directive it adds. See [Security headers](/security-headers).
- A definition fetched from `src` is data. It is capped (2 MiB by default) and parsed, never executed. A component that shows HTML has scripts, styles and event handlers stripped on every render, and a link or image address is limited to safe schemes.
- `pdf`, `wasm`, `draft-store` and `validate-url` are held to the page's own origin unless `allow-origins` lists another one.
- The check the page runs in its own sandbox is a **preview**. A browser belongs to the person using it, so only the run on your server decides. A page can be edited in developer tools, and Datum assumes it has been.
- A draft sits in the browser's storage under a name you chose. It is not encrypted and not secret: anything on the same origin can read it. Do not use drafts for data that must not rest in a browser.
- Print never runs a design system's JavaScript: the print document carries its own policy with `script-src 'none'`.

### The server host

The Spring Boot and FastAPI hosts receive a submission, judge it, and store, print or sign what was accepted. For each run the host:

1. refuses a wrong content type, an oversized body and malformed or very deep JSON before anything else;
2. builds the run context from its own copy of the definition, adding the day, host values and option lists that only the server knows;
3. takes one of a bounded number of slots, or answers 503 `server.busy` (every run takes a slot on both hosts, including inspection, the builder's save check and a public copy's validation);
4. starts a fresh instance of the sandbox, runs the program, reads exactly one framed answer and discards the instance;
5. answers 422 with codes when the answers were judged and refused, and 503 when they were not judged at all, storing nothing.

A 422 always means the answers were judged. A 503 always means they were not. There is no path from a failed run to an accepted submission.

### Plugins and rule modules

- A **plugin** is JavaScript registered by the page. It runs with the page's privileges, like any script you add. Datum does not sandbox it.
- A **rule module** that must also run on the server is written for the sandbox. It runs inside the instance, with a frozen language and a frame around the answer. Those are guard rails against a mistake. They are not a boundary against an attacker, so deploy rule modules like server code: review them, version them, ship them with the server, and never accept one from a request, from a form author through the builder, or from a database row an editor can write. See [Treat rule modules as server code](/wasm-hardening#treat-rule-modules-as-server-code).

### Design-system bindings

A binding draws a design system's markup and loads that design system's stylesheets, fonts and scripts, which the page serves. Datum loads them as described in [Security headers](/security-headers) and checks `integrity` when you give it. What a design system's own script does beyond that is the design system's business and the page's to vet. Datum's own look loads nothing outside its bundle. The reference bindings are examples; the adopter owns the result.

### Signing

- **A PDF signed with a server key.** The PDF program prepares the bytes to sign. Your server signs them with a key the sandbox never sees. See [Signing](/signing).
- **A submission signed with a passkey.** The browser's authenticator signs the canonical answers. The Spring Boot host verifies the signature against the public key it registered. The FastAPI host has no passkey verifier: it refuses a signed submission with 503 `signing.not_set_up`, so nothing is stored unverified. See [Signing a form with a passkey](/passkey-signing).
- **A PDF verified on the server.** The program checks structure and digests. It does not check the signature value and does not decide trust. The host does, against anchors you configure.
- **The local signing agent.** It listens on the loopback interface only, answers only the origins you list, and asks the person for a PIN for every signature. Its origin allow-list is the consent boundary between web pages.

## What the sandbox isolates

The programs that judge a submission and print a PDF are JavaScript evaluated by a JavaScript engine compiled to WebAssembly. A WebAssembly module reaches only what its runtime hands it.

| Isolated | How |
|---|---|
| The environment, the network and the file system | The instance is given none: no environment, no sockets, and one read-only folder that holds only the program and the run's script |
| The clock and randomness | `Date` and `Math.random` are disabled. The day is a value the host passes in. On the FastAPI host the engine's own clock and random source are the run's too: the clock starts at the epoch on every run and moves only by the run's own waits, and the random source is a fixed stream, so a rule module that imports `qjs:os` reads the same values on every run. On Spring Boot the guest's own clock and randomness are fixed as well: the WASI realtime clock and the file times read the Unix epoch on every run, and `random_get` reads the same bytes (the engine module does not import it), so a rule module that imports `qjs:os` learns neither the date nor real entropy. The monotonic clock stays the host's, since the runtime offers no way to replace it: it times sleeps and timers, and tells a run how long it has taken, not when |
| Time and memory | A deadline and a memory limit set on the runtime, outside the code they limit. Stack depth has no limit the engine enforces: the engine compiles its own stack check out under WASI, and the C stack the engine's frames use is a fixed 64 KiB. The FastAPI host checks every move of that stack's pointer and traps a move past the stack's floor before the frame is used, and writes a canary over the lowest bytes of the stack before each run as a second check; a run that reached the floor is a trap. The Spring Boot host compiles a copy of the engine module in which every move of that stack's pointer past the stack's floor traps before the frame is used, and writes a canary over the lowest bytes of the stack before each run as a second check; a run that reached the floor is a trap, as is a call stack Endive exhausts or a JVM `StackOverflowError`. Its depth guard also refuses a definition nested more than 32 component levels before the guest runs. A trap ends the run with no verdict (503) |
| One run from the next | Every run is a fresh instance on a server, discarded after it answers |
| The verdict from stray output | A fresh nonce frames the answer, and the host accepts exactly one frame |
| The built-in language from a rule | The language's objects are frozen before any rule module loads |
| The same verdict everywhere | Canonical output with sorted keys, and a parity check between the page's engine and the sandbox |

The caps are in [Limits](/limits#the-sandbox), and the full list of controls, with what the Datum hosts already do for each, is in [Hardening on a server](/wasm-hardening#the-checklist).

### What it does not isolate

- **A flaw in the runtime or the engine module.** The sandbox is software. A bug in it is the way out, so confine the process with the operating system as well, and keep the runtime patched.
- **A rule module written to attack it.** See above: review is the control.
- **The cost of a legitimate flood.** A slot bounds one run. It does not stop many callers from taking every slot. Rate-limit before the sandbox.
- **Anything the host chooses to hand in.** A run reads the context the host builds. A value the host trusts too much is the host's mistake.
- **The page's preview.** The in-page sandbox is for development. It is not a gate.

## What the host is responsible for

Datum ships no access policy, and the hosts do not decide who may call them. A route that is switched on is open until your framework's security says otherwise. On Spring Boot or FastAPI the controls that sit inside the sandbox are done or default to the safe setting. What stays yours:

1. **Who may call each route.** Authenticate and authorise in your framework, and switch on only the routes you use. Every endpoint is off by default.
2. **Rate limiting**, per caller and shared by every instance, in front of the sandbox. The hosts count every throttled request by its address before its body is read; the per-form limit counts after the parse. Share the storage so every instance counts the same windows.
3. **Who may save a definition.** An author can write a form that costs the full budget on every submission. Run the `check` operation at save.
4. **Rule modules and plugins.** Review, version and test them. `datum-security-check --plugins` attacks the host with your real modules.
5. **Sizing and confinement.** A container memory limit that covers every slot at its full limit, an unprivileged user, a read-only root file system and no outbound network beyond what the application itself calls.
6. **Keys.** Keep them in a key service or a mounted secret, never in a folder a run could be handed.
7. **Patching.** Move the engine module with a Datum release, and follow the runtime's own advisories.
8. **Storage.** The in-memory stores are for development. Where records rest, and their encryption, retention and backups, are yours.
9. **Transport and headers.** TLS, CORS, and the Content Security Policy of the pages that embed the form. The hosts add no CORS headers of their own.
10. **Proof.** Run the [conformance suite](/conformance) against the program you ship and the deployment that runs it, in CI, after every build and every update of the runtime.

[What a Datum host leaves to you](/wasm-hardening#what-a-datum-host-leaves-to-you) is the same list with the settings.

## What Datum does not claim

- It is not a penetration-tested product. The conformance suite sends the gate's attack vectors, and a pass means every case that ran behaved. It is not an audit.
- It makes no promise about code written to attack the sandbox from inside a rule module.
- It does not make a form accessible or private by itself. Accessibility evidence is automated checks only: see [Accessibility](/accessibility).
- Datum is pre-release. The definition format and the program contracts can change in 0.x: see [Release status](/introduction#release-status).

## Next

- Lock down a server: [Hardening on a server](/wasm-hardening).
- Lock down a page: [Security headers](/security-headers).
- Prove it: [Conformance suite](/conformance).
- How the parts fit: [How Datum uses WebAssembly](/wasm).
