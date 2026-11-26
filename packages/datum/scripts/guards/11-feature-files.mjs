// The feature -> files manifest (scripts/feature-files.mjs). Guards run
// inside check-bundles, BEFORE feature-files.mjs writes dist/feature-files.json in the build
// chain, so the manifest cannot be required to exist yet: this guard computes it from the same
// dist through the script's exported function and holds what the written file will say. (The
// script itself exits 1 on an unattributed file, and the browser check reads the written file.)
import { existsSync } from "node:fs";
import { join } from "node:path";

import { computeFeatureFiles } from "../feature-files.mjs";

/** The bundles a page loads first, in both module and classic-script form: never removable. */
const ENTRY = /^datum-(form|builder)(\.iife)?\.js$/;

/**
 * Tokens whose code is a lazy chunk in every build: a build where one lists no file has lost its
 * split (a renamed chunk turns "core" because core code imports it, and the feature then reads as
 * having nothing removable, which no other check notices).
 */
export const LAZY_TOKENS = ["pdf", "pdf-pages", "journeys", "webauthn", "validate-url", "try-it", "wasm", "logic", "data", "languages", "print", "agent"];

export default function guard({ dist, expect }) {
  const manifest = computeFeatureFiles(dist);
  expect(manifest.unattributed.length === 0, `feature-files: lazy files no feature or core rule explains: ${manifest.unattributed.join(", ")}; add them to scripts/feature-files.mjs`);
  const seen = new Map();
  for (const [token, feature] of Object.entries(manifest.features)) {
    for (const file of feature.files) {
      expect(!seen.has(file), `feature-files: ${file} is listed under both ${seen.get(file)} and ${token}; a shared file is core`);
      seen.set(file, token);
      expect(existsSync(join(dist, file)), `feature-files: ${token} lists ${file}, which is not in dist/`);
      expect(!ENTRY.test(file), `feature-files: ${token} lists the entry bundle ${file} as removable`);
    }
  }
  for (const { file } of manifest.core) {
    expect(!seen.has(file), `feature-files: ${file} is core but also listed under ${seen.get(file)}`);
  }
  // The two models' tokens are all there (the script reads them from src/form-features.ts and builder-features.ts).
  for (const token of ["pdf", "pdf-pages", "wasm", "webauthn", "validate-url", "journeys", "signing", "try-it"]) {
    expect(token in manifest.features, `feature-files: token ${token} is missing from the manifest`);
  }
  for (const token of LAZY_TOKENS) {
    const files = manifest.features[token]?.files ?? [];
    expect(files.length > 0, `feature-files: lazy token ${token} lists no file; its chunk was renamed, merged into the entry or made core (a static importer), so a host could no longer delete it`);
  }
}
