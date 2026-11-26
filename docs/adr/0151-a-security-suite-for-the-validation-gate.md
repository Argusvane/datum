# ADR 0151: A security suite for the validation gate

## Status

Accepted.

## Context

The sandbox and submission path can have defects that a unit test next to the code does not
catch, such as a choice answer posted at a container key skipping the option check, a catastrophic
pattern composed at run time slipping past the risky-pattern check, or a built program shipped to
a host that is a minor behind the kernel source. Each, once fixed, is promoted to a
regression test in the package that owns the code. Those tests protect the source tree. They do
not tell an operator, an auditor or a release process whether the program file that is about to be
installed, or the server that is running today, still behaves as the contract says. Several hosts
(the Spring Boot, FastAPI and Node hosts, .NET by recipe) run the same program file, and each adds
an HTTP edge of its own.

## Decision

1. **One package, three runners.** `@argusvane/datum-conformance-suite` (`packages/conformance-suite`)
   holds a catalogue of attack vectors with stable ids and drives them through:
   - (a) a program file in a sandbox,
   - (b) a live endpoint, and
   - (c) a parity comparison of the in-process kernel and the program.

   One vector is one description; the runners apply it where it is meaningful. The package name says
   conformance because it also holds the host wire-contract kit (decision 9); the attack-vector
   command keeps the name `datum-security-check`, and the fixture form key is `datum-security-suite`.
2. **A command, not a test file.** `datum-security-check` is distributed as a single unminified ESM
   bundle with the engine and the QuickJS WASM inlined, so an operator needs no TypeScript toolchain
   and no `node_modules` to run it. It takes only `--program <file>`: a program is built from source
   only by a repository script, because the builder splices function source text and must never go
   through a transforming bundler. The build holds the bundles to a size budget, so they cannot grow
   unnoticed, and the host-check bundle has a budget of its own (decision 9); a bundle over its budget fails the build.
3. **Results are citable.** Each vector has a stable id, a severity, an attacker, a provenance (the
   tests that cover it) and a gate: `enforced`, `advisory`, or `pending` with the open item that
   blocks it. A run that could not finish is never a success: it exits non-zero with its own code,
   so CI never reads "could not check" as a pass.
4. **Pending vectors register the gap.** A known open issue is a vector that fails today and becomes
   a promotion (XPASS) the day it is fixed, so a fix cannot land unnoticed and a gap cannot be
   forgotten. `--gate full` shows them; `release` skips them.
5. **Endpoint mode is bounded.** It attacks one fixture form the operator installs, is read-only
   by default, sends only to an allowlist of the form's own routes, honours rate limits and never
   prints a credential. Writes need `--allow-writes` and proof that the form is the fixture.
6. **Builder instances are in scope**: hostile definitions through the `check` and `public`
   operations in program mode, and a `builder` endpoint profile that saves them to a suite-owned
   test form, with cleanup.
7. **A host conformance contract** states what a host that stores or forwards submissions must do:
   run `check` before persisting, serve only `public`, refuse on any problem, never answer 500
   (`docs/conformance-suite.md`, "The host conformance contract", holds the detail). The endpoint
   vectors test it from outside.
8. **Endpoint mode is a manual or scheduled check, not a pull-request gate.** The program and
   parity runners are part of CI, over the program built from source and over the built
   `dist/datum-sandbox-program.js` in a second job, because the shipped file is what is attacked.
9. **A second command, `datum-host-check`, holds the wire contract.** It is the Node port of the
   Java host test kit: the wire contract of every Datum host as cases over HTTP, in a fixed order,
   with the same exit codes and report shape as the endpoint mode (ADR 0152 holds the host side).

   It is the cross-host gate: a Quarkus, NestJS, FastAPI or .NET host is held to the same table by
   the same tool, with no JDK on its runner. The endpoint mode stays the refusing side (attacks and
   forged outcomes); the host check is the specifying side (what the routes must answer), and a
   release runs both.

   Two of its capabilities need a test deployment configured to be hostile on purpose (the kit's
   hostile rule module registered for the fixture form, and the stale sandbox program with fail-fast
   off); the fixtures the kit writes carry both. Details: `docs/conformance-suite.md`, "Host
   conformance".

## Consequences

- A kernel change that weakens the gate fails a vector with a name an auditor can read, even if no
  unit test next to the change noticed.
- A release cannot ship a program that is below the suite's ABI floor or that fails an enforced
  vector.
- The vector catalogue is a second place that describes the contract. It is generated, linted
  (ids, provenance paths, a mutation test for every S1 vector) and versioned (`vectorSet`), so it
  does not drift silently, but a change to the contract touches the kernel, its tests and the
  catalogue.
- Not covered, by decision: a penetration test of a host's code outside the validation routes, and
  a live acceptance run of a host, which stays manual. The PDF program's output is a vector class of
  its own, run only with `--pdf-program`.
