# Development commands and audits

The per-unit commands, the dev loops and the accessibility audit. There is no root install: each unit
(the engine, every folder under `packages/`, `plugins/`, `bindings/` and `site/`) has its own `package.json` and lockfile,
and a unit that imports another through a `file:` dependency links to it without installing the other's own
dependencies, so each unit it builds from needs its own `npm ci`. `npm run setup` at the repository root does that, in
dependency order, and skips a unit whose `node_modules` is newer than its lockfile (`-- --force` installs again); name
units to install only those. The root `package.json` scripts (`npm run engine:ci`, `npm run datum:build`, …) run the
per-unit commands from the repository root.

## Commands

Run each from the repository root.

```
npm run setup                                  # npm ci in every unit; `-- engine packages/datum` installs just those
npm run ci                                     # setup, then every unit's checks and builds, the bindings, the site build and its tests; slow
npm run setup -- engine && npm run engine:ci   # engine: lint + traceability + typecheck + tests
(cd engine && npm run gates)                   # engine: release-gate evaluation (builds the engine first)
npm run setup -- engine packages/quickjs-wasm-host packages/pdf-kernel packages/datum
npm run datum:build && npm run datum:demo      # embeddable bundles in packages/datum/dist, then the demo pages on http://localhost:4173
npm run site:setup && npm run site:dev         # the marketing site; its live demo needs the builds below
npm run site:docs-dev                          # the docs site and its live examples (after site:setup)
(cd packages/datum && npm run a11y:browser -- --check)   # contrast audit in Chromium (npx playwright install chromium), after datum:build
```

The marketing site type-checks, builds and tests with only the engine, the bindings and the site installed (`npm run
site:setup`). Its live demo and the binding pages draw from built bundles: `npm run datum:build`, `npm run plugins:build`,
`npm run bindings:build` and then `npm run site:demo-assets`; without them the pages show their fallback text.
[site/README.md](../../site/README.md) lists what each page needs.

The FastAPI host's generated resources and the JVM host's assets have their own first-run steps: `npm run fastapi:prepare`
(see [integrations/fastapi/README.md](../../integrations/fastapi/README.md)) and, for the JVM,
[integrations/jvm/README.md](../../integrations/jvm/README.md).

## Audits

Accessibility of the Datum form is checked two ways with automated tools only (no manual audit) — axe-core over the
rendered markup in jsdom, and axe-core with colour contrast on in headless Chrome (Playwright), the
Datum binding under its light and dark schemes. The results are tracked, component by component, in
[docs/generated/theme-accessibility.md](../generated/theme-accessibility.md), from the baselines under
`packages/datum/a11y/baseline/`. The audits record what is true as committed baselines; tests
fail on drift, not on findings. In `packages/datum`, `npx vitest run tests/a11y-markup.test.ts` and
`npm run a11y:browser -- --check` fail on drift; `npm run a11y` and `npm run a11y:browser` rewrite the baselines and the tracking
document from the current output. Datum audits no design-system binding: each reference binding owns
its accessibility.

## Telemetry

The runtime's event bus can feed a typed metric stream (`engine/form-engine/verification/telemetry.ts`). The metric names are a closed list (`TELEMETRY_METRIC_NAMES`: `submission.accepted.rate`, `submission.blocked.validation.rate`, `validation.error.count.by_stage`, `runtime.data_source.resolve.error.rate`, `plugin.install.success.rate`, `plugin.initialize.success.rate`, `plugin.failure.isolated.count`, `plugin.failure.blocking.count`, the `submission.latency`, `validation.latency`, `renderer.model.build.latency` and `draft.save.latency` percentiles, and `pdf.signed.count`), and every event carries the same eight dimensions (`TelemetryDimensions`): `form_id`, `form_version`, `schema_version`, `client_runtime_version`, `server_runtime_version`, `locale`, `plugin_id` and `component_type`.

`TelemetryEmitter.emit` throws when a required dimension is missing, so a payload is validated before it reaches a sink. `attachTelemetry(events, sink, { dimensions })` (`verification/telemetry-bridge.ts`) subscribes an emitter to the runtime's event bus and maps the domain events to those metrics; it fills a dimension the caller left out with `-` so an emit never throws, and returns a handle whose `detach()` removes the subscriptions. A check of single value paths (`validatePath`) is not a form-wide run and counts in none of the validation metrics. A sink implements `TelemetrySink.record`; `ConsoleTelemetrySink` and `InMemoryTelemetrySink` ship. `TelemetryEmitter.emitReleaseGateReport(report, dimensions)` turns a release-gate report into one `submission.accepted.rate` event: 1 when the report passed, 0 when it did not. The engine sends nothing anywhere: a host binds a sink of its own.

## Dev loops

- **The builder and the form elements.** Build `packages/datum`, then `npm run demo` serves the
  demo pages under `packages/datum/demo/` over the built bundles in `dist/`, the way a real page
  loads them.
- **The marketing site.** `npm run dev` in `site` serves the pages, including the live builder and form.
- **The docs site.** `npm run docs:dev` in `site` serves `site/docs`. How a page outside this repository
  embeds the form, the builder and the server programs lives there; the live examples are specified in
  `site/docs/.vitepress/theme/examples/*.ts` (index: `site/docs/examples.md`), with the server endpoints
  in `site/docs/snippets/server/`. The hardware-token signing flow is `site/docs/signing.md`.
- **A submissions server.** `packages/submissions` is the service a host mounts; its README names the
  seams a host binds.
