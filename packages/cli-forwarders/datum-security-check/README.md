# datum-security-check

A forwarding command. It holds no tool of its own: `datum-security-check` runs the `datum-security-check` command of [`@argusvane/datum-conformance-suite`](https://www.npmjs.com/package/@argusvane/datum-conformance-suite), which runs Datum's attack vectors against the validation gate's program or a live endpoint. The name is held so that `npx datum-security-check` runs the real tool instead of whatever package might otherwise take it.

Install and run the real package:

```sh
npm install --save-dev @argusvane/datum-conformance-suite
npx --package @argusvane/datum-conformance-suite datum-security-check --help
```

Running this package does the same (it depends on the exact version of `@argusvane/datum-conformance-suite` published with it):

```sh
npx datum-security-check --help
```

Documentation, flags and exit codes: <https://datum.argusvane.com> and the README of `@argusvane/datum-conformance-suite`. Source: <https://github.com/argusvane/datum> (`packages/cli-forwarders/datum-security-check`).

## Licence

MIT, copyright Argusvane (`LICENSE`).
