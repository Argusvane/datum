# @argusvane/datum-form-test

Runs a Datum form's tests (ADR 0154): short scenarios written in plain text over the form's rules, journeys and verdicts. A scenario sets answers, presses Continue or Submit, and says what must then be true (a field shown and required, a page skipped, a submission refused with a given code). Scenarios are stored with the definition (`tests`), in a `.datum-test` file beside it, or in files named on the command line, and each runs on two sides: the browser's runtime and the server's validation kernel. A scenario the two sides judge differently is reported as `parity`. Reports come as JSON, JUnit and Markdown, with CI exit codes.

## Install

```sh
npm install --save-dev @argusvane/datum-form-test
npx --package @argusvane/datum-form-test datum-form-test --help
```

The command needs only Node 22 (the bundle carries the engine and the QuickJS sandbox). Write the `--package` form in scripts and CI: the unscoped name `datum-form-test` on npm is not Datum's.

From a checkout of the repository:

```sh
cd packages/form-test
npm ci
npm run build                      # bundles dist/cli.mjs, dist/index.mjs and dist/vitest.mjs (plain Node 22)
```

## The command

```sh
node bin/datum-form-test.mjs fixtures/main.json fixtures/clock.json --report junit --report json --out out
node bin/datum-form-test.mjs fixtures/main.json --tests fixtures/failing.datum-test   # exits 1
node bin/datum-form-test.mjs form.json --coverage --fail-on untested                  # every rule needs a scenario
node bin/datum-form-test.mjs form.json --program datum-sandbox-program.js           # the kernel side on a shipped program
```

Flags: `--tests <file>` (repeats; one definition only), `--runner runtime|kernel|both` (default `both`), `--program <file>`, `--report json|junit|md` (repeats; default `md`), `--out <dir>` (writes the named reports as `form-tests.json`, `form-tests.xml`, `form-tests.md`), `--coverage`, `--fail-on failed|untested`, `--help`, `--version`.

Exit codes: 0 passed, 1 a scenario failed or errored, the sides differed, a source did not parse or (under `--fail-on untested`) a rule has no scenario, 2 usage or input error, 3 inconclusive (no scenario came to a verdict), 4 internal error.

## The vitest helper

```ts
import { formTests } from "@argusvane/datum-form-test/vitest";

// Paths are read as given, from vitest's working directory; build them from the file's URL
// (fileURLToPath(new URL("./registration.json", import.meta.url))) under a monorepo or `--root`.
formTests("forms/registration.json", { tests: ["forms/extra.datum-test"], coverage: "warn" });
```

One `describe` per form, one `it` per scenario; a scenario every side skipped is a skipped test. The declarations of this entry are self-contained (a definition is any object with a `root`), so a project that typechecks its tests needs nothing else installed. `vitest` (2.1 or later) is an optional peer dependency, and only `@argusvane/datum-form-test/vitest` imports it.

## Programmatic use

The main entry (`@argusvane/datum-form-test`) exports `runCli`, `runFormTests`, `runScenarioOnSides`, `compareSides`, `coverageOf`, the three report writers and the report types, and never imports vitest. Its declarations still name the engine's types (`@argusvane/datum-engine`), which the tarball does not carry: use it from inside the repository, or with `skipLibCheck`, until the declarations are bundled.

## More

The language, the command, the reports, parity and coverage are documented in `docs/form-tests.md`; the decision is ADR 0154 (`docs/adr/0154-form-tests-scenarios-over-rules-journeys-and-verdicts.md`). Tests: `npm test`; types: `npm run typecheck`; regenerate the fixtures after the engine's fixture changes: `npm run fixtures:write`.
