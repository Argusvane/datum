/**
 * The `minLength` / `maxLength` an author may put on a free-text field.
 *
 * One reader for both the validation stage (which enforces them) and the render model (which
 * hints them to the browser as `minlength` / `maxlength`), so the hint and the check can never
 * disagree about what was authored. The WASM kernel mirrors this by hand
 * (`validation/wasm/portable-kernel.ts`), as it does every other constraint.
 */

export interface LengthLimits {
  /** Fewest characters a non-empty value may have. */
  minLength?: number;
  /** Most characters a value may have. */
  maxLength?: number;
  /**
   * Show the count against `maxLength` as the person types (`configuration.characterCount`).
   * Only ever true beside a maximum: a count with no limit has nothing to count
   * down to.
   */
  characterCount?: boolean;
}

/** A limit as authored: a finite number of at least one, floored. Anything else is no limit. */
function readLimit(configuration: Record<string, unknown>, key: "minLength" | "maxLength"): number | undefined {
  const raw = configuration[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const limit = Math.floor(raw);
  return limit >= 1 ? limit : undefined;
}

/**
 * Both limits from a component's configuration — or neither when they contradict each other.
 * A minimum above the maximum is an authoring mistake no value could satisfy, and, like a
 * pattern this runtime cannot compile, not something to hold the form filler to.
 */
export function readLengthLimits(configuration: unknown): LengthLimits {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return {};
  }
  const record = configuration as Record<string, unknown>;
  const minLength = readLimit(record, "minLength");
  const maxLength = readLimit(record, "maxLength");
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    return {};
  }
  const characterCount = maxLength !== undefined && record.characterCount === true;
  return {
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(characterCount ? { characterCount } : {})
  };
}

/**
 * How long a value is for a length limit: Unicode code points, untrimmed. An accented letter
 * or an emoji counts once, which is what an author writing "at most 10 characters" means;
 * browsers differ among themselves on what `maxlength` counts, which is one more reason the
 * attribute the markup emits is a hint and the stage is the check.
 */
export function countCharacters(value: string): number {
  return Array.from(value).length;
}
