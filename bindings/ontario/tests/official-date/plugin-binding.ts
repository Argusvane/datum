// The Ontario binding with the plugin's `ontario-date` adapter laid over it, as a host that registered
// `ontarioPlugin` has it: the type `ontario-date` (base `date`) draws the official <ontario-date-input>,
// and the main `date` type stays Datum's date in Ontario's markup. Built by checks.mjs.
import type { BindingFactory } from "../../../../engine/form-engine/render/live/contract.js";
import { createBinding as createOntario, ontarioPlugin } from "../../src/binding.js";

export const createBinding: BindingFactory = (lit, datum) => {
  const binding = createOntario(lit, datum);
  const definition = ontarioPlugin.components?.find((component) => component.type === "ontario-date");
  const adapter = (definition?.adapter as (lit: unknown, datum: unknown) => never)(lit, datum);
  return { ...binding, id: "ontario-plugin", components: { ...binding.components, "ontario-date": adapter } };
};
