# Changelog

All notable changes to Datum are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 the definition format and the program
contracts can change between 0.x releases, and every such change is listed here. One tag, such as `v0.1.0`, names a
release across npm, Maven Central and PyPI. 0.1.0 is published to npm only. What is published today is in
[Release status](https://datum.argusvane.com/docs/introduction#release-status).

## [Unreleased]

### Security

- `verifyWebAuthnSubmission` no longer verifies a signature with the key embedded in it when the host's
  `publicKeyFor` knows no key for the credential: such a signature is invalid, and each verdict says which key it was
  checked with (`key`). Assertions and registrations also refuse `crossOrigin` and `topOrigin`, backup state without
  backup eligibility, RSA keys under 2048 bits and ES256 keys off P-256.
- The static HTML sanitizer writes a self-closed non-void tag (`<a …/>`) as an empty element, so it can no longer
  stay open over what follows it in a printed document.
- PDF attachments are refused by an executable, script or HTML file name, by markup in the XHTML namespace and by
  XML with an internal entity subset; a stored file whose bytes exceed its declared size is left out, and the
  attachment budget is charged again over the real bytes.

### Changed

- PDF ABI 4.1.0: the program accepts `attachmentPolicy` on a document or fill and `declaredSize` on a resolved
  attachment, and prints several answers differently (see Fixed).
- A lone checkbox is answered only when it holds `true`; `"true"` and `"false"` are stored as booleans, and a
  checkbox group's list is stored as its record.
- A year typed in fewer than four digits is reported as `date.year` instead of being padded, and a native date box
  holding a partial date reports `date` with `badInput`.
- `validate({ scope, entry })` checks one collection entry of a scope; a `steps` container in a data grid row uses
  it, and switches its steps in place, each row its own.
- The live form draws tabs and steps flat for the page's own print (`beforeprint` to `afterprint`); the
  `browserPrint` mount option, or a `features` list without `print`, leaves it as on screen.

### Fixed

- PDF: a collection row with no answer at a key no longer prints the top-level answer at that key; hidden and
  excluded row fields are left out of tables; the browser PDF reads the definition's `kinds`; choice answers no
  option lists are kept; grid fields are tagged content; page breaks keep the document's margins and bands.
- Print and Check answers keep choice values no option lists, read spaces-only text as not answered, print
  impossible dates as stored and list a field once, under its earliest page.
- Live form: a stored file is written only while the form allows it, to its own row; Remove removes one file;
  focus is not taken back from the page when a submission ends; hidden steps are passed over.

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
