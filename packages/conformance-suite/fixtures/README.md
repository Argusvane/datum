# The endpoint fixture form

`datum-security-check --endpoint ...` attacks a form on a live server. It does not touch your forms:
it needs ONE form that you install for it, `datum-security-suite`, and it only ever talks to that
form's own routes. This folder holds that form.

- `endpoint-fixture.definition.json`: the form definition (`datum-security-check fixture` prints it).
- Its root carries `configuration.securitySuiteFixture: "1"`, the marker the run looks for before it
  will write anything.

The form is small on purpose: `name` (required, 40 characters), `code` (a pattern), an `addr`
container with a required `city` and a `pick` select (`ok` / `fine`), a `tags` checkbox group
(`x` / `y`), a `rows` collection with a required `sku` and a number `n`, a `risky` text with a
backtracking pattern, a `doc` file field with a tiny size limit, and a `secret` field that is
required when `name` equals `ZZSECRETZZ` by a `server-secret` rule. A journey `main` with one page
lists every field; that page routes the name `STOPZZ` to a second page `stop` of kind `exit` (the
JRN vectors submit it to prove an exit page cannot be skipped), and every other answer to the end. Nothing in it needs a data source, a plugin or per-host configuration.

## Reinstall the fixture for the live JRN rows

The live JRN-01, JRN-03 and JRN-07 rows (`--endpoint`) judge the form installed on the server, not the copy in this folder. The fixture changed at vector set `2026.10.15-1` (journey `main` routes `STOPZZ` to the exit page `stop`), so every installation made before that must be removed and installed again (`datum-security-check fixture` prints the current definition; paste it over the form's JSON in the builder and save, or delete the form and redo the install below). Recognise a missing or stale fixture by the run:

- **INCONCLUSIVE, exit code 3**, before any vector runs: the preflight prints the setting to fix, for example `the form has no journey "main" (journey.unknown): install the fixture form` or `HTTP 400 bad_document for a well-formed check: the form is probably not the fixture`. Nothing was judged; install the fixture and run again. (A 429 the server will not wait out, an unreachable server and an incomplete builder cleanup also exit 3; the report's `inconclusive` list says which.)
- **FAIL, exit code 1**, from an old installation that still has a `main` journey: JRN-01 fails on the row `check-the-exit-answers-through-main` (the exit answer was accepted) and the JRN-07 omission rows follow. That is the fixture, not the host: reinstall, then judge the result.

The builder profile (`--builder`) installs its own suite form and does not need this; its cleanup deletes the form with its records, so a form left by an aborted run is removed by `datum-security-check builder-cleanup`.

## What a run sends, and what it never sends

- Default mode (no flags beyond the endpoint): `POST` of the form's validate route only (and `GET`
  of the public definition, if you give its URL, and of the form's record list). A validate stores
  nothing and writes no record.
- Never: `PUT`, `DELETE`, a request to another form's route (but one synthetic form id,
  `datum-security-suite--no-such-form`, to see a 404), or a followed redirect. Anything else the
  suite refuses to send is a bug in the suite and it throws.
- `--allow-writes` also posts to the submit route: a few records land in the fixture form (and
  nowhere else). It needs the marker (give `--public-definition-url`, or vouch for the form with
  `--i-installed-the-suite-fixture`). Without the marker the writing vectors are skipped. The
  report says how many records were created.
- About 100 to 200 requests per run, one at a time, 250 ms apart (`--delay-ms`), at most 400
  (`--max-requests`). A `429` is waited out once if the server says it is short (`Retry-After` of
  at most 60 s); otherwise the run stops as INCONCLUSIVE and lists what it did not run. The suite
  never tries to provoke a rate limit.

## Install on `@argusvane/datum-submissions`

`datum-security-check fixture --format submissions` prints the body of `POST /api/forms`
(`{definition, settings}`), the registration your host already exposes
(`SUBMISSION_ROUTES`), or call `service.register(definition)` in code:

```ts
import { fixtureDefinition } from "@argusvane/datum-conformance-suite";
await service.register(fixtureDefinition());
```

The routes the run uses are `POST /api/submissions/validate`, `POST /api/submissions` (writes
only), `GET /api/forms/:key/definition` and `GET /api/forms/:key/submissions` (the record count
around a check, REC-13), with `:key` the catalog key `datum-security-suite@1`. The body is
`{document, submissionKey}` for a delivery and `{document, scope, pageId?}` for a check. A host answers as
`packages/submissions/src/http-mapping.ts` does: `parseValidateRequest` for a check's strict request,
`validationBody` (`{accepted, errors, notes?}`) for its verdict, `receiveResponse` for a delivery and
`errorResponse` / `statusOf` for refusals (a run that gave no verdict is a `503` with its code). What the
service does not do for it: turn a body that is not a JSON object into
`400 {errors:[{field:null,code:"bad_document"}]}`, cap the body, and never answer a 5xx other than a typed `503`.

Then: `datum-security-check --endpoint https://host --form datum-security-suite`.

## Reading the result

Exit `0` PASS, `1` an enforced vector failed, `3` INCONCLUSIVE (the preflight found the fixture
missing or misconfigured, the run was rate limited out, or the account was refused). The preflight
sends three controls first (a valid submission, a blank name, a pick outside the options); the
message says which setting to fix. Any `5xx` other than a typed `503`, and any body that is not
JSON where the contract promises JSON, fails the run whatever the vector expected (the
never-500 rule, SEC-05).

## The builder profile (`--builder`)

The builder profile needs no fixture installed: it makes its own form (`secsuite_<8 hex>`, label "Datum security suite (safe to delete)"), fills it with the fixture definition and hostile ones, and deletes it. Requirements:

- `--definition-limit` is the host's definition size limit (default 8 MiB); the one oversize body (BLD-05) is sent only under `--heavy` or `--gate full`. The form's `formulaErrors` is the fixture's `fail`.
- `@argusvane/datum-submissions`: nothing beyond a reachable service (`--auth-header` for a proxy in front of it). The docs' `PUT /api/forms/:id` save recipe is not a route of `SUBMISSION_ROUTES`: a save is `POST /api/forms`.
- Adopt mode (`--builder-form <id>` plus the marker `root.configuration.securitySuiteFixture "1"`, or `--i-installed-the-suite-fixture`) is for a host where forms cannot be created over HTTP: the original definition is saved to the state file, restored at the end (BLD-11) and the form is never deleted; the one record the final submit stores stays in it.
- `datum-security-check builder-cleanup --endpoint <url> --state-file <path>` removes what a killed run left (it reads the id from the state file, and refuses a state file written for another server).

