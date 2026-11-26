import { CAPABILITY_ORDER, type Capability } from "../capabilities.js";
import type { CapabilityModule, HostCase } from "../case.js";
import { ASSETS } from "./assets.js";
import { BUILDER } from "./builder.js";
import { FLOOD } from "./flood.js";
import { FORMS } from "./forms.js";
import { HARDENING } from "./hardening.js";
import { HOST_CONTEXT } from "./host-context.js";
import { PASSKEYS } from "./passkeys.js";
import { PDF } from "./pdf.js";
import { RUNTIME_DOWN } from "./runtime-down.js";
import { SUBMISSIONS } from "./submissions.js";
import { SUBMISSIONS_TEST } from "./submissions-test.js";
import { TSA } from "./tsa.js";

/** Every capability's module, in the fixed run order (flood last). */
export const MODULES: readonly CapabilityModule[] = [SUBMISSIONS, SUBMISSIONS_TEST, FORMS, ASSETS, BUILDER, PDF, TSA, PASSKEYS, HARDENING, RUNTIME_DOWN, HOST_CONTEXT, FLOOD];

/** Every case, capability by capability in run order, each capability's cases by their Java @Order. */
export const CASES: readonly HostCase[] = MODULES.flatMap((module) => [...module.cases].sort((a, b) => a.order - b.order));

export function moduleOf(capability: Capability): CapabilityModule {
  const found = MODULES.find((module) => module.capability === capability);
  if (found === undefined) throw new Error(`no module for ${capability}`);
  return found;
}

export function caseById(id: string): HostCase | undefined {
  return CASES.find((entry) => entry.id === id.trim().toUpperCase());
}

// The module list and the capability order are one list; a module out of place would reorder a run.
if (MODULES.map((module) => module.capability).join(",") !== CAPABILITY_ORDER.join(",")) {
  throw new Error("cases/index.ts: MODULES is not in CAPABILITY_ORDER");
}
