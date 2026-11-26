// The allocation claims every dist file exactly once, with the documented skips.
import assert from "node:assert/strict";
import { test } from "node:test";

import { allocateDistFiles, DISTRIBUTIONS } from "../allocation.mjs";

const input = {
  distFiles: [
    "datum-sandbox-program.js", "datum-pdf-program.js", "fonts/DejaVuSans.ttf", "fonts/DejaVuSans.ttf.map",
    "datum-form.js", "datum-form.css", "datum-form-webauthn-ab.js", "datum-wasm.js", "datum-form.iife.js", "datum-form.js.map",
    "datum-builder.js", "datum-builder-index-x.js", "datum-builder-pdf-designer-y.js", "builder-fonts/Geist.woff2",
    "datum-pdf.js", "datum-pdf-pages.js", "pdfjs/pdf.worker.js", "datum-pdf-x.js",
    "types/index.d.ts", "feature-files.json"
  ],
  pdfFeatureFiles: new Set(["datum-pdf.js", "datum-pdf-pages.js", "pdfjs/pdf.worker.js", "datum-pdf-x.js", "datum-builder-pdf-designer-y.js", "fonts/DejaVuSans.ttf"]),
  omittedFiles: new Set(["datum-form-webauthn-ab.js"])
};

test("every dist file lands in exactly one bucket", () => {
  const { buckets, unclaimed } = allocateDistFiles(input);
  assert.deepEqual(unclaimed, []);
  const all = Object.values(buckets).flat();
  assert.equal(all.length, input.distFiles.length);
  assert.equal(new Set(all).size, all.length);
});

test("the documented destinations", () => {
  const { buckets } = allocateDistFiles(input);
  assert.deepEqual(buckets["argusvane-datum-programs"].sort(), ["datum-pdf-program.js", "datum-sandbox-program.js", "fonts/DejaVuSans.ttf"]);
  assert.ok(buckets["argusvane-datum-assets-ui"].includes("datum-wasm.js"));
  assert.ok(buckets["argusvane-datum-assets-ui"].includes("builder-fonts/Geist.woff2"));
  assert.ok(!buckets["argusvane-datum-assets-ui"].includes("datum-builder-pdf-designer-y.js"));
  assert.ok(buckets["argusvane-datum-assets-pdf"].includes("datum-builder-pdf-designer-y.js"));
  assert.ok(buckets["argusvane-datum-assets-pdf"].includes("pdfjs/pdf.worker.js"));
  assert.deepEqual(buckets.omitted, ["datum-form-webauthn-ab.js"]);
  for (const skipped of ["types/index.d.ts", "datum-form.iife.js", "datum-form.js.map", "feature-files.json"]) {
    assert.ok(buckets.skip.includes(skipped), skipped);
  }
});

test("a file nobody claims is reported, not shipped", () => {
  const { unclaimed } = allocateDistFiles({ ...input, distFiles: [...input.distFiles, "mystery.bin"] });
  assert.deepEqual(unclaimed, ["mystery.bin"]);
});

test("the eight distributions are named once", () => {
  assert.equal(DISTRIBUTIONS.length, 8);
  assert.equal(new Set(DISTRIBUTIONS.map((d) => d.name)).size, 8);
});

test("a binding or plugin bundle in dist/ is reported: those packages ship from their own dist", () => {
  const { unclaimed } = allocateDistFiles({ ...input, distFiles: ["datum-binding-gcds.js", "datum-acme-plugin.js", "gcds-tokens.css"] });
  assert.deepEqual(unclaimed, ["datum-binding-gcds.js", "datum-acme-plugin.js", "gcds-tokens.css"]);
});
