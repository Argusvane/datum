import type { ValidationContext, ValidationResult, ValidationStage } from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { ParityVector } from "./parity-runner.js";

type Err = ValidationResult["errors"][number];

/**
 * Reference deterministic validation logic shared by all parity adapters. Pure: no time,
 * locale, randomness, or I/O. The same function backs the browser pipeline stage, the WASM
 * validator, and the server hook so any drift shows up as a parity mismatch.
 */
export function coreDeterministicValidator(context: ValidationContext): ValidationResult {
  const values = context.values;
  const errors: Err[] = [];

  const isBlank = (value: unknown): boolean =>
    value === undefined || value === null || (typeof value === "string" && value.trim() === "");

  if (isBlank(values.email)) {
    errors.push({ code: "required", componentId: "email", path: "email", stage: "field", source: "client" });
  } else if (typeof values.email === "string" && !values.email.includes("@")) {
    errors.push({ code: "format.email", componentId: "email", path: "email", stage: "field", source: "client" });
  }

  if (typeof values.age === "number" && (values.age < 18 || values.age > 120)) {
    errors.push({
      code: "range",
      componentId: "age",
      path: "age",
      stage: "field",
      source: "client",
      parameters: { min: 18, max: 120 }
    });
  }

  if (values.wantsNewsletter === true && isBlank(values.email)) {
    errors.push({ code: "cross-field.newsletterEmail", stage: "form", source: "client" });
  }

  return { errors };
}

/** The same logic packaged as a deterministic {@link ValidationStage}. */
export const coreValidationStage: ValidationStage = {
  id: "core-deterministic",
  version: "1.0.0",
  kind: "deterministic",
  validate: coreDeterministicValidator
};

/**
 * The schema the parity vectors are written against. The wasm adapter needs it because the
 * ABI context carries the form (sanitization derives its allowlist from it). Deliberately
 * free of `required`/`pattern` constraints: parity here compares the shared validator logic,
 * and the kernel's own constraint stage is covered by its dedicated tests.
 */
export const coreValidationRoot: ComponentNode = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "email", type: "text", configuration: {} },
      { id: "age", type: "number", configuration: {} },
      { id: "wantsNewsletter", type: "checkbox", configuration: {} }
    ]
  }
};

export const coreValidationVectors: ParityVector[] = [
  { id: "empty-form", context: { formId: "f", values: {} } },
  { id: "valid", context: { formId: "f", values: { email: "a@b.co", age: 30 } } },
  { id: "bad-email", context: { formId: "f", values: { email: "nope", age: 30 } } },
  { id: "age-too-low", context: { formId: "f", values: { email: "a@b.co", age: 12 } } },
  { id: "age-too-high", context: { formId: "f", values: { email: "a@b.co", age: 999 } } },
  {
    id: "newsletter-without-email",
    context: { formId: "f", values: { wantsNewsletter: true } }
  },
  {
    id: "multiple-errors",
    context: { formId: "f", values: { email: "", age: 5, wantsNewsletter: true } }
  }
];

/**
 * Adversarial value vectors over {@link coreValidationRoot}:
 * nulls, blanks, `0`, `-0`, non-finite numbers, numerals as text in a number field, wrong
 * shapes for every type, boundary ages, hostile keys, oversize text. They are not in
 * {@link coreValidationVectors}: the browser adapter there wraps the core stage alone, while
 * the kernel always runs its own field-constraints stage, so a vector raising a shape error
 * (`number`) compares only through a pipeline that carries that stage too.
 */
