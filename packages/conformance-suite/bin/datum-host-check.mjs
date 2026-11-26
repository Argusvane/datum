#!/usr/bin/env node
// A shim: the command line is the bundle in dist/ (npm run build). Nothing here needs a TypeScript toolchain.
import("../dist/host-check.mjs").catch((error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write("datum-host-check: dist/host-check.mjs is missing; run `npm run build` in packages/conformance-suite\n");
  } else {
    process.stderr.write(`datum-host-check: ${error && error.stack ? error.stack : error}\n`);
  }
  process.exit(4);
});
