import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// The passing project: the scenarios stored in the definition, and the sidecar beside it.
// Paths come from this file, not the working directory, because the parent test runs vitest
// with `--root` from the package folder.
formTests(join(import.meta.dirname, "fixtures/main.json"), { name: "helper project: passing" });
