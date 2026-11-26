# datum-host-check

A forwarding command. It holds no tool of its own: `datum-host-check` runs the `datum-host-check` command of [`@argusvane/datum-conformance-suite`](https://www.npmjs.com/package/@argusvane/datum-conformance-suite), which checks that a host's wire contract for Datum forms holds. The name is held so that `npx datum-host-check` runs the real tool instead of whatever package might otherwise take it.

Install and run the real package:

```sh
npm install --save-dev @argusvane/datum-conformance-suite
npx --package @argusvane/datum-conformance-suite datum-host-check --help
```

Running this package does the same (it depends on the exact version of `@argusvane/datum-conformance-suite` published with it):

```sh
npx datum-host-check --help
```

Documentation, flags and exit codes: <https://datum.argusvane.com> and the README of `@argusvane/datum-conformance-suite`. Source: <https://github.com/argusvane/datum> (`packages/cli-forwarders/datum-host-check`).

## Licence

MIT, copyright Argusvane (`LICENSE`).
