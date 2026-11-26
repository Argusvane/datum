#!/usr/bin/env node
// A shim: the command line is the bundle in dist/ (npm run build). Nothing here needs a TypeScript toolchain.
import("../dist/cli.mjs").catch((error) => {
  if (error && error.code === "ERR_MODULE_NOT_FOUND") {
    // The message names the module that is missing: dist/cli.mjs itself, or dist/index.mjs behind it.
    process.stderr.write(`datum-form-test: ${error.message}; run \`npm run build\` in packages/form-test\n`);
  } else {
    process.stderr.write(`datum-form-test: ${error && error.stack ? error.stack : error}\n`);
  }
  process.exit(4);
});
