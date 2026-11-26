# datum-form-test

A forwarding command. It holds no tool of its own: `datum-form-test` runs the `datum-form-test` command of [`@argusvane/datum-form-test`](https://www.npmjs.com/package/@argusvane/datum-form-test), which runs a Datum form's tests (scenarios over its rules, journeys and verdicts) from the command line and in CI. The name is held so that `npx datum-form-test` runs the real tool instead of whatever package might otherwise take it.

Install and run the real package:

```sh
npm install --save-dev @argusvane/datum-form-test
npx --package @argusvane/datum-form-test datum-form-test --help
```

Running this package does the same (it depends on the exact version of `@argusvane/datum-form-test` published with it):

```sh
npx datum-form-test --help
```

Documentation, flags and exit codes: <https://datum.argusvane.com> and the README of `@argusvane/datum-form-test`. Source: <https://github.com/argusvane/datum> (`packages/cli-forwarders/datum-form-test`).

## Licence

MIT, copyright Argusvane (`LICENSE`).
