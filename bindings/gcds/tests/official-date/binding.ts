// The GCDS binding with the official <gcds-date-input> drawing every `date` (not only the `gcds-date`
// type), so the conformance cases (DAT, ERR, RO) hold the official-component adapter to the same
// contract as the tier-2 Datum date. The adapter is the plugin's `gcds-date`.
//   node ../../packages/datum/binding-kit/conformance.ts --binding tests/official-date/binding.ts --assets tests/official-date/binding-check.json --port 5302
import type { BindingFactory } from "../../../../engine/form-engine/render/live/contract.js";
import { createBinding as createGcds, gcdsPlugin } from "../../src/binding.js";

export const createBinding: BindingFactory = (lit, datum) => {
  const binding = createGcds(lit, datum);
  const definition = gcdsPlugin.components?.find((component) => component.type === "gcds-date");
  const adapter = (definition?.adapter as (lit: unknown, datum: unknown) => never)(lit, datum);
  return { ...binding, id: "gcds-official-date", components: { ...binding.components, date: adapter } };
};
