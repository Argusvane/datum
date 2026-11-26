// The references are generated (reference/generate.mjs): this runs the generator's --check so the
// kit's checks step (datumBinding.checks, run as node <script> --port <n>) fails when a reference
// file differs from what the generator writes. The port is ignored.
//   node bindings/nova-scotia/tests/references.mjs
// Exit 0 when every file matches, 1 when one differs.
process.argv.push("--check");
await import("../reference/generate.mjs");
