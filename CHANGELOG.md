# Changelog

All notable changes to Datum are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the definition format and the program
contracts can change between 0.x releases, and every such change is listed here. One tag, such as `v0.1.0`, names a
release across npm, Maven Central and PyPI. 0.1.0 is published to npm only. What is published today is in
[Release status](https://datum.argusvane.com/docs/introduction#release-status).

## [Unreleased]

### Changed

- The sandbox ABI (`WASM_ABI_VERSION`, 4.1.0 in 0.1.0) and the PDF ABI (`PDF_ABI_VERSION`, 4.0.0 in 0.1.0) are both
  reset to 1.0.0, and every host's floor for both programs is 1.0.0. A program built from 0.1.0 answers another major,
  so a host of the next release refuses it at start: rebuild the programs from the same release as the host.
- A counted form text is worded by plural category only, as `<base>.<category>` (`summaryHeading.one`,
  `summaryHeading.other`, `fileAnnounced.other`). A category no catalog words reads `<base>.other`.
- `resolveFormText`, `resolveFormTextPlural` and `createFormTextResolver` read the host's translation catalog from
  `words.catalog`, and `plural()` takes no fallback keys.
- On `<datum-form-builder>`, the `features` list alone decides whether the PDF and Journeys sides exist
  (`features="-pdf"`, `features="-journeys"`). `pdf` names how the executor arrives (`auto` or a module URL).
- The PDF program refuses a `render` or `layout` document without its theme geometry (`controls`, `choice`, `fields`,
  `headings`, `table`, `box`, `panel`, `list`, `spacing`) as `invalid_request`. A `fill` request with `areas` must send
  the plan's `typography` and `colors`.
- A stored draft must carry `state.mode`, `visitedSteps` and `completedSteps`; one without them is refused as
  `draft.malformed`.
- `FormTestSnapshot.pages` is always present (empty without a journey), and `BuilderModeContext.holdForInspector` is
  required.
- The Tests panel offers Assert this only when the shell lends `assertReady` beside `assertSnapshot`.
- The PDF parity documents every host's render contract checks are `packages/pdf-kernel/tests/fixtures/documents/`
  (`datum-pdf`, `datum-plain`, `datum-pdf-fr-CA`), built by the current engine.

### Removed

- The PDF program's `capabilities` reply no longer lists features; it answers `abi` and `kernelVersion`. Hosts no
  longer check a program for features, and the conformance suite runs the `OUT` class against any PDF program of
  ABI 1.0.0 or a later version of that major.
- Expression trees as authored rules. A rule, journey route `when`, worked-out value, PDF layout `when` or field or
  area `expression` written as a tree (bare or `{ expression, run }`) is refused as `invalidRule`; write the formula
  text or `{ formula, run }`. The 200-level depth limit for trees goes with them.
- The `{base}One` / `base` pairs of counted form texts (`summaryHeadingOne`, `countLeftOne`, `fileAnnouncedMany`, …).
- The `{{pageNumber}}` and `{{pageCount}}` spellings in PDF template text and print headers and footers; use
  `{{page}}` and `{{pages}}`.
- `<datum-form-builder>`'s `journeys` attribute, `pdf="off"`, and the `features` token `form`.
- The agent tools' `navigator.modelContext` fallback: WebMCP is read from `document.modelContext` only.
- The `JourneyPreview` alias, the builder entry's `JourneyPreviewContext`, and `LAYOUT_CONTAINER_TYPES` from the
  render entry (it stays in the registry entry).
- The builder components' fallbacks from the studio token names to other token names (`--db-accent-text`,
  `--db-line-card`, `--db-focus`, `--db-ink-subtle`, `--db-surface-hover`, `--db-*-line`).

## [0.1.0] - 2026-11-26

The first release, 0.1.0, contains the following.

### Added

- The form definition: one JSON file holding a form's components, data model, rules written as formulas, pages,
  journeys, translations, tests and PDF layouts.
- The form engine, in plain TypeScript with no framework: validation, rules, journeys and the builder's logic.
- `<datum-form>`, the web component that draws a form on any page, and `<datum-form-builder>`, the visual builder,
  as script-tag bundles with drafts, print, languages and agent tools for browser assistants. Datum's own look is
  built in and has light and dark schemes.
- The validation sandbox: the same validation program runs in the browser and on a server, in a WebAssembly sandbox
  with a time budget, a memory limit and a framed answer.
- The PDF kernel: PDFs rendered from a form's layouts or filled into a template, tagged for accessibility, PDF/A,
  signed (PAdES, with a timestamp), and verified.
- Signed submissions with a passkey (WebAuthn), and a local PIV signing agent for hardware tokens and certificate
  files. The agent runs from the repository.
- Form tests: scenarios kept with a form, run in the builder, from the command line (`@argusvane/datum-form-test`)
  and in a vitest suite.
- The conformance suite (`@argusvane/datum-conformance-suite`): `datum-security-check`, `datum-host-check` and
  `datum-binding-check`, which hold a sandbox program, a server host and a binding to their contracts.
- Server hosts: Spring Boot (Maven, group `com.argusvane`, with starters for submissions, UI, PDF, timestamp and
  passkeys) and FastAPI (PyPI, `argusvane-datum-*`), both tested on Linux. Other frameworks run the same two programs
  through the framework-free sandbox libraries (`datum-sandbox` on the JVM, `argusvane-datum-sandbox` in Python).
  In 0.1.0 they run from the repository; their Maven Central and PyPI packages come in a later release.
- An address limit on both hosts (`datum.web.throttle.address-limit`, default 600 per window; FastAPI
  `address_limit`). Every throttled request is counted by its address before its body is read, so a flood of bodies
  that never parse is refused with 429 `flood` as well. The per-form limit still counts after the parse. The host
  check has a new case, FLD-02, and a host running it sets `address-limit=200`.
- Nine reference design-system bindings (GC Design System, USWDS, GOV.UK, Bootstrap, Nova Scotia, Alberta, Québec,
  Ontario and Fluent UI), a binding kit that tests a binding, and the Font Awesome icon-set plugin. They are
  reference and demo material that is not published as packages.
- Air-gapped deployments: an offline bundle, with each binding's files packed, and a check that nothing reaches out.
- Documentation at https://datum.argusvane.com/docs/, including the threat model, and the project site with a live
  demo.
- Release assets: the bundles as plain script files on the GitHub Release, with their source maps.
