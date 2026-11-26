# Conformance suite

The conformance suite is three commands that check Datum's server side from outside:

- `datum-security-check` attacks the validation gate, the sandbox program that judges every submission.
- `datum-host-check` holds a server host to the wire contract of its endpoints.
- `datum-binding-check` holds a design-system binding to what the renderer asks of it.

Each prints a result per case, writes a report and ends with an exit code a CI job can act on.

All three come from the `@argusvane/datum-conformance-suite` package and need Node 22 or newer. The package is not published to a registry yet. Build it from the repository root, which installs the suite and the packages it builds through (`file:` links), or install a tarball made with `npm pack`:

```sh
npm run setup -- engine packages/*-wasm-host packages/pdf-kernel packages/submissions packages/conformance-suite
npm run conformance-suite:build
```

Until the package is published, the command names on this page are not on your path. From a checkout, after the build, run each as `node packages/conformance-suite/bin/<command>.mjs` with the same arguments, for example `node packages/conformance-suite/bin/datum-host-check.mjs --endpoint https://forms.example --capabilities forms`. The root script `npm run conformance-suite:host-check -- <arguments>` runs the host check the same way.

## Where each one fits

| Moment | Command |
|---|---|
| Before a deployment serves a form | `datum-security-check` against the program you ship, then against the running server |
| In CI, after every build | `datum-security-check --program`, and `datum-host-check` against a test deployment |
| Writing a host for a framework | `datum-host-check` until every capability passes |
| Writing a binding | `datum-binding-check` until every case passes |

The suite is not a penetration test. A pass means the gate or host behaved as the contract says on every case that ran, so read the skipped and pending cases before you quote one.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every selected case passed |
| 1 | A case failed |
| 2 | Usage or configuration error, or a named capability asserted nothing |
| 3 | Inconclusive: the check could not finish (the server, a fixture form or a switch is missing, rate limited out) |
| 4 | The tool itself broke |

`datum-binding-check` has two cases of its own:

- **Code 3** is a failed preflight: Playwright, esbuild or the browser missing, or an asset out of reach. It is non-zero on purpose, so a CI job never reads "could not check" as a pass.
- **Code 2** is an assets file that is missing or is not JSON, a usage error.

## datum-security-check

It sends attack vectors at the validation gate: forged outcomes, answers a choice does not offer, smuggled journey members, oversized and malformed bodies, runaway rules, replays. Each vector has an id such as `ISO-03` and is reported PASS, FAIL, WARN, SKIP, XFAIL, XPASS or ERROR. Failures come first in the report, each with the expected and the observed result.

Run it against a built sandbox program, which needs nothing else, or against a live server.

```sh
datum-security-check --program packages/datum/dist/datum-sandbox-program.js --format json,md --out report/
datum-security-check --endpoint https://forms.example --form datum-security-suite --out report/
```

Endpoint mode needs one fixture form installed on the server. `datum-security-check fixture --format submissions` prints the body to create it, and `fixture` alone prints the definition.

- **Default.** Only the validate route is read.
- **`--allow-writes`.** It also posts submissions, and only to a form you vouch for with `--i-installed-the-suite-fixture`.
- **Never.** The suite never sends PUT or DELETE to a form route and never follows a redirect, apart from the builder profile below.

| Flag | Effect |
|---|---|
| `--program <file>` | Check this sandbox program |
| `--manifest <file>` | Check the program against its release `manifest.json` |
| `--abi-floor <x.y.z>` | Require a later sandbox interface version within the suite's major (4.0.0 is the floor) |
| `--budget-profile node\|browser` | The nominal evaluation budget the time bounds are multiples of: `node` (the default) or `browser` |
| `--golden <file>` | Judge against this golden file instead of the bundled one |
| `--plugins <module.js>` | Register this rule module in every sandbox. Repeatable. Use it to attack a host with the modules it really registers |
| `--parity` | Compare the in-browser engine with the program |
| `--all` | Program and parity together, plus the endpoint when given |
| `--pdf-program <file>`, `--pdf` | Render hostile answers through the PDF program and inspect the bytes |
| `--endpoint <url>` `--form <id>` | Attack a live server; `--form-version` defaults to `1` |
| `--public-definition-url <url>` | Where the public copy of the form is read. A form that carries the fixture marker there may be posted to under `--allow-writes`, as an alternative to `--i-installed-the-suite-fixture` |
| `--auth-header "Name: value"`, `--header`, `--cookie` | Credentials for the server; never printed |
| `--max-requests` `--delay-ms` `--timeout-ms` `--body-limit` | Request budget (defaults 400, 250, 30000, 1048576) |
| `--builder` | The builder profile: saves hostile definitions into a form of its own, then deletes it; needs `--allow-writes` |
| `--builder-form <id>` | The id of the form the builder profile makes |
| `--state-file <path>` | Where the builder run records what it made, so `builder-cleanup` can remove it (default `./.datum-security-run.json`) |
| `--definition-limit <bytes>` | The largest definition the builder profile saves (default 8 MiB) |
| `--max-saves N` | The most saves the builder profile makes (default 60) |
| `--dry-run` | Builder profile: print the requests it would send and send none |
| `--only`, `--skip` | Ids or classes, comma separated (`ISO-03`, `isolation`) |
| `--gate release\|full` | `release` is the default; `full` also runs pending and heavy vectors |
| `--fail-on fail\|warn` | `warn` makes a WARN or XPASS fail the run |
| `--heavy` | Add the vectors that need seconds and hundreds of megabytes |
| `--format json,md`, `--out <dir>` | Report formats (default `md`); `--out -` prints to stdout |
| `--quiet` | Print only errors |
| `--json`, `--help`, `--version` | `--json` goes with `list`; the others print usage and the version |

