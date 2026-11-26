import type { Json } from "../observation.js";
import type { Gen } from "../vectors/schema.js";
import { validValues } from "./base-form.js";

/** The marker texts the hostile controls plant; a verdict that carries one back has been polluted or has leaked. */
export const POLLUTION_MARKER = "ZZPOLLZZ";
export const STRAY_MARKER = "ZZSTRAYZZ";
export const CONSTRUCTOR_MARKER = "ZZCTORZZ";
export const TOSTRING_MARKER = "ZZTOSTRINGZZ";

const valid = (): Record<string, Json> => validValues() as Record<string, Json>;

/** Answers for each control vector. The hostile ones are parsed from text so `__proto__` is an own key, not a prototype. */
export const CONTROL_VALUES = {
  "CTL-01": (): Json => valid(),
  "CTL-02": (): Json => ({ ...valid(), name: "" }),
  "CTL-03": (): Json => ({ ...valid(), name: "x".repeat(41) }),
  "CTL-04": (): Json => ({ ...valid(), code: "abc" }),
  "CTL-05": (): Json => ({ ...valid(), stray: STRAY_MARKER, constructor: CONSTRUCTOR_MARKER }),
  "CTL-06": (): Json => hostileValues(),
  "CTL-06-bulk": (): Gen => ({ $gen: "merge", of: [valid(), { $gen: "unknownKeys", n: 10_000, prefix: "bulk" }] })
} as const;

function hostileValues(): Json {
  const text = JSON.stringify(valid()).slice(0, -1);
  return JSON.parse(
    `${text},"__proto__":{"polluted":"${POLLUTION_MARKER}"},"constructor":{"prototype":{"polluted":"${POLLUTION_MARKER}"}},"toString":"${TOSTRING_MARKER}"}`
  ) as Json;
}
