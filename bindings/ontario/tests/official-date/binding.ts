// The Ontario binding with the official <ontario-date-input> drawing every `date` (not only the
// `ontario-date` type), so the conformance cases (DAT, ERR, RO) hold the official-component adapter to
// the same contract as the tier-2 Datum date. The adapter is the plugin's `ontario-date`.
//   node ../../packages/datum/binding-kit/conformance.ts --binding tests/official-date/binding.ts --assets tests/official-date/binding-check.json
import type { BindingFactory } from "../../../../engine/form-engine/render/live/contract.js";
import { createBinding as createOntario, ontarioPlugin } from "../../src/binding.js";

export const createBinding: BindingFactory = (lit, datum) => {
  const binding = createOntario(lit, datum);
  const definition = ontarioPlugin.components?.find((component) => component.type === "ontario-date");
  const adapter = (definition?.adapter as (lit: unknown, datum: unknown) => never)(lit, datum);
  return { ...binding, id: "ontario-official-date", components: { ...binding.components, date: adapter } };
};