The vector classes are `abi`, `builder`, `canonical`, `context`, `control`, `definition`, `files`, `isolation`, `journey`, `options`, `output`, `parity`, `receiver`, `resource`, `secrecy` and `test`, and an id is the class's short code and a number.

Subcommands:

- `list [--json]` prints the vector catalogue.
- `explain <id>` shows what one vector sends and expects.
- `fixture` prints the fixture form.
- `builder-cleanup --endpoint <url>` removes what a killed builder run left.

The JSON report has a `schemaVersion` and a schema shipped with the package.

## datum-host-check

It checks that a host answers the endpoint catalog correctly:

- Status codes, error codes and bodies.
- The order of the receiving pipeline.
- That no reply is a 5xx other than a typed 503.

It runs one group of cases per capability, always in the order of the table below, whatever order `--capabilities` names them in. `flood` is last because it spends the request budget.

| Group | What it holds the host to | What the host needs |
|---|---|---|
| `submissions` | The control documents, the journey check and its one verdict shape (`{accepted, errors, notes?}`, blocking errors only), a strict check request (`{document, scope, pageId?}`, else 400 `bad_document`), the refusals before the program (409, 415, 413, 400, 404), the submission key: a retry answered with the first receipt, another attempt another record, a known key with another document 409 | The fixture form installed; at least 20 submissions a minute from one address |
| `submissions-test` | `POST /submissions/test` reports the control values, and the report is one flat object of exactly 14 members, whether the document is accepted or refused | The dry-run route on |
| `forms` | The public copy under its key and `id@version`, its `ETag`, the 304, 404 `form.notFound` | The fixture form installed |
| `assets` | `host.json`, the immutable bundles, the glue, the builder's files, no path out of the assets | `--builder-enabled` when the host serves the builder |
| `builder` | Only someone who may build saves, `If-Match` and 409, the program's 422s, id rules, 409 `form.exists` | `--build-form`, and person headers for an author and a viewer |
| `pdf` | Posted answers print and refused ones do not, sign, the chain, verify, 404 `layout.notFound`, 415, 400 `pdf.notAPdf`, the PDF theme per route | The fixture form; `--pdf-signing` and `--pdf-bindings` for the cases that need them |
| `tsa` | A granted token, a rejection for unreadable bytes, 403 for a session cookie then 415, the certificates in PEM and DER | The [timestamp server](/timestamps) on |
| `passkeys` | The signing block, who may ask for a challenge, the challenge's shape, the register refusals in order, a person's list, 404 for another person's passkey | `--signing-form`, and person headers for two people |
| `hardening` | A looping rule is cut, unbounded memory and a 40 MiB answer are refused, stray output after the answer frame refuses the run. A run that gave no verdict is a 503 with its code and no `Retry-After`, on a delivery and on a journey check; only a rule that threw (`validator.failed`) is a 422 | A test deployment that registers the kit's hostile rule module for the fixture form |
| `runtime-down` | A runtime that could not prove its program answers 503 to every submission and to a journey check | A test deployment started with the stale program and fail-fast off |
| `host-context` | The host reads `host.` rules from a context it works out itself, never from one the client writes. A test header stands in for a session: `admin` makes `admin_note` required, `user` and no header do not, and a document that forges the context is read as the user's | A test deployment that serves the kit's host context form, has the dry run on, and wires a test-only provider for the `X-Datum-Test-Role` header |
| `flood` | 429 `flood` with `Retry-After`, from the per-form limit (FLD-01) and from the address limit, which counts a body that does not parse (FLD-02); last because it spends the request budget | A low per-form limit (the kit posts up to 120 times) and an address limit above the rest of a kit run and below 400 (the kit posts up to 400 bodies of `{`) |

Every reply in every group is also held to one rule: no 5xx but a typed 503, and JSON on a JSON route. A run that failed (`wasm.execution_error`, `outcome_too_large`, or a registered form nested too deep, `definition.tooDeep`) is such a 503, never a 422 or a 200 verdict. The routes are listed on [the wire](/wire).

