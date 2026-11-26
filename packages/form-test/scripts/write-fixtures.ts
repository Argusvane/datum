// Writes packages/form-test/fixtures/ from the engine's form-tests fixture (`npm run fixtures:write`,
// vite-node). The texts are made by tests/helpers/fixture-files.ts, which tests/fixtures.test.ts reads
// too, so a change to the engine's corpus that is not written here fails that test instead of drifting.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureFiles } from "../tests/helpers/fixture-files.js";

const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
mkdirSync(folder, { recursive: true });
for (const [name, text] of Object.entries(fixtureFiles())) {
  writeFileSync(join(folder, name), text);
  console.log(`fixtures/${name} ${Buffer.byteLength(text)} bytes`);
}
