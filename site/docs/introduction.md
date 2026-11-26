# Introduction

Datum is forms infrastructure you run in your own environment: your forms, your data, your keys. A form is designed once, as one JSON document, and rendered on any page. What comes out is the output you choose: a submission validated in a WASM sandbox on your own server, a PDF from a layout you designed or an existing PDF filled in, a printed page, a JSON record, a signature with a certificate or a passkey.

It is a set of packages you host, not a service you subscribe to. Datum's own code fetches nothing from a third party at runtime, so an [air-gapped deployment](/air-gapped) works the same as any other. A design-system binding may load fonts, icons or images from a third-party host (Google Fonts, Adobe Fonts or the design system's own site); [the table in Design-system bindings](/bindings#hosting-the-files) lists each.

The words on this site, such as definition, envelope, binding, journey and sandbox, each have one meaning. [Concepts](/concepts) says how a form flows from the builder to the page, to your server and into a record, and defines every term in a line with a link to its page. Datum is pre-release: [Release status](#release-status) says what that means for the contracts.

## The pieces

| Piece | What it is | Where it runs |
|---|---|---|
| The form element | `<datum-form>`, a web component that renders a definition, validates the answers and raises the submission | Any page, any framework |
| The builder | `<datum-form-builder>`, the design surface: canvas, inspector, logic, data, journeys, PDF layouts, tests, languages | The browser |
| The definition | One JSON document: components, rules, journeys, layouts, translations, tests | Your repository, your storage |
| The sandbox | A WebAssembly runtime and the sandbox program in it, which validates a submission | Your server, and the page while you develop |
| The PDF program | Draws a layout from the answers or fills an existing PDF, with tagging, PDF/A and signatures | The browser or your server |
| A server host | Endpoints for definitions, submissions, PDFs, timestamps and passkeys, in your framework | Spring Boot, FastAPI; more planned |

Each piece stands on its own.

- A team can design, test and publish a complete form with the first two alone.
- The form element is the engine with a face on it: a page that wants the runtime, the rules and the validation without the element can use [the engine on its own](/engine).
- A person filling it in can print it, or download a PDF or the answers as a file.
- When submissions should be kept in one place, signed with a server's key or verified centrally, a server host takes over without changing the form.

## How a form flows

A form is designed in the builder, published on a page, filled in, submitted as a canonical envelope, checked again by your server in the sandbox, and kept as a record, with a PDF if you want one. [Concepts](/concepts#how-a-form-flows) walks the six steps and names what happens in each.

## Where to go next

- [Concepts](/concepts) defines every term the site uses.
- [Getting started](/getting-started) goes from the build to a form on a page of your own, a form you designed, and its answers on a server.
- [Building a form](/building-a-form) walks the builder's workspaces, and [Components](/components) lists what a form is made of.
- [The definition](/definition) is the one file a form is, and [The form element](/form-element) lists every attribute, property, event and method.
- [Server hosts](/server-hosts) covers the Spring Boot and FastAPI packages, and what any other server needs.

## Release status

Datum is pre-release, at version 0.1.0. This is the one place that says what is published; other pages link here instead of repeating it.

**The first release, 0.1.0, publishes:**

| Where | What |
|---|---|
| npm | `@argusvane/datum` (the form and builder bundles), `@argusvane/datum-conformance-suite` and `@argusvane/datum-form-test` |
| GitHub Release | The same bundles as plain script files, with the source maps |
| CDN | The npm package's files, from any npm CDN such as jsDelivr: [From a CDN](/files#from-a-cdn) |

**Coming in a later release:** the Spring Boot host on Maven Central (group `com.argusvane`) and the FastAPI host on PyPI (the `argusvane-datum-*` distributions). Until then, both run from the repository.

**What is never a package of its own:** the engine, the PDF kernel, the sandbox host and the submissions reference server (what ships of them is built into the packages above), the reference [bindings](/bindings), the PIV signing agent (it runs from the repository) and the other [server hosts](/server-hosts), which are documented as snippets.

**What to expect from a 0.x release:** the definition format and the program contracts can change between releases, and every change is recorded in the [changelog](https://github.com/argusvane/datum/blob/main/CHANGELOG.md). Security fixes go to the latest 0.x release and to `main`. Datum is tested on Linux.

Versions today:

| What | Version | Where it shows |
|---|---|---|
| Packages | 0.1.0 | Every package |
| Sandbox program interface | 4.1.0 | [Running the programs on your own server](/server-programs#interface-versions) |
| PDF program interface | 4.0.0 | The same table |
| `schemaVersion` of a definition | any non-empty string; the examples use `"1"` | The definition |

- The major number of an interface changes when a payload's shape breaks, and a host refuses a program built for another major.
- A `schemaVersion` is compared for equality when a draft is restored, and nothing migrates a definition from one to another.
- Deploy servers first or together with the browser bundle.