```sh
datum-host-check fixtures --out kit/
datum-host-check --endpoint http://localhost:8000 --capabilities submissions,submissions-test,forms,assets,flood --out report/
```

`fixtures --out <dir>` writes:

- The fixture form and the golden file.
- The hostile rule module (`hardening-rules.js`).
- A stale program (`stale-program.js`) the `hardening` and `runtime-down` deployments need.
- `fixture-pdf-theme.json` for the PDF theme cases.
- `fixture-host-context-form.json` for the `host-context` deployment. That deployment installs the form beside the first, turns the dry run on, and wires a test-only provider that reads the role from `X-Datum-Test-Role`. Never wire that provider where real submissions are taken.

Before a run:

1. Install the fixture form on the host, and switch on the routes each capability needs, which your [Spring Boot](/spring-boot) or [FastAPI](/fastapi) page lists.
2. Aim the kit at a test deployment, because it writes records.
3. Start a fresh application for every run: a second run inside the throttle window fails with 429.
4. For the `flood` capability set the per-form limit to 30 and the address limit to 200 (Spring Boot: `datum.web.throttle.limit=30` and `datum.web.throttle.address-limit=200`; FastAPI: `DATUM_WEB__THROTTLE__LIMIT=30` and `DATUM_WEB__THROTTLE__ADDRESS_LIMIT=200`). The kit runs from one address, and every request counts against the address limit, so 200 leaves room for the rest of a kit run and is reached by FLD-02 within its 400 tries.

| Flag | Effect |
|---|---|
| `--endpoint <url>` | The host's base URL with its context path |
| `--capabilities a,b,c` | What the host serves; required |
| `--api-path`, `--assets-path`, `--tsa-path`, `--webauthn-path` | Where the routes are, defaults `/api`, `/datum/assets`, `/tsa`, `/api/webauthn` |
| `--builder-enabled`, `--pdf-signing`, `--pdf-bindings` | Say what the host has switched on, so the cases that need it run instead of being skipped |
| `--signing-form <key>`, `--build-form <key>` | The form the passkey and builder cases use |
| `--header Name=Value` | On every request; repeatable |
| `--person-header`, `--other-person-header` | Headers of a signed-in person and of another one |
| `--csrf cookie:<cookie>:<header>` | The cookie-token recipe, for Spring Security `cookie:XSRF-TOKEN:X-XSRF-TOKEN` |
| `--only`, `--skip` | Case ids, comma separated |
| `--out <dir>` | Write `report.json` and `report.md` |
| `--timeout <ms>` | Per request (default 120000) |
| `--config <file.properties>` | Read the target options from a properties file. The keys are the Java kit's `datum.tck.<key>` names, so one file serves both kits |
| `datum.tck.<key>=<value>` | The same settings as arguments, one each |
| `--json`, `-h`, `--version` | Machine-readable output for `list` and `agent-tools`; usage; the version |

Subcommands:

- `list [--json]`.
- `explain <id>`.
- `agent-tools --tools <dump.json>` compares a page's assistant tool dump with the shipped catalogue and needs no server. Its exit codes differ from the table above: 0 for no finding, 1 for a finding, 2 when the dump cannot be read.

The other subcommands use the exit codes in the table above.

## datum-binding-check

It runs the renderer with a binding in headless Chromium and checks what Datum and the binding write or pass to each other:

- Mounting and the value round trip.
- Errors drawn and the error summary.
- Read-only fields and date parts.
- Data grids, tabs and journeys.
- Languages, and the print and PDF suggestions.

It never judges the design system's own quality. It needs Playwright with a browser (`npx playwright install chromium`), and esbuild for any binding but Datum's own.

```sh
datum-binding-check
datum-binding-check --binding gcds --report out/
datum-binding-check --binding ./my-binding.ts --assets ./my-binding/assets.json --offline
```

| Flag | Effect |
|---|---|
| `--binding <datum \| id \| path>` | `datum` is the default; an id names a `bindings/<id>` package; a path names a module exporting `createBinding(lit, datum)` |
| `--assets <file>` | The stylesheets, scripts and fonts the host loads, and the other settings of the binding |
| `--only` | Case ids or groups, for example `MNT,VAL,ERR-01` |
| `--baseline <report.json>` | Show which cases changed state since a known-good run |
| `--report <dir>` | Write `report.json`, `junit.xml`, `report.html` and a screenshot per failing case |
| `--offline` | Fail the run naming any request to a host the run does not answer |
| `--browser` | `chromium` (default), `firefox` or `webkit`; the cases are verified on Chromium |
| `--continue` | Run although preflight found a problem |
| `--list`, `--case-timeout <ms>` | List the cases; per-case timeout, default 60000 |
| `--port <n>` | The first port to try for the local server (default: any free one) |
| `--help`, `-h` | Print usage |

[Writing a binding](/writing-a-binding) shows what a binding provides and how to use these results.


