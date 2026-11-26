# datum-binding-check

A forwarding command. It holds no tool of its own: `datum-binding-check` runs the `datum-binding-check` command of [`@argusvane/datum-conformance-suite`](https://www.npmjs.com/package/@argusvane/datum-conformance-suite), which checks a form-renderer binding against Datum's feature corpus, in a browser. The name is held so that `npx datum-binding-check` runs the real tool instead of whatever package might otherwise take it.

Install and run the real package:

```sh
npm install --save-dev @argusvane/datum-conformance-suite
npx --package @argusvane/datum-conformance-suite datum-binding-check --help
```

Running this package does the same (it depends on the exact version of `@argusvane/datum-conformance-suite` published with it):

```sh
npx datum-binding-check --help
```

Documentation, flags and exit codes: <https://datum.argusvane.com> and the README of `@argusvane/datum-conformance-suite`. Source: <https://github.com/argusvane/datum> (`packages/cli-forwarders/datum-binding-check`).

## Licence

MIT, copyright Argusvane (`LICENSE`).
