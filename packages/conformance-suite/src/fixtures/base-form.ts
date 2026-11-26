import definition from "../../fixtures/endpoint-fixture.definition.json" with { type: "json" };

/** The section-5 fixture form: the one every endpoint vector uses and the program vectors start from. */
export const BASE_DEFINITION = definition as unknown as { id: string; version: string; root: Record<string, unknown>; journey: unknown };

/** A deep copy of the fixture form's root component, safe for a vector to edit. */
export function baseRoot(): Record<string, unknown> {
  return structuredClone(BASE_DEFINITION.root);
}

/** The form's id as the program runner sends it. */
export const BASE_FORM_ID = BASE_DEFINITION.id;

/**
 * A valid submission of the fixture form (CTL-01). It leaves `risky` empty on purpose: the
 * kernel refuses that field's pattern `(a|a?)+` as risky, so any answer to it is a `pattern` error.
 */
export function validValues(): Record<string, unknown> {
  return {
    name: "Ada Lovelace",
    code: "AB1234",
    addr: { city: "Ottawa", pick: "ok" },
    tags: { x: true, y: false },
    rows: [{ sku: "s1", n: 1 }]
  };
}
