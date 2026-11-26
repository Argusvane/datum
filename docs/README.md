# Datum documentation

What is under `docs/`, by who reads it. The first heading of each file is its title.

## Where the documentation lives

`site/docs` is the canonical user documentation, published at https://datum.argusvane.com/docs/. It is where a
person learns to use Datum, and where a change to user-facing behaviour is written. `docs/` holds what the site does
not:

- the architecture decision records, in [adr/](adr/README.md);
- the generated references, in `reference/` and `generated/`, which scripts write from the code;
- the deep host references for [Spring Boot](spring.md) and [FastAPI](fastapi.md), and the reference guides that sit
  beside the code they describe.

Where a guide here and a page on the site cover the same ground, the site's page is the current one and the guide
here is the bug. What is published and what is not is written once, in
[Release status](https://datum.argusvane.com/docs/introduction#release-status). Support routes are in
[SUPPORT.md](../SUPPORT.md), and the changes between releases in [CHANGELOG.md](../CHANGELOG.md).

## Guides

For people putting a form on a page, wiring a server, or authoring forms.

- [Publishing a form](publishing.md): from the builder's Download to a working page, what the form opens as, the PDF action and hosting.
- [Integration recipes](integration-recipes.md): copy-paste starting points for wiring the form into a host page.
- [Host security](host-security.md): the CSP, CORS, SRI and Trusted Types a page needs for a form drawn with a design-system binding, and print.
- [Releasing](releasing.md): how a release is cut: the order across Maven Central, npm and PyPI, and what each step refuses.
- [Air-gapped deployments](air-gapped.md): running Datum with no route to the Internet: the offline bundle, the binding packs, the settings that reach out, and the check.
- [Data model](data-model.md): how a form's data model is read, reviewed and built from a sample.
- [Data sources](data-sources.md): option lists and values a form loads from outside itself.
- [Formulas](formulas.md): rules written as FEEL text and the function library.
- [Translation support](translation-support.md): localizing a form's own text.
- [Translating the builder's interface](builder-ui-translation.md): wording the builder's own screens in another language.
- [Writing a design-system binding](binding-authoring.md): the binding contract, the package, and the binding kit that tests it.
- [Print support](print-support.md): printing a live form or a read-only form from the browser.
- [PDF rendering](pdf-rendering.md): producing, templating and filling PDFs from a form.
- [PDF tagging](pdf-tagging.md): the structure tags written into generated PDFs.
- [Form tests](form-tests.md): scenarios over a form's rules, journeys and verdicts, run from the command line, vitest or the builder.
- [Agent tools](agent-tools.md): the tools a form or builder page exposes to a browser agent and to page script.
- [Conformance suite](conformance-suite.md): checking a sandbox program or a live server against the validation gate's attack vectors, and the host conformance contract.
- [Datum for Spring Boot](spring.md): the Maven starters, their SPIs, properties, security notes and the host test kit.
- [Datum for FastAPI](fastapi.md): the Python packages, their settings, hooks, engines and testing helpers.
- [Plugin packaging and discovery](plugins/packaging-and-discovery.md): the in-repo plugin manifest contract.

## Reference

- [Embedding](reference/embedding.md): the bundles and assets, the elements' API, putting the builder on a page, saving, printing and icons.
- [The builder](reference/builder.md): the bar, workspaces, strip panels, drawers, the remembered layout, the command palette, file actions, slots, the look and its dark scheme.
- [Attributes](reference/attributes.md): every attribute, property, method and event of the elements. Generated from the code; `attributes.json` is its machine form.
- [Agent tools reference](reference/agent-tools.md): every agent tool with its description and schemas. Generated from the code.
- [Feature matrix](reference/feature-matrix.md): what the engine implements, each row with its evidence. Generated from `engine/traceability/feature-matrix.json`.
- [Journeys](reference/journeys.md): the journey block, the builder's Journeys mode, steps and Check answers, journey-only fields, opening a journey, server checks.
- [Sandbox and server runs](reference/server-runs.md): sandbox validation, the run log, and re-running the sandbox and PDF programs on a server.
- [Sandbox ABI](reference/sandbox-abi.md): the validation program's contract and its current version.
- [PDF ABI](reference/pdf-abi.md): the PDF program's contract and its current version.
- [Development](reference/development.md): per-unit commands, the audits, the dev loops.

## Decisions

- [adr/](adr/README.md): architecture decision records, one file per decision, numbered from 0001, indexed in adr/README.md. Each states how the thing works and the reasoning where there was a real choice.

## Generated reports

Written by scripts and held to the code by tests; never edited by hand. The command that regenerates each is in [CONTRIBUTING.md](../CONTRIBUTING.md).

- [generated/theme-accessibility.md](generated/theme-accessibility.md): the Datum form's automated axe findings (none at the committed baselines; no manual audit), from the committed axe baselines.
