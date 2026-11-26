import { join } from "node:path";

import { formTests } from "../../src/vitest.js";

// A form whose rule calls today(). An empty signature list given to the
// kernel side would be taken as the whole function table and fail every such form there only.
// Nothing is given here, as in the common call.
formTests(join(import.meta.dirname, "../../fixtures/clock.json"), { name: "helper project: clock" });
// And with a plugin signature given: the built-ins stay.
formTests(join(import.meta.dirname, "../../fixtures/clock.json"), {
  name: "helper project: clock with a plugin function",
  signatures: [{ name: "double", min: 1, max: 1 }],
  functions: { double: (args: unknown[]) => Number(args[0]) * 2 }
});