export const adversarialValueVectors: ParityVector[] = [
  { id: "adv-nulls", context: { formId: "f", values: { email: null, age: null, wantsNewsletter: null } } },
  { id: "adv-blank-email", context: { formId: "f", values: { email: "   ", age: 30 } } },
  { id: "adv-zero-age", context: { formId: "f", values: { email: "a@b.co", age: 0 } } },
  { id: "adv-negative-zero-age", context: { formId: "f", values: { email: "a@b.co", age: -0 } } },
  { id: "adv-nan-age", context: { formId: "f", values: { email: "a@b.co", age: Number.NaN } } },
  { id: "adv-infinity-age", context: { formId: "f", values: { email: "a@b.co", age: Number.POSITIVE_INFINITY } } },
  { id: "adv-negative-infinity-age", context: { formId: "f", values: { email: "a@b.co", age: Number.NEGATIVE_INFINITY } } },
  { id: "adv-text-age-in-range", context: { formId: "f", values: { email: "a@b.co", age: "30" } } },
  { id: "adv-text-age-out-of-range", context: { formId: "f", values: { email: "a@b.co", age: "5" } } },
  { id: "adv-text-age-spaces", context: { formId: "f", values: { email: "a@b.co", age: " 30 " } } },
  { id: "adv-text-age-comma", context: { formId: "f", values: { email: "a@b.co", age: "3,0" } } },
  { id: "adv-text-age-hex", context: { formId: "f", values: { email: "a@b.co", age: "0x1e" } } },
  { id: "adv-text-age-huge-exponent", context: { formId: "f", values: { email: "a@b.co", age: "1e999" } } },
  { id: "adv-text-age-nan", context: { formId: "f", values: { email: "a@b.co", age: "NaN" } } },
  { id: "adv-text-age-arabic-digits", context: { formId: "f", values: { email: "a@b.co", age: "٣٠" } } },
  { id: "adv-array-age", context: { formId: "f", values: { email: "a@b.co", age: [30] } } },
  { id: "adv-boolean-age", context: { formId: "f", values: { email: "a@b.co", age: true } } },
  { id: "adv-object-age", context: { formId: "f", values: { email: "a@b.co", age: { value: 30 } } } },
  { id: "adv-array-email", context: { formId: "f", values: { email: ["a@b.co"], age: 30 } } },
  { id: "adv-object-email", context: { formId: "f", values: { email: { address: "a@b.co" }, age: 30 } } },
  { id: "adv-number-email", context: { formId: "f", values: { email: 42, age: 30 } } },
  { id: "adv-boolean-email", context: { formId: "f", values: { email: true, age: 30 } } },
  { id: "adv-newsletter-text-true", context: { formId: "f", values: { email: "", wantsNewsletter: "true" } } },
  { id: "adv-newsletter-one", context: { formId: "f", values: { email: "", wantsNewsletter: 1 } } },
  { id: "adv-newsletter-null-blank-email", context: { formId: "f", values: { email: "", wantsNewsletter: null } } },
  { id: "adv-undefined-entries", context: { formId: "f", values: { email: undefined, age: undefined } } },
  { id: "adv-proto-key", context: { formId: "f", values: JSON.parse('{"__proto__":{"polluted":1},"email":"a@b.co","age":30}') as Record<string, unknown> } },
  { id: "adv-constructor-key", context: { formId: "f", values: { constructor: "x", email: "a@b.co", age: 30 } } },
  { id: "adv-unknown-key", context: { formId: "f", values: { rogue: 1, email: "a@b.co", age: 30 } } },
  { id: "adv-boundary-18", context: { formId: "f", values: { email: "a@b.co", age: 18 } } },
  { id: "adv-boundary-120", context: { formId: "f", values: { email: "a@b.co", age: 120 } } },
  { id: "adv-just-below-18", context: { formId: "f", values: { email: "a@b.co", age: 17.999 } } },
  { id: "adv-just-above-120", context: { formId: "f", values: { email: "a@b.co", age: 120.001 } } },
  { id: "adv-unsafe-integer-age", context: { formId: "f", values: { email: "a@b.co", age: 9007199254740993 } } },
  { id: "adv-email-with-nul", context: { formId: "f", values: { email: "a@b.co\u0000", age: 30 } } },
  { id: "adv-email-10k", context: { formId: "f", values: { email: `${"a".repeat(10_000)}@b.co`, age: 30 } } }
];
